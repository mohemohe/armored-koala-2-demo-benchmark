// AK2 DEMO — Node verification harness.
// Runs the REAL fixed-step simulation (same code the browser uses) and checks:
// movement/EN, FCS firing solutions (A01-A13 live-fire), enemy AI behavior,
// stage structure/objectives, snapshot fields.
// Usage: node test/run.mjs

import { Game } from '../src/core/game.js';
import { buildStage } from '../src/core/stageDef.js';
import { makeArena, idle, targetView, steps, drainEvents, dist2d, dist3d, DT } from './helpers.mjs';
import { PARAMS, effectiveStats } from '../src/core/params.js';

const P = PARAMS.player;
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
const f2 = x => x.toFixed(2);

// =========================================================================
section('STAGE STRUCTURE');
const stage = buildStage();
{
  const guards = stage.spawns.filter(s => s.kind === 'guard');
  const turrets = stage.spawns.filter(s => s.kind === 'turret');
  const controls = stage.spawns.filter(s => s.isGateControl);
  check('sector count >= 15', stage.sectors.length >= 15, `${stage.sectors.length} sectors`);
  check('30 guards + 15 turrets', guards.length === 30 && turrets.length === 15,
    `${guards.length}G/${turrets.length}T`);
  check('6 gate-control turrets', controls.length === 6);
  check('6 barriers', stage.barriers.length === 6);
  check('mandatory flight sections >= 6', stage.climbs.length >= 6, `${stage.climbs.length}`);

  // branches & loops on link graph
  const deg = {};
  for (const l of stage.links) { deg[l.a] = (deg[l.a] || 0) + 1; deg[l.b] = (deg[l.b] || 0) + 1; }
  const branches = Object.values(deg).filter(d => d >= 3).length;
  // cycle rank: E - V + C (connected graph => C=1)
  const nodes = new Set(); for (const l of stage.links) { nodes.add(l.a); nodes.add(l.b); }
  const rank = stage.links.length - nodes.size + 1;
  check('>=3 branch sectors', branches >= 3, `${branches}`);
  check('>=2 loops (cycle rank)', rank >= 2, `rank ${rank}`);

  // Route length: Dijkstra over (sector, doorPos, controlMask).
  // Entering a sector may collect its control (0-cost bit). Traversing a link
  // requires its barrier open. Intra-sector cost = euclid door-to-door
  // (lower bound on real walking distance).
  const rl = shortestClearRoute(stage, controls);
  check('shortest clear route >= 1500 m (graph lower bound)', rl >= 1500, `${rl.toFixed(0)} m`);

  const ir = measureRoute(stage);
  console.log(`  info  intended waypoint route = ${ir.toFixed(0)} m`);
}

