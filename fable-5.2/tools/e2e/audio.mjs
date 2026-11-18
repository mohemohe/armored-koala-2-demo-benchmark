#!/usr/bin/env node
/**
 * Sound wiring of the application (src/app.ts ↔ src/audio): is sound really produced, only after a user
 * gesture, never behind a menu, and never at the price of the game?
 *
 *   AK2_URL=http://127.0.0.1:5190/ node tools/e2e/audio.mjs [--only=u,v,w,x,x2,z]
 *
 * Nobody can LISTEN in this environment (headless Chromium, no audio device). What can be observed is the
 * WebAudio graph the page builds and the samples that reach its output. Everything below is test-side
 * instrumentation injected with addInitScript before the page's own scripts (see audioProbeInit): the shipped
 * page has no audio hook and exposes nothing but the read-only window.__AK2__.getSnapshot().
 *
 *   - the AudioContext constructor is wrapped: how many contexts exist, when and inside which event each one
 *     was created (`window.event`, `navigator.userActivation`)
 *   - AudioScheduledSourceNode / AudioBufferSourceNode `start` and `stop` are wrapped: sources started, sources
 *     sounding now, sources running without a scheduled stop (= the continuous glide / thrust layers)
 *   - AudioNode `connect` / `disconnect` are wrapped: the master gain (the node that feeds the destination),
 *     the game bus (the gain in front of the 24 Hz high-pass) and the loop layers (gains created silent on
 *     the game bus) are recognised by their place in the graph; AudioParam writes to master / bus are logged
 *   - a test-side AudioWorklet meter is connected to the master node and counts EVERY sample that leaves it
 *     (samples of all channels, non-zero samples, peak, RMS per ≈ 43 ms window, stamped with the context
 *     time): "silent" below means the output samples are zero, not that some counter says so
 *   - requestAnimationFrame can be held back (a hidden tab renders no frames)
 *   - the app's sound toast is watched with a MutationObserver: each time it appears, its text, its rectangle
 *     and the rectangles of the HUD blocks at the top of the display area (the two top panels, the gate
 *     banner and the event messages at the top centre) are recorded at that very moment — a slow frame
 *     cannot hide the toast from the test, and "covers no HUD block" is a statement about those rectangles
 *   - fault injection: no AudioContext at all, a constructor that throws, a context whose graph cannot be
 *     built, a context that stays suspended and refuses resume()
 *
 * Sections (each opens its own page):
 *   u  shipped page: no AudioContext before the first start click (not after other clicks, not after M);
 *      the 出撃 click creates exactly one, inside the click; machine-gun fire and a quick boost start sources
 *      and the output carries signal; the glide layer runs while gliding and is torn down after a brake
 *   v  (same page) pause: nothing starts during several seconds, loop layers gone, game bus at 0, output
 *      samples zero, snapshot frozen; resume → sound again; M → master gain 0 and silent output while firing,
 *      text "音声 OFF [M]" in toast / pause menu / garage, one toggle per physical press, choice remembered;
 *      none of the toasts shown while playing covers a HUD block
 *   w  mini stage, scripted lock + virtual clock: the same scripted sortie gives a byte-identical snapshot
 *      with working audio, without AudioContext, with a throwing constructor, with an unbuildable graph and
 *      with a context that refuses to resume — and no console error in any of them
 *   z  mini stage: a pause with NO rendered frame (rAF held back, as in a hidden tab) still silences the
 *      fight at once
 *   x  mini stage, really played: failed (fell while gliding) and cleared (through the gate while gliding):
 *      a result cue sounds and ends, no loop is left running, nothing starts on the result screen; re-sortie
 *      and garage are silent and no second AudioContext is ever created; M pressed while the gate banner and
 *      the messages of the sixth control turret are on screen: the toast covers none of them
 *   x2 mini stage at 1280×720 (the reference size, where that stack grows into the place of the sound toast):
 *      the toast is shown below the stack and returns to its place when the messages are gone
 *
 * Wall-clock waits are used on purpose here: sound runs in real time whatever the frame rate.
 */
import * as L from './lib.mjs';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const only = arg('only') ? new Set(arg('only').split(',')) : null;
const want = (id) => !only || only.has(id);
const W = 800;
const H = 450;
/** Output below this peak (−120 dBFS) counts as silence; the measured peak and the non-zero count are reported. */
const SILENT_PEAK = 1e-6;
/** Master gain of the default volume: 0.7 on the squared taper (src/audio/engine.ts DEFAULT_VOLUME). */
const DEFAULT_MASTER = 0.7 * 0.7;

