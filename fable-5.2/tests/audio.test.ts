/**
 * Audio engine logic in Node. There is no WebAudio here, so the engine runs against a strict fake context
 * that validates every call the way a browser would (finite values, positive exponential targets, start
 * before stop …) and keeps count of connected nodes and running sources. What things SOUND like is measured
 * in a real browser by dev/audio.ts (OfflineAudioContext); this file covers the bookkeeping:
 * robustness, the event → sound mapping, voice limiting, pause / stop behaviour and resource release.
 */
import { describe, expect, it, vi } from 'vitest';
import { ENEMIES, PLAYER } from '../src/config';
import { AudioEngine, DEFAULT_VOLUME } from '../src/audio/engine';
import { EVENT_SOUNDS, createCueState, dispatchEvent, type AudioSimView } from '../src/audio/cues';
import { CEILING, CLIP_KNEE, Mixer, VOICE_CAP, compressorMakeup, softClip, type PlayOptions } from '../src/audio/mixer';
import { NoiseBank, Patch, generateNoise, makeRandom } from '../src/audio/patch';
import { CATEGORIES, LOOPS, SOUNDS, SOUND_IDS, type SoundId } from '../src/audio/sounds';
import { BEHIND_WARNING_CUTOFF, MAX_PAN, OPEN_CUTOFF, distanceGain, place, rolloffGain, type Listener, type Placement } from '../src/audio/spatial';
import { buildSnapshot } from '../src/sim/snapshot';
import type { SimEvent } from '../src/sim/types';
import { RealFight, SyntheticFight, sampleEvents, sampleView } from '../dev/audio-scenarios';

// ───────────────────────────── strict fake WebAudio ─────────────────────────────

class FakeParam {
  value: number;
  /** Value at the end of the scheduled timeline (what an exponential ramp would start from). */
  private last: number;
  calls = 0;
  constructor(
    private readonly ctx: FakeContext,
    initial: number,
  ) {
    this.value = initial;
    this.last = initial;
  }
  private check(v: number, t: number): void {
    this.calls++;
    this.ctx.paramCalls++;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`non-finite param value ${v}`);
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) throw new RangeError(`bad param time ${t}`);
  }
  setValueAtTime(v: number, t: number): this {
    this.check(v, t);
    this.last = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.check(v, t);
    this.last = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.check(v, t);
    if (!(v > 0)) throw new RangeError(`exponential ramp to ${v}`);
    if (!(this.last > 0)) throw new RangeError(`exponential ramp from ${this.last}`);
    this.last = v;
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number): this {
    this.check(v, t);
    if (!(tau >= 0) || !Number.isFinite(tau)) throw new RangeError(`bad time constant ${tau}`);
    this.last = v;
    this.value = v;
    return this;
  }
  cancelScheduledValues(t: number): this {
    this.check(0, t);
    return this;
  }
}

class FakeNode {
  outs = 0;
  constructor(readonly ctx: FakeContext) {
    ctx.created++;
  }
  connect(dest: FakeNode | FakeParam): FakeNode | FakeParam {
    if (!(dest instanceof FakeNode) && !(dest instanceof FakeParam)) throw new TypeError('connect: bad destination');
    if (this.outs === 0) this.ctx.connected++;
    this.outs++;
    return dest;
  }
  disconnect(): void {
    if (this.outs > 0) this.ctx.connected--;
    this.outs = 0;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(this.ctx, 1);
}
class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(this.ctx, 350);
  Q = new FakeParam(this.ctx, 1);
  gain = new FakeParam(this.ctx, 0);
}
class FakePanner extends FakeNode {
  pan = new FakeParam(this.ctx, 0);
}
class FakeCompressor extends FakeNode {
  threshold = new FakeParam(this.ctx, -24);
  knee = new FakeParam(this.ctx, 30);
  ratio = new FakeParam(this.ctx, 12);
  attack = new FakeParam(this.ctx, 0.003);
  release = new FakeParam(this.ctx, 0.25);
}
class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample = 'none';
}

class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  startAt = -1;
  stopAt = Infinity;
  ended = false;
  constructor(ctx: FakeContext) {
    super(ctx);
    ctx.sources.push(this);
  }
  start(when = 0, offset = 0): void {
    if (this.startAt >= 0) throw new Error('InvalidStateError: start called twice');
    if (!Number.isFinite(when) || when < 0) throw new RangeError(`bad start time ${when}`);
    if (!Number.isFinite(offset) || offset < 0) throw new RangeError(`bad offset ${offset}`);
    this.startAt = when;
    this.ctx.started++;
  }
  stop(when = 0): void {
    if (this.startAt < 0) throw new Error('InvalidStateError: stop before start');
    if (!Number.isFinite(when) || when < 0) throw new RangeError(`bad stop time ${when}`);
    this.stopAt = when;
  }
}
class FakeOsc extends FakeSource {
  type = 'sine';
  frequency = new FakeParam(this.ctx, 440);
  detune = new FakeParam(this.ctx, 0);
}
class FakeBufferSource extends FakeSource {
  buffer: unknown = null;
  loop = false;
  playbackRate = new FakeParam(this.ctx, 1);
}

class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  state: 'running' | 'suspended' | 'closed' = 'running';
  created = 0;
  connected = 0;
  started = 0;
  paramCalls = 0;
  sources: FakeSource[] = [];
  listeners: Array<() => void> = [];
  destination = new FakeNode(this);
  resumeCalls = 0;
  closeCalls = 0;

  createGain = (): FakeGain => new FakeGain(this);
  createBiquadFilter = (): FakeFilter => new FakeFilter(this);
  createStereoPanner = (): FakePanner => new FakePanner(this);
  createDynamicsCompressor = (): FakeCompressor => new FakeCompressor(this);
  createWaveShaper = (): FakeShaper => new FakeShaper(this);
  createOscillator = (): FakeOsc => new FakeOsc(this);
  createBufferSource = (): FakeBufferSource => new FakeBufferSource(this);
  createBuffer(channels: number, length: number, sampleRate: number): { duration: number; getChannelData(c: number): Float32Array } {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / sampleRate, getChannelData: (c: number) => data[c] };
  }
  addEventListener(_type: string, fn: () => void): void {
    this.listeners.push(fn);
  }
  removeEventListener(_type: string, fn: () => void): void {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
    for (const f of this.listeners) f();
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closeCalls++;
    this.state = 'closed';
    return Promise.resolve();
  }

  /** Sources that have been started and have neither ended nor been disconnected. */
  get running(): number {
    let n = 0;
    for (const s of this.sources) if (s.startAt >= 0 && !s.ended) n++;
    return n;
  }

  /** Advances the clock and fires `onended` like the audio thread would. */
  advance(dt: number): void {
    this.currentTime += dt;
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const s = this.sources[i];
      if (s.startAt >= 0 && !s.ended && s.stopAt <= this.currentTime) {
        s.ended = true;
        this.sources.splice(i, 1);
        if (s.onended) s.onended();
      }
    }
  }
}

const asCtx = (c: FakeContext): BaseAudioContext => c as unknown as BaseAudioContext;

function liveEngine(): { engine: AudioEngine; ctx: FakeContext; baseline: number } {
  const ctx = new FakeContext();
  const engine = new AudioEngine({ createContext: () => asCtx(ctx), volume: 1 });
  engine.unlock();
  expect(engine.getDebugInfo().errors).toBe(0);
  return { engine, ctx, baseline: ctx.connected };
}

/** Records which sounds the engine asks its mixer for. */
function spyPlays(engine: AudioEngine): { ids: SoundId[]; opts: PlayOptions[] } {
  const mixer = engine.getMixer() as Mixer;
  const rec = { ids: [] as SoundId[], opts: [] as PlayOptions[] };
  const original = mixer.play.bind(mixer);
  vi.spyOn(mixer, 'play').mockImplementation((id: SoundId, o?: PlayOptions) => {
    rec.ids.push(id);
    rec.opts.push({ ...(o ?? {}) });
    return original(id, o);
  });
  return rec;
}