function shortestClearRoute(stage, controls) {
  const ctrlBit = {};
  for (const c of controls) ctrlBit[c.sectorId] = 1 << (+c.id.slice(2) - 1);
  const startSec = stage.sectorAt(stage.start.pos);
  const escapeC = [250, 0, 15.5];
  // positions per sector
  const posOf = {};
  const addPos = (s, p) => { (posOf[s] = posOf[s] || []).push(p); };
  for (const l of stage.links) { addPos(l.a, l.pos); addPos(l.b, l.pos); }
  addPos(startSec, stage.start.pos);
  addPos('exitgate', escapeC);
  // control turret positions are destinations too (reaching them costs travel)
  const ctrlPosIdx = {};
  for (const c of controls) {
    addPos(c.sectorId, c.pos);
    ctrlPosIdx[c.sectorId + '|' + c.pos.join(',')] = 1 << (+c.id.slice(2) - 1);
  }
  const barrierOpen = (barrier, m) => {
    if (!barrier) return true;
    if (barrier === 'B6') return m === 63;
    return (m & (1 << (+barrier.slice(1) - 1))) !== 0;
  };
  const key = (s, pi, m) => `${s}|${pi}|${m}`;
  const dist = new Map();
  const startState = [startSec, posOf[startSec].length - 1, 0];
  dist.set(key(...startState), 0);
  const pq = [[0, ...startState]];
  let best = Infinity;
  while (pq.length) {
    pq.sort((x, y) => x[0] - y[0]);
    const [d, s, pi, m] = pq.shift();
    if (d > (dist.get(key(s, pi, m)) ?? Infinity)) continue;
    // collect the control bit only while standing at its turret position
    const bitHere = ctrlPosIdx[s + '|' + posOf[s][pi].join(',')] || 0;
    const mC = m | bitHere;
    if (mC !== m) {
      const k2 = key(s, pi, mC);
      if (d < (dist.get(k2) ?? Infinity)) { dist.set(k2, d); pq.push([d, s, pi, mC]); }
    }
    if (s === 'exitgate' && posOf[s][pi] === escapeC && mC === 63) { best = d; break; }
    const p = posOf[s][pi];
    // walk inside sector to other doors (euclid)
    for (let qi = 0; qi < posOf[s].length; qi++) {
      if (qi === pi) continue;
      const nd = d + dist3d(p, posOf[s][qi]);
      const k2 = key(s, qi, mC);
      if (nd < (dist.get(k2) ?? Infinity)) { dist.set(k2, nd); pq.push([nd, s, qi, mC]); }
    }
    // cross links at current door position
    for (const l of stage.links) {
      if (l.a === s && samePos(l.pos, p) && barrierOpen(l.barrier, mC)) {
        const qi = posOf[l.b].findIndex(x => samePos(x, l.pos));
        if (qi >= 0) {
          const nd = d + 1;
          const k2 = key(l.b, qi, mC);
          if (nd < (dist.get(k2) ?? Infinity)) { dist.set(k2, nd); pq.push([nd, l.b, qi, mC]); }
        }
      }
      if (l.b === s && samePos(l.pos, p) && barrierOpen(l.barrier, mC)) {
        const qi = posOf[l.a].findIndex(x => samePos(x, l.pos));
        if (qi >= 0) {
          const nd = d + 1;
          const k2 = key(l.a, qi, mC);
          if (nd < (dist.get(k2) ?? Infinity)) { dist.set(k2, nd); pq.push([nd, l.a, qi, mC]); }
        }
      }
    }
  }
  return best;
}
function samePos(a, b) { return Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[2] - b[2]) < 0.5; }
// Measure intended route: start -> doors & controls in forced order -> escape.
function measureRoute(stage) {
  const wpts = [
    stage.start.pos,
    [-47, 0, -60], [-2, 1, -72],                    // mill->pipes door, TC1
    [-24, 0, -60], [-10, 0, -30],                    // conn, B1 door
    [30, 0, -45], [67, 17, -57],                     // power door, TC2 (deck)
    [30, 0, -45], [8, 0, -10], [8, 0, 20],           // back, corridor B2
    [5, 9, 75],                                       // TC3 (mezz)
    [30, 0, 50],                                      // B3 door into mainhall
    [-10, 0, 30], [-25, 0, -10], [-21, 0, -60], [-52, 0, -80], // back west->conveyor
    [130, 0, -80], [210, 0, -20], [210, -4, 0], [112, -8, 15], // conveyor->cooling->pit->tunnel
    [50, -8, 55],                                      // TC4
    [100, -8, 60], [100, 2, 60],                       // return shaft up
    [-10, 0, 60], [-25, 0, 40], [-40, 0, 10],           // assembly->hub->mill
    [-41, 9, 0.5], [-60, 9, 0],                         // gantry slot, TC5
    [-41, 9, 0.5], [-40, 0, -30], [-24, 0, -60], [-10, 0, -30], [30, 0, -45], // to power
    [74, -8, -41], [70, -8, -50],                       // hatch down, TC6
    [74, -8, -41], [30, 0, -45], [-10, 0, -30], [-24, 0, -60], [-52, 0, -80], // back to conveyor
    [130, 0, -80], [210, 0, -20], [210, -4, 0], [227, 0, 15], [236, 0, 15], [250, 0, 15.5], // pit->ledge->exitgate->escape
  ];
  let total = 0;
  for (let i = 1; i < wpts.length; i++) total += dist3d(wpts[i - 1], wpts[i]);
  return total;
}