// ───────────────────────────── test-side probe (runs IN THE PAGE before its own scripts) ─────────────────────────────
function audioProbeInit(opts) {
  const P = (window.__e2eAudio = {
    fault: opts.fault || 'none',
    contexts: [],
    ctx: null,
    started: 0,
    sources: [],
    master: null,
    gameBus: null,
    loopGains: [],
    paramLog: [],
    resumeCalls: 0,
    meter: { ready: false, error: null, windows: [] },
    frames: 0,
    lastTs: -1,
    hold: false,
    toasts: [],
    toastGeom: [],
  });
  const appState = () => {
    try {
      return window.__AK2__ ? window.__AK2__.getSnapshot().state : '?';
    } catch {
      return '?';
    }
  };

  // ── rendered frames: counter + a switch that holds them back (a hidden tab renders none) ──
  const realRaf = window.requestAnimationFrame.bind(window);
  const held = [];
  window.requestAnimationFrame = (cb) => {
    if (P.hold) {
      held.push(cb);
      return 0;
    }
    return realRaf((ts) => {
      if (ts !== P.lastTs) {
        P.lastTs = ts;
        P.frames++;
      }
      cb(ts);
    });
  };
  P.release = () => {
    P.hold = false;
    for (const cb of held.splice(0)) window.requestAnimationFrame(cb);
  };

  // ── the toast of the app (text shown for a moment): logged so that a slow frame cannot hide it ──
  P.watchToast = () => {
    const el = document.querySelector('.ak2-toast');
    if (!el || P.toastObserver) return !!el;
    const rectOf = (e) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v * 10) / 10) : null;
    };
    const note = () => {
      if (!el.classList.contains('is-on')) return;
      P.toasts.push(el.textContent);
      // where the toast is, and what the HUD shows along the top of the display area at this very moment
      const t = rectOf(el);
      const hit = (b) => !!t && !!b && t[0] < b[2] && b[0] < t[2] && t[1] < b[3] && b[1] < t[3];
      const blocks = {};
      for (const sel of ['.hud-top-left', '.hud-top-right', '.hud-top-center', '.hud-banner']) blocks[sel] = rectOf(document.querySelector(sel));
      const messages = Array.from(document.querySelectorAll('.hud-toast'), rectOf).filter(Boolean);
      const overlaps = Object.keys(blocks).filter((sel) => hit(blocks[sel]));
      if (messages.some(hit)) overlaps.push('.hud-toast');
      P.toastGeom.push({ text: el.textContent, state: appState(), rect: t, banner: blocks['.hud-banner'], topCentre: blocks['.hud-top-center'], messages: messages.length, overlaps });
      if (P.toastGeom.length > 200) P.toastGeom.splice(0, 100);
    };
    P.toastObserver = new MutationObserver(note);
    P.toastObserver.observe(el, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
    return true;
  };

  const Native = window.AudioContext;
  const record = (ctx, refused) => {
    P.contexts.push({
      refused: !!refused,
      atMs: performance.now(),
      userActive: navigator.userActivation ? navigator.userActivation.isActive : null,
      eventType: window.event ? window.event.type : null,
      eventTrusted: window.event ? window.event.isTrusted : null,
      appState: appState(),
    });
    if (ctx) P.ctx = ctx;
  };

  if (P.fault === 'missing' || typeof Native !== 'function') {
    delete window.AudioContext;
    delete window.webkitAudioContext;
  } else if (P.fault === 'throw') {
    window.AudioContext = function AudioContext() {
      record(null, true);
      throw new DOMException('AudioContext refused by the test', 'NotSupportedError');
    };
  } else if (P.fault === 'broken-graph') {
    window.AudioContext = class AudioContext extends Native {
      constructor(...a) {
        super(...a);
        record(this, false);
      }
      createGain() {
        throw new Error('createGain refused by the test');
      }
    };
  } else if (P.fault === 'suspended') {
    window.AudioContext = class AudioContext extends Native {
      constructor(...a) {
        super(...a);
        record(this, false);
        super.suspend().catch(() => {});
      }
      get state() {
        return 'suspended';
      }
      resume() {
        P.resumeCalls++;
        return Promise.reject(new DOMException('resume refused by the test', 'NotAllowedError'));
      }
    };
  } else {
    window.AudioContext = class AudioContext extends Native {
      constructor(...a) {
        super(...a);
        record(this, false);
      }
    };
  }

  P.read = () => {
    const ctx = P.ctx;
    let now = 0;
    let state = null;
    try {
      now = ctx ? ctx.currentTime : 0;
      state = ctx ? Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state').get.call(ctx) : null;
    } catch {
      /* closed context */
    }
    let sounding = 0;
    let sustained = 0;
    for (const r of P.sources) {
      if (r.ended || r.when > now) continue;
      if (r.stopAt === null) sustained++;
      if (r.stopAt === null || r.stopAt > now) sounding++;
    }
    const value = (node) => {
      try {
        return node ? node.gain.value : null;
      } catch {
        return null;
      }
    };
    return {
      fault: P.fault,
      available: typeof window.AudioContext === 'function',
      contexts: P.contexts.length,
      created: P.contexts.slice(0, 3),
      state,
      now,
      started: P.started,
      sounding,
      sustained,
      masterGain: value(P.master),
      busGain: value(P.gameBus),
      loopGains: P.loopGains.map((l) => ({ connected: l.connected, gain: value(l.node) })),
      paramLog: P.paramLog.slice(-30),
      resumeCalls: P.resumeCalls,
      meterReady: P.meter.ready,
      meterError: P.meter.error,
      frames: P.frames,
      toasts: P.toasts.slice(),
      toastGeom: P.toastGeom.slice(),
      appState: appState(),
    };
  };
  /** Output samples between two context times (whole meter windows inside the interval). */
  P.meterBetween = (t0, t1) => {
    let samples = 0;
    let nonZero = 0;
    let peak = 0;
    let sq = 0;
    for (const w of P.meter.windows) {
      if (w[0] < t0 || w[1] > t1) continue;
      samples += w[2];
      nonZero += w[3];
      if (w[4] > peak) peak = w[4];
      sq += w[5];
    }
    return { samples, nonZero, peak, rms: samples > 0 ? Math.sqrt(sq / samples) : 0, seconds: t1 - t0 };
  };

  if (P.fault !== 'none' || typeof Native !== 'function') return;

  // ── sources ──
  const wrapStart = (proto) => {
    const native = proto.start;
    proto.start = function (when, ...rest) {
      const now = this.context.currentTime;
      const rec = { kind: this.constructor.name, when: typeof when === 'number' ? Math.max(when, now) : now, stopAt: null, ended: false };
      this.__e2eSource = rec;
      P.sources.push(rec);
      P.started++;
      this.addEventListener('ended', () => {
        rec.ended = true;
      });
      if (P.sources.length > 4000) P.sources = P.sources.filter((r) => !r.ended);
      return when === undefined ? native.call(this) : native.call(this, when, ...rest);
    };
  };
  wrapStart(AudioScheduledSourceNode.prototype);
  if (Object.prototype.hasOwnProperty.call(AudioBufferSourceNode.prototype, 'start')) wrapStart(AudioBufferSourceNode.prototype);
  const nativeStop = AudioScheduledSourceNode.prototype.stop;
  AudioScheduledSourceNode.prototype.stop = function (when) {
    const rec = this.__e2eSource;
    if (rec) rec.stopAt = typeof when === 'number' ? when : this.context.currentTime;
    return when === undefined ? nativeStop.call(this) : nativeStop.call(this, when);
  };

  // ── graph: master, game bus, loop layers ──
  const METER =
    'class E2EMeter extends AudioWorkletProcessor{constructor(){super();this.t0=currentTime;this.n=0;this.nz=0;this.pk=0;this.sq=0;this.b=0;}' +
    'process(inputs){const inp=inputs[0];let len=128;for(let c=0;c<inp.length;c++){const d=inp[c];len=d.length;for(let i=0;i<d.length;i++){const v=d[i];' +
    'if(v!==0){this.nz++;const a=v<0?-v:v;if(a>this.pk)this.pk=a;this.sq+=v*v;}}}this.n+=len*Math.max(1,inp.length);' +
    'if(++this.b>=16){const t1=currentTime+len/sampleRate;this.port.postMessage([this.t0,t1,this.n,this.nz,this.pk,this.sq]);' +
    'this.t0=t1;this.n=0;this.nz=0;this.pk=0;this.sq=0;this.b=0;}return true;}}registerProcessor("e2e-meter",E2EMeter);';
  const nativeConnect = AudioNode.prototype.connect;
  const nativeDisconnect = AudioNode.prototype.disconnect;
  const attachMeter = (master) => {
    const ctx = master.context;
    try {
      const url = URL.createObjectURL(new Blob([METER], { type: 'application/javascript' }));
      ctx.audioWorklet.addModule(url).then(
        () => {
          const node = new AudioWorkletNode(ctx, 'e2e-meter', { numberOfInputs: 1, numberOfOutputs: 1 });
          node.port.onmessage = (e) => {
            P.meter.windows.push(e.data);
            if (P.meter.windows.length > 60000) P.meter.windows.splice(0, 20000);
          };
          nativeConnect.call(master, node);
          nativeConnect.call(node, ctx.destination); // (writes nothing: silence; only keeps the meter pulled)
          P.meter.ready = true;
        },
        (err) => {
          P.meter.error = String(err);
        },
      );
    } catch (err) {
      P.meter.error = String(err);
    }
  };
  AudioNode.prototype.connect = function (dest, ...rest) {
    const out = nativeConnect.call(this, dest, ...rest);
    try {
      if (this instanceof GainNode && dest instanceof AudioNode) {
        if (!P.master && dest === this.context.destination) {
          P.master = this;
          attachMeter(this);
        } else if (!P.master && !P.gameBus && dest instanceof BiquadFilterNode) {
          P.gameBus = this; // the first gain → filter connection of the master chain: game bus → high-pass
        } else if (P.gameBus && dest === P.gameBus && this.gain.value === 0) {
          const rec = { node: this, connected: true };
          this.__e2eLoop = rec;
          P.loopGains.push(rec);
          if (P.loopGains.length > 200) P.loopGains = P.loopGains.filter((l) => l.connected);
        }
      }
    } catch {
      /* instrumentation must never disturb the page */
    }
    return out;
  };
  AudioNode.prototype.disconnect = function (...a) {
    if (this.__e2eLoop) this.__e2eLoop.connected = false;
    return nativeDisconnect.apply(this, a);
  };

  // ── AudioParam writes to the master gain and to the game-bus gain ──
  const logParam = (param, method, value, when) => {
    const which = P.master && param === P.master.gain ? 'master' : P.gameBus && param === P.gameBus.gain ? 'bus' : null;
    if (!which) return;
    P.paramLog.push([which, method, value, when === undefined ? null : when, P.ctx ? P.ctx.currentTime : 0]);
    if (P.paramLog.length > 400) P.paramLog.splice(0, 200);
  };
  for (const method of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime']) {
    const native = AudioParam.prototype[method];
    AudioParam.prototype[method] = function (value, when, ...rest) {
      logParam(this, method, value, when);
      return native.call(this, value, when, ...rest);
    };
  }
  const valueDesc = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
  Object.defineProperty(AudioParam.prototype, 'value', {
    configurable: true,
    enumerable: valueDesc.enumerable,
    get: valueDesc.get,
    set(v) {
      logParam(this, 'value=', v);
      valueDesc.set.call(this, v);
    },
  });
}