const allSamples = (): SimEvent[] => Object.values(sampleEvents()).flat();

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    if (o instanceof Map) for (const v of o.values()) deepFreeze(v);
    else for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

// ───────────────────────────── robustness ─────────────────────────────

describe('AudioEngine without WebAudio', () => {
  it('is a silent no-op that never throws (Node has no AudioContext)', () => {
    expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined();
    const a = new AudioEngine();
    const view = sampleView();
    expect(() => {
      a.handleEvents(allSamples(), view);
      a.update(view, 1 / 60, true);
      a.playUi('click');
      a.unlock();
      a.unlock();
      a.handleEvents(allSamples(), view);
      a.update(view, 1 / 60, true);
      a.update(null, 1 / 60, false);
      a.playUi('sortie');
      a.setMuted(true);
      a.setVolume(0.3);
      a.stopAll();
      a.dispose();
      a.dispose();
      a.unlock();
      a.handleEvents(allSamples(), view);
    }).not.toThrow();
    expect(a.activeVoices).toBe(0);
    expect(a.muted).toBe(true);
    expect(a.volume).toBe(0.3);
    expect(a.getDebugInfo().errors).toBe(0);
  });

  it('survives a context factory that throws or returns nothing', () => {
    const a = new AudioEngine({
      createContext: () => {
        throw new Error('no audio device');
      },
    });
    expect(() => a.unlock()).not.toThrow();
    expect(a.getDebugInfo().errors).toBe(1);
    expect(() => a.handleEvents(allSamples(), sampleView())).not.toThrow();
    expect(a.activeVoices).toBe(0);

    const b = new AudioEngine({ createContext: () => null });
    b.unlock();
    expect(b.getDebugInfo().state).toBe('unavailable');
    expect(b.getDebugInfo().errors).toBe(0);
  });

  it('survives a context whose node factories throw', () => {
    const ctx = new FakeContext();
    ctx.createDynamicsCompressor = () => {
      throw new Error('unsupported');
    };
    const a = new AudioEngine({ createContext: () => asCtx(ctx) });
    expect(() => a.unlock()).not.toThrow();
    expect(a.getMixer()).toBeNull();
    expect(ctx.closeCalls).toBe(1);
    expect(() => {
      a.handleEvents(allSamples(), sampleView());
      a.update(sampleView(), 0.016, true);
      a.playUi('error');
    }).not.toThrow();
  });

  it('has a moderate default volume', () => {
    expect(new AudioEngine().volume).toBe(DEFAULT_VOLUME);
    expect(DEFAULT_VOLUME).toBeGreaterThan(0.4);
    expect(DEFAULT_VOLUME).toBeLessThan(0.85);
  });
});

describe('AudioEngine life cycle', () => {
  it('creates nothing before unlock() (autoplay policy)', () => {
    const ctx = new FakeContext();
    const factory = vi.fn(() => asCtx(ctx));
    const a = new AudioEngine({ createContext: factory });
    a.handleEvents(allSamples(), sampleView());
    a.update(sampleView(), 0.016, true);
    a.playUi('click');
    a.setVolume(0.5);
    a.setMuted(false);
    a.stopAll();
    expect(factory).not.toHaveBeenCalled();
    expect(ctx.created).toBe(1); // only the fake destination itself
    a.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    a.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    a.handleEvents([{ type: 'jump' }], sampleView());
    expect(a.activeVoices).toBe(1);
    expect(a.getDebugInfo().errors).toBe(0);
  });

  it('resumes a suspended context on unlock() and plays the UI sound requested in the same gesture', () => {
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    const a = new AudioEngine({ createContext: () => asCtx(ctx) });
    a.unlock(); // the fake resumes synchronously
    expect(ctx.resumeCalls).toBe(1);
    ctx.state = 'suspended';
    a.playUi('sortie'); // still suspended: remembered, not scheduled
    expect(a.activeVoices).toBe(0);
    a.handleEvents(allSamples(), sampleView()); // game sounds are not queued
    expect(a.activeVoices).toBe(0);
    a.unlock();
    expect(a.activeVoices).toBe(1);
    expect(a.getDebugInfo().errors).toBe(0);
  });

  it('does nothing while the context is suspended or closed, and never throws', () => {
    const { engine, ctx } = liveEngine();
    ctx.state = 'suspended';
    engine.handleEvents(allSamples(), sampleView());
    engine.update({ ...sampleView(), player: { ...sampleView().player, horizontalMode: 'glide', flying: true } }, 0.016, true);
    expect(engine.activeVoices).toBe(0);
    ctx.state = 'closed';
    expect(() => {
      engine.handleEvents(allSamples(), sampleView());
      engine.update(sampleView(), 0.016, true);
      engine.update(sampleView(), 0.016, false);
      engine.playUi('click');
      engine.setVolume(0.2);
      engine.setMuted(true);
      engine.stopAll();
      engine.dispose();
    }).not.toThrow();
    expect(engine.getDebugInfo().errors).toBe(0);
  });

  it('tolerates missing / broken simulation fields', () => {
    const { engine } = liveEngine();
    const broken: unknown[] = [
      null,
      undefined,
      {},
      { player: null, camera: null, lock: null, enemyById: null },
      { player: {}, camera: {}, lock: {} },
      { player: { vel: { x: NaN, y: NaN, z: NaN }, hp: NaN, en: NaN }, camera: { pos: { x: NaN, y: 0, z: Infinity }, yaw: NaN } },
      { time: 'x', player: { horizontalMode: 'glide', flying: true }, enemyById: new Map() },
    ];
    for (const sim of broken) {
      expect(() => {
        engine.handleEvents(allSamples(), sim as AudioSimView);
        engine.update(sim as AudioSimView, 0.016, true);
        engine.update(sim as AudioSimView, NaN, true);
        engine.update(sim as AudioSimView, -1, false);
      }).not.toThrow();
    }
    expect(() => {
      engine.handleEvents([null, undefined, {}, { type: 'nonsense' }, { type: 'land' }, { type: 'projectile-hit' }, { type: 'player-damaged' }] as unknown as SimEvent[], sampleView());
      engine.handleEvents(null as unknown as SimEvent[], sampleView());
      engine.playUi('bogus' as 'click');
      engine.setVolume(NaN);
      engine.setVolume(7);
    }).not.toThrow();
    expect(engine.volume).toBe(1);
    expect(engine.getDebugInfo().errors).toBe(0);
  });

  it('never writes to the events or the simulation it is given', () => {
    const { engine, ctx } = liveEngine();
    const view = deepFreeze(sampleView());
    const events = deepFreeze(allSamples());
    for (let i = 0; i < 30; i++) {
      engine.handleEvents(events, view);
      engine.update(view, 1 / 60, true);
      ctx.advance(1 / 60);
    }
    expect(engine.getDebugInfo().errors).toBe(0);
  });

  it('dispose() releases everything and closes the context it created', () => {
    const { engine, ctx } = liveEngine();
    engine.handleEvents(allSamples(), sampleView());
    engine.update({ ...sampleView(), player: { ...sampleView().player, horizontalMode: 'glide', flying: true, vel: { x: 30, y: 0, z: 0 } } }, 0.016, true);
    expect(engine.activeVoices).toBeGreaterThan(5);
    engine.dispose();
    expect(ctx.connected).toBe(0);
    expect(ctx.closeCalls).toBe(1);
    expect(engine.activeVoices).toBe(0);
    engine.handleEvents(allSamples(), sampleView());
    engine.unlock();
    expect(ctx.connected).toBe(0);
    expect(engine.getDebugInfo().state).toBe('disposed');
  });
});

// ───────────────────────────── event → sound mapping ─────────────────────────────