// =========================================================================
section('MOVEMENT / EN — single QB & hold-Q');
{
  const g = new Game(makeArena(), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 1);
  const v = targetView(g, [100, 0, 100]);
  // "hold Q 5 s": the input layer emits ONE edge (keydown), then nothing for 5 s.
  const en0 = g.player.en;
  let inp = { ...idle(v), qbEdge: true };
  g.step(inp);
  check('single press spends exactly 36 EN', Math.abs(g.player.en - (en0 - 36)) < 0.01,
    `en=${f2(g.player.en)}`);
  inp = idle(v);
  for (let i = 0; i < 5 * 120; i++) g.step(inp);
  check('hold Q 5s -> exactly 1 QB', g.player.qbSuccessfulCount === 1, `count=${g.player.qbSuccessfulCount}`);
  check('Q impulse does not retrigger while held', g.player.qbSuccessfulCount === 1);

  // QB boundary EN 35 / 36
  const g2 = new Game(makeArena(), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 1);
  const v2 = targetView(g2, [100, 0, 100]);
  g2.player.en = 35;
  g2.step({ ...idle(v2), qbEdge: true });
  check('EN 35 -> QB denied', g2.player.qbSuccessfulCount === 0 && g2.player.en < 36,
    `count=${g2.player.qbSuccessfulCount} en=${f2(g2.player.en)}`);
  g2.player.en = 36;
  g2.step({ ...idle(v2), qbEdge: true });
  check('EN 36 -> QB fires, spends 36', g2.player.qbSuccessfulCount === 1 && Math.abs(g2.player.en) < 0.01,
    `en=${g2.player.en.toFixed(3)}`);

  // tap Q then release everything: thrust completes, inertia, auto-glide
  const g3 = new Game(makeArena(), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 1);
  const v3 = targetView(g3, [100, 0, 100]);
  const p0 = g3.player.pos.slice();
  g3.step({ ...idle(v3), qbEdge: true, move: [1, 0] });
  const vAfterPress = Math.hypot(g3.player.vel[0], g3.player.vel[2]);
  let maxSp = 0, spAt075 = 0, spAt2 = 0, stillGlide = false;
  const idleInp = idle(v3);
  for (let i = 0; i < 3 * 120; i++) {
    g3.step(idleInp);
    const s = Math.hypot(g3.player.vel[0], g3.player.vel[2]);
    maxSp = Math.max(maxSp, s);
    if (i === Math.round(0.75 * 120) - 2) spAt075 = s;
    if (i === 2 * 120 - 1) spAt2 = s;
  }
  stillGlide = g3.player.glideEnabled;
  check('tap Q: impulse velocity ~80 m/s', Math.abs(vAfterPress - 80) < 1, f2(vAfterPress));
  check('tap Q: inertial decel into glide (0.75s speed)', spAt075 > 20 && spAt075 < 32, f2(spAt075));
  check('tap Q: automatic glide persists with no input', stillGlide && spAt2 > 15, `glide=${stillGlide} sp=${f2(spAt2)}`);
}

// redo distance test cleanly (0.75 s after press)
{
  const g = new Game(makeArena(), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 1);
  const v = targetView(g, [100, 0, 100]);
  const p0 = g.player.pos.slice();
  g.step({ ...idle(v), qbEdge: true, move: [1, 0] });
  for (let i = 0; i < Math.round(0.75 * 120) - 1; i++) g.step(idle(v));
  const d = dist2d(g.player.pos, p0);
  check('2-leg QB 0.75s distance ~42.6 m', Math.abs(d - 42.6) < 1.5, f2(d));

  const gq = new Game(makeArena(), { fcs: 'medium', generator: 'balanced', legs: 'quadruped' }, 1);
  const vq = targetView(gq, [100, 0, 100]);
  const q0 = gq.player.pos.slice();
  gq.step({ ...idle(vq), qbEdge: true, move: [1, 0] });
  for (let i = 0; i < Math.round(0.75 * 120) - 1; i++) gq.step(idle(vq));
  const dq = dist2d(gq.player.pos, q0);
  check('4-leg QB 0.75s distance ~34.08 m', Math.abs(dq - 34.08) < 1.5, f2(dq));
}

