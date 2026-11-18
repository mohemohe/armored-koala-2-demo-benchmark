#!/usr/bin/env node
/**
 * factory-run.mjs — a test-side bot plays the SHIPPED page (production build of index.html, the real
 * 19-sector factory) from the sortie to MISSION CLEAR through the real input path:
 *
 *     real key / mouse events (CDP)  →  InputManager  →  Sim  →  renderer / HUD
 *
 * and reads nothing but what a player has: `window.__AK2__.getSnapshot()` (read-only, SPEC §10), the HUD's
 * DOM and screenshots. Nothing in the page is changed and the page offers nothing to change: no cheat, no
 * hook. Fault injection / instrumentation is test-side only (context.addInitScript): the scripted pointer
 * lock + virtual frame clock of lib.mjs and the small frame-stepping helper below (`botPageInit`).
 *
 * HOW TO RUN (tsx, because the bot imports the stage data and the planners of the repo — TypeScript):
 *
 *   node tools/e2e/serve.mjs --port=5250 &                       # snapshot build of the shipped page
 *   AK2_URL=http://127.0.0.1:5250/ npx tsx tools/e2e/factory-run.mjs --out=/tmp/ak2-factory
 *
 *   --out=<dir>       log-<label>.jsonl (one row per frame), summary-<label>.json, shots/*.png (default: no
 *                     files, no screenshots);  --label=<name> names them (default "run")
 *   --size=320x180    viewport (CSS px) while playing. Small on purpose: this machine has no GPU and its CPUs
 *                     are throttled under sustained load (steal time up to 60 %). A software-rendered frame
 *                     costs ≈ 0.2 s at this size in the start dock while the CPUs are not throttled and
 *                     0.4 – 1.4 s during a whole sortie; ≈ 0.45 – 1.0 s at 640×360 in the dock (measured). The
 *                     game logic depends on the aspect ratio only (lock circle = 0.2 × height at every size).
 *   --shot-size=1280x720   window size for the screenshots: the window is really resized for the picture
 *                     and back, with game time standing still (the shadow gets the same Sim.setViewport calls)
 *   --dpr=1           devicePixelRatio while playing (test-side display emulation; 0.5 = the game's own lower
 *                     limit, a quarter of the pixels for the software rasteriser). The game logic only sees CSS px.
 *   --shot-dpr=1      devicePixelRatio for the screenshots (switched for the picture, one redraw with frame time 0)
 *   --fps=15          virtual frame rate: every rendered frame feeds exactly 1/fps s to the game (8 simulation
 *                     ticks at 15). The measured sortie (≈ 334 s of game time = 5009 frames) took 75 minutes
 *                     of wall time here; the pilot was also tried at 7.5, 10, 20, 30 and 46 (--dry only).
 *   --coarse-ms=0     optional longer frame time (e.g. 200) for the frames in which nothing can happen (straight
 *                     walk, no enemy in sight or alerted within 140 m, no bullet in flight, no corner within
 *                     reach); 0 = always 1/fps. Saves a third of the rendered frames. Tried with --dry only.
 *   --decide-every=1  rendered frames per decision of the pilot (2 = it reacts every second frame)
 *   --no-hold         let the page redraw (frame time 0) while the bot thinks. Default: the game's animation
 *                     frames are kept back between steps, so every software-rendered frame is a game frame
 *                     (measured here: 0.83 s per step over a whole sortie with it, 1.45 s per step over the
 *                     first 37 s of game time without it; the CPU throttling was not the same in both runs)
 *   --seed=<n>        URL query seed (default: none = the game's default seed 20260908)
 *   --loadout=fcs,generator,legs   e.g. medium,balanced,biped (default = the garage's initial selection)
 *   --tactics=dodge|plain          dodge (default): reads enemy shots and side-steps them; plain: the
 *                                  strafing pattern of the headless combat bot (tools/stageAnalysis.ts, V16)
 *   --stop-after=<1..4>            stop after that milestone (1 = T01, 2 = first climb, 3 = gate open, 4 = clear)
 *   --max-sim=<seconds>            give up after that much simulation time (default 900)
 *   --no-shadow       do not run the lock-step comparison against the headless simulation
 *   --mini-fall       self-test of the end-of-sortie handling on the mini stage (dev/app-test.html): holds S
 *                     until the mech falls off, then result screen → 同じ構成で再出撃 → t = 0 comparison
 *   --dry             NO BROWSER: the same pilot drives the headless Sim through the repo's InputCore with the
 *                     same frame arithmetic. For developing the pilot only — it is not evidence about the page.
 *
 * WHAT THE BOT IS
 *   Pilot   = the player: decides once per rendered frame from the snapshot of the previous frame. It may
 *             import data and logic from the repo (route waypoints, collision World for its own line-of-
 *             sight tests, the ground / flight planners and the flight controller logic of
 *             tools/stageAnalysis.ts), because a player sees the stage and the route marker of the HUD.
 *             It tracks the camera yaw / pitch itself from the mouse movement the PAGE reports as received
 *             (the snapshot has no camera angles) and checks that against the snapshot whenever it can.
 *   Driver  = the hands. BrowserDriver sends real, trusted events: keyboard.down / up, mouse.down / up and
 *             mouse.move. With the scripted lock the pointer is not captured, so relative motion is made
 *             the way a hand on a finite desk does it — lift and set down again: a move to a point just
 *             OUTSIDE the viewport is not delivered to the page, the following move back inside arrives
 *             with movementX / movementY = the wanted delta (measured, see the `mouse` section of the
 *             summary). One mouse event per frame, at most `LOOK_MAX` px. A turn of fewer than 6 px that
 *             would take the pointer over the border cannot be sent in that frame (`skippedSmall`): the
 *             pilot asks again in the next one. The trigger is released for the lift and pressed again
 *             behind it within the same frame (a held button captures the pointer).
 *   Lock step: the virtual clock stands still while the bot thinks; one step = "send the input, let exactly
 *             one rendered frame of 1/fps s pass, read the snapshot". Game time is exact and the run is
 *             repeatable; wall-clock speed (SwiftShader) does not matter.
 *   Shadow  = cross-check, not control: the headless Sim receives the same per-frame input (as delivered)
 *             through the repo's InputCore and its snapshot is compared with the page's after every frame.
 *
 * MILESTONES (reported with simulation time, HP, EN, position, objective state)
 *   1  T01 destroyed → controlsDestroyed 1, B1 open            3  six control turrets, final gate open
 *   2  first mandatory flight climb (F1) with Space held        4  exit zone → 'cleared', re-sortie t = 0 identical
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { launch, openGame, evaluate, waitForState, selectLoadout, sleep, BASE_URL, TIMEOUT } from './lib.mjs';
import { CAMERA, PLAYER, ENEMIES, ENEMY_AI, WEAPONS, DEFAULT_LOADOUT, DEFAULT_SEED, computeEffectiveStats } from '../../src/config.ts';
import { getFactoryStage } from '../../src/stage/factory.ts';
import { World } from '../../src/sim/world.ts';
import { Sim } from '../../src/sim/sim.ts';
import { buildSnapshot } from '../../src/sim/snapshot.ts';
import { computeCameraRig, createCameraState } from '../../src/sim/camera.ts';
import { solveLinearIntercept } from '../../src/sim/ballistics.ts';
import { InputCore, MOUSE_FIRE } from '../../src/input/input.ts';
import { StageAnalyzer, estimateClimbEn } from '../stageAnalysis.ts';

// ───────────────────────────── arguments ─────────────────────────────
const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const OUT = arg('out');
const [VW, VH] = arg('size', '320x180').split('x').map(Number);
/** Viewport for the screenshots: the window is resized for the picture and back (game time stands still). */
const [SW, SH] = arg('shot-size', '1280x720').split('x').map(Number);
const FPS = Number(arg('fps', '15'));
const STEP_MS = 1000 / FPS;
/** Rendered frames per decision of the pilot (the input of a decision stays in force for that many frames). */
const EVERY = Math.max(1, Number(arg('decide-every', '1')));
const DT = EVERY / FPS;
/** devicePixelRatio while playing / for screenshots (test-side emulation; the game only ever sees CSS px). */
const PLAY_DPR = Number(arg('dpr', '1'));
const SHOT_DPR = Number(arg('shot-dpr', String(Math.max(1, PLAY_DPR))));
/**
 * Optional longer frame time (ms) for the frames in which nothing can happen to the mech: walking a straight
 * stretch with no enemy in sight or alerted nearby, no bullet in flight and no corner within reach.
 * 0 (default) = every frame is 1/fps. (A display whose frame time varies; the game caps a frame at 250 ms.)
 */
const COARSE_MS = Number(arg('coarse-ms', '0'));
/** Frame pacing: the game's animation frames are kept back while the bot thinks (see botPageInit). */
const HOLD = !flag('no-hold');
const SEED = arg('seed') === null ? null : Number(arg('seed')) >>> 0;
const LOADOUT = (() => {
  const s = arg('loadout');
  if (!s) return { ...DEFAULT_LOADOUT };
  const [fcs, generator, legs] = s.split(',');
  return { fcs, generator, legs };
})();
const TACTICS = arg('tactics', 'dodge');
const STOP_AFTER = Number(arg('stop-after', '4'));
const MAX_SIM = Number(arg('max-sim', '900'));
const DRY = flag('dry');
const SHADOW = !DRY && !flag('no-shadow');
const QUIET = flag('quiet');
const LABEL = arg('label', DRY ? 'dry' : 'run');
/** Shadow comparison: numbers may differ by this much (the two JavaScript engines round sin / cos differently). */
const SHADOW_TOL = 1e-6;

// ───────────────────────────── small helpers ─────────────────────────────
const SENS = CAMERA.mouseSensitivity;
const HX = PLAYER.half.x;
const HY = PLAYER.half.y;
const V = (a) => ({ x: a[0], y: a[1], z: a[2] });
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const distH = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wrapPi = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const fmtP = (p) => `(${r1(p.x)}, ${r1(p.y)}, ${r1(p.z)})`;
const say = (...a) => {
  if (!QUIET) console.log(...a);
};

/** Largest mouse movement of one event (CSS px): one viewport width minus a margin. */
const LOOK_MAX = Math.min(600, VW - 40);
const LOOK_MAX_Y = Math.min(300, VH - 40);

const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'];
const DIGIT = { machinegun: 'Digit1', beam: 'Digit2', missile: 'Digit3' };
/** The 8 key combinations of WASD as (forward, right) components, plus "no key". */
const COMBOS = [
  { keys: ['KeyW'], f: 1, r: 0 },
  { keys: ['KeyW', 'KeyD'], f: 1, r: 1 },
  { keys: ['KeyD'], f: 0, r: 1 },
  { keys: ['KeyS', 'KeyD'], f: -1, r: 1 },
  { keys: ['KeyS'], f: -1, r: 0 },
  { keys: ['KeyS', 'KeyA'], f: -1, r: -1 },
  { keys: ['KeyA'], f: 0, r: -1 },
  { keys: ['KeyW', 'KeyA'], f: 1, r: -1 },
  { keys: [], f: 0, r: 0 },
];

// ───────────────────────────── the pilot (driver independent) ─────────────────────────────
class Pilot {
  /**
   * @param {object} env  { stage, an (StageAnalyzer), world (own World: barrier state follows the snapshot),
   *                        loadout, dt, tactics, log(text) }
   */
  constructor(env) {
    this.env = env;
    this.stage = env.stage;
    this.an = env.an;
    this.world = env.world;
    this.route = env.stage.route;
    this.dt = env.dt;
    this.tactics = env.tactics;
    this.log = env.log;
    this.stats = computeEffectiveStats(env.loadout);
    this.cam = createCameraState();
    this.reset();
  }