describe('event → sound mapping', () => {
  const record = (events: SimEvent[], view: AudioSimView = sampleView()): Array<{ id: SoundId; o: PlayOptions }> => {
    const out: Array<{ id: SoundId; o: PlayOptions }> = [];
    const st = createCueState();
    for (const e of events) dispatchEvent(e, view, { play: (id, o) => out.push({ id, o: { ...(o ?? {}) } }) }, st);
    return out;
  };
  const ids = (events: SimEvent[]): SoundId[] => record(events).map((r) => r.id);
  const samples = sampleEvents();

  it('documents every SimEvent type and only refers to sounds that exist', () => {
    expect(Object.keys(EVENT_SOUNDS).sort()).toEqual(Object.keys(samples).sort());
    const silent = Object.entries(EVENT_SOUNDS)
      .filter(([, v]) => v.startsWith('silent'))
      .map(([k]) => k)
      .sort();
    expect(silent).toEqual(['enemy-damaged', 'sector-entered']);
    for (const [type, list] of Object.entries(samples)) {
      const played = ids(list);
      for (const id of played) expect(SOUND_IDS).toContain(id);
      if (silent.includes(type)) expect(played).toEqual([]);
      else expect(played.length, type).toBeGreaterThan(0);
    }
  });

  it('maps each event to the designed sound', () => {
    expect(ids(samples['player-shot'])).toEqual(['mg', 'beam', 'missile-launch']);
    expect(ids(samples.beam)).toEqual(['beam-hit-enemy', 'beam-hit-world']);
    expect(ids(samples['fire-rejected'])).toEqual(['reject-nolock', 'reject-noen', 'reject-noammo']);
    expect(record(samples['weapon-switched']).map((r) => r.o.variant)).toEqual([0, 1, 2]);
    expect(record(samples.qb).map((r) => r.o.variant)).toEqual([0, 1]);
    expect(ids(samples['qb-rejected'])).toEqual(['qb-reject', 'qb-reject', 'qb-reject']);
    expect(ids(samples.glide)).toEqual(['glide-on', 'glide-off']); // the automatic one is left to the loop
    expect(ids(samples.jump)).toEqual(['jump']);
    expect(ids(samples['projectile-hit'])).toEqual(['hit-enemy', 'hit-world', 'explode-missile', 'explode-missile', 'bullet-world']);
    expect(ids(samples['projectile-expired'])).toEqual(['explode-missile']);
    expect(ids(samples['enemy-telegraph'])).toEqual(['telegraph-guard', 'telegraph-turret', 'telegraph-guard']);
    expect(ids(samples['enemy-shot'])).toEqual(['shot-guard', 'shot-turret']);
    expect(ids(samples['enemy-destroyed'])).toEqual(['explode-guard', 'explode-turret', 'explode-control']);
    expect(ids(samples['enemy-alerted'])).toEqual(['alert']);
    expect(ids(samples['player-damaged'])).toEqual(['damage', 'damage']);
    expect(ids(samples['barrier-opened'])).toEqual(['barrier-open']);
    expect(ids(samples['gate-opened'])).toEqual(['gate-open']);
    expect(ids(samples.cleared)).toEqual(['cleared']);
    expect(ids(samples.failed)).toEqual(['failed', 'failed']);
  });

  it('scales landings by speed and damage by amount, and alternates machine-gun shots', () => {
    const land = record(samples.land);
    expect(land.length).toBe(2); // 0.4 m/s is silent
    expect(land[0].o.intensity).toBeGreaterThan(0.2);
    expect(land[0].o.intensity).toBeLessThan(0.5);
    expect(land[1].o.intensity).toBe(1);
    expect(land[1].o.gain).toBeGreaterThan(land[0].o.gain as number);
    const dmg = record(samples['player-damaged']);
    expect(dmg[0].o.intensity).toBe(0);
    expect(dmg[1].o.intensity).toBe(1);
    expect(dmg[0].o.pos).toEqual({ x: -30, y: 2, z: -10 });
    const mg: SimEvent = samples['player-shot'][0];
    expect(record([mg, mg, mg, mg]).map((r) => r.o.variant)).toEqual([0, 1, 0, 1]);
  });

  it('places telegraphs at the enemy and passes the remaining telegraph time on', () => {
    const t = record(samples['enemy-telegraph']);
    expect(t[0].o.pos).toEqual({ x: 20, y: 1.3, z: -40 });
    expect(t[0].o.duration).toBe(ENEMIES.guard.telegraph);
    expect(t[1].o.pos).toEqual({ x: -35, y: 1.6, z: -60 });
    expect(t[1].o.duration).toBe(ENEMIES.turret.telegraph);
    expect(t[2].o.pos).toBeNull(); // unknown enemy: still a warning, centred
  });

  it('when a whole group warns / fires in one frame, the nearest enemies are the ones that are heard', () => {
    const { engine } = liveEngine();
    const plays = spyPlays(engine);
    const enemies = new Map<string, { pos: { x: number; y: number; z: number }; kind: string; alive: boolean }>();
    const telegraphs: SimEvent[] = [];
    const shots: SimEvent[] = [];
    // 12 guards on a line ahead of the camera, listed from the farthest (118 m) to the nearest (8 m)
    for (let i = 0; i < 12; i++) {
      const id = 'G' + i;
      const pos = { x: 0, y: 1.3, z: -(118 - i * 10) };
      enemies.set(id, { pos, kind: 'guard', alive: true });
      telegraphs.push({ type: 'enemy-telegraph', enemyId: id, duration: ENEMIES.guard.telegraph });
      shots.push({ type: 'enemy-shot', enemyId: id, kind: 'guard', muzzle: pos, dir: { x: 0, y: 0, z: 1 } });
    }
    const view: AudioSimView = { ...sampleView(), camera: { pos: { x: 0, y: 1.3, z: 0 }, yaw: 0 }, enemyById: enemies };
    engine.handleEvents(telegraphs, view);
    const heard = plays.opts.map((o) => -(o.pos as { z: number }).z).sort((a, b) => a - b);
    expect(heard).toEqual([8, 18, 28, 38]);
    plays.ids.length = 0;
    plays.opts.length = 0;
    engine.handleEvents(shots, view);
    expect(plays.opts.map((o) => -(o.pos as { z: number }).z).sort((a, b) => a - b)).toEqual([8, 18, 28, 38]);
    expect(engine.getDebugInfo().dropped).toBe(0); // everything that was selected really started
    // a normal frame (few events) is passed through untouched
    plays.ids.length = 0;
    engine.handleEvents(telegraphs.slice(0, 3), view);
    expect(plays.ids).toEqual(['telegraph-guard', 'telegraph-guard', 'telegraph-guard']);
    expect(engine.getDebugInfo().errors).toBe(0);
  });

  it('every sound of the bank is reachable (events, state cues or menu sounds)', () => {
    const fromEvents = new Set(ids(allSamples()));
    const fromState: SoundId[] = ['lock-on', 'lock-lost', 'brake', 'en-low', 'low-hp'];
    const fromUi: SoundId[] = ['ui-click', 'ui-sortie', 'ui-pause', 'ui-resume', 'ui-error'];
    const reachable = new Set<SoundId>([...fromEvents, ...fromState, ...fromUi]);
    expect(SOUND_IDS.filter((id) => !reachable.has(id))).toEqual([]);
  });
});

// ───────────────────────────── state-driven cues and loops ─────────────────────────────