section('MOVEMENT / EN — glide at 0 EN, regen, simultaneous spend');
{
  // zero-EN glide keeps working + grounded glide regen resumes after 0.75 s
  const g = new Game(makeArena(), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 1);
  const v = targetView(g, [100, 0, 100]);
  g.player.en = 0; g.player.lastEnSpentAt = g.now; // "just spent"
  g.step({ ...idle(v), shiftEdge: true, move: [1, 0] });
  for (let i = 0; i < Math.round(0.5 * 120); i++) g.step(idle(v));
  check('EN 0 glide moves the unit', Math.hypot(g.player.vel[0], g.player.vel[2]) > 10 && g.player.glideEnabled);
  const enBefore075 = g.player.en;
  for (let i = 0; i < Math.round(0.8 * 120); i++) g.step(idle(v));
  check('no regen before 0.75s wait ends', enBefore075 <= 0.01, `en@0.5s=${enBefore075.toFixed(2)}`);
  check('grounded glide regen after wait', g.player.en > 3.0 && g.player.glideEnabled,
    `en=${f2(g.player.en)}`);

  // simultaneous spend: QB(36) + beam(8) + flight(20/s) same step, from EN pool
  const g2 = new Game(makeArena(), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 1);
  const view2 = targetView(g2, [100, 0, 100]);
  g2.player.en = 100; g2.player.weapon = 'beam';
  g2.player.grounded = false; g2.player.vel[1] = 0; // airborne for flight
  g2.step({ ...idle(view2), qbEdge: true, move: [1, 0], fireHeld: true, spaceHeld: true, spaceHeldFor: 1.0 });
  const expect = 100 - 36 - 8 - 20 * DT;
  check('QB+beam+flight spend one pool in order', Math.abs(g2.player.en - expect) < 0.05,
    `en=${f2(g2.player.en)} exp=${f2(expect)}`);
}

// =========================================================================
section('FCS A01-A13 — machine gun live fire (20 shots each)');
function runShots({ pos, vel, dist = null, shots = 20, weapon = 'machinegun', legs = 'biped' }) {
  const spawns = [{ id: 'TGT', kind: 'dummy', pos: pos.slice(), sectorId: 'arena', isGateControl: false }];
  const arena = makeArena({ spawns, start: [0, 0, 0] });
  const g = new Game(arena, { fcs: 'medium', generator: 'balanced', legs }, 7);
  g.fcsUnlocked = true;
  g.player.weapon = weapon;
  const tgt = g.enemies[0];
  tgt.scriptVel = vel.slice();
  const view = targetView(g, tgt);
  const inp = idle(view); inp.fireHeld = false;
  // wait for lock
  let lockedAt = -1;
  for (let i = 0; i < 4 * 120; i++) {
    g.step(inp);
    if (g.fcs.state === 'locked') { lockedAt = g.now; break; }
  }
  let fired = 0, hits = 0, maxResid = 0, shotsRec = [];
  inp.fireHeld = true;
  for (let i = 0; i < 20 * 120 && fired < shots; i++) {
    const before = g.shotSeq;
    g.step(inp);
    for (const ev of drainEvents(g)) {
      if (ev.type === 'enemyHit' && ev.id === 'TGT') hits++;
    }
    fired = g.shotSeq;
    if (g.recentPlayerShots.length > shotsRec.length) {
      const r = g.recentPlayerShots[g.recentPlayerShots.length - 1];
      shotsRec.push(r);
      if (r.residualMeters !== null) maxResid = Math.max(maxResid, r.residualMeters);
    }
  }
  // let bullets already in flight land
  for (let i = 0; i < 2 * 120; i++) {
    g.step({ ...idle(view) });
    for (const ev of drainEvents(g)) if (ev.type === 'enemyHit' && ev.id === 'TGT') hits++;
  }
  return { lockedAt, fired, hits, maxResid, shotsRec, game: g, tgt };
}