const probeScript = (opts = {}) => `(${audioProbeInit.toString()})(${JSON.stringify(opts)});`;

// ───────────────────────────── helpers ─────────────────────────────
const audio = (page) => L.evaluate(page, () => window.__e2eAudio.read());
const meter = (page, t0, t1) => L.evaluate(page, ([a, b]) => window.__e2eAudio.meterBetween(a, b), [t0, t1]);
const watchToast = (page) => L.evaluate(page, () => window.__e2eAudio.watchToast());
const uiText = (page) =>
  L.evaluate(page, () => {
    const text = (sel) => {
      const e = document.querySelector(sel);
      return e && e.getClientRects().length > 0 ? e.textContent.replace(/\s+/g, ' ').trim() : null;
    };
    const toast = document.querySelector('.ak2-toast');
    return { garage: text('.gar-audio'), pause: text('.menu-audio'), toast: toast ? toast.textContent : null, toastOn: !!toast && toast.classList.contains('is-on') };
  });
const short = (m) => ({ samples: m.samples, nonZero: m.nonZero, peak: Number(m.peak.toExponential(2)), rms: Number(m.rms.toExponential(2)) });
const shotCount = (s) => s.recentPlayerShots.at(-1)?.id ?? 0;
/** Waits (wall clock, bounded) until the test-side meter is connected. */
async function meterReady(page) {
  for (let i = 0; i < 100; i++) {
    const a = await audio(page);
    if (a.meterReady || a.meterError) return a;
    await L.sleep(100);
  }
  return audio(page);
}
/** Real click on a button that starts / continues the game, then wait for 'playing' (scripted lock). */
async function into(page, act) {
  await L.clickAct(page, act);
  return L.waitForState(page, 'playing');
}

const browser = await L.launch();
const checks = new L.Checks('audio');
const t0 = Date.now();
const lap = (text) => console.log(`      [${((Date.now() - t0) / 1000).toFixed(0)} s] ${text}`);