describe('state-driven cues', () => {
  const make = (): { engine: AudioEngine; ctx: FakeContext; plays: { ids: SoundId[]; opts: PlayOptions[] }; view: ReturnType<typeof mutableView>; frame: (n?: number) => void } => {
    const { engine, ctx } = liveEngine();
    const plays = spyPlays(engine);
    const view = mutableView();
    const frame = (n = 1): void => {
      for (let i = 0; i < n; i++) {
        view.time += 1 / 60;
        engine.update(view, 1 / 60, true);
        ctx.advance(1 / 60);
      }
    };
    return { engine, ctx, plays, view, frame };
  };
  function mutableView() {
    return {
      time: 1,
      status: 'playing',
      camera: { pos: { x: 0, y: 6.5, z: 9.5 }, yaw: 0 },
      player: { pos: { x: 0, y: 2, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, hp: PLAYER.maxHp as number, en: 120, horizontalMode: 'walk', flying: false, braking: false },
      lock: { state: 'none', targetId: null as string | null },
      enemyById: new Map([['G01', { pos: { x: 0, y: 1.3, z: -30 }, kind: 'guard', alive: true }]]),
    };
  }

  it('confirms a completed lock and announces a lost one (but not when the target was destroyed)', () => {
    const { plays, view, frame } = make();
    frame(3);
    view.lock.state = 'acquiring';
    view.lock.targetId = 'G01';
    frame(3);
    expect(plays.ids).toEqual([]);
    view.lock.state = 'locked';
    frame(10);
    expect(plays.ids).toEqual(['lock-on']);
    view.lock.state = 'none';
    view.lock.targetId = null;
    frame(10);
    expect(plays.ids).toEqual(['lock-on', 'lock-lost']);
    view.lock.state = 'locked';
    view.lock.targetId = 'G01';
    frame(10);
    (view.enemyById.get('G01') as { alive: boolean }).alive = false;
    view.lock.state = 'none';
    view.lock.targetId = null;
    frame(10);
    expect(plays.ids).toEqual(['lock-on', 'lock-lost', 'lock-on']);
  });

  it('does not announce the state it finds on the first frame, after stopAll() or after a sim reset', () => {
    const { engine, plays, view, frame } = make();
    view.lock.state = 'locked';
    view.lock.targetId = 'G01';
    view.player.braking = true;
    view.player.vel.x = 30;
    view.player.en = 10;
    frame(5);
    expect(plays.ids).toEqual([]);
    view.player.en = 120;
    view.player.braking = false;
    view.lock.state = 'none';
    frame(2);
    plays.ids.length = 0;
    engine.stopAll();
    view.lock.state = 'locked';
    view.player.en = 5;
    frame(3);
    expect(plays.ids).toEqual([]);
    // simulation time jumps back (re-sortie without stopAll): adopt silently as well
    view.lock.state = 'none';
    view.player.en = 120;
    view.time = 0;
    frame(1);
    expect(plays.ids).toEqual([]);
  });

  it('plays the brake only when moving, scaled by speed', () => {
    const { plays, view, frame } = make();
    frame(2);
    view.player.braking = true;
    view.player.vel.x = 1;
    frame(2);
    expect(plays.ids).toEqual([]);
    view.player.braking = false;
    frame(30);
    view.player.braking = true;
    view.player.vel.x = 60;
    frame(2);
    expect(plays.ids).toEqual(['brake']);
    expect(plays.opts[0].intensity).toBe(1);
  });

  it('warns once when EN falls below the quick-boost cost', () => {
    const { plays, view, frame } = make();
    frame(2);
    view.player.en = PLAYER.qbCost + 1;
    frame(2);
    view.player.en = PLAYER.qbCost - 1;
    frame(20);
    expect(plays.ids).toEqual(['en-low']);
  });

  it('repeats the low-HP warning slowly below 30 % and faster below 15 %, and not at all above', () => {
    const { plays, view, frame } = make();
    frame(120);
    expect(plays.ids).toEqual([]);
    view.player.hp = PLAYER.maxHp * 0.29;
    frame(600); // 10 s
    const slow = plays.ids.filter((i) => i === 'low-hp').length;
    expect(slow).toBeGreaterThanOrEqual(5);
    expect(slow).toBeLessThanOrEqual(7);
    plays.ids.length = 0;
    view.player.hp = PLAYER.maxHp * 0.1;
    frame(600);
    const fast = plays.ids.filter((i) => i === 'low-hp').length;
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeLessThanOrEqual(10);
    plays.ids.length = 0;
    view.player.hp = PLAYER.maxHp * 0.31;
    frame(300);
    view.player.hp = 0;
    frame(300);
    expect(plays.ids).toEqual([]);
  });

  it('runs the glide loop only while gliding and the thrust loop only while flying', () => {
    const { engine, ctx, view, frame } = make();
    const baseline = ctx.connected;
    frame(10);
    expect(engine.activeVoices).toBe(0);
    view.player.horizontalMode = 'glide';
    view.player.vel.x = 22;
    frame(10);
    expect(engine.activeVoices).toBe(1);
    view.player.flying = true;
    frame(10);
    expect(engine.activeVoices).toBe(2);
    view.player.horizontalMode = 'walk';
    view.player.flying = false;
    frame(60); // silent for more than the idle time: both layers are torn down
    expect(engine.activeVoices).toBe(0);
    expect(ctx.connected).toBe(baseline);
    expect(ctx.running).toBe(0);
  });

  it('does not touch the audio graph while nothing changes (allocation-light update)', () => {
    const { ctx, view, frame } = make();
    view.player.horizontalMode = 'glide';
    view.player.vel.x = 22;
    view.player.flying = true;
    frame(30);
    const created = ctx.created;
    const calls = ctx.paramCalls;
    frame(600);
    expect(ctx.created).toBe(created);
    expect(ctx.paramCalls).toBe(calls);
  });
});

// ───────────────────────────── voices: cap, pause, stop, release ─────────────────────────────

describe('voice management', () => {
  it('every sound builds a valid graph that ends within its designed bound and is fully released', () => {
    const ctx = new FakeContext();
    const mixer = new Mixer(asCtx(ctx));
    const baseline = ctx.connected;
    const variants: PlayOptions[] = [
      {},
      { variant: 1, intensity: 0, duration: 0.01 },
      { variant: 2, intensity: 1, duration: 5 },
      { variant: 99, intensity: 0.5, duration: 0.2, pos: { x: 60, y: 3, z: 40 } },
    ];
    for (const id of SOUND_IDS) {
      for (const o of variants) {
        const t0 = ctx.currentTime;
        expect(mixer.play(id, o), id).toBe(true);
        expect(mixer.activeVoices).toBe(1);
        let latest = 0;
        for (const s of ctx.sources) {
          expect(s.startAt, id).toBeGreaterThanOrEqual(t0);
          expect(Number.isFinite(s.stopAt), `${id}: a source is never stopped`).toBe(true);
          if (s.stopAt > latest) latest = s.stopAt;
        }
        expect(latest - t0, id).toBeLessThanOrEqual(SOUNDS[id].maxSeconds + 0.005);
        ctx.advance(SOUNDS[id].maxSeconds + 0.1);
        expect(mixer.activeVoices, id).toBe(0);
        expect(ctx.connected, id).toBe(baseline);
        expect(ctx.running, id).toBe(0);
        expect(mixer.stats.liveNodes, id).toBe(0);
        ctx.advance(3); // past every throttle interval
      }
    }
    for (const id of Object.keys(LOOPS) as Array<keyof typeof LOOPS>) {
      mixer.setLoop(id, 1, 0.5);
      mixer.setLoop(id, 0.5, 1);
      expect(mixer.activeVoices).toBe(1);
      mixer.setLoop(id, 0, 0);
      ctx.advance(1);
      expect(mixer.activeVoices).toBe(0);
      expect(ctx.connected).toBe(baseline);
    }
  });

  it('keeps the voice count under the cap when flooded and returns to zero', () => {
    const { engine, ctx, baseline } = liveEngine();
    const fight = new SyntheticFight({ guards: 40, turrets: 20 });
    let max = 0;
    for (let i = 0; i < 600; i++) {
      // ten seconds, with a 0.5 s hitch every second (many events in one batch)
      const dt = i % 60 === 59 ? 0.5 : 1 / 60;
      const events: SimEvent[] = [...fight.step(dt), ...allSamples()];
      engine.handleEvents(events, fight.view);
      engine.update(fight.view, dt, true);
      max = Math.max(max, engine.activeVoices);
      ctx.advance(dt);
    }
    const info = engine.getDebugInfo();
    expect(max).toBeLessThanOrEqual(VOICE_CAP);
    expect(max).toBeGreaterThan(12);
    expect(info.dropped + info.stolen).toBeGreaterThan(100);
    expect(info.errors).toBe(0);
    engine.update(fight.view, 1 / 60, false);
    ctx.advance(4);
    expect(engine.activeVoices).toBe(0);
    expect(ctx.connected).toBe(baseline);
    expect(ctx.running).toBe(0);
    expect(engine.getDebugInfo().liveNodes).toBe(0);
  });

  it('respects the per-category limits', () => {
    const ctx = new FakeContext();
    const mixer = new Mixer(asCtx(ctx));
    mixer.setListener(0, 0, 0, 0);
    for (let i = 0; i < 40; i++) {
      mixer.play('explode-control', { pos: { x: 10 + i, y: 0, z: -20 } });
      expect(mixer.activeVoices).toBeLessThanOrEqual(CATEGORIES.explosion.max);
      ctx.advance(0.06);
    }
    expect(mixer.activeVoices).toBe(CATEGORIES.explosion.max);
    expect(mixer.stats.stolen + mixer.stats.dropped).toBe(40 - CATEGORIES.explosion.max);
  });

  it('a near explosion replaces a far one, never the other way round', () => {
    const ctx = new FakeContext();
    const mixer = new Mixer(asCtx(ctx));
    mixer.setListener(0, 0, 0, 0);
    for (let i = 0; i < CATEGORIES.explosion.max; i++) {
      expect(mixer.play('explode-turret', { pos: { x: 0, y: 0, z: -10 - i } })).toBe(true);
      ctx.advance(0.06);
    }
    const stolen = mixer.stats.stolen;
    expect(mixer.play('explode-turret', { pos: { x: 0, y: 0, z: -140 } })).toBe(false); // quieter than all that play
    expect(mixer.stats.stolen).toBe(stolen);
    ctx.advance(0.06);
    expect(mixer.play('explode-turret', { pos: { x: 0, y: 0, z: -3 } })).toBe(true); // louder: the weakest gives way
    expect(mixer.stats.stolen).toBe(stolen + 1);
    expect(mixer.activeVoices).toBe(CATEGORIES.explosion.max);
  });

  it('high-priority sounds get through a full mixer; low-priority ones are refused', () => {
    const ctx = new FakeContext();
    const mixer = new Mixer(asCtx(ctx));
    mixer.setListener(0, 0, 0, 0);
    const fill: SoundId[] = ['gate-open', 'barrier-open', 'explode-control', 'explode-turret', 'explode-guard', 'explode-missile', 'missile-launch', 'cleared', 'failed', 'ui-sortie', 'damage', 'low-hp', 'qb', 'land', 'brake', 'jump'];
    mixer.setLoop('glide', 1, 0.5); // loop layers count towards the cap
    let guard = 0;
    while (mixer.activeVoices < VOICE_CAP && guard++ < 400) {
      for (const id of fill) mixer.play(id, { pos: { x: 0, y: 0, z: -5 } });
      mixer.play('telegraph-turret', { pos: { x: 0, y: 0, z: -5 } });
      mixer.play('shot-turret', { pos: { x: 0, y: 0, z: -5 } });
      ctx.advance(0.031);
    }
    expect(mixer.activeVoices).toBe(VOICE_CAP);
    const dropped = mixer.stats.dropped;
    // 'alert' has the lowest priority of all categories: refused, nothing is cut for it
    const stolenBefore = mixer.stats.stolen;
    expect(mixer.play('alert', { pos: { x: 0, y: 0, z: -5 } })).toBe(false);
    expect(mixer.stats.dropped).toBe(dropped + 1);
    expect(mixer.stats.stolen).toBe(stolenBefore);
    // a menu sound has the highest priority: something else gives way
    expect(mixer.play('ui-click')).toBe(true);
    expect(mixer.activeVoices).toBe(VOICE_CAP);
    expect(mixer.stats.stolen).toBe(stolenBefore + 1);
    // a loop layer that starts while the mixer is full takes the place of the least important one-shot
    mixer.setLoop('thrust', 1, 0.5);
    expect(mixer.activeVoices).toBe(VOICE_CAP);
    expect(mixer.stats.stolen).toBe(stolenBefore + 2);
  });

  it('plays centred when StereoPannerNode is missing, and cleans up when a voice cannot be built', () => {
    const ctx = new FakeContext();
    (ctx as unknown as { createStereoPanner: unknown }).createStereoPanner = undefined;
    const mixer = new Mixer(asCtx(ctx));
    mixer.setListener(0, 0, 0, 0);
    const baseline = ctx.connected;
    expect(mixer.play('shot-turret', { pos: { x: 30, y: 0, z: 0 } })).toBe(true);
    ctx.advance(1);
    expect(mixer.activeVoices).toBe(0);
    expect(ctx.connected).toBe(baseline);

    // a browser that fails in the middle of a patch: the engine swallows it and nothing keeps running
    const broken = new FakeContext();
    const engine = new AudioEngine({ createContext: () => asCtx(broken), volume: 1 });
    engine.unlock();
    const base = broken.connected;
    let calls = 0;
    const original = broken.createBiquadFilter;
    broken.createBiquadFilter = () => {
      if (++calls % 2 === 0) throw new Error('out of nodes');
      return original();
    };
    expect(() => engine.handleEvents(allSamples(), sampleView())).not.toThrow();
    expect(engine.getDebugInfo().errors).toBeGreaterThan(0);
    broken.advance(4);
    expect(engine.activeVoices).toBe(0);
    expect(broken.connected).toBe(base);
    expect(broken.running).toBe(0);
  });

  it('throttles identical sounds: delayed a little, then dropped', () => {
    const ctx = new FakeContext();
    const mixer = new Mixer(asCtx(ctx));
    const starts: number[] = [];
    for (let i = 0; i < 12; i++) {
      const before = ctx.sources.length;
      if (mixer.play('shot-guard')) starts.push(ctx.sources[before].startAt);
    }
    // a volley of identical shots in one frame becomes a short flam (20 ms steps); the rest is dropped
    expect(starts.length).toBe(4);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeCloseTo(SOUNDS['shot-guard'].minInterval, 6);
    expect(starts[starts.length - 1] - starts[0]).toBeLessThanOrEqual(SOUNDS['shot-guard'].maxDelay + 1e-9);
    expect(mixer.stats.dropped).toBe(8);
  });

  it('sustained fire keeps an even rhythm on the audio clock and catches up after a frame hitch', () => {
    const ctx = new FakeContext();
    const mixer = new Mixer(asCtx(ctx));
    const interval = SOUNDS.mg.minInterval;
    const frame = 0.016;
    const starts: number[] = [];
    const shotTimes: number[] = [];
    let nextShot = 0.05;
    let simTime = 0;
    const run = (frames: number): void => {
      for (let i = 0; i < frames; i++) {
        simTime += frame;
        ctx.advance(frame);
        while (nextShot <= simTime) {
          const before = ctx.sources.length;
          expect(mixer.play('mg')).toBe(true); // no shot is ever dropped
          starts.push(ctx.sources[before].startAt);
          shotTimes.push(nextShot);
          nextShot += interval;
        }
      }
    };
    const lag = (i: number): number => starts[i] - shotTimes[i];
    // 5 s at 62.5 fps: the shot events arrive 96 / 112 ms apart …
    run(313);
    const n1 = starts.length;
    expect(n1).toBeGreaterThan(45);
    // … but the sounds stay within 2.5 ms of the fire interval, and at most a frame late
    for (let i = 5; i < n1; i++) {
      expect(Math.abs(starts[i] - starts[i - 1] - interval)).toBeLessThan(0.0025);
      expect(lag(i)).toBeLessThanOrEqual(frame + 0.0045);
      expect(lag(i)).toBeGreaterThan(0);
    }
    // a 200 ms hitch: nothing is delivered, then the shots of the gap arrive in one batch
    simTime += 0.2 - frame;
    ctx.advance(0.2 - frame);
    run(1);
    expect(lag(n1)).toBeGreaterThan(0.15); // the first sound after the hitch is late (it cannot be otherwise) …
    run(125); // … 2 s later the lag is back inside the snap window …
    expect(lag(starts.length - 1)).toBeLessThanOrEqual(0.045);
    run(625); // … and after 10 more seconds it is back at one frame
    expect(lag(starts.length - 1)).toBeLessThanOrEqual(frame + 0.0045);
    // catching up never squeezed two shots closer than 85 % of the fire interval
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(interval * 0.85 - 1e-9);
  });

  it('pause: every game voice and loop is stopped within 150 ms; menu sounds and the next sortie are not affected', () => {
    const { engine, ctx, baseline } = liveEngine();
    const view = { ...sampleView(), player: { ...sampleView().player, horizontalMode: 'glide', flying: true, vel: { x: 40, y: 0, z: 0 } } };
    // (the result jingles are menu-bus sounds by design; a sortie that has ended cannot be paused)
    engine.handleEvents(allSamples().filter((e) => e.type !== 'cleared' && e.type !== 'failed'), view);
    engine.update(view, 1 / 60, true);
    ctx.advance(0.05);
    expect(engine.activeVoices).toBeGreaterThan(8);
    const pausedAt = ctx.currentTime;
    engine.update(view, 1 / 60, false); // pause (sim.status is still 'playing')
    engine.playUi('pause');
    for (const s of ctx.sources) {
      const ui = s.startAt >= pausedAt; // only the pause blip was created after the pause
      if (!ui) expect(s.stopAt).toBeLessThanOrEqual(pausedAt + 0.15);
    }
    expect(engine.activeVoices).toBe(1); // the menu sound
    // game sounds requested while paused are refused …
    const mixer = engine.getMixer() as Mixer;
    expect(mixer.play('qb')).toBe(false);
    expect(mixer.play('ui-click')).toBe(true);
    ctx.advance(0.15);
    expect(ctx.running).toBeLessThanOrEqual(4); // only the two menu sounds are left
    ctx.advance(1);
    expect(engine.activeVoices).toBe(0);
    expect(ctx.connected).toBe(baseline);
    // … and everything works again after resume
    engine.update(view, 1 / 60, true);
    engine.handleEvents([{ type: 'jump' }], view);
    expect(engine.activeVoices).toBeGreaterThanOrEqual(2); // jump + loops
    expect(engine.getDebugInfo().errors).toBe(0);
  });

  it('events arriving before the first update() of a resumed game are not lost', () => {
    const { engine, ctx } = liveEngine();
    engine.update(sampleView(), 1 / 60, false);
    ctx.advance(0.5);
    engine.handleEvents([{ type: 'jump' }], sampleView());
    expect(engine.activeVoices).toBe(1);
  });

  it('end of the sortie: loops fade, the last sounds and the result jingle ring out', () => {
    const { engine, ctx } = liveEngine();
    const view = { ...sampleView(), player: { ...sampleView().player, horizontalMode: 'glide', vel: { x: 40, y: 0, z: 0 } } };
    engine.update(view, 1 / 60, true);
    engine.handleEvents([{ type: 'enemy-destroyed', enemyId: 'T01', kind: 'turret', pos: { x: 0, y: 2, z: -20 }, isGateControl: true }, { type: 'cleared' }], view);
    const ended = { ...view, status: 'cleared' };
    engine.update(ended, 1 / 60, false);
    ctx.advance(0.3);
    engine.update(ended, 1 / 60, false);
    expect(engine.activeVoices).toBe(3); // explosion + jingle + the glide layer still fading
    ctx.advance(0.6);
    engine.update(ended, 1 / 60, false);
    expect(engine.activeVoices).toBe(2); // the loop is gone, nothing was cut
    ctx.advance(3);
    expect(engine.activeVoices).toBe(0);
  });

  it('stopAll() silences everything at once and leaves no node behind', () => {
    const { engine, ctx, baseline } = liveEngine();
    const view = { ...sampleView(), player: { ...sampleView().player, horizontalMode: 'glide', flying: true, vel: { x: 40, y: 0, z: 0 } } };
    engine.handleEvents(allSamples(), view);
    engine.update(view, 1 / 60, true);
    engine.playUi('click');
    expect(engine.activeVoices).toBeGreaterThan(8);
    const at = ctx.currentTime;
    engine.stopAll();
    expect(engine.activeVoices).toBe(0);
    for (const s of ctx.sources) expect(s.stopAt).toBeLessThanOrEqual(at + 0.05);
    ctx.advance(0.1);
    engine.update(view, 1 / 60, false);
    expect(ctx.connected).toBe(baseline);
    expect(ctx.running).toBe(0);
    // a sound requested right after stopAll() (the sortie click) plays normally
    engine.stopAll();
    engine.playUi('sortie');
    expect(engine.activeVoices).toBe(1);
  });

  it('muted: no voice is created; unmuting brings sound back', () => {
    const { engine, ctx } = liveEngine();
    engine.setMuted(true);
    const created = ctx.created;
    engine.handleEvents(allSamples(), sampleView());
    engine.playUi('click');
    engine.update({ ...sampleView(), player: { ...sampleView().player, horizontalMode: 'glide', vel: { x: 40, y: 0, z: 0 } } }, 1 / 60, true);
    expect(ctx.created).toBe(created);
    expect(engine.activeVoices).toBe(0);
    engine.setMuted(false);
    engine.handleEvents([{ type: 'jump' }], sampleView());
    expect(engine.activeVoices).toBe(1);
  });

  it('frees voices through onended even when nobody calls update()', () => {
    const { engine, ctx, baseline } = liveEngine();
    const mixer = engine.getMixer() as Mixer;
    engine.handleEvents(allSamples(), sampleView());
    expect(ctx.connected).toBeGreaterThan(baseline + 50);
    for (let i = 0; i < 400; i++) ctx.advance(0.01); // 4 s of audio time, no engine call at all
    expect(ctx.connected).toBe(baseline);
    expect(mixer.stats.liveNodes).toBe(0);
  });

  it('ten simulated minutes of heavy fighting leave nothing behind', () => {
    const { engine, ctx, baseline } = liveEngine();
    const fight = new SyntheticFight();
    let max = 0;
    let maxNodes = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 600 * 60; i++) {
      engine.handleEvents(fight.step(dt), fight.view);
      engine.update(fight.view, dt, true);
      if ((i & 7) === 0) {
        max = Math.max(max, engine.activeVoices);
        maxNodes = Math.max(maxNodes, ctx.connected - baseline);
      }
      ctx.advance(dt);
    }
    const info = engine.getDebugInfo();
    expect(info.errors).toBe(0);
    expect(info.started).toBeGreaterThan(20000);
    expect(max).toBeLessThanOrEqual(VOICE_CAP);
    expect(maxNodes).toBeLessThan(700);
    expect(ctx.sources.length).toBeLessThan(400); // ended sources are not kept
    engine.update(fight.view, dt, false);
    ctx.advance(4);
    expect(engine.activeVoices).toBe(0);
    expect(ctx.connected).toBe(baseline);
    expect(ctx.running).toBe(0);
  });
});