  reset() {
    this.yaw = this.stage.playerStart.yaw;
    this.pitch = 0;
    this.k = 1;
    this.arrivals = this.route.map(() => null);
    this.arrivals[0] = 0;
    this.plan = null;
    this.pi = 0;
    this.planKind = 'ground';
    this.blockedFor = 0;
    this.wasGrounded = true;
    this.refT = 0;
    this.ref = null;
    this.stuck = 0;
    this.replans = 0;
    this.flight = null;
    this.climbs = [];
    this.enWait = 0;
    this.prev = null;
    this.lastCmd = null;
    this.bullets = [];
    this.mode = 'start';
    this.prelude = [];
    this.calib = { yawChecks: 0, yawMaxErr: 0, resyncs: 0, aimChecks: 0, aimMaxErrDeg: 0, aimLog: [] };
    this.seenShotId = 0;
    this.missilesOut = [];
    this.openKey = '';
    this.C = { target: null, since: 0, hp0: 0, dir: 1, flipAt: 0, beam: false, rng: 0x9e3779b9, ignore: new Map(), missileReadyAt: 0, fightFrames: 0, lockedOn: new Set() };
    this.counters = { enemyShotsSeen: 0, dodgeOverrides: 0, walkDodges: 0, flightFailures: 0, noPlan: 0, coarseFrames: 0 };
  }

  rnd() {
    const C = this.C;
    C.rng = (Math.imul(C.rng, 1664525) + 1013904223) >>> 0;
    return C.rng / 4294967296;
  }

  /** The driver reports the mouse movement the game really received in the frame (CSS px). */
  lookApplied(dx, dy) {
    if (dx === 0 && dy === 0) return;
    // same arithmetic as InputManager.apply → Sim.applyLook
    let yaw = this.yaw + -dx * SENS;
    if (yaw > Math.PI) yaw -= 2 * Math.PI * Math.ceil((yaw - Math.PI) / (2 * Math.PI));
    if (yaw < -Math.PI) yaw += 2 * Math.PI * Math.ceil((-Math.PI - yaw) / (2 * Math.PI));
    this.yaw = yaw;
    this.pitch = Math.min(CAMERA.pitchMax, Math.max(CAMERA.pitchMin, this.pitch + -dy * SENS));
  }

  /** Mouse movement (px) that turns the view to (yawW, pitchW); at most one event's worth. */
  lookTo(yawW, pitchW) {
    const dx = clamp(Math.round(wrapPi(this.yaw - yawW) / SENS), -LOOK_MAX, LOOK_MAX);
    const dy = clamp(Math.round((this.pitch - clamp(pitchW, CAMERA.pitchMin, CAMERA.pitchMax)) / SENS), -LOOK_MAX_Y, LOOK_MAX_Y);
    return [dx, dy];
  }

  closedIds() {
    return this.an.closable.filter((id) => !this.world.isBarrierOpen(id));
  }

  /** The pilot's own collision world follows what the snapshot says is open. */
  syncWorld(objective) {
    const key = objective.openBarrierIds.join(',') + (objective.gateOpen ? '+G' : '');
    if (key === this.openKey) return;
    this.openKey = key;
    for (const b of this.stage.barriers) this.world.setBarrierOpen(b.id, objective.openBarrierIds.includes(b.id));
    this.world.setBarrierOpen(this.stage.finalGate.id, objective.gateOpen);
    this.plan = null;
  }

  /** Camera pivot as the game computes it (pulled down under a low ceiling). */
  pivotOf(pos) {
    const up = this.world.raycast(pos, { x: 0, y: 1, z: 0 }, CAMERA.pivotUp + CAMERA.collisionPad);
    return { x: pos.x, y: up ? pos.y + Math.max(0, up.dist - CAMERA.collisionPad) : pos.y + CAMERA.pivotUp, z: pos.z };
  }

  // ───────── observation: enemy shots → straight bullets the pilot can side-step ─────────
  observeShots(S, pos, vel) {
    const t = S.elapsedSeconds;
    const prev = this.prev;
    const now = new Map();
    for (const e of S.enemies) now.set(e.id, e);
    if (prev) {
      const span = Math.max(1e-9, t - prev.t);
      for (const e of S.enemies) {
        const pe = prev.enemies.get(e.id);
        if (!pe || e.shotsFired <= pe.shotsFired || e.lastShotAtSeconds === null) continue;
        const cfg = ENEMIES[e.kind];
        const n = e.shotsFired - pe.shotsFired;
        this.counters.enemyShotsSeen += n;
        for (let j = 0; j < n; j++) {
          const tf = e.lastShotAtSeconds - j * cfg.burstInterval;
          const a = clamp((tf - prev.t) / span, 0, 1);
          const me = { x: prev.pos.x + (pos.x - prev.pos.x) * a, y: prev.pos.y + (pos.y - prev.pos.y) * a, z: prev.pos.z + (pos.z - prev.pos.z) * a };
          const mv = { x: prev.vel.x + (vel.x - prev.vel.x) * a, y: prev.vel.y + (vel.y - prev.vel.y) * a, z: prev.vel.z + (vel.z - prev.vel.z) * a };
          const ep = V(pe.position);
          const ec = V(e.position);
          const m = { x: ep.x + (ec.x - ep.x) * a, y: ep.y + (ec.y - ep.y) * a + cfg.muzzleUp, z: ep.z + (ec.z - ep.z) * a };
          // the enemy's own aiming rule (SPEC §2.3): linear lead on the current velocity, capped at 1.2 s
          const sol = solveLinearIntercept(m, me, mv, cfg.bulletSpeed, ENEMY_AI.maxPredictSeconds);
          let d;
          if (sol) d = sol.dir;
          else {
            const lead = Math.min(ENEMY_AI.maxPredictSeconds, dist3(m, me) / cfg.bulletSpeed);
            const ax = me.x + mv.x * lead - m.x;
            const ay = me.y + mv.y * lead - m.y;
            const az = me.z + mv.z * lead - m.z;
            const l = Math.hypot(ax, ay, az) || 1;
            d = { x: ax / l, y: ay / l, z: az / l };
          }
          const range = dist3(m, me);
          this.bullets.push({ from: e.id, m, d, speed: cfg.bulletSpeed, tf, tEnd: tf + Math.min(cfg.bulletLife, (range + 8) / cfg.bulletSpeed), range });
        }
      }
    }
    this.bullets = this.bullets.filter((b) => b.tEnd > t);
    this.prev = { t, pos, vel, enemies: now };
  }

  /**
   * Smallest clearance (m, negative = inside the hit box) between the pilot's box and every bullet in flight
   * if it walks towards the horizontal unit direction (cx, cz) from now on ((0, 0) = stops).
   */
  clearance(pos, vel, cx, cz, t) {
    if (this.bullets.length === 0) return Infinity;
    const speed = this.stats.walkSpeed;
    const acc = PLAYER.walkAccel * this.stats.horizontalSpeedMultiplier;
    const h = 1 / 240;
    let px = pos.x;
    let pz = pos.z;
    let vx = vel.x;
    let vz = vel.z;
    let worst = Infinity;
    let tEnd = t;
    for (const b of this.bullets) if (b.tEnd > tEnd) tEnd = b.tEnd;
    const steps = Math.min(240, Math.ceil((tEnd - t) / h));
    for (let i = 1; i <= steps; i++) {
      const dvx = cx * speed - vx;
      const dvz = cz * speed - vz;
      const dv = Math.hypot(dvx, dvz);
      const nvx = dv <= acc * h ? cx * speed : vx + (dvx / dv) * acc * h;
      const nvz = dv <= acc * h ? cz * speed : vz + (dvz / dv) * acc * h;
      px += 0.5 * (vx + nvx) * h;
      pz += 0.5 * (vz + nvz) * h;
      vx = nvx;
      vz = nvz;
      const tt = t + i * h;
      for (const b of this.bullets) {
        const s = b.speed * (tt - b.tf);
        if (s < 0 || tt > b.tEnd) continue;
        const qx = b.m.x + b.d.x * s;
        const qy = b.m.y + b.d.y * s;
        const qz = b.m.z + b.d.z * s;
        const c = Math.max(Math.abs(qx - px) - HX, Math.abs(qz - pz) - HX, Math.abs(qy - pos.y) - HY);
        if (c < worst) worst = c;
      }
    }
    return worst;
  }

  /** May the box stand `step` m further along (dx, dz)? Free of solids and with floor under its feet. */
  safeStep(pos, dx, dz, step = 2.2) {
    const q = { x: pos.x + dx * step, y: pos.y + 2e-4, z: pos.z + dz * step };
    return !this.world.overlapsBox(q, PLAYER.half) && this.world.probeGround(q, { x: 0.6, y: HY, z: 0.6 }, 0.3) <= 0.05;
  }

  /**
   * Chooses the WASD combination for this frame: the one closest to `prefer` (a horizontal world direction)
   * unless bullets in flight would hit on that course — then the course that clears them best.
   * @returns {{ combo, dir: {x, z}, clear: number, override: boolean }}
   */
  planMove(pos, vel, yawAfter, prefer, t, allowDodge) {
    const fx = -Math.sin(yawAfter);
    const fz = -Math.cos(yawAfter);
    const rx = Math.cos(yawAfter);
    const rz = -Math.sin(yawAfter);
    const cap = 1.3;
    let best = null;
    let preferred = null;
    for (const combo of COMBOS) {
      let dx = fx * combo.f + rx * combo.r;
      let dz = fz * combo.f + rz * combo.r;
      const l = Math.hypot(dx, dz);
      if (l > 0) {
        dx /= l;
        dz /= l;
      }
      const moving = l > 0;
      const safe = !moving || (this.safeStep(pos, dx, dz, 2.2) && this.safeStep(pos, dx, dz, 1.1));
      const along = moving ? dx * prefer.x + dz * prefer.z : -0.4;
      const clear = allowDodge ? this.clearance(pos, vel, dx, dz, t) : Infinity;
      const score = Math.min(clear, cap) * 10 + along * 1.5 + (this.lastCombo === combo ? 0.4 : 0) - (safe ? 0 : 1000);
      const c = { combo, dir: { x: dx, z: dz }, clear, safe, along, score };
      if (!best || score > best.score) best = c;
      if (safe && (!preferred || along > preferred.along)) preferred = c;
    }
    best.override = !!preferred && best !== preferred && this.bullets.length > 0;
    this.lastCombo = best.combo;
    return best;
  }

  // ───────── combat ─────────
  engageable(e, pos, t) {
    if (!e.alive || (this.C.ignore.get(e.id) ?? -1) > t) return false;
    const ep = V(e.position);
    const mz = this.an.muzzleFacing(pos, ep);
    if (dist3(mz, ep) > 118) return false;
    const pivot = this.pivotOf(pos);
    return !this.world.segmentBlocked(pivot, ep) && !this.world.segmentBlocked(mz, ep);
  }

  nextControlId(S) {
    for (const b of this.stage.barriers) {
      const e = this.prev.enemies.get(b.controlEnemyId);
      if (e && e.alive) return e.id;
    }
    return null;
  }

  pickTarget(S, pos, t) {
    const ctrlId = this.nextControlId(S);
    let best = null;
    let bestKey = Infinity;
    for (const e of S.enemies) {
      if (!e.alive || !e.hasLineOfSight || !this.engageable(e, pos, t)) continue;
      const d = dist3(pos, V(e.position));
      // dodge tactics: whatever dies fastest first (guards: 3 beam shots), the control turret before other turrets
      const key = this.tactics === 'plain' ? d : d + (e.kind === 'guard' ? 0 : e.id === ctrlId ? 150 : 300);
      if (key < bestKey) {
        bestKey = key;
        best = e;
      }
    }
    const ctrl = ctrlId ? this.prev.enemies.get(ctrlId) : null;
    if (ctrl && this.engageable(ctrl, pos, t)) {
      if (this.tactics === 'plain' || !best) return ctrl;
    }
    return best;
  }