try {
  // ═══════════════════════════ u + v. shipped page: unlock, sound, pause, mute ═══════════════════════════
  if (want('u') || want('v'))
    await checks.section('u/v. shipped page: gesture, sound, pause, mute', async () => {
      const game = await L.openGame(browser, { width: W, height: H, initScript: probeScript() });
      const page = game.page;
      await watchToast(page);

      // ── u: nothing before the first start click ──
      await L.sleep(1500);
      await L.clickAct(page, 'help');
      await L.waitFrames(page, 2);
      await L.clickAct(page, 'help-close');
      await L.selectLoadout(page, { legs: 'quadruped' });
      await L.selectLoadout(page, { legs: 'biped' });
      const ui0 = await uiText(page);
      await page.keyboard.press('KeyM');
      const ui1 = await uiText(page);
      await page.keyboard.press('KeyM');
      const ui2 = await uiText(page);
      let a = await audio(page);
      checks.check('u: the garage shows the sound state as text and M toggles it (音声 ON [M] ⇄ 音声 OFF [M]), with a toast', ui0.garage === '音声 ON [M]' && ui1.garage === '音声 OFF [M]' && ui2.garage === '音声 ON [M]' && a.toasts.length === 2 && a.toasts[0].includes('音声 OFF [M]') && a.toasts[1].includes('音声 ON [M]'), { garage: [ui0.garage, ui1.garage, ui2.garage], toasts: a.toasts });
      checks.check('u: no AudioContext exists before the first start click — not after loading, not after clicks on other buttons, not after the M key', a.available && a.contexts === 0 && a.started === 0, { contexts: a.contexts, sourcesStarted: a.started, appState: a.appState });

      // ── u: the 出撃 click ──
      const first = await L.sortie(page);
      lap('playing');
      a = await meterReady(page);
      const c = a.created[0] ?? {};
      checks.check("u: the click on 出撃 creates exactly one AudioContext — inside the trusted click event, while the app is still in 'garage' (before the pointer lock answered)", a.contexts === 1 && c.eventType === 'click' && c.eventTrusted === true && c.userActive === true && c.appState === 'garage' && first.state === 'playing', c);
      checks.check("u: the context is running and the test-side meter is connected to the master node", a.state === 'running' && a.meterReady && !a.meterError && a.masterGain !== null && a.busGain !== null, { state: a.state, meter: a.meterReady, meterError: a.meterError, masterGain: a.masterGain, busGain: a.busGain });
      checks.check('u: master gain = default volume (0.7² = 0.49), game bus open (1)', L.near(a.masterGain, DEFAULT_MASTER, 1e-3) && L.near(a.busGain, 1, 1e-3), { masterGain: a.masterGain, busGain: a.busGain });
      await L.waitSimSeconds(page, 0.5);
      await L.sleep(1200); // the sortie cue (≈ 0.8 s) has ended

      // ── u: machine gun ──
      let before = await audio(page);
      let s0 = await L.snap(page);
      await L.fireFor(page, 0.6);
      await L.waitFrames(page, 2);
      let s1 = await L.snap(page);
      let after = await audio(page);
      let m = await meter(page, before.now, after.now);
      checks.check('u: machine-gun fire starts sound sources', shotCount(s1) > shotCount(s0) && after.started > before.started, { shots: shotCount(s1) - shotCount(s0), sourcesStarted: after.started - before.started });
      checks.check('u: … and the master output carries signal while firing (every output sample counted by the test-side meter)', m.samples > 4000 && m.nonZero > 1000 && m.peak > 0.005, short(m));

      // ── u: quick boost → glide layer ──
      before = await audio(page);
      await L.tapKey(page, 'KeyQ');
      const sq = await L.waitForSnapshot(page, (s) => s.player.movement.qbSuccessfulCount >= 1 || s.state !== 'playing', null, { label: 'quick boost' });
      await L.waitSimSeconds(page, 0.4);
      await L.sleep(400);
      const sg = await L.snap(page);
      after = await audio(page);
      checks.check('u: a quick boost starts sound sources', sq.player.movement.qbSuccessfulCount === 1 && after.started > before.started, { qb: sq.player.movement.qbSuccessfulCount, sourcesStarted: after.started - before.started });
      checks.check('u: while gliding a continuous layer runs: sources without a stop time, on a loop gain that is connected to the game bus and open', sg.player.movement.horizontalMode === 'glide' && after.sustained >= 1 && after.loopGains.some((l) => l.connected && l.gain > 0.01), { mode: sg.player.movement.horizontalMode, sustainedSources: after.sustained, loopGains: after.loopGains.filter((l) => l.connected) });
      await L.sleep(700);
      const g1 = await audio(page);
      m = await meter(page, g1.now - 0.5, g1.now);
      checks.check('u: … and it is in the output (signal during 0.5 s of gliding with no key held)', m.samples > 4000 && m.peak > 0.0005, short(m));
      await L.holdKey(page, 'ControlLeft', 0.3);
      await L.waitFrames(page, 2);
      await L.sleep(1500);
      await L.waitFrames(page, 2);
      const sb = await L.snap(page);
      a = await audio(page);
      checks.check('u: after the brake the glide layer is gone (no source without a stop time, every loop gain disconnected)', sb.player.movement.glideEnabled === false && a.sustained === 0 && a.loopGains.every((l) => !l.connected), { glideEnabled: sb.player.movement.glideEnabled, sustainedSources: a.sustained, loopGainsConnected: a.loopGains.filter((l) => l.connected).length });
      lap('u done');

      if (want('v')) {
        // ── v: pause while a loop and one-shots are sounding (glide backwards, trigger held) ──
        await L.keyDown(page, 'KeyS');
        await L.tapKey(page, 'ShiftLeft');
        await L.waitSimSeconds(page, 0.3);
        await L.keyUp(page, 'KeyS');
        await L.mouseDown(page);
        await L.waitSimSeconds(page, 0.5);
        const pre = await audio(page);
        const paused = await L.pauseBy(page, 'pointerlock');
        await L.mouseUp(page);
        await L.sleep(800);
        const p0 = await audio(page);
        await L.sleep(4000);
        const p1 = await audio(page);
        const stillPaused = await L.snap(page);
        m = await meter(page, p0.now + 0.4, p1.now);
        const ui = await uiText(page);
        checks.check('v: (before the pause) glide layer running and shots sounding', pre.sustained >= 1 && pre.sounding >= 1 && paused.state === 'paused', { sustained: pre.sustained, sounding: pre.sounding });
        checks.check('v: paused: no sound source is started during 4 s (only the short menu blip right at the pause)', p1.started === p0.started && p0.started - pre.started <= 12, { startedAtThePause: p0.started - pre.started, startedDuring4s: p1.started - p0.started });
        checks.check('v: paused: the loop layers are silent — no source without a stop time, nothing sounding, every loop gain disconnected, game-bus gain 0', p1.sustained === 0 && p1.sounding === 0 && p1.loopGains.every((l) => !l.connected) && p1.busGain === 0, { sustained: p1.sustained, sounding: p1.sounding, loopGainsConnected: p1.loopGains.filter((l) => l.connected).length, busGain: p1.busGain });
        checks.check('v: paused: the output is silent from 1.2 s after the pause on (all samples of ≈ 3.6 s)', m.samples > 100000 && m.peak < SILENT_PEAK, short(m));
        checks.note('v: paused: non-zero output samples in that window (0 = digital silence)', m.nonZero);
        checks.check('v: paused: the simulation is frozen (snapshot identical after 4.8 s) and the pause menu shows the sound state', JSON.stringify(stillPaused) === JSON.stringify(paused) && ui.pause !== null && ui.pause.startsWith('音声 ON [M]'), { t: [paused.elapsedSeconds, stillPaused.elapsedSeconds], pauseMenu: ui.pause });

        // ── v: resume ──
        await L.resume(page);
        const r0 = await audio(page);
        s0 = await L.snap(page);
        await L.fireFor(page, 0.5);
        await L.waitFrames(page, 2);
        s1 = await L.snap(page);
        const r1 = await audio(page);
        m = await meter(page, r0.now, r1.now);
        checks.check('v: after the resume the game bus is open again (gain 1), firing starts sources and the output carries signal', L.near(r1.busGain, 1, 1e-3) && shotCount(s1) > shotCount(s0) && r1.started > r0.started && m.peak > 0.005, { busGain: r1.busGain, shots: shotCount(s1) - shotCount(s0), sourcesStarted: r1.started - r0.started, ...short(m) });
        await L.holdKey(page, 'ControlLeft', 0.3);
        lap('pause / resume done');

        // ── v: mute while playing ──
        let toasts = (await audio(page)).toasts.length;
        await page.keyboard.press('KeyM');
        await L.sleep(700);
        const m1 = await audio(page);
        const wrote = m1.paramLog.filter((e) => e[0] === 'master' && e[1] === 'setTargetAtTime').at(-1);
        checks.check('v: M while playing → toast "音声 OFF [M] …", master gain automated to 0 and reads 0', m1.toasts.length === toasts + 1 && m1.toasts.at(-1).includes('音声 OFF [M]') && !!wrote && wrote[2] === 0 && m1.masterGain < 1e-3, { toast: m1.toasts.at(-1), masterWrite: wrote, masterGain: m1.masterGain });
        s0 = await L.snap(page);
        await L.fireFor(page, 0.6);
        await L.waitFrames(page, 2);
        s1 = await L.snap(page);
        const m2 = await audio(page);
        m = await meter(page, m1.now, m2.now);
        checks.check('v: muted: the machine gun fires (simulation unaffected) but no source is started and the output is silent', shotCount(s1) > shotCount(s0) && m2.started === m1.started && m.samples > 4000 && m.peak < SILENT_PEAK, { shots: shotCount(s1) - shotCount(s0), sourcesStarted: m2.started - m1.started, ...short(m) });

        // ── v: one toggle per physical press (auto-repeat), Ctrl+M is not ours ──
        toasts = m2.toasts.length;
        await L.keyDown(page, 'KeyM');
        await L.autoRepeat(page, 'KeyM', 6);
        await L.keyUp(page, 'KeyM');
        await L.sleep(500);
        let m3 = await audio(page);
        checks.check('v: M held with 6 auto-repeats toggles exactly once → 音声 ON, master gain back to 0.49', m3.toasts.length === toasts + 1 && m3.toasts.at(-1).includes('音声 ON [M]') && L.near(m3.masterGain, DEFAULT_MASTER, 5e-3), { toasts: m3.toasts.slice(toasts), masterGain: m3.masterGain });
        await L.keyDown(page, 'ControlRight');
        await page.keyboard.press('KeyM');
        await L.keyUp(page, 'ControlRight');
        await L.sleep(300);
        const m4 = await audio(page);
        checks.check('v: Ctrl+M (a browser shortcut) does not toggle', m4.toasts.length === m3.toasts.length && L.near(m4.masterGain, DEFAULT_MASTER, 5e-3), { toasts: m4.toasts.length - m3.toasts.length, masterGain: m4.masterGain });
        s0 = await L.snap(page);
        await L.fireFor(page, 0.4);
        await L.waitFrames(page, 2);
        m3 = await audio(page);
        checks.check('v: unmuted: firing starts sources again', m3.started > m4.started, { sourcesStarted: m3.started - m4.started });

        // ── v: the state as text in the pause menu and in the garage; remembered over a reload ──
        await L.pauseBy(page, 'pointerlock');
        await L.sleep(400);
        const u1 = await uiText(page);
        await page.keyboard.press('KeyM');
        await L.sleep(300);
        const u2 = await uiText(page);
        const m5 = await audio(page);
        await L.toGarage(page);
        await L.sleep(1200);
        const u3 = await uiText(page);
        const g = await audio(page);
        m = await meter(page, g.now - 0.6, g.now);
        checks.check('v: the pause menu shows 音声 ON [M] → (M) → 音声 OFF [M]; the garage shows 音声 OFF [M]', u1.pause !== null && u1.pause.startsWith('音声 ON [M]') && u2.pause !== null && u2.pause.startsWith('音声 OFF [M]') && m5.masterGain < 1e-3 && u3.garage === '音声 OFF [M]', { pause: [u1.pause, u2.pause], garage: u3.garage });
        checks.check('v: back in the garage nothing sounds (no source running, output silent)', g.sounding === 0 && g.sustained === 0 && m.peak < SILENT_PEAK, { sounding: g.sounding, sustained: g.sustained, ...short(m) });
        const shown = g.toastGeom.filter((x) => x.state === 'playing');
        // (two toasts were shown in state 'playing': M → OFF, and the held M → ON; Ctrl+M shows none)
        checks.check('v: the two sound toasts shown while playing (top centre, clear of the top HUD panels) covered no HUD block', shown.length === 2 && shown.every((x) => x.rect !== null && x.overlaps.length === 0), shown.map((x) => ({ text: x.text, rect: x.rect, overlaps: x.overlaps })));
        await page.reload({ waitUntil: 'load', timeout: L.TIMEOUT });
        await L.waitReady(page);
        const u4 = await uiText(page);
        const a2 = await audio(page);
        checks.check('v: after a reload the choice is remembered (音声 OFF [M]) and still no AudioContext exists before a start click', u4.garage === '音声 OFF [M]' && a2.contexts === 0, { garage: u4.garage, contexts: a2.contexts });
      }
      checks.noPageErrors(game, 'u/v: no console errors / uncaught exceptions');
      checks.note('u/v: console warnings', game.warnings.slice(0, 5));
      await game.close();
    });

  // ═══════════════════════════ w. no / broken WebAudio, determinism, pause without frames ═══════════════════════════
  if (want('w'))
    await checks.section('w. mini stage: the game does not depend on audio', async () => {
      /**
       * One scripted sortie with exact game time (virtual clock): walk, fire, quick boost, glide toggle, jump +
       * flight, beam, brake, M twice, pause + resume. Input is real keyboard / mouse input sent while the clock
       * stands still. Returns the final snapshot and what the page did with audio.
       */
      const scenario = async (fault) => {
        const game = await L.openGame(browser, { width: W, height: H, path: L.HARNESS_PATH, scripted: { lock: true, clock: true }, initScript: probeScript({ fault }) });
        const page = game.page;
        await watchToast(page);
        await L.clockFreeze(page);
        const first = await into(page, 'sortie');
        await L.realFrames(page, 2);
        const step = 1000 / 60;
        await L.keyDown(page, 'KeyD');
        await L.clockAdvance(page, 18, step);
        await L.keyUp(page, 'KeyD');
        await page.mouse.down();
        await L.clockAdvance(page, 30, step);
        await page.mouse.up();
        await L.tapKey(page, 'KeyQ');
        await L.clockAdvance(page, 30, step);
        await page.keyboard.press('KeyM');
        await L.tapKey(page, 'ShiftLeft');
        await L.clockAdvance(page, 12, step);
        await L.keyDown(page, 'Space');
        await L.clockAdvance(page, 30, step);
        await L.keyUp(page, 'Space');
        await L.tapKey(page, 'Digit2');
        await page.mouse.down();
        await L.clockAdvance(page, 24, step);
        await page.mouse.up();
        await page.keyboard.press('KeyM');
        await L.tapKey(page, 'ControlLeft');
        await L.clockAdvance(page, 12, step);
        const playing = await L.snap(page);
        await page.keyboard.press('Escape');
        const paused = await L.waitForState(page, 'paused');
        await L.sleep(600);
        const ui = await uiText(page);
        await into(page, 'resume');
        await L.realFrames(page, 2);
        await L.clockAdvance(page, 12, step);
        const end = await L.snap(page);
        const a = await audio(page);
        const out = { fault, first, playing, paused, end, audio: a, ui, errors: game.errors.slice(), warnings: game.warnings.slice() };
        await game.close();
        return out;
      };

      const base = await scenario('none');
      lap('w: reference run (audio working)');
      const m = base.end.player.movement;
      checks.check('w[audio working]: the scripted sortie plays (time advances, shots, 1 quick boost, beam, EN spent) and sound was produced', base.first.state === 'playing' && base.end.state === 'playing' && base.end.elapsedSeconds > 2.5 && base.end.recentPlayerShots.length >= 3 && m.qbSuccessfulCount === 1 && base.end.player.weapon === 'beam' && base.audio.contexts === 1 && base.audio.started > 10, { t: base.end.elapsedSeconds, shots: base.end.recentPlayerShots.length, qb: m.qbSuccessfulCount, en: base.end.player.en, sourcesStarted: base.audio.started });
      checks.check('w[audio working]: no console errors', base.errors.length === 0, base.errors.slice(0, 3));
      const labels = { missing: 'no AudioContext in the browser', throw: 'the AudioContext constructor throws', 'broken-graph': 'the context cannot build its graph (createGain throws)', suspended: 'the context stays suspended and refuses resume()' };
      for (const fault of ['missing', 'throw', 'broken-graph', 'suspended']) {
        const r = await scenario(fault);
        lap('w: ' + fault);
        const same = JSON.stringify(r.end) === JSON.stringify(base.end) && JSON.stringify(r.playing) === JSON.stringify(base.playing) && JSON.stringify(r.paused) === JSON.stringify(base.paused);
        checks.check(`w[${labels[fault]}]: the game runs — and its snapshots (before the pause, paused, at the end) are byte-identical to the run with working audio`, r.first.state === 'playing' && r.end.state === 'playing' && same, { t: r.end.elapsedSeconds, identical: same, contexts: r.audio.contexts, available: r.audio.available, sourcesStarted: r.audio.started, resumeCalls: r.audio.resumeCalls });
        checks.check(`w[${labels[fault]}]: no console error, no uncaught exception, no warning; M still toggles the text`, r.errors.length === 0 && r.warnings.length === 0 && r.audio.toasts.length === 2 && r.audio.toasts[0].includes('音声 OFF [M]') && r.audio.toasts[1].includes('音声 ON [M]') && r.ui.pause !== null && r.ui.pause.startsWith('音声 ON [M]'), { errors: r.errors.slice(0, 3), warnings: r.warnings.slice(0, 3), toasts: r.audio.toasts, pauseMenu: r.ui.pause });
      }
    });

  // ═══════════════════════════ z. pause without a rendered frame (hidden tab) ═══════════════════════════
  if (want('z'))
    await checks.section('z. mini stage: a pause with no rendered frame silences the fight at once', async () => {
      // A hidden tab renders no frames, so "tell the audio engine in the next frame" would leave the glide
      // layer humming for as long as the tab stays hidden. The probe holds requestAnimationFrame back.
      const game = await L.openGame(browser, { width: W, height: H, path: L.HARNESS_PATH, initScript: probeScript() });
      const page = game.page;
      await L.sortie(page);
      await meterReady(page);
      await L.sleep(1200);
      await L.tapKey(page, 'ShiftLeft');
      await L.mouseDown(page);
      await L.waitSimSeconds(page, 0.6);
      await L.sleep(300);
      const pre = await audio(page);
      // Hold the frames back. The one callback that is already registered with the browser still runs (it
      // can take a second in software rendering): wait for it, then no frame is rendered any more.
      const framesAtHold = await L.evaluate(page, () => {
        window.__e2eAudio.hold = true;
        return window.__e2eAudio.frames;
      });
      await page.waitForFunction((f) => window.__e2eAudio.frames > f, framesAtHold, { polling: 50, timeout: 15000 }).catch(() => {});
      await L.sleep(600);
      const h0 = await audio(page);
      await L.evaluate(page, () => window.dispatchEvent(new Event('blur')));
      await L.mouseUp(page);
      await L.sleep(1500);
      const h1 = await audio(page);
      await L.sleep(2000);
      const h2 = await audio(page);
      const mm = await meter(page, h1.now, h2.now);
      checks.check('z: (before) glide layer running and shots sounding; then no frame is rendered any more', pre.sustained >= 1 && pre.sounding >= 1 && h0.appState === 'playing' && h2.frames === h0.frames, { sustained: pre.sustained, sounding: pre.sounding, framesDuringHold: h2.frames - h0.frames });
      checks.check("z: window blur → 'paused' and the fight is silenced without a single frame: no source without a stop time, game-bus gain 0, nothing new started, output silent", h1.appState === 'paused' && h1.sustained === 0 && h1.busGain === 0 && h2.started === h1.started && h2.sounding === 0 && mm.samples > 60000 && mm.peak < SILENT_PEAK, { state: h1.appState, sustained: h1.sustained, busGain: h1.busGain, startedLater: h2.started - h1.started, ...short(mm) });
      await L.evaluate(page, () => window.__e2eAudio.release());
      await L.resume(page);
      await L.waitSimSeconds(page, 0.3);
      const back = await audio(page);
      checks.check('z: frames come back, resume works, the glide layer returns', back.appState === 'playing' && back.frames > h2.frames && L.near(back.busGain, 1, 1e-3) && back.sustained >= 1, { frames: back.frames - h2.frames, busGain: back.busGain, sustained: back.sustained });
      checks.noPageErrors(game, 'z: no console errors / uncaught exceptions');
      await game.close();
    });

  // ═══════════════════════════ x. result screens, re-sortie, garage ═══════════════════════════
  if (want('x'))
    await checks.section('x. mini stage: failed / cleared → a short cue, no loop left', async () => {
      const game = await L.openGame(browser, { width: W, height: H, path: L.HARNESS_PATH, initScript: probeScript() });
      const page = game.page;
      await watchToast(page);

      /** The sortie has just ended: a cue sounds, then silence; no loop; nothing new on the result screen. */
      const afterResult = async (label, endSnap) => {
        const e0 = await audio(page);
        await L.sleep(1000);
        const e1 = await audio(page);
        await L.sleep(3500);
        const e2 = await audio(page);
        await L.sleep(1500);
        const e3 = await audio(page);
        const cue = await meter(page, e0.now, e1.now);
        const tail = await meter(page, e2.now, e3.now);
        checks.check(`x[${label}]: a result cue is in the output right after the end of the sortie`, cue.samples > 20000 && cue.peak > 0.005, short(cue));
        checks.check(`x[${label}]: no loop is left running (no source without a stop time, every loop gain disconnected) and nothing new starts on the result screen`, e1.sustained === 0 && e2.sustained === 0 && e2.loopGains.every((l) => !l.connected) && e3.started === e1.started, { sustained: [e1.sustained, e2.sustained], loopGainsConnected: e2.loopGains.filter((l) => l.connected).length, startedLater: e3.started - e1.started });
        checks.check(`x[${label}]: the cue is short: 4.5 s after the end nothing sounds and the output is silent`, e2.sounding === 0 && e3.sounding === 0 && tail.samples > 40000 && tail.peak < SILENT_PEAK, { sounding: [e2.sounding, e3.sounding], ...short(tail) });
        const s = await L.snap(page);
        checks.check(`x[${label}]: the result state is frozen meanwhile`, JSON.stringify(s) === JSON.stringify(endSnap), { t: [endSnap.elapsedSeconds, s.elapsedSeconds] });
      };

      // ── failed: glide backwards off the floor (the glide layer is running when the sortie ends) ──
      await L.sortie(page);
      await meterReady(page);
      await L.keyDown(page, 'KeyS');
      await L.tapKey(page, 'ShiftLeft');
      const fell = await L.waitForState(page, ['failed', 'cleared']);
      await L.keyUp(page, 'KeyS');
      checks.check("x[failed]: gliding backwards off the floor → 'failed' with the glide still enabled", fell.state === 'failed' && fell.player.movement.glideEnabled === true, { state: fell.state, glide: fell.player.movement.glideEnabled, t: fell.elapsedSeconds });
      await afterResult('failed', fell);
      lap('x: failed');

      // ── re-sortie from the result screen, then garage from the pause menu ──
      await L.restart(page);
      await L.sleep(300);
      let a = await audio(page);
      checks.check('x[re-sortie]: still exactly one AudioContext (the second start click resumes, never creates)', a.contexts === 1 && a.state === 'running', { contexts: a.contexts, state: a.state });
      await L.tapKey(page, 'ShiftLeft');
      await L.waitSimSeconds(page, 0.5);
      await L.sleep(300);
      const gl = await audio(page);
      await L.pauseBy(page, 'pointerlock');
      await L.toGarage(page);
      await L.sleep(1500);
      const g0 = await audio(page);
      await L.sleep(1500);
      const g1 = await audio(page);
      let m = await meter(page, g0.now, g1.now);
      checks.check('x[garage]: from a gliding sortie (layer running) to the garage: no source running, nothing started, output silent', gl.sustained >= 1 && g1.sustained === 0 && g1.sounding === 0 && g1.started === g0.started && m.samples > 40000 && m.peak < SILENT_PEAK, { sustainedBefore: gl.sustained, sustained: g1.sustained, sounding: g1.sounding, startedInGarage: g1.started - g0.started, ...short(m) });

      // ── cleared: destroy the six control turrets from cover, then glide through the gate ──
      await L.sortie(page, { fcs: 'medium', generator: 'balanced', legs: 'biped' });
      const c0 = await audio(page);
      await L.mouseDown(page);
      const done = await L.waitForSnapshot(page, (x) => x.objective.controlsDestroyed >= 6 || x.state !== 'playing', null, { label: '6 control turrets', timeout: 600000 });
      const c1 = await audio(page);
      // M twice at once (off, on again): right now the gate banner and the two HUD messages of the sixth
      // turret are stacked at the top centre, reaching into the place where the sound toast normally sits
      await page.keyboard.press('KeyM');
      await page.keyboard.press('KeyM');
      await L.mouseUp(page);
      const stacked = (await audio(page)).toastGeom.slice(-2);
      m = await meter(page, c0.now, c1.now);
      // (ceiling of the engine's soft clipper 0.95 × master gain 0.49 = 0.4655)
      checks.check('x[fight]: six control turrets destroyed; hundreds of sources started; the output stays below the clipper ceiling × master gain (0.466)', done.objective.controlsDestroyed === 6 && c1.started - c0.started > 100 && m.peak > 0.01 && m.peak <= 0.95 * DEFAULT_MASTER + 1e-3, { t: done.elapsedSeconds, sourcesStarted: c1.started - c0.started, soundingNow: c1.sounding, ...short(m) });
      checks.check('x[toast]: (test precondition) at both M presses the gate banner and at least one HUD message were on screen at the top centre', stacked.length === 2 && stacked.every((x) => x.state === 'playing' && x.banner !== null && x.messages >= 1), stacked.map((x) => ({ text: x.text, banner: x.banner, messages: x.messages, topCentre: x.topCentre })));
      // (in a display area this small the HUD itself puts that stack below its top panels; x2 has the 1280×720 layout)
      checks.check('x[toast]: the sound toast covers no HUD block (banner, messages, top panels)', stacked.length === 2 && stacked.every((x) => x.rect !== null && x.overlaps.length === 0), stacked.map((x) => ({ text: x.text, rect: x.rect, topCentre: x.topCentre, overlaps: x.overlaps })));
      await L.holdKey(page, 'KeyD', 0.3);
      await L.keyDown(page, 'KeyW');
      await L.tapKey(page, 'ShiftLeft');
      const cleared = await L.waitForState(page, ['cleared', 'failed'], { timeout: 600000 });
      await L.keyUp(page, 'KeyW');
      checks.check("x[cleared]: through the gate while gliding → 'cleared' with the glide still enabled", cleared.state === 'cleared' && cleared.player.movement.glideEnabled === true, { state: cleared.state, glide: cleared.player.movement.glideEnabled, t: cleared.elapsedSeconds });
      await afterResult('cleared', cleared);
      a = await audio(page);
      checks.check('x: one AudioContext for the whole session (3 sorties, 2 results, garage)', a.contexts === 1, { contexts: a.contexts });
      checks.noPageErrors(game, 'x: no console errors / uncaught exceptions');
      checks.note('x: console warnings', game.warnings.slice(0, 5));
      await game.close();
    });

  // ═══════════════════════════ x2. the sound toast and the HUD's top-centre stack (1280×720) ═══════════════════════════
  if (want('x2'))
    await checks.section('x2. mini stage at 1280×720: the sound toast gives way to the HUD messages at the top centre', async () => {
      // At the reference size the toast sits at the top centre between the two top HUD panels — the place the
      // HUD's own top-centre stack grows into for a few seconds after the last control turret (gate banner +
      // two messages). The toast must then be shown below that stack, and return when the messages are gone.
      const game = await L.openGame(browser, { width: 1280, height: 720, path: L.HARNESS_PATH, initScript: probeScript() });
      const page = game.page;
      await watchToast(page);
      await L.sortie(page, { fcs: 'medium', generator: 'balanced', legs: 'biped' });
      await L.waitSimSeconds(page, 0.3);
      const pressTwice = async () => {
        await page.keyboard.press('KeyM'); // off
        await page.keyboard.press('KeyM'); // on again
        return (await audio(page)).toastGeom.slice(-2);
      };
      const view = (list) => list.map((x) => ({ text: x.text, rect: x.rect, topCentre: x.topCentre, messages: x.messages, overlaps: x.overlaps }));
      const free = await pressTwice();
      const home = free.length === 2 && free[0].rect ? free[0].rect[1] : NaN;
      // (4.7 em of the UI scale = 75.2 px at 1280×720, see src/app.css)
      checks.check('x2: nothing at the top centre → the toast is at its own place (top 75.2 px, between the two top panels) and covers no HUD block', free.length === 2 && free.every((x) => x.state === 'playing' && x.rect !== null && x.topCentre === null && x.overlaps.length === 0 && L.near(x.rect[1], 75.2, 0.6)), view(free));
      await L.mouseDown(page);
      const done = await L.waitForSnapshot(page, (x) => x.objective.controlsDestroyed >= 6 || x.state !== 'playing', null, { label: '6 control turrets', timeout: 600000 });
      const stacked = await pressTwice();
      await L.mouseUp(page);
      checks.check('x2: (test precondition) sixth control turret destroyed; at both M presses the gate banner and at least one HUD message reach into the place of the toast', done.objective.controlsDestroyed === 6 && stacked.length === 2 && stacked.every((x) => x.state === 'playing' && x.banner !== null && x.messages >= 1 && x.topCentre !== null && x.topCentre[3] > home), view(stacked));
      checks.check('x2: the toast is then shown below that stack and covers no HUD block (banner, messages, top panels)', stacked.length === 2 && stacked.every((x) => x.rect !== null && x.topCentre !== null && x.rect[1] >= x.topCentre[3] && x.overlaps.length === 0), view(stacked));
      await L.waitSimSeconds(page, 6); // the two messages last 4.5 s of game time; the banner stays
      const after = await pressTwice();
      checks.check('x2: messages gone (banner only): the toast is back at its own place and covers no HUD block', after.length === 2 && after.every((x) => x.state === 'playing' && x.banner !== null && x.messages === 0 && x.rect !== null && x.overlaps.length === 0 && L.near(x.rect[1], home, 0.6)), view(after));
      checks.noPageErrors(game, 'x2: no console errors / uncaught exceptions');
      await game.close();
    });
} finally {
  await browser.close();
}
console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(checks.finish());