// ───────────────────────────── a real simulation ─────────────────────────────

describe('the call sequence of src/app.ts (garage → sortie → pause → resume → result → garage)', () => {
  const gliding = (): AudioSimView => ({ ...sampleView(), player: { ...sampleView().player, horizontalMode: 'glide', vel: { x: 22, y: 0, z: 0 } } }) as AudioSimView;
  /** Sources that are started and have no stop time: the continuous layers. */
  const sustained = (ctx: FakeContext): number => ctx.sources.filter((s) => s.startAt >= 0 && !s.ended && s.stopAt === Infinity).length;

  it('one context for the whole session; game sound only while playing; nothing left behind', () => {
    const ctx = new FakeContext();
    let made = 0;
    const engine = new AudioEngine({
      createContext: () => {
        made++;
        return asCtx(ctx);
      },
      muted: false,
    });
    // garage, before any click: every frame calls update(sim, dt, false) — nothing exists, nothing is created
    engine.update(sampleView(), 1 / 60, false);
    engine.playUi('click');
    engine.setMuted(true); // (M in the garage: only the flag)
    engine.setMuted(false);
    expect([made, ctx.created]).toEqual([0, 1]); // (1 = the fake destination node)
    expect(engine.getDebugInfo().state).toBe('idle');

    // click on 出撃: unlock() in the click; later (pointer lock) prepareSortie() + enterPlaying('sortie')
    engine.unlock();
    const baseline = ctx.connected;
    engine.stopAll();
    engine.update(gliding(), 0, true);
    engine.playUi('sortie');
    expect(made).toBe(1);
    expect(engine.activeVoices).toBe(2); // the sortie cue + the glide layer
    // playing frames: events, then update
    for (let i = 0; i < 60; i++) {
      // 1 s of playing frames: the sortie cue (a menu sound, ≈ 0.8 s) ends, the glide layer stays
      engine.update(gliding(), 1 / 60, true);
      ctx.advance(1 / 60);
    }
    expect(engine.activeVoices).toBe(1);
    engine.handleEvents([{ type: 'jump' }, { type: 'qb', dir: { x: 0, z: -1 }, airborne: false }], gliding());
    engine.update(gliding(), 1 / 60, true);
    ctx.advance(0.05);
    expect(sustained(ctx)).toBeGreaterThan(0);
    expect(engine.activeVoices).toBe(3); // jump + quick boost + the glide layer

    // pause(): update(sim, 0, false) at the transition, then the menu blip
    const pausedAt = ctx.currentTime;
    engine.update(gliding(), 0, false);
    engine.playUi('pause');
    expect(sustained(ctx)).toBe(0);
    for (const s of ctx.sources) if (s.startAt < pausedAt) expect(s.stopAt).toBeLessThanOrEqual(pausedAt + 0.15);
    engine.handleEvents([], gliding());
    for (let i = 0; i < 120; i++) {
      // 2 s of paused frames
      engine.update(gliding(), 1 / 60, false);
      ctx.advance(1 / 60);
    }
    expect(engine.activeVoices).toBe(0);
    expect(ctx.running).toBe(0);
    expect(ctx.connected).toBe(baseline);

    // second start click (再開): unlock() again — no second context; enterPlaying('resume')
    engine.unlock();
    engine.update(gliding(), 0, true);
    engine.playUi('resume');
    expect(made).toBe(1);
    expect(sustained(ctx)).toBeGreaterThan(0);

    // the sortie ends: the event is handled in the playing frame, then finishSortie() → update(sim, 0, false)
    engine.handleEvents([{ type: 'failed', reason: 'fell' }], gliding());
    const ended = { ...gliding(), status: 'failed' } as AudioSimView;
    engine.update(ended, 0, false);
    for (let i = 0; i < 60; i++) {
      engine.update(ended, 1 / 60, false);
      ctx.advance(1 / 60);
    }
    expect(sustained(ctx)).toBe(0); // no loop left after 1 s …
    expect(engine.activeVoices).toBe(1); // … only the result cue rings
    for (let i = 0; i < 180; i++) {
      engine.update(ended, 1 / 60, false);
      ctx.advance(1 / 60);
    }
    expect(engine.activeVoices).toBe(0); // and it is short

    // 再出撃 from the result screen with the cue still ringing, then back to the garage
    engine.handleEvents([{ type: 'failed', reason: 'fell' }], gliding());
    engine.unlock();
    engine.stopAll();
    engine.update(gliding(), 0, true);
    engine.playUi('sortie');
    ctx.advance(0.1);
    expect(engine.activeVoices).toBe(2);
    engine.update(gliding(), 0, false); // pause()
    engine.stopAll(); // onGarage()
    engine.update(sampleView(), 0, false); // the reset simulation, state 'garage'
    ctx.advance(0.2);
    engine.update(sampleView(), 1 / 60, false);
    expect(engine.activeVoices).toBe(0);
    expect(ctx.running).toBe(0);
    expect(ctx.connected).toBe(baseline);
    expect([made, ctx.closeCalls, engine.getDebugInfo().errors]).toEqual([1, 0, 0]);
  });

  it('starting muted (a remembered choice) creates no voice until M un-mutes', () => {
    const ctx = new FakeContext();
    const engine = new AudioEngine({ createContext: () => asCtx(ctx), muted: true });
    expect(engine.muted).toBe(true);
    engine.unlock();
    const created = ctx.created;
    engine.stopAll();
    engine.update(gliding(), 0, true);
    engine.playUi('sortie');
    engine.handleEvents(allSamples(), gliding());
    engine.update(gliding(), 1 / 60, true);
    expect(ctx.created).toBe(created);
    expect(engine.activeVoices).toBe(0);
    engine.setMuted(false);
    engine.playUi('click');
    engine.update(gliding(), 1 / 60, true);
    expect(engine.activeVoices).toBe(2); // the confirmation blip + the glide layer
    expect(engine.getDebugInfo().errors).toBe(0);
  });
});