// offsets chosen so the target stays inside the 120 m lock range for the
// whole lock+fire window (~3 s).
const A = [
  ['A01 static 50m', [50, 0, 0], [0, 0, 0]],
  ['A02 +X 15m/s 50m', [50, 0, 10], [15, 0, 0]],
  ['A03 -X 15m/s 50m', [50, 0, -10], [-15, 0, 0]],
  ['A04 +Z 15m/s 55m', [45, 0, 30], [0, 0, 15]],
  ['A05 -Z 15m/s 55m', [45, 0, 30], [0, 0, -15]],
  ['A06 diag 10,0,10 57m', [40, 0, 40], [10, 0, 10]],
  ['A07 +Y 8m/s 50m', [50, 5, 0], [0, 8, 0]],
  ['A08 -Y 7m/s (from 30m up)', [50, 30, 0], [0, -7, 0]],
  ['A09 +X 30m/s 25m', [25, 0, 0], [30, 0, 0]],
  ['A10 toward -Z 20m/s 90m', [0, 0, 90], [0, 0, -20]],
  ['A11 away +Z 20m/s 55m', [0, 0, 55], [0, 0, 20]],
  ['A12 elevated static 15up 60m', [60, 15, 0], [0, 0, 0]],
  ['A13 combo 15,5,-10 82m', [60, 10, 55], [15, 5, -10]],
];
for (const [name, pos, vel] of A) {
  const r = runShots({ pos, vel });
  check(`${name}: locked & 20 fired`, r.fired === 20 && r.lockedAt >= 0,
    `fired=${r.fired} lockAt=${r.lockedAt.toFixed(2)}`);
  check(`${name}: 20/20 hits`, r.hits === 20, `hits=${r.hits}`);
  check(`${name}: residual <= 0.01 m`, r.maxResid <= 0.01, `max=${(r.maxResid * 1000).toFixed(2)}mm`);
}