  /** One frame of fighting. False when there is nothing to fight (the caller goes on with the route). */
  fightStep(S, pos, vel, cmd) {
    const C = this.C;
    const P = S.player;
    const t = S.elapsedSeconds;
    let e = C.target ? this.prev.enemies.get(C.target) : null;
    if (e && !this.engageable(e, pos, t)) e = null;
    if (e && t - C.since > 8) {
      if (e.hp > C.hp0 - 1) {
        C.ignore.set(e.id, t + 20);
        this.log(`t=${r1(t)} ignoring ${e.id} for 20 s (no damage in 8 s)`);
        e = null;
      } else {
        C.since = t;
        C.hp0 = e.hp;
      }
    }
    if (!e) {
      e = this.pickTarget(S, pos, t);
      if (e) {
        C.since = t;
        C.hp0 = e.hp;
      }
    }
    C.target = e ? e.id : null;
    if (!e) return false;
    C.fightFrames++;
    const ep = V(e.position);
    const ev = V(e.velocity);
    const d = dist3(pos, ep);
    // aim: the camera-centre ray passes through the pivot; look from the pivot at where the target will be
    // (relative to the mech) in the middle of the coming frame
    const lead = 0.5 * this.dt;
    const pivot = this.pivotOf(pos);
    const ax = ep.x + (ev.x - vel.x) * lead - pivot.x;
    const ay = ep.y + (ev.y - vel.y) * lead - pivot.y;
    const az = ep.z + (ev.z - vel.z) * lead - pivot.z;
    const al = Math.hypot(ax, ay, az) || 1;
    const yawW = Math.atan2(-ax, -az);
    const pitchW = Math.asin(clamp(ay / al, -1, 1));
    cmd.look = this.lookTo(yawW, pitchW);
    const yawAfter = this.yaw - cmd.look[0] * SENS;
    const pitchAfter = clamp(this.pitch - cmd.look[1] * SENS, CAMERA.pitchMin, CAMERA.pitchMax);
    const aimErr = Math.hypot(wrapPi(yawW - yawAfter) * Math.cos(pitchW), pitchW - pitchAfter);
    const radius = ENEMIES[e.kind].radius;
    const onTarget = aimErr < Math.atan2(radius * 0.6, al);
    // weapon (the rule of the headless combat bot, plus missiles when the beam is resting)
    if (C.beam ? P.en < 16 : P.en >= 60) C.beam = !C.beam;
    const locked = S.lock.state === 'locked' && S.lock.targetId === e.id;
    if (locked) C.lockedOn.add(e.id);
    let want = C.beam ? 'beam' : P.ammo.machinegun > 0 ? 'machinegun' : P.ammo.missile > 0 ? 'missile' : 'beam';
    if (want === 'missile' && !locked && P.en >= 8) want = 'beam';
    if (this.tactics !== 'plain' && want !== 'missile' && !C.beam && locked && P.ammo.missile > 0 && t >= C.missileReadyAt - 1e-9 && d > 14) {
      const pending = this.missilesOut.filter((m) => m.id === e.id && m.until > t).length * WEAPONS.missile.damage;
      if (e.hp - pending > 60) want = 'missile';
    }
    if (P.weapon !== want) cmd.taps.push(DIGIT[want]);
    cmd.fire = want === 'beam' ? P.en >= 8 && (locked || onTarget) : want === 'machinegun' ? locked || (d < 25 && onTarget) : locked;
    cmd.note = `fight ${e.id} ${want}${locked ? ' L' : ''}`;
    // movement: strafe left / right relative to the line to the target, reversing every 0.35–0.65 s
    if (t >= C.flipAt) {
      C.dir = -C.dir;
      C.flipAt = t + 0.35 + 0.3 * this.rnd();
    }
    let prefer = { x: Math.cos(yawAfter) * C.dir, z: -Math.sin(yawAfter) * C.dir };
    if (!this.safeStep(pos, prefer.x, prefer.z) && this.safeStep(pos, -prefer.x, -prefer.z)) {
      C.dir = -C.dir;
      prefer = { x: -prefer.x, z: -prefer.z };
    }
    const mv = this.planMove(pos, vel, yawAfter, prefer, t, this.tactics !== 'plain');
    if (mv.override) {
      this.counters.dodgeOverrides++;
      // the pattern goes on from the side-step: no immediate swing back into the bullets
      if (mv.dir.x * prefer.x + mv.dir.z * prefer.z < -0.2) {
        C.dir = -C.dir;
        C.flipAt = t + 0.35 + 0.3 * this.rnd();
      }
    }
    for (const k of mv.combo.keys) cmd.keys[k] = true;
    return true;
  }

  // ───────── steering ─────────
  steer(x, z, pos, cmd) {
    const dx = x - pos.x;
    const dz = z - pos.z;
    const dh = Math.hypot(dx, dz);
    let err = 0;
    if (dh > 0.05) {
      const yawW = Math.atan2(-dx, -dz);
      cmd.look = this.lookTo(yawW, 0);
      err = wrapPi(yawW - (this.yaw - cmd.look[0] * SENS));
    } else cmd.look = this.lookTo(this.yaw, 0);
    return { d: dh, err };
  }

  resetWatchdog(t, pos) {
    this.refT = t;
    this.ref = { ...pos };
  }

  // ───────── flight (the controller of tools/stageAnalysis.ts flyClimb, decided once per frame) ─────────
  startFlight(S, pos, T, pts) {
    this.flight = { to: { ...T }, pts, k: 1, started: false, airborne: false, held: false, frames: 0, t0: S.elapsedSeconds, en0: S.player.en, from: { ...pos }, flyingFrames: 0, spaceFrames: 0, spacePresses: 0, maxY: pos.y, waypoint: this.k };
    this.log(`t=${r1(S.elapsedSeconds)} climb to waypoint ${this.k} ${fmtP(T)} from ${fmtP(pos)} EN ${r1(S.player.en)} via ${pts.length} points`);
  }

  flyStep(S, pos, cmd) {
    const F = this.flight;
    const P = S.player;
    const t = S.elapsedSeconds;
    const to = F.to;
    if (F.started && !P.grounded) F.airborne = true;
    if (P.movement.verticalMode === 'flying') F.flyingFrames++;
    if (pos.y > F.maxY) F.maxY = pos.y;
    const finish = (ok, reason) => {
      const rec = { waypoint: F.waypoint, ok, reason, from: F.from, to, landed: { ...pos }, height: to.y - F.from.y, horizontal: distH(F.from, to), enUsed: F.en0 - P.en, enLeft: P.en, seconds: t - F.t0, flyingFrames: F.flyingFrames, spaceHeldFrames: F.spaceFrames, spacePresses: F.spacePresses, maxY: F.maxY, tStart: F.t0, tEnd: t, hpStart: F.hp0, hpEnd: P.hp };
      this.climbs.push(rec);
      if (!ok) this.counters.flightFailures++;
      this.log(`t=${r1(t)} climb ${ok ? 'LANDED' : 'FAILED'} at ${fmtP(pos)}: ${reason}; EN used ${r1(rec.enUsed)}, ${r2(rec.seconds)} s, ${F.flyingFrames} frames 'flying'`);
      this.flight = null;
      this.plan = null;
      this.wasGrounded = P.grounded;
      this.resetWatchdog(t, pos);
      return cmd;
    };
    if (F.hp0 === undefined) F.hp0 = P.hp;
    if (F.airborne && P.grounded) {
      const dl = distH(to, pos);
      if (Math.abs(pos.y - to.y) < 0.05 && dl <= 3.5) return finish(P.en > 0, P.en > 0 ? 'landed' : 'landed with EN 0');
      return finish(false, `touched down at ${fmtP(pos)} instead of the landing surface`);
    }
    if (F.started && !F.airborne && F.frames * this.dt > 0.5) return finish(false, 'the jump did not lift the mech off the take-off surface');
    if (t - F.t0 > 40) return finish(false, 'timeout (40 s)');
    const pts = F.pts;
    let tgt = pts[F.k];
    let dh = distH(tgt, pos);
    while (F.k < pts.length - 1 && dh < 1.0 && pos.y > tgt.y - 0.6) {
      F.k++;
      tgt = pts[F.k];
      dh = distH(tgt, pos);
    }
    const final = F.k === pts.length - 1;
    let err = 0;
    if (dh > 0.25) err = this.steer(tgt.x, tgt.z, pos, cmd).err;
    else cmd.look = this.lookTo(this.yaw, 0);
    if (!F.started && Math.abs(err) > 0.05) {
      cmd.note = 'climb: turning to the landing';
      return cmd; // face the landing before the jump
    }
    const speedRatio = this.stats.airSpeed / PLAYER.flyClimbSpeed;
    const overLanding = final && dh < 1.2;
    const wantY = final ? to.y + 0.7 : tgt.y + 0.3;
    const clearY = final ? to.y + 0.25 : tgt.y - 0.3;
    // advance horizontally only when the remaining climb fits into the remaining horizontal distance
    const canAdvance = pos.y >= clearY || dh > speedRatio * (clearY - pos.y) + 2.0;
    const hold = !overLanding && pos.y < wantY + (F.held ? 0.15 : 0);
    const wasHeld = F.held;
    if (!F.started) {
      F.started = true;
      F.held = true;
    } else F.held = hold;
    if (F.held) F.spaceFrames++;
    if (F.held && !wasHeld) F.spacePresses++;
    F.frames++;
    cmd.keys.KeyW = dh > 0.25 && canAdvance && !overLanding && Math.abs(err) < 0.5;
    cmd.keys.Space = F.held;
    cmd.note = `climb y=${r1(pos.y)}→${r1(to.y)} dh=${r1(dh)} ${P.movement.verticalMode}`;
    return cmd;
  }

  // ───────── yaw / aim self-checks against the snapshot ─────────
  selfCheck(S) {
    const P = S.player;
    const last = this.lastCmd;
    if (last && P.grounded && P.movement.horizontalMode === 'walk') {
      const held = MOVE_KEYS.filter((c) => c !== 'Space' && last.keys[c]);
      const d = P.movement.desiredHorizontalDirection;
      if (held.length === 1 && held[0] === 'KeyW' && (d[0] !== 0 || d[1] !== 0)) {
        const yawObs = Math.atan2(-d[0], -d[1]);
        const err = Math.abs(wrapPi(yawObs - this.yaw));
        this.calib.yawChecks++;
        if (err > this.calib.yawMaxErr) this.calib.yawMaxErr = err;
        if (err > 0.01) {
          this.calib.resyncs++;
          this.log(`t=${r1(S.elapsedSeconds)} yaw estimate off by ${r3(err)} rad — resynchronised from the snapshot`);
          this.yaw = yawObs;
        }
      }
    }
    // free-fire shots reveal the aim direction: muzzle → first hit of the camera-centre ray (yaw AND pitch)
    for (const shot of S.recentPlayerShots) {
      if (shot.id <= this.seenShotId) continue;
      this.seenShotId = shot.id;
      if (shot.weapon === 'missile') {
        this.C.missileReadyAt = shot.firedAtSeconds + WEAPONS.missile.interval;
        const tp = shot.targetPositionAtFire ? V(shot.targetPositionAtFire) : null;
        this.missilesOut.push({ id: shot.targetId, until: shot.firedAtSeconds + (tp ? dist3(V(shot.muzzlePosition), tp) / WEAPONS.missile.speed : 2) + 0.6 });
      }
      // (only a free-fire shot of a frame in which the mech stood still and the view did not turn: position and
      //  angles at the instant of the shot are then those of this snapshot)
      const still = this.prev && Math.hypot(...P.velocity) === 0 && Math.hypot(this.prev.vel.x, this.prev.vel.y, this.prev.vel.z) === 0;
      if (shot.solutionStatus !== 'inactive' || !still || !last || last.look[0] !== 0 || last.look[1] !== 0) continue;
      const pos = V(P.position);
      computeCameraRig(this.world, pos, this.yaw, this.pitch, VW / VH, this.cam);
      const c = this.cam;
      const m = V(shot.muzzlePosition);
      let depth = (m.x - c.pos.x) * c.forward.x + (m.y - c.pos.y) * c.forward.y + (m.z - c.pos.z) * c.forward.z;
      if (!(depth > 0)) depth = 0;
      const start = { x: c.pos.x + c.forward.x * depth, y: c.pos.y + c.forward.y * depth, z: c.pos.z + c.forward.z * depth };
      let dist = 2000;
      const hit = this.world.raycast(start, c.forward, 2000);
      if (hit && hit.dist < dist) dist = hit.dist;
      let viaEnemy = false;
      for (const e of S.enemies) {
        if (!e.alive) continue;
        const ep = V(e.position);
        const ox = ep.x - start.x;
        const oy = ep.y - start.y;
        const oz = ep.z - start.z;
        const b = ox * c.forward.x + oy * c.forward.y + oz * c.forward.z;
        const r = ENEMIES[e.kind].radius;
        const disc = b * b - (ox * ox + oy * oy + oz * oz - r * r);
        if (disc < 0) continue;
        const s = b - Math.sqrt(disc);
        if (s >= 0 && s < dist) {
          dist = s;
          viaEnemy = true;
        }
      }
      if (dist >= 2000) continue; // sky: the game's own far distance is not part of the snapshot
      const ax = start.x + c.forward.x * dist - m.x;
      const ay = start.y + c.forward.y * dist - m.y;
      const az = start.z + c.forward.z * dist - m.z;
      const al = Math.hypot(ax, ay, az) || 1;
      const ld = shot.launchDirection;
      const cos = clamp((ax * ld[0] + ay * ld[1] + az * ld[2]) / al, -1, 1);
      const errDeg = (Math.acos(cos) * 180) / Math.PI;
      this.calib.aimChecks++;
      if (errDeg > this.calib.aimMaxErrDeg) this.calib.aimMaxErrDeg = errDeg;
      if (this.calib.aimLog.length < 12) this.calib.aimLog.push({ t: r3(shot.firedAtSeconds), weapon: shot.weapon, yaw: r3(this.yaw), pitch: r3(this.pitch), aimDist: r1(dist), viaEnemy, errDeg: Number(errDeg.toExponential(2)) });
    }
  }