describe('driven by a real Sim', () => {
  it('handles every event of a won and of a lost fight; the union covers all SimEvent types', () => {
    const seen: Record<string, number> = {};
    const outcomes: string[] = [];
    for (const mode of ['win', 'lose'] as const) {
      const { engine, ctx, baseline } = liveEngine();
      const plays = spyPlays(engine);
      const fight = new RealFight(mode);
      const dt = 1 / 60;
      let max = 0;
      for (let i = 0; i < 60 * 60 && !fight.finished; i++) {
        const before = buildSnapshot(fight.sim, 'playing');
        const events = fight.step(dt);
        const after = JSON.stringify(buildSnapshot(fight.sim, 'playing'));
        engine.handleEvents(events, fight.sim);
        engine.update(fight.sim, dt, true);
        // the engine only reads: the simulation is bit-identical after the audio calls
        expect(JSON.stringify(buildSnapshot(fight.sim, 'playing'))).toBe(after);
        expect(before).toBeTruthy();
        max = Math.max(max, engine.activeVoices);
        ctx.advance(dt);
      }
      outcomes.push(fight.sim.status);
      for (const [k, v] of Object.entries(fight.counts)) seen[k] = (seen[k] ?? 0) + v;
      expect(engine.getDebugInfo().errors, mode).toBe(0);
      expect(max).toBeLessThanOrEqual(VOICE_CAP);
      expect(plays.ids).toContain(mode === 'win' ? 'cleared' : 'failed');
      // result screen
      engine.update(fight.sim, dt, false);
      ctx.advance(4);
      engine.update(fight.sim, dt, false);
      expect(engine.activeVoices).toBe(0);
      expect(ctx.connected).toBe(baseline);
    }
    expect(outcomes).toEqual(['cleared', 'failed']);
    const missing = Object.keys(EVENT_SOUNDS).filter((t) => !seen[t]);
    expect(missing, `event types never produced by the two fights: ${missing.join(', ')}`).toEqual([]);
  });
});