section('FCS — beam, missile, no velocity inheritance, ballistic retention');
{
  // beam hits CURRENT position instantly
  const r = runShots({ pos: [60, 0, 20], vel: [15, 0, 0], shots: 1, weapon: 'beam' });
  check('beam: instant hit on firing frame', r.hits === 1, `hits=${r.hits}`);
  const rec = r.shotsRec[0];
  check('beam: predicted flight = 0 (current pos)', rec && rec.predictedFlightSeconds === 0);

  // missile: lead dir + limited guidance -> hit constant target
  const spawns = [{ id: 'TGT', kind: 'dummy', pos: [80, 0, 0], sectorId: 'arena', isGateControl: false }];
  const g = new Game(makeArena({ spawns }), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 3);
  g.fcsUnlocked = true;
  const tgt = g.enemies[0]; tgt.scriptVel = [0, 0, 18];
  const view = targetView(g, tgt);
  const inp = idle(view);
  for (let i = 0; i < 3 * 120 && g.fcs.state !== 'locked'; i++) g.step(inp);
  g.player.weapon = 'missile';
  g.step({ ...idle(view), fireHeld: true });
  drainEvents(g);
  const ms = g.projectiles.missiles[0];
  check('missile spawned locked', !!ms);
  if (ms) {
    const direct = [tgt.center()[0] - ms.pos[0], 0, tgt.center()[2] - ms.pos[2]];
    const dl = Math.hypot(direct[0], direct[2]);
    const leadAng = Math.acos(Math.max(-1, Math.min(1,
      (ms.vel[0] * direct[0] + ms.vel[2] * direct[2]) / (45 * dl))));
    check('missile: launch leads target (>0.05 rad)', leadAng > 0.05, `lead=${leadAng.toFixed(3)}rad`);
    let maxTurn = 0, hit = false;
    let prevV = ms.vel.slice();
    for (let i = 0; i < 5 * 120 && !hit; i++) {
      g.step({ ...idle(view) });
      const m = g.projectiles.missiles[0];
      if (m) {
        const dot = prevV[0] * m.vel[0] + prevV[1] * m.vel[1] + prevV[2] * m.vel[2];
        const ang = Math.acos(Math.max(-1, Math.min(1, dot / 2025))) / DT;
        maxTurn = Math.max(maxTurn, ang);
        prevV = m.vel.slice();
      }
      for (const ev of drainEvents(g)) if (ev.type === 'enemyHit' && ev.id === 'TGT') hit = true;
    }
    check('missile: hits constant-velocity target', hit);
    check('missile: turn rate <= 120 deg/s', maxTurn <= 120 * Math.PI / 180 + 0.05,
      `max=${(maxTurn * 180 / Math.PI).toFixed(1)}deg/s`);
  }

  // no forced hit: target reverses after launch -> bullet must not track
  const spawns2 = [{ id: 'TGT', kind: 'dummy', pos: [60, 0, 0], sectorId: 'arena', isGateControl: false }];
  const g2 = new Game(makeArena({ spawns: spawns2 }), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 5);
  g2.fcsUnlocked = true;
  const tgt2 = g2.enemies[0]; tgt2.scriptVel = [15, 0, 0];
  const v2 = targetView(g2, tgt2);
  for (let i = 0; i < 3 * 120 && g2.fcs.state !== 'locked'; i++) g2.step(idle(v2));
  g2.step({ ...idle(v2), fireHeld: true });
  drainEvents(g2);
  tgt2.scriptVel = [-15, 0, 0]; // sharp reversal right after launch
  let hit2 = false;
  for (let i = 0; i < 2 * 120; i++) {
    g2.step(idle(v2));
    for (const ev of drainEvents(g2)) if (ev.type === 'enemyHit' && ev.id === 'TGT') hit2 = true;
  }
  check('ballistic: no forced hit after target reversal', !hit2);

  // moving shooter: v0 magnitude exactly 100 (no inherited velocity)
  const spawns3 = [{ id: 'TGT', kind: 'dummy', pos: [60, 0, 30], sectorId: 'arena', isGateControl: false }];
  const g3 = new Game(makeArena({ spawns: spawns3 }), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 9);
  g3.fcsUnlocked = true;
  const t3 = g3.enemies[0];
  const v3 = targetView(g3, t3);
  // get player gliding
  g3.step({ ...idle(v3), shiftEdge: true, move: [0, 1] });
  for (let i = 0; i < 1 * 120; i++) {
    g3.step({ ...idle(v3), move: [0, 1] });
    drainEvents(g3);
  }
  const pspd = Math.hypot(g3.player.vel[0], g3.player.vel[2]);
  for (let i = 0; i < 3 * 120 && g3.fcs.state !== 'locked'; i++) g3.step({ ...idle(v3), move: [0, 1] });
  g3.step({ ...idle(v3), move: [0, 1], fireHeld: true });
  const rec3 = g3.recentPlayerShots[g3.recentPlayerShots.length - 1];
  const v0l = rec3 && rec3.initialVelocity ? Math.hypot(...rec3.initialVelocity) : 0;
  check('moving shooter: |v0| exactly 100 (no inheritance)', Math.abs(v0l - 100) < 1e-6,
    `|v0|=${v0l.toFixed(4)} shooterSpd=${pspd.toFixed(1)}`);
  const mz = rec3.muzzlePosition, pm = g3.player.muzzle();
  check('moving shooter: muzzle = current muzzle pos', dist3d(mz, pm) < 0.35,
    `dz=${f2(dist3d(mz, pm))}`);
}