  // ───────── one decision per frame ─────────
  decide(S) {
    const cmd = { keys: {}, taps: [], fire: false, look: [0, 0], note: '' };
    if (S.state !== 'playing') return cmd;
    const P = S.player;
    const t = S.elapsedSeconds;
    const pos = V(P.position);
    const vel = V(P.velocity);
    this.syncWorld(S.objective);
    this.selfCheck(S);
    this.observeShots(S, pos, vel);
    if (!this.ref) this.resetWatchdog(t, pos);

    // scripted prelude: calibration moves in the sheltered dock (the same in every mode)
    if (this.prelude.length > 0) {
      const step = this.prelude.shift();
      Object.assign(cmd, step);
      cmd.note = 'calibration';
      this.mode = 'calibration';
      return this.done(cmd);
    }

    const R = this.route;
    while (!this.flight && this.k < R.length) {
      const T = R[this.k].position;
      if (P.grounded && distH(T, pos) < 0.75 && Math.abs(T.y - pos.y) < 0.3) {
        this.arrivals[this.k] = t;
        this.k++;
        this.plan = null;
      } else break;
    }
    if (this.k >= R.length) {
      cmd.note = 'end of the route';
      this.mode = 'end';
      return this.done(cmd);
    }
    const T = R[this.k].position;
    const dy = T.y - pos.y;
    const dh = distH(T, pos);

    if (this.flight) {
      this.mode = 'climb';
      return this.done(this.flyStep(S, pos, cmd));
    }
    if (P.grounded && this.fightStep(S, pos, vel, cmd)) {
      this.mode = 'fight';
      this.plan = null;
      this.resetWatchdog(t, pos);
      return this.done(cmd);
    }
    // watchdog: at least 1 m every 4 s while trying to move
    if (t - this.refT > 4) {
      if (dist3(pos, this.ref) < 1 && this.mode !== 'wait-en') {
        this.stuck++;
        this.plan = null;
        this.log(`t=${r1(t)} STUCK near ${fmtP(pos)} on the way to waypoint ${this.k} ${fmtP(T)} (${this.stuck})`);
      }
      this.resetWatchdog(t, pos);
    }
    if (P.grounded && !this.wasGrounded) this.plan = null; // landed: plan again from here
    this.wasGrounded = P.grounded;

    if (!P.grounded) {
      // falling after walking off an edge: keep following the drop plan (or head straight for the waypoint)
      let q = T;
      if (this.plan && this.planKind === 'drop') {
        while (this.pi < this.plan.length - 1 && distH(this.plan[this.pi], pos) < 0.6) this.pi++;
        q = this.plan[this.pi];
      }
      const s = this.steer(q.x, q.z, pos, cmd);
      cmd.keys.KeyW = s.d > 0.3 && Math.abs(s.err) < 0.6;
      cmd.note = 'falling';
      this.mode = 'fall';
      return this.done(cmd);
    }

    if (dy > 0.3) {
      // climb: wait for EN on the ground, then jump + fly
      const need = Math.min(this.stats.maxEn, estimateClimbEn(dy, dh, this.stats.airSpeed) + 10);
      if (P.en < need - 1e-6) {
        this.enWait += this.dt;
        this.steer(T.x, T.z, pos, cmd);
        cmd.note = `waiting for EN ${r1(P.en)} / ${r1(need)}`;
        this.mode = 'wait-en';
        return this.done(cmd);
      }
      const pts = this.an.flightPlan(pos, T, this.closedIds()) ?? [{ ...pos }, { ...T }];
      this.startFlight(S, pos, T, pts);
      this.mode = 'climb';
      return this.done(this.flyStep(S, pos, cmd));
    }

    if (!this.plan) {
      if (dy < -0.3) {
        this.plan = this.an.flightPlan(pos, T, this.closedIds()) ?? [{ ...pos }, { ...T }];
        this.planKind = 'drop';
      } else {
        this.plan = this.an.groundPlan(pos, T, this.closedIds());
        this.planKind = 'ground';
        if (!this.plan) {
          this.counters.noPlan++;
          this.log(`t=${r1(t)} no walkable plan from ${fmtP(pos)} to waypoint ${this.k} ${fmtP(T)} — heading straight for it`);
          this.plan = [{ ...pos }, { ...T }];
        }
      }
      this.pi = 1;
    }
    const plan = this.plan;
    while (this.pi < plan.length - 1 && distH(plan[this.pi], pos) < (this.planKind === 'drop' ? 0.6 : 0.3)) this.pi++;
    const q = plan[this.pi];
    let ax = q.x;
    let az = q.z;
    if (this.planKind === 'ground' && this.pi > 0) {
      // track the planned segment (aim 2.5 m ahead of the own projection onto it) instead of cutting corners
      const a = plan[this.pi - 1];
      const sx = q.x - a.x;
      const sz = q.z - a.z;
      const sl = Math.hypot(sx, sz);
      if (sl > 1e-6) {
        const u = Math.min(1, Math.max(0, ((pos.x - a.x) * sx + (pos.z - a.z) * sz) / (sl * sl)) + 2.5 / sl);
        ax = a.x + sx * u;
        az = a.z + sz * u;
      }
    }
    const s = this.steer(ax, az, pos, cmd);
    const go = s.d > 0.05 && Math.abs(s.err) < 0.6;
    this.mode = 'walk';
    cmd.note = `walk → wp ${this.k}`;
    if (go && this.tactics !== 'plain' && this.planKind === 'ground' && this.bullets.length > 0) {
      // bullets in flight while walking: keep the course unless it runs into them
      const yawAfter = this.yaw - cmd.look[0] * SENS;
      const mv = this.planMove(pos, vel, yawAfter, { x: -Math.sin(yawAfter), z: -Math.cos(yawAfter) }, t, true);
      for (const k of mv.combo.keys) cmd.keys[k] = true;
      if (mv.override) {
        this.counters.walkDodges++;
        this.plan = null;
        cmd.note += ' (side-step)';
      }
    } else cmd.keys.KeyW = go;
    // pressed against something for a second: plan again from where the mech really is
    const moved = this.lastPos ? distH(this.lastPos, pos) : 1;
    const lastS = this.lastCmd && this.lastCmd.frameMs ? this.lastCmd.frameMs / 1000 : this.dt;
    if (this.lastCmd && this.lastCmd.keys.KeyW && moved < 0.2 * lastS) this.blockedFor += lastS;
    else this.blockedFor = 0;
    // a long frame where nothing can happen: straight walk, nobody in sight, no corner within reach
    if (COARSE_MS > 0 && EVERY === 1 && cmd.keys.KeyW && !cmd.keys.KeyA && !cmd.keys.KeyD && !cmd.keys.KeyS && this.planKind === 'ground' && this.blockedFor === 0 && this.bullets.length === 0 && Math.abs(s.err) < 0.03) {
      const reach = this.stats.walkSpeed * (COARSE_MS / 1000) + 1.2;
      let quiet = distH(q, pos) > reach && distH(T, pos) > reach;
      if (quiet) {
        for (const e of S.enemies) {
          if (e.alive && (e.hasLineOfSight || (e.alert && dist3(pos, V(e.position)) < 140))) {
            quiet = false;
            break;
          }
        }
      }
      if (quiet) {
        cmd.frameMs = COARSE_MS;
        this.counters.coarseFrames++;
      }
    }
    if (this.blockedFor > 1) {
      this.plan = null;
      this.blockedFor = 0;
      this.replans++;
    }
    return this.done(cmd, pos);
  }

  done(cmd, pos = null) {
    this.lastCmd = cmd;
    this.lastPos = pos ?? (this.prev ? this.prev.pos : null);
    return cmd;
  }
}

// ───────────────────────────── headless driver (also the shadow of a browser run) ─────────────────────────────
/**
 * The game's frame, without a browser: InputCore (the pure state machine of src/input/input.ts) receives the
 * key / button / mouse-movement events, and one frame does exactly what App.frame does while playing —
 * InputManager.apply (flush + look) and Sim.advance(realDt), with realDt taken from the same clock arithmetic
 * as the page's virtual clock (now += stepMs; realDt = (now − last) / 1000).
 */
class HeadlessGame {
  constructor({ stage, loadout, seed, width, height, stepMs, clockNow }) {
    this.sim = new Sim(stage, { loadout, seed: seed ?? DEFAULT_SEED, viewport: { width, height } });
    this.loadout = loadout;
    this.core = new InputCore();
    this.core.setActive(true);
    this.down = {};
    this.fireDown = false;
    this.stepMs = stepMs;
    this.now = clockNow;
    this.appliedAt = null;
    this.hits = [];
    this.applyInput(); // the first 'playing' frame of the app feeds 0 s
  }

  applyInput() {
    const sim = this.sim;
    const core = this.core;
    const simAdvanced = !(sim.time === this.appliedAt);
    this.appliedAt = sim.time;
    core.flush(sim.input, simAdvanced);
    const dx = core.pendingLookX;
    const dy = core.pendingLookY;
    if (dx !== 0 || dy !== 0) {
      core.clearLook();
      sim.applyLook(-dx * SENS, -dy * SENS);
    }
  }

  snapshot() {
    const sim = this.sim;
    return JSON.parse(JSON.stringify(buildSnapshot(sim, sim.status === 'playing' ? 'playing' : sim.status)));
  }

  /** One frame with the given input: { keys: {code: bool}, taps: [code], fire: bool, look: [dx, dy] }. */
  frame(cmd) {
    const core = this.core;
    for (const code of MOVE_KEYS) {
      const want = !!cmd.keys[code];
      if (want !== !!this.down[code]) {
        if (want) core.press(code, false);
        else core.release(code);
        this.down[code] = want;
      }
    }
    for (const code of cmd.taps) {
      core.press(code, false);
      core.release(code);
    }
    if (cmd.fire !== this.fireDown) {
      core.release(MOUSE_FIRE);
      if (cmd.fire) core.press(MOUSE_FIRE, false, true);
      this.fireDown = cmd.fire;
    }
    if (cmd.look[0] !== 0 || cmd.look[1] !== 0) core.addLook(cmd.look[0], cmd.look[1]);
    this.applyInput();
    const last = this.now;
    this.now += cmd.frameMs ?? this.stepMs;
    this.sim.advance((this.now - last) / 1000);
    for (const ev of this.sim.drainEvents()) {
      if (ev.type !== 'player-damaged') continue;
      const e = ev.fromEnemyId ? this.sim.enemyById.get(ev.fromEnemyId) : null;
      // (who fired the bullet that hit, and what that enemy is doing at the end of the frame of the hit)
      this.hits.push({ t: r3(this.sim.time), amount: ev.amount, from: ev.fromEnemyId, shooterAlive: e ? e.alive : null, shooterHasLos: e ? e.hasLos : null, secondsSinceItsLastShot: e && e.lastShotAt !== null ? r3(this.sim.time - e.lastShotAt) : null, flightMeters: r1(dist3(ev.sourcePos, this.sim.player.pos)), muzzleToMechBlockedNow: this.sim.world.segmentBlocked(ev.sourcePos, this.sim.player.pos) });
    }
    return this.snapshot();
  }
}