// ───────────────────────────── pure parts ─────────────────────────────

describe('stereo placement', () => {
  const L = (yaw = 0): Listener => ({ x: 0, y: 0, z: 0, yaw, valid: true });
  const P = (): Placement => ({ pan: 0, gain: 1, cutoff: 0, distance: 0 });

  it('pans to the side the source is on, relative to the camera yaw', () => {
    // yaw 0 looks along -Z: +X is to the right
    expect(place(L(0), 30, 0, 0, 'world', P()).pan).toBeCloseTo(MAX_PAN, 6);
    expect(place(L(0), -30, 0, 0, 'world', P()).pan).toBeCloseTo(-MAX_PAN, 6);
    expect(place(L(0), 0, 0, -30, 'world', P()).pan).toBeCloseTo(0, 6);
    expect(place(L(0), 0, 0, 30, 'world', P()).pan).toBeCloseTo(0, 6);
    // positive yaw turns left: looking along -X, the old "ahead" (-Z) is now to the right
    expect(place(L(Math.PI / 2), 0, 0, -30, 'world', P()).pan).toBeCloseTo(MAX_PAN, 6);
    expect(place(L(Math.PI / 2), -30, 0, 0, 'world', P()).pan).toBeCloseTo(0, 6);
    expect(place(L(-Math.PI / 2), 0, 0, -30, 'world', P()).pan).toBeCloseTo(-MAX_PAN, 6);
    // 45° to the right
    expect(place(L(0), 20, 0, -20, 'world', P()).pan).toBeCloseTo(MAX_PAN * Math.SQRT1_2, 6);
  });

  it('flattens the pan for sources overhead and right at the listener', () => {
    expect(Math.abs(place(L(0), 1, 40, 0, 'world', P()).pan)).toBeLessThan(0.05);
    expect(Math.abs(place(L(0), 0.5, 0, 0, 'world', P()).pan)).toBeLessThan(0.15);
  });

  it('attenuates with distance, monotonically, by the law of each class', () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(35)).toBeCloseTo(0.5, 6);
    let prev = 2;
    for (let d = 0; d <= 260; d += 5) {
      const g = rolloffGain('world', d);
      expect(g).toBeLessThanOrEqual(prev);
      expect(g).toBeGreaterThanOrEqual(0);
      prev = g;
    }
    expect(rolloffGain('world', 250)).toBe(0);
    // telegraphs stay readable over the whole enemy weapon range
    expect(rolloffGain('warning', ENEMIES.turret.range)).toBeGreaterThanOrEqual(0.38);
    expect(rolloffGain('warning', 10)).toBeGreaterThan(rolloffGain('warning', 60));
    expect(rolloffGain('near', 30)).toBeLessThan(rolloffGain('world', 30));
    expect(rolloffGain('event', 100)).toBeGreaterThan(0.45);
    expect(rolloffGain('feedback', 120)).toBeGreaterThan(0.6);
    expect(rolloffGain('pan', 500)).toBe(1);
  });

  it('dulls sources behind the camera and far away', () => {
    const front = place(L(0), 0, 0, -20, 'world', P()).cutoff;
    const back = place(L(0), 0, 0, 20, 'world', P()).cutoff;
    const far = place(L(0), 0, 0, -120, 'world', P()).cutoff;
    const side = place(L(0), 60, 0, 0, 'world', P()).cutoff;
    const backSide = place(L(0), 30, 0, 30, 'world', P()).cutoff;
    expect(front).toBe(OPEN_CUTOFF);
    expect(far).toBe(OPEN_CUTOFF); // no filter node for anything in front of the camera
    expect(side).toBe(OPEN_CUTOFF);
    expect(back).toBeLessThan(2500);
    expect(backSide).toBeGreaterThan(back);
    expect(backSide).toBeLessThan(OPEN_CUTOFF);
    expect(place(L(0), 0, 0, 20, 'pan', P()).cutoff).toBe(OPEN_CUTOFF);
    // a warning behind the camera keeps its 1-2 kHz chirp: never filtered below BEHIND_WARNING_CUTOFF
    expect(place(L(0), 0, 0, 20, 'warning', P()).cutoff).toBe(BEHIND_WARNING_CUTOFF);
    expect(place(L(0), 0, 0, 119, 'warning', P()).cutoff).toBe(BEHIND_WARNING_CUTOFF);
    expect(BEHIND_WARNING_CUTOFF).toBeGreaterThanOrEqual(3000);
  });

  it('never produces NaN', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const a = place(L(0), bad, 0, 0, 'world', P());
      const b = place(L(bad), 10, 0, 0, 'world', P());
      for (const r of [a, b]) for (const v of [r.pan, r.gain, r.cutoff, r.distance]) expect(Number.isFinite(v)).toBe(true);
    }
    const invalid = place({ x: 0, y: 0, z: 0, yaw: 0, valid: false }, 50, 0, 0, 'world', P());
    expect(invalid.pan).toBe(0);
    expect(invalid.gain).toBe(1);
    const here = place(L(0), 0, 0, 0, 'world', P());
    expect(here.pan).toBe(0);
    expect(here.gain).toBe(1);
  });
});