// =========================================================================
section('ENEMY AI');
{
  // initiation delay + burst cadence
  const g = new Game(makeArena({ spawns: [{ id: 'G', kind: 'guard', pos: [40, 0, 0], sectorId: 'arena' }] }), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 11);
  const v = targetView(g, g.enemies[0]);
  const shotTimes = [];
  for (let i = 0; i < 5 * 120; i++) {
    g.step(idle(v));
    for (const ev of drainEvents(g)) if (ev.type === 'enemyShot') shotTimes.push(g.now);
  }
  check('guard initiates ~0.5s after LOS', shotTimes.length > 0 && Math.abs(shotTimes[0] - 0.5) < 0.12,
    `t0=${shotTimes.length ? f2(shotTimes[0]) : 'none'}`);
  if (shotTimes.length >= 4) {
    check('burst of 3 @0.12s', Math.abs(shotTimes[1] - shotTimes[0] - 0.12) < 0.03 &&
      Math.abs(shotTimes[2] - shotTimes[1] - 0.12) < 0.03,
      `${f2(shotTimes[1] - shotTimes[0])},${f2(shotTimes[2] - shotTimes[1])}`);
    check('next burst >=1.2s period', shotTimes[3] - shotTimes[0] >= 1.19, f2(shotTimes[3] - shotTimes[0]));
  }

  // lead: moving player gets hit (direct aim would miss)
  const gL = new Game(makeArena({ spawns: [{ id: 'G', kind: 'guard', pos: [0, 0, 40], sectorId: 'arena' }] }), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 13);
  const vL = targetView(gL, gL.enemies[0]);
  let hitsL = 0;
  for (let i = 0; i < 6 * 120; i++) {
    gL.step({ ...idle(vL), move: [1, 0], camForwardXZ: [0, 1] });
    for (const ev of drainEvents(gL)) if (ev.type === 'playerHit') hitsL++;
    if (gL.player.pos[0] > 60) break;
  }
  check('guard leads moving player (hits)', hitsL > 0, `hits=${hitsL}`);

  // occlusion pursuit: guard loses LOS -> approaches last seen, stops firing
  const wall = [[-5, 0, -8], [-3, 8, 8]];   // blocks LOS only after the player moves behind it
  const gO = new Game(makeArena({ boxes: [wall], spawns: [{ id: 'G', kind: 'guard', pos: [40, 0, 0], sectorId: 'arena' }] }), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 17);
  const vO = targetView(gO, gO.enemies[0]);
  // phase 1: visible for 1.5s at origin
  for (let i = 0; i < 1.5 * 120; i++) { gO.step(idle(vO)); drainEvents(gO); }
  const shotsSeen = gO.enemies[0].shotsFired;
  // phase 2: teleport player behind the wall (occluded)
  gO.player.pos = [-10, 0, 0];
  let shotsHidden0 = gO.enemies[0].shotsFired, lostAt = -1, moveStart = -1;
  const guardStart = gO.enemies[0].pos.slice();
  for (let i = 0; i < 3 * 120; i++) {
    gO.step(idle(vO));
    drainEvents(gO);
    const en = gO.enemies[0];
    if (lostAt < 0 && !en.hasLineOfSight) lostAt = gO.now;
    if (moveStart < 0 && lostAt >= 0 && Math.hypot(en.vel[0], en.vel[2]) > 1) moveStart = gO.now;
  }
  check('occlusion: guard stops firing', gO.enemies[0].shotsFired === shotsHidden0 ||
    gO.enemies[0].shotsFired <= shotsHidden0 + 1, `fired=${gO.enemies[0].shotsFired - shotsHidden0}`);
  check('occlusion: moves toward last seen within 0.5s+', moveStart >= 0 && moveStart - lostAt <= 0.75,
    `delay=${moveStart >= 0 ? f2(moveStart - lostAt) : 'never'}`);
  check('occlusion: closes distance to last seen',
    dist2d(gO.enemies[0].pos, [-10, 0, 0]) < dist2d(guardStart, [-10, 0, 0]),
    `${f2(dist2d(gO.enemies[0].pos, [-10, 0, 0]))}m`);

  // off-screen attack: enemy behind player still fires
  const gB = new Game(makeArena({ spawns: [{ id: 'G', kind: 'guard', pos: [-30, 0, 0], sectorId: 'arena' }] }), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 19);
  // player faces +Z; guard at -X behind nothing — AI ignores camera anyway
  const vB = targetView(gB, [0, 0, 100]);
  let hitsB = 0;
  for (let i = 0; i < 5 * 120; i++) {
    gB.step(idle(vB));
    for (const ev of drainEvents(gB)) if (ev.type === 'playerHit') hitsB++;
  }
  check('off-screen enemy attacks player', hitsB > 0 && gB.enemies[0].shotsFired > 0,
    `hits=${hitsB}`);

  // exposure lethality: 2 guards + 1 turret vs stationary HP1000 -> dead <15s
  const gX = new Game(makeArena({
    spawns: [
      { id: 'G1', kind: 'guard', pos: [30, 0, 15], sectorId: 'arena' },
      { id: 'G2', kind: 'guard', pos: [30, 0, -15], sectorId: 'arena' },
      { id: 'T1', kind: 'turret', pos: [-30, 0, 0], sectorId: 'arena' },
    ],
  }), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 23);
  const vX = targetView(gX, [0, 0, 100]);
  let deadAt = -1;
  for (let i = 0; i < 16 * 120 && deadAt < 0; i++) {
    gX.step(idle(vX));
    drainEvents(gX);
    if (gX.state === 'failed') deadAt = gX.now;
  }
  check('2 guards + 1 turret kill stationary player <15s', deadAt > 0 && deadAt < 15,
    `t=${deadAt > 0 ? f2(deadAt) : 'alive hp=' + f2(gX.player.hp)}`);
}