class DryDriver {
  constructor(o) {
    this.o = o;
    this.kind = 'dry';
  }
  async start() {
    this.game = new HeadlessGame({ ...this.o, clockNow: 1000 });
    return this.game.snapshot();
  }
  async step(cmd) {
    let s = this.game.frame(cmd);
    for (let i = 1; i < EVERY && s.state === 'playing'; i++) s = this.game.frame({ ...cmd, taps: [], look: [0, 0] });
    return { s, lookDx: cmd.look[0], lookDy: cmd.look[1], waited: 0 };
  }
  async screenshot() {
    return null;
  }
  async close() {}
}

// ───────────────────────────── browser driver ─────────────────────────────
/**
 * Test-side page helper (context.addInitScript, runs before the page's own scripts; never in the shipped
 * page): counts the trusted mouse movement the page receives and steps the virtual clock of lib.mjs by
 * exactly one frame once the mouse event of the step has arrived.
 */
function botPageInit() {
  const B = (window.__bot = { moves: 0, sumX: 0, sumY: 0, big: 0, arm: null, log: [], hold: false, held: new Map(), after: null });
  // Frame pacing: while `hold` is on and the virtual clock has no budget, the page's animation-frame callbacks
  // are kept back instead of being run with a frame time of 0. The game then renders exactly one frame per
  // step — the display simply does not refresh while the bot thinks — and no software-rendered frame is wasted.
  const libRaf = window.requestAnimationFrame.bind(window); // the virtual-clock wrapper of lib.mjs
  const libCancel = window.cancelAnimationFrame.bind(window);
  let heldId = 1e9;
  window.requestAnimationFrame = (cb) => {
    if (B.hold && window.__e2e.clock.budget === 0) {
      B.held.set(++heldId, cb);
      return heldId;
    }
    return libRaf(cb);
  };
  window.cancelAnimationFrame = (id) => {
    if (!B.held.delete(id)) libCancel(id);
  };
  /** Lets the kept-back callbacks run in the next rendered frame; `B.after` is called once they have run. */
  B.release = () => {
    const cbs = [...B.held.values()];
    B.held.clear();
    let left = cbs.length;
    for (const cb of cbs) {
      libRaf((ts) => {
        try {
          cb(ts);
        } finally {
          if (--left === 0 && B.after) {
            const a = B.after;
            B.after = null;
            a();
          }
        }
      });
    }
    return cbs.length;
  };
  B.setHold = (on) => {
    B.hold = on;
    if (!on) B.release();
  };
  /** One frame with a frame time of 0 (redraw only), e.g. before a screenshot. */
  B.idleFrame = () =>
    new Promise((resolve) => {
      if (B.held.size === 0) return libRaf(() => libRaf(() => libRaf(() => resolve(false))));
      B.after = () => resolve(true);
      B.release();
    });
  window.addEventListener(
    'mousemove',
    (e) => {
      if (!e.isTrusted) return;
      const mx = e.movementX;
      const my = e.movementY;
      if (mx === 0 && my === 0) return;
      B.moves++;
      // (the game ignores a single event of more than 2000 px: MAX_MOUSE_STEP in src/input/input.ts)
      if (Math.abs(mx) <= 2000 && Math.abs(my) <= 2000) {
        B.sumX += mx;
        B.sumY += my;
      } else B.big++;
      if (B.log.length < 400) B.log.push([mx, my, e.clientX, e.clientY, document.pointerLockElement !== null]);
      if (B.arm && B.moves >= B.arm.moves) {
        const a = B.arm;
        B.arm = null;
        a.go();
      }
    },
    true,
  );
  B.readHud = () => {
    const hud = document.querySelector('.ak2-hud');
    if (!hud) return null;
    const q = (sel) => {
      const e = hud.querySelector(sel);
      return e ? e.textContent : null;
    };
    const banner = hud.querySelector('.hud-banner');
    return {
      visible: getComputedStyle(hud).display !== 'none',
      hp: q('.hud-hphead .num'),
      hpMax: q('.hud-hphead .max'),
      en: q('.hud-enhead .num'),
      enMax: q('.hud-enhead .max'),
      ctrl: q('.hud-ctrl .n'),
      barriers: [...hud.querySelectorAll('.hud-bcell')].map((e) => e.textContent),
      gate: q('.hud-gate .v'),
      banner: banner ? !banner.classList.contains('is-off') : null,
      bannerText: q('.hud-banner .m'),
      sector: q('.hud-sector'),
      objective: q('.hud-objective .t'),
      route: q('.hud-route .t'),
      mg: q('.hud-wrow[data-w="machinegun"] .ammo'),
      missile: q('.hud-wrow[data-w="missile"] .ammo'),
      selected: (hud.querySelector('.hud-wrow.selected') || { getAttribute: () => null }).getAttribute('data-w'),
      lock: hud.getAttribute('data-lock'),
      lockLabel: q('.hud-locklabel'),
      hMode: (hud.querySelector('.hud-mode .cell:nth-child(1) .v') || { getAttribute: () => null }).getAttribute('data-m'),
      vMode: (hud.querySelector('.hud-mode .cell:nth-child(2) .v') || { getAttribute: () => null }).getAttribute('data-m'),
    };
  };
  B.collect = (o, waited, called, frames0) => {
    const out = { s: window.__AK2__.getSnapshot(), moves: B.moves, sumX: B.sumX, sumY: B.sumY, big: B.big, waited, frames: window.__e2e.clock.frames, now: window.__e2e.clock.now, pageMs: performance.now() - called, realFrames: window.__e2e.clock.frames - frames0 };
    if (o.hud) out.hud = B.readHud();
    return out;
  };
  /** One step: when `o.moves` trusted mouse moves have arrived (or `o.patience` frames passed), run exactly `o.frames` frames of o.stepMs. */
  B.step = (o) =>
    new Promise((resolve) => {
      const clock = window.__e2e.clock;
      const called = performance.now();
      const frames0 = clock.frames;
      let armed = false;
      let waited = 0;
      let finished = false;
      let viaAfter = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve(B.collect(o, waited, called, frames0));
      };
      const go = () => {
        clock.step = o.stepMs;
        clock.budget = o.frames;
        armed = true;
        // held frames (one frame per step): the game's frame runs next and the step ends right behind it
        if (B.held.size > 0 && o.frames === 1) {
          viaAfter = true;
          B.after = finish;
          B.release();
        }
      };
      if (B.moves >= o.moves) go();
      else B.arm = { moves: o.moves, go };
      const f = () => {
        if (finished) return;
        // (with kept-back frames this callback can run BEFORE the game's frame of the step: only B.after ends it)
        if (armed && !viaAfter && clock.budget === 0) return finish();
        if (!armed && ++waited >= o.patience) {
          B.arm = null;
          go(); // the step runs without the missing mouse event
        }
        libRaf(f);
      };
      libRaf(f);
    });
}

class BrowserDriver {
  constructor(o) {
    this.o = o;
    this.kind = 'browser';
    this.down = {};
    this.fireDown = false;
    this.ptr = { x: 0, y: 0 };
    this.moves = 0;
    this.sumX = 0;
    this.sumY = 0;
    this.resizes = [];
    this.onResize = null;
    this.stats = { steps: 0, lookEvents: 0, liftAndSet: 0, undelivered: 0, lateLook: 0, lookMismatch: 0, bigEvents: 0, wallMs: 0, skippedSmall: 0, inputMs: 0, pageMs: 0, realFrames: 0 };
  }

  async open() {
    this.browser = await launch();
    const query = this.o.seed === null ? null : { seed: this.o.seed };
    this.game = await openGame(this.browser, { path: this.o.path ?? '', width: this.o.width, height: this.o.height, query, scripted: { lock: true, clock: true }, initScript: botPageInit });
    this.page = this.game.page;
    this.cdp = await this.page.context().newCDPSession(this.page);
    if (PLAY_DPR !== 1) await this.setScale(PLAY_DPR);
  }