describe('master chain maths', () => {
  it('the soft clipper is the identity below the knee and never exceeds the ceiling', () => {
    for (let x = -CLIP_KNEE; x <= CLIP_KNEE; x += 0.05) expect(softClip(x)).toBe(x);
    let prev = -Infinity;
    for (let x = -50; x <= 50; x += 0.01) {
      const y = softClip(x);
      expect(Math.abs(y)).toBeLessThanOrEqual(CEILING);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
    expect(softClip(100)).toBeCloseTo(CEILING, 9);
    expect(softClip(-0.8)).toBeCloseTo(-softClip(0.8), 12);
    expect(CEILING).toBeLessThanOrEqual(0.95);
  });

  it('predicts the make-up gain of a DynamicsCompressorNode (value measured in Chromium)', () => {
    // threshold -16 dB, knee 12 dB, ratio 5 → 1.778 measured with a -40 dBFS tone in headless Chromium
    expect(compressorMakeup(-16, 12, 5)).toBeCloseTo(1.778, 2);
    expect(compressorMakeup(0, 0, 1)).toBeCloseTo(1, 6);
    expect(compressorMakeup(-24, 30, 12)).toBeGreaterThan(1);
  });
});

describe('noise and patches', () => {
  it('noise buffers are zero-mean, level-normalised, below full scale and seamless', () => {
    const target = { white: 0.4, pink: 0.25, brown: 0.3, crackle: 0.12 } as const;
    for (const kind of ['white', 'pink', 'brown', 'crackle'] as const) {
      const n = generateNoise(kind, 48000, 1);
      expect(n.length).toBe(48000);
      let sum = 0;
      let sq = 0;
      let peak = 0;
      let step = 0;
      for (let i = 0; i < n.length; i++) {
        sum += n[i];
        sq += n[i] * n[i];
        peak = Math.max(peak, Math.abs(n[i]));
        if (i > 0) step = Math.max(step, Math.abs(n[i] - n[i - 1]));
      }
      expect(Math.abs(sum / n.length)).toBeLessThan(1e-6);
      expect(peak).toBeLessThanOrEqual(0.981);
      if (peak < 0.979) expect(Math.sqrt(sq / n.length)).toBeCloseTo(target[kind], 3);
      // the wrap-around step is no larger than the steps inside the buffer
      expect(Math.abs(n[0] - n[n.length - 1])).toBeLessThanOrEqual(step);
      // deterministic
      expect(Array.from(generateNoise(kind, 48000, 0.01))).toEqual(Array.from(generateNoise(kind, 48000, 0.01)));
    }
  });

  it('makeRandom is uniform in [0, 1) and deterministic', () => {
    const a = makeRandom(7);
    const b = makeRandom(7);
    let sum = 0;
    for (let i = 0; i < 10000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 10000).toBeGreaterThan(0.47);
    expect(sum / 10000).toBeLessThan(0.53);
  });

  it('Patch envelopes end at exactly zero and report the end of the voice', () => {
    const ctx = new FakeContext();
    const out = ctx.createGain();
    const patch = new Patch(asCtx(ctx), new NoiseBank(asCtx(ctx)), 2, out as unknown as AudioNode, makeRandom(1));
    const g = patch.gain();
    expect(patch.perc(g.gain, 0.1, 0.5, 0.01, 0.2)).toBeCloseTo(0.313, 6);
    expect(patch.hold(g.gain, 0.5, 0.2, 0.6, 0.01, 0.1, 0.05)).toBeCloseTo(0.66, 6);
    patch.osc('sine', 440, 0, 0.9);
    patch.noise('white');
    patch.finish(0.5); // shorter than the explicit stop: the voice still ends with its last source
    expect(patch.end).toBeCloseTo(2.9, 9);
    expect(patch.tail).not.toBeNull();
    for (const s of ctx.sources) expect(s.stopAt).toBeLessThanOrEqual(2.9 + 1e-9);
    expect(() => patch.perc(g.gain, 0, 0, 0, 0)).not.toThrow();
    expect(() => patch.glide(g.gain, 0, 0, -5, 0)).not.toThrow();
  });
});