// =========================================================================
section('OBJECTIVES / SNAPSHOT (real stage)');
{
  const g = new Game(stage, { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 42);
  const ids = Object.fromEntries(g.enemies.map(e => [e.id, e]));
  check('B1 closed at start', !stage.barriers.find(b => b.id === 'B1').open &&
    !stage.barrierBoxes['B1'][0].disabled);
  g.damageEnemy(ids['TC1'], 9999, ids['TC1'].center(), 'machinegun');
  g.damageEnemy(ids['TC1'], 9999, ids['TC1'].center(), 'machinegun');
  check('TC1 -> B1 opens', stage.barriers.find(b => b.id === 'B1').open &&
    stage.barrierBoxes['B1'][0].disabled);
  check('FCS unlocks on first control kill', g.fcsUnlocked === true);
  for (const id of ['TC2', 'TC3', 'TC4', 'TC5']) g.damageEnemy(ids[id], 9999, ids[id].center(), 'machinegun');
  check('B6 stays shut until all six down', !g.gateOpen && !stage.barriers.find(b => b.id === 'B6').open);
  g.damageEnemy(ids['TC6'], 9999, ids['TC6'].center(), 'machinegun');
  check('B6 + gate open on sixth kill', g.gateOpen && stage.barriers.find(b => b.id === 'B6').open);

  // clear on entering escape zone
  const v = targetView(g, [250, 0, 15]);
  g.player.pos = [250, 0, 15];
  g.step(idle(v));
  check('entering escape zone clears mission', g.state === 'cleared');

  // fail precedence
  const g2 = new Game(buildStage(), { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 42);
  g2.player.hp = 0;
  g2.step(idle(v));
  check('hp 0 -> failed', g2.state === 'failed');

  // snapshot required fields
  const s = g2.getSnapshot();
  const need = ['version', 'seed', 'state', 'elapsedSeconds', 'loadout', 'player', 'effectiveStats',
    'lock', 'fireControl', 'recentPlayerShots', 'enemies', 'objective', 'stage'];
  check('snapshot has all top-level fields', need.every(k => k in s));
  check('snapshot player.movement fields', ['horizontalMode', 'verticalMode', 'glideEnabled',
    'desiredHorizontalDirection', 'qbSuccessfulCount', 'qbLastStartedAtSeconds',
    'qbImpulseRemainingSeconds', 'qbCooldownRemainingSeconds', 'lastEnSpentAtSeconds']
    .every(k => k in s.player.movement));
  check('snapshot enemy fields', s.enemies.length === 45 &&
    ['id', 'kind', 'isGateControl', 'sectorId', 'position', 'velocity', 'hp', 'alive',
      'alert', 'hasLineOfSight', 'shotsFired', 'lastShotAtSeconds'].every(k => k in s.enemies[0]));
}

// =========================================================================
console.log(`\n========================================`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (failures.length) console.log('FAILED: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