  /** Test-side display emulation: window size (CSS px) and devicePixelRatio. Returns once the canvas has followed. */
  async setDisplay(width, height, scale) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await this.page.waitForFunction(
      ([w, h, v]) => {
        const c = document.querySelector('canvas');
        return window.devicePixelRatio === v && window.innerWidth === w && window.innerHeight === h && (!c || (c.clientWidth === w && c.clientHeight === h));
      },
      [width, height, scale],
      { polling: 20, timeout: TIMEOUT },
    );
  }
  setScale(scale) {
    return this.setDisplay(this.o.width, this.o.height, scale);
  }

  /** Garage → 'playing' at t = 0 with the virtual clock standing still. Returns the t = 0 snapshot. */
  async start() {
    const page = this.page;
    await evaluate(page, () => {
      window.__e2e.clock.budget = 0;
    });
    const garage = await selectLoadout(page, this.o.loadoutExplicit ? this.o.loadout : {});
    this.garageSnapshot = garage;
    await this.clickAct('sortie');
    await waitForState(page, 'playing');
    return this.settle();
  }

  /** A real click on the centre (whole CSS px) of a visible, uncovered button; the pointer stays there. */
  async clickAct(act) {
    const page = this.page;
    const loc = page.locator(`[data-act="${act}"]`).first();
    await loc.waitFor({ state: 'visible', timeout: TIMEOUT });
    const hit = await loc.evaluate((el) => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const top = document.elementFromPoint(x, y);
      return { x, y, ok: !!top && (top === el || el.contains(top)), disabled: el.disabled === true };
    });
    if (!hit.ok || hit.disabled) throw new Error(`button "${act}" is ${hit.disabled ? 'disabled' : 'covered'}`);
    await page.mouse.move(hit.x, hit.y);
    await page.mouse.down();
    await page.mouse.up();
    this.ptr = { x: hit.x, y: hit.y };
  }

  /** After a click that started a sortie: counters read, clock value noted, nothing held. */
  async settle() {
    const page = this.page;
    await sleep(150);
    const info = await evaluate(page, () => ({ s: window.__AK2__.getSnapshot(), moves: window.__bot.moves, sumX: window.__bot.sumX, sumY: window.__bot.sumY, now: window.__e2e.clock.now, locked: document.pointerLockElement !== null }));
    this.moves = info.moves;
    this.sumX = info.sumX;
    this.sumY = info.sumY;
    this.clockNow = info.now;
    this.down = {};
    this.fireDown = false;
    if (!info.locked) throw new Error('the scripted pointer lock is not held after the sortie click');
    this.pointerStart = { ...this.ptr };
    this.display = await evaluate(page, () => {
      const c = document.querySelector('canvas');
      return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio, canvasCss: [c.clientWidth, c.clientHeight], canvasBuffer: [c.width, c.height] };
    });
    if (HOLD) await this.setHold(true);
    return info.s;
  }

  /** Frame pacing on / off (see botPageInit). On: returns once the game's next frame is being kept back. */
  async setHold(on) {
    await evaluate(this.page, (v) => window.__bot.setHold(v), on);
    if (on) await this.page.waitForFunction(() => window.__bot.held.size > 0, null, { polling: 20, timeout: TIMEOUT });
  }

  /**
   * Mouse positions that make the page receive exactly (dx, dy): a plain move when the pointer has room,
   * otherwise "lift and set down" — a move to a point just outside the viewport (not delivered) and the move
   * from there to a point inside. Returns null when neither fits (tiny move at the border): the pilot simply
   * asks again in the next frame.
   */
  planLook(dx, dy) {
    const { width: w, height: h } = this.o;
    const p = this.ptr;
    const tx = p.x + dx;
    const ty = p.y + dy;
    if (tx >= 3 && tx <= w - 4 && ty >= 3 && ty <= h - 4) return [{ x: tx, y: ty, delivered: true }];
    const midY = Math.round(h / 2);
    const midX = Math.round(w / 2);
    if (dx >= 6) return [{ x: -3, y: midY - dy, delivered: false }, { x: dx - 3, y: midY, delivered: true }];
    if (dx <= -6) return [{ x: w + 2, y: midY - dy, delivered: false }, { x: w + 2 + dx, y: midY, delivered: true }];
    if (dy >= 6) return [{ x: midX - dx, y: -3, delivered: false }, { x: midX, y: dy - 3, delivered: true }];
    if (dy <= -6) return [{ x: midX - dx, y: h + 2, delivered: false }, { x: midX, y: h + 2 + dy, delivered: true }];
    return null;
  }

  async step(cmd, opt = {}) {
    const page = this.page;
    const t0 = Date.now();
    for (const code of MOVE_KEYS) {
      const want = !!cmd.keys[code];
      if (want !== !!this.down[code]) {
        if (want) await page.keyboard.down(code);
        else await page.keyboard.up(code);
        this.down[code] = want;
      }
    }
    for (const code of cmd.taps) {
      await page.keyboard.down(code);
      await page.keyboard.up(code);
    }
    const [dx, dy] = cmd.look;
    const moves = dx !== 0 || dy !== 0 ? this.planLook(dx, dy) : [];
    if (moves === null) this.stats.skippedSmall++;
    const lift = !!moves && moves.length === 2;
    // (a held button would capture the pointer: the move outside the viewport would be delivered as a drag)
    if (lift && this.fireDown && cmd.fire) {
      await page.mouse.up();
      this.fireDown = false;
    }
    if (cmd.fire !== this.fireDown && !(lift && cmd.fire)) {
      if (cmd.fire) await page.mouse.down();
      else await page.mouse.up();
      this.fireDown = cmd.fire;
    }
    const pending = [];
    let expect = this.moves;
    if (moves) {
      for (const m of moves) {
        // The move to the point outside the viewport is awaited: sent back to back with the next one the two
        // are merged and the page gets the movement from the OLD position (measured). The move that is
        // delivered is not awaited here — the browser hands it to the page with the next frame.
        if (m.delivered) pending.push(page.mouse.move(m.x, m.y));
        else await page.mouse.move(m.x, m.y);
        this.ptr = { x: m.x, y: m.y };
        if (m.delivered) expect++;
      }
      if (moves.length > 0) this.stats.lookEvents++;
      if (lift) this.stats.liftAndSet++;
    }
    if (lift && cmd.fire && !this.fireDown) {
      // pressed again behind the mouse move: the trigger is down for the whole frame (the press is latched)
      pending.push(page.mouse.down());
      this.fireDown = true;
    }
    this.stats.inputMs += Date.now() - t0;
    const r = await evaluate(page, (o) => window.__bot.step(o), { stepMs: cmd.frameMs ?? this.o.stepMs, frames: EVERY, moves: expect, patience: 6, hud: !!opt.hud });
    this.stats.pageMs += r.pageMs;
    this.stats.realFrames += r.realFrames;
    await Promise.all(pending);
    const got = [r.sumX - this.sumX, r.sumY - this.sumY];
    if (r.moves < expect) this.stats.undelivered += expect - r.moves;
    if (r.waited >= 6) this.stats.lateLook++;
    const want = moves && moves.length > 0 ? [dx, dy] : [0, 0];
    if (got[0] !== want[0] || got[1] !== want[1]) {
      this.stats.lookMismatch++;
      if (this.stats.lookMismatch <= 10) say(`  look mismatch at step ${this.stats.steps}: wanted ${want}, the page received ${got} (events ${r.moves - this.moves}, waited ${r.waited})`);
    }
    this.stats.bigEvents = r.big;
    this.moves = r.moves;
    this.sumX = r.sumX;
    this.sumY = r.sumY;
    this.stats.steps++;
    this.stats.wallMs += Date.now() - t0;
    return { s: r.s, lookDx: got[0], lookDy: got[1], hud: r.hud ?? null, waited: r.waited, clockNow: r.now };
  }

  async releaseAll() {
    for (const code of MOVE_KEYS) {
      if (this.down[code]) await this.page.keyboard.up(code);
      this.down[code] = false;
    }
    if (this.fireDown) await this.page.mouse.up();
    this.fireDown = false;
  }

  async hud() {
    return evaluate(this.page, () => window.__bot.readHud());
  }

  /** Screenshot (the virtual clock stands still: game time does not move; `settleMs` lets CSS transitions finish). */
  async screenshot(name, settleMs = 500) {
    if (!OUT) return null;
    const dir = path.join(OUT, 'shots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name.endsWith('.png') ? name : name + '.png');
    const resized = SW !== this.o.width || SH !== this.o.height || SHOT_DPR !== PLAY_DPR;
    if (resized) {
      // The picture is taken in a window of the screenshot size: a real resize (the game follows it through
      // its own resize handling: lock circle, camera aspect, HUD layout), redrawn with a frame time of 0.
      await this.setDisplay(SW, SH, SHOT_DPR);
      await evaluate(this.page, () => window.__bot.idleFrame());
      await evaluate(this.page, () => window.__bot.idleFrame());
    }
    if (settleMs > 0) await sleep(settleMs);
    let radius = null;
    if (resized) radius = await evaluate(this.page, () => window.__AK2__.getSnapshot().lock.radiusCssPx);
    const png = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
    if (resized) {
      await this.setDisplay(this.o.width, this.o.height, PLAY_DPR);
      await evaluate(this.page, () => window.__bot.idleFrame());
      this.resizes.push({ name, lockRadiusCssPxAtShot: radius });
      if (this.onResize) this.onResize(SW, SH);
      if (this.onResize) this.onResize(this.o.width, this.o.height);
    }
    return file;
  }

  async close() {
    try {
      await this.browser.close();
    } catch {
      /* already gone */
    }
  }
}

// ───────────────────────────── HUD ↔ snapshot ─────────────────────────────
/** Compares the HUD's text with the snapshot of the same frame. Returns a list of contradictions. */
function hudContradictions(hud, S, stage) {
  const bad = [];
  if (!hud) return ['no HUD element'];
  const P = S.player;
  const expect = (name, got, want) => {
    if (got !== want) bad.push(`${name}: HUD "${got}" ≠ snapshot "${want}"`);
  };
  if (!hud.visible) bad.push('HUD not displayed');
  expect('HP', hud.hp, String(Math.max(0, Math.ceil(P.hp - 1e-9))));
  expect('EN', hud.en, (Math.round(P.en * 10) / 10).toFixed(1));
  expect('EN max', (hud.enMax || '').replace(/[^0-9]/g, ''), String(S.effectiveStats.maxEn));
  expect('control turrets', hud.ctrl, `${S.objective.controlsDestroyed}/${S.objective.controlsRequired}`);
  stage.barriers.forEach((b, i) => {
    const cell = hud.barriers[i] || '';
    const open = S.objective.openBarrierIds.includes(b.id);
    if (!cell.startsWith(b.id) || cell.includes('開放') !== open || cell.includes('閉鎖') === open) bad.push(`barrier ${b.id}: HUD "${cell}" ≠ snapshot ${open ? 'open' : 'closed'}`);
  });
  if (S.objective.gateOpen !== (hud.gate || '').includes('開放')) bad.push(`final gate: HUD "${hud.gate}" ≠ snapshot gateOpen ${S.objective.gateOpen}`);
  if (S.objective.gateOpen !== hud.banner) bad.push(`escape banner shown ${hud.banner} ≠ snapshot gateOpen ${S.objective.gateOpen}`);
  if (S.stage.currentSectorId !== null && !(hud.sector || '').startsWith(S.stage.currentSectorId)) bad.push(`sector: HUD "${hud.sector}" ≠ snapshot ${S.stage.currentSectorId}`);
  // objective text: the next control turret and its barrier while one is left, the exit afterwards
  const next = stage.barriers.find((b) => !S.objective.openBarrierIds.includes(b.id));
  const obj = hud.objective || '';
  if (next && !(obj.includes(next.controlEnemyId) && obj.includes(next.id))) bad.push(`objective: HUD "${obj}" does not name ${next.controlEnemyId} / ${next.id}`);
  if (!next && !/脱出|EXIT|ゲート/.test(obj)) bad.push(`objective: HUD "${obj}" does not point to the exit although all barriers are open`);
  expect('machine-gun ammo', (hud.mg || '').split('/')[0].trim(), String(P.ammo.machinegun));
  expect('missile ammo', (hud.missile || '').split('/')[0].trim(), String(P.ammo.missile));
  expect('selected weapon', hud.selected, P.weapon);
  expect('lock state', hud.lock, S.lock.state);
  expect('horizontal mode', hud.hMode, P.movement.horizontalMode);
  expect('vertical mode', hud.vMode, P.movement.verticalMode);
  return bad;
}

/**
 * Largest numeric deviation between two JSON values of the same shape and the first place where they differ
 * in anything else (structure, strings, booleans, null). { dev, where, other }
 */
function deviation(a, b, where = '', out = { dev: 0, where: null, other: null }) {
  if (typeof a === 'number' && typeof b === 'number') {
    const d = Math.abs(a - b);
    if (d > out.dev) {
      out.dev = d;
      out.where = where;
    }
    return out;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b && !out.other) out.other = `${where}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a) || !(k in b)) {
      if (!out.other) out.other = `${where}.${k}: missing on one side`;
      continue;
    }
    deviation(a[k], b[k], where ? `${where}.${k}` : k, out);
  }
  return out;
}

/** First difference between two JSON values as "path: a ≠ b" (null = equal). */
function firstDiff(a, b, where = '') {
  if (isDeepStrictEqual(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return `${where}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], where ? `${where}.${k}` : k);
    if (d) return d;
  }
  return `${where}: differs`;
}

/**
 * After the sortie ended (cleared / failed): reads the result screen, takes its picture, clicks
 * 同じ構成で再出撃 and compares the whole t = 0 snapshot with that of the first sortie.
 */
async function resultAndResortie(driver, S, S0, shot) {
  const page = driver.page;
  const out = {};
  await page.locator('[data-act="restart"]').first().waitFor({ state: 'visible', timeout: TIMEOUT });
  out.resultScreen = await evaluate(page, () => {
    const t = document.querySelector('.res-title');
    let panel = t;
    while (panel && panel.parentElement && !panel.querySelector('[data-act="restart"]')) panel = panel.parentElement;
    const hud = document.querySelector('.ak2-hud');
    return {
      title: t ? t.textContent : null,
      text: panel ? panel.innerText.replace(/\s+/g, ' ').trim().slice(0, 700) : null,
      buttons: [...document.querySelectorAll('[data-act]')].filter((b) => b.offsetParent !== null).map((b) => `${b.getAttribute('data-act')}: ${b.textContent.trim()}`),
      hudDisplay: hud ? getComputedStyle(hud).display : null,
      pointerLocked: document.pointerLockElement !== null,
    };
  });
  say(`  result screen: ${JSON.stringify(out.resultScreen)}`);
  await shot(S.state === 'cleared' ? '09-result-mission-clear' : '09-result-mission-failed', `result screen (${S.state})`, 800);
  await driver.clickAct('restart');
  await waitForState(page, 'playing');
  const again = await driver.settle();
  const diff = firstDiff(S0, again);
  out.resortie = { state: again.state, t: again.elapsedSeconds, identicalToFirstSortie: diff === null, firstDifference: diff };
  say(`  re-sortie: state ${again.state}, t = ${again.elapsedSeconds}, whole t = 0 snapshot identical to the first sortie: ${diff === null}${diff ? ' — ' + diff : ''}`);
  await shot('10-resortie-t0', 're-sortie with the same loadout, t = 0');
  return out;
}

/**
 * Self-test of the end-of-sortie handling on the mini stage (dev/app-test.html, not the shipped page):
 * S is held until the mech falls off → 'failed' → result screen → re-sortie → t = 0 comparison.
 */
async function miniFall() {
  const driver = new BrowserDriver({ loadout: LOADOUT, loadoutExplicit: false, seed: SEED, width: VW, height: VH, stepMs: STEP_MS, path: 'dev/app-test.html' });
  const res = { label: LABEL, mode: 'self-test on the mini stage (dev/app-test.html)', shots: [], steps: 0 };
  try {
    await driver.open();
    let S = await driver.start();
    const S0 = S;
    const shot = async (name, why, settle) => {
      const file = await driver.screenshot(name, settle);
      if (file) res.shots.push({ file, why });
      return file;
    };
    await shot('00-sortie', 'mini stage, t = 0');
    while (S.state === 'playing' && S.elapsedSeconds < 30) {
      const r = await driver.step({ keys: { KeyS: true }, taps: [], fire: false, look: [res.steps % 2 ? 40 : -40, 0] });
      S = r.s;
      res.steps++;
    }
    res.end = { state: S.state, t: S.elapsedSeconds, hp: S.player.hp, pos: S.player.position };
    say(`mini stage: ${S.state} at t = ${S.elapsedSeconds}, pos ${S.player.position.map(r1)}`);
    await driver.releaseAll();
    if (HOLD) await driver.setHold(false);
    if (S.state !== 'playing') Object.assign(res.end, await resultAndResortie(driver, S, S0, shot));
    res.mouse = driver.stats;
    res.pageErrors = driver.game.errors.slice(0, 20);
  } catch (err) {
    res.error = String(err && err.stack ? err.stack : err);
    say('ERROR ' + res.error);
  } finally {
    await driver.close();
  }
  return res;
}

// ───────────────────────────── one attempt ─────────────────────────────
async function attempt(ctx) {
  const { stage, an } = ctx;
  const world = new World(stage);
  const notes = [];
  const log = (text) => {
    notes.push(text);
    say('  ' + text);
  };
  const pilot = new Pilot({ stage, an, world, loadout: LOADOUT, dt: DT, tactics: TACTICS, log });
  // calibration prelude: turn right 200 px with W (yaw from the snapshot), turn back, look up-right and fire
  // one machine-gun round into the dock (free aim → launch direction → yaw and pitch), look back.
  pilot.prelude = [
    { keys: { KeyW: true }, taps: [], fire: false, look: [200, 0] },
    { keys: { KeyW: true }, taps: [], fire: false, look: [-200, 0] },
    { keys: {}, taps: [], fire: false, look: [150, -80] },
    { keys: {}, taps: [], fire: false, look: [0, 0] },
    { keys: {}, taps: [], fire: false, look: [0, 0] },
    { keys: {}, taps: [], fire: false, look: [0, 0] },
    { keys: {}, taps: [], fire: true, look: [0, 0] },
    { keys: {}, taps: [], fire: false, look: [0, 0] },
    { keys: {}, taps: [], fire: false, look: [-150, 80] },
  ];
  const driverOpts = { stage, loadout: LOADOUT, loadoutExplicit: !!arg('loadout'), seed: SEED, width: VW, height: VH, stepMs: STEP_MS };
  const driver = DRY ? new DryDriver(driverOpts) : new BrowserDriver(driverOpts);
  const res = {
    label: LABEL,
    mode: DRY ? 'dry (headless Sim, NOT evidence about the page)' : 'browser',
    url: DRY ? null : BASE_URL,
    viewport: [VW, VH],
    screenshotViewport: [SW, SH],
    devicePixelRatio: { playing: PLAY_DPR, screenshots: SHOT_DPR },
    fps: FPS,
    framesPerDecision: EVERY,
    frameMs: { normal: STEP_MS, quietStraightWalk: COARSE_MS > 0 ? COARSE_MS : STEP_MS },
    framePacing: HOLD ? 'game frames kept back between steps' : 'free (frames with a frame time of 0 between steps)',
    seed: SEED ?? DEFAULT_SEED,
    loadout: LOADOUT,
    tactics: TACTICS,
    milestones: [],
    barriers: [],
    kills: [],
    hpCurve: [],
    damage: [],
    hud: { checks: 0, contradictions: 0, first: [] },
    shots: [],
    shadow: SHADOW ? { frames: 0, identical: 0, close: 0, tolerance: SHADOW_TOL, maxDeviation: 0, maxDeviationAt: null, firstDiff: null, firstRealDiff: null, growth: [], noted: 0, otherNoted: false } : null,
    notes,
  };
  let logStream = null;
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    logStream = fs.createWriteStream(path.join(OUT, `log-${LABEL}.jsonl`));
  }
  const wall0 = Date.now();
  let S;
  let frame = 0;
  let stopReason = '';
  try {
    if (!DRY) await driver.open();
    S = await driver.start();
    const S0 = S;
    res.t0 = { state: S.state, t: S.elapsedSeconds, pos: S.player.position, hp: S.player.hp, en: S.player.en, lockRadiusCssPx: S.lock.radiusCssPx, sectorCount: S.stage.sectorCount, version: S.version, seed: S.seed, loadout: S.loadout, display: driver.display ?? null, pointerStart: driver.pointerStart ?? null };
    say(`sortie: state ${S.state}, t = ${S.elapsedSeconds}, seed ${S.seed}, loadout ${JSON.stringify(S.loadout)}, lock radius ${S.lock.radiusCssPx} px, ${S.stage.sectorCount} sectors, ${S.enemies.length} enemies`);
    if (S.state !== 'playing' || S.elapsedSeconds !== 0) throw new Error(`the sortie did not start at t = 0 in 'playing' (state ${S.state}, t ${S.elapsedSeconds})`);
    const shadow = SHADOW ? new HeadlessGame({ ...driverOpts, clockNow: driver.clockNow }) : null;
    if (!DRY) {
      // Math.sin / Math.cos of the page's engine against this process's engine, for every yaw one mouse pixel apart
      const n = Math.round((2 * Math.PI) / SENS);
      const page = await evaluate(driver.page, ([count, sens]) => {
        const out = [];
        for (let i = 0; i < count; i++) out.push(Math.sin(-i * sens), Math.cos(-i * sens));
        return out;
      }, [n, SENS]);
      let differ = 0;
      let worst = 0;
      for (let i = 0; i < n; i++) {
        const ds = Math.abs(page[2 * i] - Math.sin(-i * SENS));
        const dc = Math.abs(page[2 * i + 1] - Math.cos(-i * SENS));
        if (ds > 0 || dc > 0) differ++;
        worst = Math.max(worst, ds, dc);
      }
      res.trig = { anglesCompared: n, anglesWithDifferentSinOrCos: differ, largestDifference: worst };
    }
    if (shadow) {
      // a window resize for a screenshot reaches the shadow as the same Sim.setViewport calls
      driver.onResize = (w, h) => shadow.sim.setViewport(w, h);
      const d0 = firstDiff(S, shadow.snapshot());
      res.shadow.t0Identical = d0 === null;
      if (d0) say('  shadow: t = 0 snapshot differs: ' + d0);
    }
    const shot = async (name, why, settle) => {
      const file = await driver.screenshot(name, settle);
      if (file) res.shots.push({ file, why, t: S.elapsedSeconds, frame });
      return file;
    };
    const mark = (id, name, extra = {}) => {
      const m = { id, name, t: r3(S.elapsedSeconds), frame, hp: S.player.hp, en: r1(S.player.en), pos: S.player.position.map(r2), sector: S.stage.currentSectorId, objective: { ...S.objective }, wallMinutes: r1((Date.now() - wall0) / 60000), ...extra };
      res.milestones.push(m);
      say(`MILESTONE ${id}: ${name} — t = ${m.t} s, HP ${m.hp}, EN ${m.en}, pos ${JSON.stringify(m.pos)}, ${m.sector}, controls ${m.objective.controlsDestroyed}/6, barriers [${m.objective.openBarrierIds}], gate ${m.objective.gateOpen}`);
      return m;
    };
    const checkHud = async (hud, why) => {
      if (!hud) return;
      res.hud.checks++;
      const bad = hudContradictions(hud, S, stage);
      if (bad.length > 0) {
        res.hud.contradictions++;
        if (res.hud.first.length < 10) res.hud.first.push({ t: S.elapsedSeconds, frame, why, bad, hud });
        say(`  HUD CONTRADICTION at t = ${r2(S.elapsedSeconds)} (${why}): ${bad.join('; ')}`);
      }
      return bad;
    };
    await shot('00-sortie', 'sortie, t = 0');

    let prevS = S;
    let lastHp = S.player.hp;
    let nextHudAt = 0;
    let nextCurveAt = 0;
    let m2 = false;
    let flightShot = false;
    let lastReport = 0;
    let lastWall = 0;
    let lastFrame = 0;
    const extra = {};
    const done = new Set();
    const hudEvery = 2; // seconds of game time
    for (;;) {
      const cmd = pilot.decide(S);
      if (S.state !== 'playing') {
        stopReason = `state ${S.state}`;
        break;
      }
      if (S.elapsedSeconds > MAX_SIM) {
        stopReason = `gave up after ${MAX_SIM} s of game time`;
        break;
      }
      if (pilot.stuck >= 6) {
        stopReason = 'stuck 6 times';
        break;
      }
      const wantHud = !DRY && S.elapsedSeconds >= nextHudAt;
      const r = await driver.step(cmd, { hud: wantHud });
      frame++;
      pilot.lookApplied(r.lookDx, r.lookDy);
      S = r.s;
      if (shadow) {
        // the shadow gets what the page got: the same keys / buttons, and the mouse movement as delivered
        let sh = shadow.frame({ ...cmd, look: [r.lookDx, r.lookDy] });
        for (let i = 1; i < EVERY && sh.state === 'playing'; i++) sh = shadow.frame({ ...cmd, taps: [], look: [0, 0] });
        res.shadow.frames++;
        if (isDeepStrictEqual(sh, S)) {
          res.shadow.identical++;
          res.shadow.close++;
        } else {
          const dv = deviation(S, sh);
          if (dv.dev > res.shadow.maxDeviation) {
            res.shadow.maxDeviation = dv.dev;
            res.shadow.maxDeviationAt = { frame, t: S.elapsedSeconds, where: dv.where };
          }
          // how the difference grows: one entry whenever it is ten times larger than the last one noted
          if ((dv.dev > res.shadow.noted * 10 || (dv.other && !res.shadow.otherNoted)) && res.shadow.growth.length < 60) {
            res.shadow.noted = Math.max(dv.dev, 1e-300);
            if (dv.other) res.shadow.otherNoted = true;
            res.shadow.growth.push({ frame, t: r3(S.elapsedSeconds), deviation: Number(dv.dev.toExponential(2)), where: dv.where, other: dv.other });
          }
          if (!dv.other && dv.dev <= SHADOW_TOL) res.shadow.close++;
          else if (!res.shadow.firstRealDiff) {
            res.shadow.firstRealDiff = { frame, t: S.elapsedSeconds, diff: dv.other ?? `${dv.where}: deviation ${dv.dev}` };
            say(`  shadow: first difference beyond ${SHADOW_TOL} at frame ${frame} (t = ${S.elapsedSeconds}): ${res.shadow.firstRealDiff.diff}`);
          }
          if (!res.shadow.firstDiff) res.shadow.firstDiff = { frame, t: S.elapsedSeconds, diff: firstDiff(S, sh) };
        }
      }
      const P = S.player;
      if (wantHud) {
        nextHudAt = S.elapsedSeconds + hudEvery;
        await checkHud(r.hud, 'periodic');
      }
      // per-frame log
      if (logStream) logStream.write(JSON.stringify([frame, r3(S.elapsedSeconds), ...P.position.map(r2), P.hp, r1(P.en), pilot.k, pilot.mode, pilot.C.target, S.stage.currentSectorId, S.lock.state, P.weapon, Object.keys(cmd.keys).filter((k) => cmd.keys[k]).join('+'), cmd.fire ? 1 : 0, cmd.look, r.waited, cmd.note]) + '\n');
      if (S.elapsedSeconds >= nextCurveAt) {
        nextCurveAt = Math.floor(S.elapsedSeconds) + 1;
        res.hpCurve.push([r1(S.elapsedSeconds), P.hp, r1(P.en), S.stage.currentSectorId, pilot.k]);
      }
      // damage taken
      if (P.hp < lastHp) {
        const shooters = S.enemies.filter((e) => e.alive && e.hasLineOfSight).map((e) => e.id);
        res.damage.push({ t: r2(S.elapsedSeconds), lost: lastHp - P.hp, hp: P.hp, sector: S.stage.currentSectorId, pos: P.position.map(r1), mode: pilot.mode, enemiesWithLos: shooters });
      }
      lastHp = P.hp;
      // kills
      for (const e of S.enemies) {
        const pe = prevS.enemies.find((x) => x.id === e.id);
        if (pe && pe.alive && !e.alive) res.kills.push({ id: e.id, t: r2(S.elapsedSeconds), hp: P.hp, lockedBefore: pilot.C.lockedOn.has(e.id) });
      }
      // barrier events
      if (S.objective.controlsDestroyed > prevS.objective.controlsDestroyed) {
        const opened = S.objective.openBarrierIds.filter((id) => !prevS.objective.openBarrierIds.includes(id));
        const b = stage.barriers.find((x) => opened.includes(x.id));
        const ctrlPos = b ? stage.enemies.find((e) => e.id === b.controlEnemyId).position : null;
        const rec = { n: S.objective.controlsDestroyed, barrier: opened.join(','), control: b ? b.controlEnemyId : null, t: r2(S.elapsedSeconds), hp: P.hp, en: r1(P.en), pos: P.position.map(r1), sector: S.stage.currentSectorId, distance: ctrlPos ? r1(dist3(V(P.position), ctrlPos)) : null, lockedBefore: b ? pilot.C.lockedOn.has(b.controlEnemyId) : null };
        res.barriers.push(rec);
        say(`  control turret ${rec.control} destroyed → ${rec.barrier} open: t = ${rec.t} s, HP ${rec.hp}, from ${JSON.stringify(rec.pos)} at ${rec.distance} m (${S.objective.controlsDestroyed}/6)`);
        if (!DRY) {
          const hud = await driver.hud();
          await checkHud(hud, `control ${rec.n}`);
          rec.hud = hud ? { ctrl: hud.ctrl, barriers: hud.barriers, gate: hud.gate, banner: hud.banner, objective: hud.objective, route: hud.route } : null;
          await shot(`0${rec.n}-control-${rec.control}-${rec.barrier}`, `control turret ${rec.control} destroyed, barrier ${rec.barrier} open`);
        }
        if (S.objective.controlsDestroyed === 1 && !done.has(1)) {
          done.add(1);
          const shotsAtT01 = S.recentPlayerShots.filter((x) => x.targetId === rec.control);
          mark(1, `${rec.control} destroyed, ${rec.barrier} open`, { control: rec.control, firedFrom: rec.pos, distance: rec.distance, lockCompleteSeen: rec.lockedBefore, lockedShotsInLast32: shotsAtT01.length, hud: rec.hud });
          if (STOP_AFTER === 1) {
            stopReason = 'stopped after milestone 1 (--stop-after)';
            break;
          }
        }
        if (S.objective.gateOpen && !done.has(3)) {
          done.add(3);
          mark(3, 'all six control turrets destroyed, final gate open', { hud: rec.hud });
          if (STOP_AFTER === 3) {
            stopReason = 'stopped after milestone 3 (--stop-after)';
            break;
          }
        }
      }
      if (!DRY && !extra.locked && S.elapsedSeconds > 5 && S.lock.state === 'locked' && cmd.fire && S.fireControl.status === 'solved') {
        extra.locked = true;
        const hud = await driver.hud();
        await checkHud(hud, 'locked and firing');
        res.lockShot = { t: S.elapsedSeconds, target: S.lock.targetId, weapon: P.weapon, fireControl: { status: S.fireControl.status, predictedFlightSeconds: S.fireControl.predictedFlightSeconds, residualMeters: S.fireControl.residualMeters }, hudLockLabel: hud ? hud.lockLabel : null };
        await shot('03-locked-and-firing', `lock complete on ${S.lock.targetId}, trigger held`, 300);
      }
      if (!DRY && !extra.gate && S.objective.gateOpen && pilot.k >= pilot.route.length - 2) {
        extra.gate = true;
        const hud = await driver.hud();
        await checkHud(hud, 'approach to the final gate');
        await shot('08-final-gate-approach', 'on the way to the open final gate');
      }
      // first flight
      if (!flightShot && !DRY && pilot.flight && P.movement.verticalMode === 'flying' && P.position[1] > pilot.flight.from.y + 4) {
        flightShot = true;
        const hud = await driver.hud();
        await checkHud(hud, 'in flight');
        await shot('02-first-climb-in-flight', 'first climb, Space held, verticalMode flying');
      }
      if (!m2 && pilot.climbs.length > 0 && pilot.climbs.some((c) => c.ok && c.enUsed > 0.01)) {
        m2 = true;
        const c = pilot.climbs.find((x) => x.ok && x.enUsed > 0.01);
        const spot = stage.flightSpots.find((f) => dist3(f.to, c.to) < 0.5);
        mark(2, `first flight climb landed (${spot ? spot.id : 'route climb'}, +${r1(c.height)} m)`, { climb: { ...c, from: fmtP(c.from), to: fmtP(c.to), landed: fmtP(c.landed) }, spot: spot ? spot.id : null });
        if (!DRY) await shot('02-first-climb-landed', 'landed after the first climb');
        if (STOP_AFTER === 2) {
          stopReason = 'stopped after milestone 2 (--stop-after)';
          break;
        }
      }
      if (S.elapsedSeconds - lastReport >= 10) {
        lastReport = S.elapsedSeconds;
        const wall = (Date.now() - wall0) / 1000;
        say(`  t=${r1(S.elapsedSeconds)} s  frame ${frame}  HP ${P.hp}  EN ${r1(P.en)}  ${S.stage.currentSectorId}  wp ${pilot.k}/${pilot.route.length}  ${pilot.mode}  controls ${S.objective.controlsDestroyed}/6  wall ${r1(wall / 60)} min (${Math.round(((wall - lastWall) * 1000) / Math.max(1, frame - lastFrame))} ms/step now)`);
        lastWall = wall;
        lastFrame = frame;
      }
      prevS = S;
    }

    // ── the end of the sortie ──
    const P = S.player;
    res.end = { state: S.state, t: r3(S.elapsedSeconds), frames: frame, hp: P.hp, en: r1(P.en), pos: P.position.map(r2), sector: S.stage.currentSectorId, objective: S.objective, waypoint: pilot.k, waypoints: pilot.route.length, stopReason, ammo: P.ammo, visitedSectorIds: S.stage.visitedSectorIds, enemiesDestroyed: S.enemies.filter((e) => !e.alive).length, enemyShotsFired: S.enemies.reduce((a, e) => a + e.shotsFired, 0) };
    say(`END: ${stopReason} at t = ${res.end.t} s — HP ${P.hp}, waypoint ${pilot.k}/${pilot.route.length}, ${res.end.sector}, controls ${S.objective.controlsDestroyed}/6, visited ${S.stage.visitedSectorIds.length} sectors`);
    if (!DRY) {
      await driver.releaseAll();
      if (HOLD) await driver.setHold(false);
    }
    if (S.state === 'cleared') mark(4, "exit zone reached, state 'cleared'", { visitedSectorIds: S.stage.visitedSectorIds });
    if (!DRY && (S.state === 'cleared' || S.state === 'failed')) {
      const after = await resultAndResortie(driver, S, S0, shot);
      Object.assign(S.state === 'cleared' ? res.milestones[res.milestones.length - 1] : res.end, after);
    } else if (!DRY) await shot('09-stopped', 'where the run stopped');
  } catch (err) {
    res.error = String(err && err.stack ? err.stack : err);
    say('ERROR ' + res.error);
    try {
      if (!DRY && driver.page) await driver.screenshot('99-error', 0);
    } catch {
      /* page gone */
    }
  } finally {
    res.wallMinutes = r1((Date.now() - wall0) / 60000);
    res.pilot = { waypointReached: pilot.k - 1, waypoints: pilot.route.length, arrivals: pilot.arrivals.map((t) => (t === null ? null : r1(t))), climbs: pilot.climbs.map((c) => ({ ...c, from: fmtP(c.from), to: fmtP(c.to), landed: fmtP(c.landed), enUsed: r1(c.enUsed), enLeft: r1(c.enLeft), seconds: r2(c.seconds), maxY: r2(c.maxY), tStart: r2(c.tStart), tEnd: r2(c.tEnd) })), enWaitSeconds: r1(pilot.enWait), stuck: pilot.stuck, replans: pilot.replans, fightSeconds: r1(pilot.C.fightFrames * DT), counters: pilot.counters, calibration: { ...pilot.calib, yawMaxErr: Number(pilot.calib.yawMaxErr.toExponential(2)), aimMaxErrDeg: Number(pilot.calib.aimMaxErrDeg.toExponential(2)) } };
    if (DRY && driver.game) res.hits = driver.game.hits;
    if (!DRY) {
      const n = driver.stats.steps || 1;
      res.mouse = { ...driver.stats, msPerStep: Math.round(driver.stats.wallMs / n), inputMsPerStep: Math.round(driver.stats.inputMs / n), pageMsPerStep: Math.round(driver.stats.pageMs / n), realFramesPerStep: r2(driver.stats.realFrames / n) };
      res.screenshotResizes = driver.resizes;
      res.pageErrors = driver.game ? driver.game.errors.slice(0, 20) : [];
      res.pageWarnings = driver.game ? driver.game.warnings.slice(0, 20) : [];
      res.externalRequests = driver.game ? driver.game.requests.filter((u) => !u.startsWith(BASE_URL) && !u.startsWith('data:') && !u.startsWith('blob:')) : [];
    }
    if (logStream) await new Promise((resolve) => logStream.end(resolve));
    await driver.close();
  }
  return res;
}

// ───────────────────────────── main ─────────────────────────────
const tStart = Date.now();
if (flag('mini-fall')) {
  const r = await miniFall();
  console.log(JSON.stringify(r, null, 1));
  if (OUT) fs.writeFileSync(path.join(OUT, `summary-${LABEL}.json`), JSON.stringify(r, null, 1));
  process.exit(r.error || !r.end || !r.end.resortie || !r.end.resortie.identicalToFirstSortie ? 1 : 0);
}
say(`factory-run: ${DRY ? 'DRY (headless Sim — not evidence about the page)' : BASE_URL}, ${VW}×${VH} CSS px at devicePixelRatio ${PLAY_DPR}, ${FPS} frames per game second, one decision per ${EVERY} frame(s), seed ${SEED ?? `default (${DEFAULT_SEED})`}, loadout ${JSON.stringify(LOADOUT)}, tactics ${TACTICS}`);
const stage = getFactoryStage();
const an = new StageAnalyzer(stage);
say(`stage ${stage.id}: ${stage.sectors.length} sectors, ${stage.enemies.length} enemies, route ${stage.route.length} waypoints; planners ready after ${Date.now() - tStart} ms`);
const result = await attempt({ stage, an });
const summary = [];
summary.push(`RESULT ${result.label}: ${result.end ? result.end.state : 'no end'} — ${result.end ? result.end.stopReason : result.error}`);
if (result.end) summary.push(`  game time ${result.end.t} s in ${result.end.frames} frames, HP ${result.end.hp}/1000, waypoint ${result.end.waypoint}/${result.end.waypoints}, controls ${result.end.objective.controlsDestroyed}/6, enemies destroyed ${result.end.enemiesDestroyed}/45, enemy shots ${result.end.enemyShotsFired}, visited [${result.end.visitedSectorIds.join(' ')}]`);
summary.push(`  milestones reached: ${result.milestones.map((m) => m.id).join(', ') || 'none'}; wall ${result.wallMinutes} min`);
if (result.shadow) summary.push(`  shadow (headless Sim fed the same input): ${result.shadow.identical}/${result.shadow.frames} frames bit-identical, ${result.shadow.close}/${result.shadow.frames} within ${SHADOW_TOL} (largest deviation ${result.shadow.maxDeviation.toExponential(2)}${result.shadow.maxDeviationAt ? ' at ' + result.shadow.maxDeviationAt.where : ''})${result.shadow.firstRealDiff ? `; first real difference at frame ${result.shadow.firstRealDiff.frame}: ${result.shadow.firstRealDiff.diff}` : ''}; trig ${JSON.stringify(result.trig ?? null)}`);
if (!DRY) summary.push(`  HUD checks ${result.hud.checks}, contradictions ${result.hud.contradictions}; page errors ${result.pageErrors.length}; mouse ${JSON.stringify(result.mouse)}`);
summary.push(`  pilot: ${JSON.stringify(result.pilot.counters)}, climbs ${result.pilot.climbs.filter((c) => c.ok).length}/${result.pilot.climbs.length}, fight ${result.pilot.fightSeconds} s, EN wait ${result.pilot.enWaitSeconds} s, stuck ${result.pilot.stuck}, yaw checks ${result.pilot.calibration.yawChecks} (max err ${result.pilot.calibration.yawMaxErr} rad, resyncs ${result.pilot.calibration.resyncs}), aim checks ${result.pilot.calibration.aimChecks} (max err ${result.pilot.calibration.aimMaxErrDeg}°)`);
console.log(summary.join('\n'));
if (OUT) {
  fs.writeFileSync(path.join(OUT, `summary-${LABEL}.json`), JSON.stringify(result, null, 1));
  console.log(`written: ${path.join(OUT, `summary-${LABEL}.json`)}`);
}
const reached = new Set(result.milestones.map((m) => m.id));
process.exit(result.error ? 2 : reached.has(Math.min(4, STOP_AFTER)) ? 0 : 1);
