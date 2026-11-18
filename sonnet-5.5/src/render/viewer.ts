/**
 * Dev-only render viewer (viewer.html). Drives the real GameRenderer with hand-posed GameState objects so that the
 * models / effects / stage can be looked at and screenshotted (tools/render-shots.ts). Not part of the game.
 */
import { Game } from '../sim/game';
import { updateCamera, playerMuzzlePosition, freeFireDirection } from '../sim/camera';
import { visualAimDirection } from './aim';
import { GameRenderer } from './renderer';
import { buildStageMeshes } from './stageMesh';
import { MaterialLibrary, STAGE_MATS, TEXTURE_NAMES } from './textures';
import { buildDemoStage, buildStressStage } from './viewerStage';
import { buildStage } from '../stage';
import type { GameEvent, GameState, Loadout, MaterialKey, StageDef, V3 } from '../sim/types';
import { WEAPONS } from '../config';

const params = new URLSearchParams(location.search);
const W = Number(params.get('w') ?? 1280);
const H = Number(params.get('h') ?? 720);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const renderer = new GameRenderer(canvas);
renderer.resize(W, H, Number(params.get('dpr') ?? 1));

let game: Game;
let stage: StageDef;
let updater: ((t: number, dt: number, events: GameEvent[]) => void) | null = null;
let clock = 0;
let stateOverrideMode: 'garage' | null = null;

const v = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const norm = (a: V3): V3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

function newGame(st: StageDef, loadout: Loadout): void {
  stage = st;
  game = new Game({ stage: st, loadout, viewportW: W, viewportH: H });
  game.sortie(loadout);
  renderer.setStage(st);
  renderer.showGame();
  stateOverrideMode = null;
  updater = null;
  clock = 0;
}

function camLook(s: GameState, pos: V3, target: V3, fov = 60): void {
  const f = norm(sub(target, pos));
  const r = norm(cross(f, v(0, 1, 0)));
  const u = cross(r, f);
  s.camera.pos = pos;
  s.camera.forward = f;
  s.camera.right = r;
  s.camera.up = u;
  s.camera.fovYDeg = fov;
}

function place(s: GameState, pos: V3, yaw: number, pitch: number): void {
  s.player.pos = pos;
  s.player.prevPos = { ...pos };
  s.player.yaw = yaw;
  s.player.pitch = pitch;
  updateCamera(s, game.world);
}

function killEnemy(s: GameState, id: string): void {
  const e = s.enemies.find((x) => x.id === id);
  if (e) {
    e.alive = false;
    e.hp = 0;
  }
}

// ------------------------------------------------------------------ scenes
type Scene = (a: Record<string, string>) => void;

const scenes: Record<string, Scene> = {
  'hangar-biped': () => {
    newGame(buildDemoStage(), { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    game.state.mode = 'garage';
    renderer.showHangar(game.state.loadout);
  },
  'hangar-quad': () => {
    newGame(buildDemoStage(), { fcs: 'medium', generator: 'balanced', legs: 'quadruped' });
    game.state.mode = 'garage';
    renderer.showHangar(game.state.loadout);
  },
  play: (a) => {
    const legs = a.legs === 'quad' ? 'quadruped' : 'biped';
    newGame(buildDemoStage(), { fcs: 'medium', generator: 'balanced', legs });
    const s = game.state;
    s.player.weapon = (a.weapon as never) ?? 'machinegun';
    place(s, v(0, 1.5, 34), Number(a.yaw ?? 0.05), Number(a.pitch ?? -0.08));
    updater = (t, dt) => {
      const mode = a.mode ?? 'idle';
      const p = s.player;
      p.mv.thrusting = false;
      p.mv.qbImpulseRemaining = 0;
      p.grounded = true;
      p.mv.verticalMode = 'grounded';
      p.mv.horizontalMode = 'walk';
      p.vel = v(0, 0, 0);
      if (mode === 'walk') p.vel = v(0, 0, -9);
      if (mode === 'walkside') p.vel = v(8, 0, 0);
      if (mode === 'glide') {
        p.vel = v(0, 0, -22);
        p.mv.horizontalMode = 'glide';
      }
      if (mode === 'qb') {
        p.vel = v(0, 0, -80);
        p.mv.horizontalMode = 'quickboost';
        p.mv.qbImpulseRemaining = 0.1;
        p.mv.qbDir = { x: 0, z: -1 };
      }
      if (mode === 'qbglide') {
        p.vel = v(0, 0, -62);
        p.mv.horizontalMode = 'glide';
        p.mv.qbDir = { x: 0, z: -1 };
      }
      if (mode === 'fly') {
        p.grounded = false;
        p.mv.verticalMode = 'flying';
        p.mv.thrusting = true;
        p.vel = v(0, 8, -12);
        if (p.pos.y < 9) p.pos.y = 9;
      }
      if (mode === 'jump') {
        p.grounded = false;
        p.mv.verticalMode = 'rising';
        p.vel = v(0, 6, -6);
        if (p.pos.y < 4) p.pos.y = 4;
      }
      if (mode === 'fall') {
        p.grounded = false;
        p.mv.verticalMode = 'falling';
        p.vel = v(0, -12, -10);
        if (p.pos.y < 6) p.pos.y = 6;
      }
      p.pos = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + (mode === 'fly' || mode === 'jump' ? 0 : 0), z: p.pos.z + p.vel.z * dt };
      updateCamera(s, game.world);
      if (a.cam) {
        // close-up cameras around the mech (dev only): front / side / back / top
        const c = p.pos;
        const ang = p.yaw;
        const f = { x: -Math.sin(ang), z: -Math.cos(ang) };
        const r = { x: Math.cos(ang), z: -Math.sin(ang) };
        const d = Number(a.dist ?? 6.5);
        const tgt = v(c.x, c.y + 0.4, c.z);
        let pos = v(c.x, c.y + 1.2, c.z);
        if (a.cam === 'front') pos = v(c.x + (f.x * 0.8 + r.x * 0.6) * d, c.y + 1.0, c.z + (f.z * 0.8 + r.z * 0.6) * d);
        else if (a.cam === 'side') pos = v(c.x + r.x * d, c.y + 0.6, c.z + r.z * d);
        else if (a.cam === 'back') pos = v(c.x - f.x * d, c.y + 1.4, c.z - f.z * d);
        else if (a.cam === 'backr') pos = v(c.x + (-f.x * 0.75 + r.x * 0.65) * d, c.y + 1.2, c.z + (-f.z * 0.75 + r.z * 0.65) * d);
        else if (a.cam === 'top') pos = v(c.x - f.x * 3, c.y + d, c.z - f.z * 3);
        camLook(s, pos, tgt, Number(a.fov ?? 45));
        // the debug camera must not change where the gun aims: force the aim to the player's own view direction
        const cp = Math.cos(p.pitch);
        const dir = { x: -Math.sin(ang) * cp, y: Math.sin(p.pitch), z: -Math.cos(ang) * cp };
        s.lock = { state: 'locked', targetId: 'G01', progress: 1, elapsed: 1, radiusCssPx: 100 };
        s.fc = { ...s.fc, status: 'solved', weapon: p.weapon, launchDirection: dir };
      }
      if (a.lock === '1' || a.lock === 'nosol') {
        // pretend a lock + solution on G01 so the arm follows the launch direction ('nosol' = no_solution: direct aim at the target)
        const e = s.enemies[0];
        const m = playerMuzzlePosition(p);
        const d = norm({ x: e.pos.x - m.x, y: e.pos.y - m.y + 1.2, z: e.pos.z - m.z });
        s.lock = { state: 'locked', targetId: e.id, progress: 1, elapsed: 1, radiusCssPx: 100 };
        s.fc = { ...s.fc, status: a.lock === 'nosol' ? 'no_solution' : 'solved', weapon: p.weapon, launchDirection: d };
      }
      void t;
    };
  },
  enemies: (a) => {
    newGame(buildDemoStage(), { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    const s = game.state;
    // line up guards and turrets in front of a close camera
    const g = s.enemies.filter((e) => e.kind === 'guard');
    const tu = s.enemies.filter((e) => e.kind === 'turret');
    const row = [g[0], g[1], g[2], g[3]];
    row.forEach((e, i) => {
      e.pos = v(-9 + i * 4.2, 1.5, 22);
      e.yaw = Math.PI - 0.25 + i * 0.12;
    });
    row[1].alert = true;
    row[2].alert = true;
    row[2].telegraph = 0.7;
    row[3].hitFlash = 0.12;
    row[3].alert = true;
    g[4].pos = v(-4, 1.5, 14);
    g[4].alive = false;
    tu[0].pos = v(8, 1.6, 17);
    tu[0].yaw = Math.PI + 0.35;
    tu[0].alert = true;
    tu[0].telegraph = 0.8;
    tu[1].pos = v(15, 1.6, 20);
    tu[1].yaw = Math.PI - 0.25;
    tu[1].alert = true;
    place(s, v(0, 1.5, 40), 0, -0.05);
    updater = (t) => {
      s.camera.fovYDeg = 58;
      camLook(s, v(a.cx ? Number(a.cx) : 3, a.cy ? Number(a.cy) : 3.6, a.cz ? Number(a.cz) : 34), v(a.tx ? Number(a.tx) : 3.5, 1.5, 20), 58);
      row[1].vel = v(0, 0, 0);
      row[2].telegraph = 0.4 + 0.5 * Math.abs(Math.sin(t * 6));
      tu[0].telegraph = 0.4 + 0.5 * Math.abs(Math.sin(t * 4));
      // walking guard
      g[5].pos = v(-12, 1.5, 26);
      g[5].vel = v(7, 0, 0);
      g[5].yaw = -Math.PI / 2;
      g[5].pos.x = -12 + ((t * 7) % 10);
      row[0].alert = t > 0.5;
    };
  },
  'enemy-far': () => {
    newGame(buildDemoStage(), { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    const s = game.state;
    place(s, v(0, 1.5, 32), 0, -0.02);
    s.enemies.forEach((e, i) => {
      if (e.kind === 'guard') e.pos = v(-30 + i * 12, 1.5, -10);
    });
    s.enemies[6].pos = v(-20, 1.6, -34);
    s.enemies[7].pos = v(20, 1.6, -34);
  },
  fx: (a) => {
    newGame(buildDemoStage(), { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    const s = game.state;
    place(s, v(0, 1.5, 34), 0, -0.02);
    const kind = a.kind ?? 'mg';
    const rng = (x: number): number => Math.abs(Math.sin(x * 12.9898) * 43758.5453) % 1;
    let nextId = 1;
    let acc = 0;
    updater = (t, dt, ev) => {
      const p = s.player;
      p.pos = v(0, 1.5, 34);
      updateCamera(s, game.world);
      p.weapon = kind === 'beam' ? 'beam' : kind === 'missile' ? 'missile' : 'machinegun';
      const muzzle = playerMuzzlePosition(p);
      const dir = freeFireDirection(s, game.world, muzzle);
      if (a.cam === 'side') {
        // debug camera off to the side; keep the mech aiming along the real firing direction
        camLook(s, v(a.cx ? Number(a.cx) : 9, a.cy ? Number(a.cy) : 3.4, a.cz ? Number(a.cz) : 40), v(a.tx ? Number(a.tx) : -1, 2, a.tz ? Number(a.tz) : 22), Number(a.fov ?? 62));
        s.lock = { state: 'locked', targetId: 'G01', progress: 1, elapsed: 1, radiusCssPx: 100 };
        s.fc = { ...s.fc, status: 'solved', weapon: p.weapon, launchDirection: dir };
      }
      // integrate fake projectiles
      for (const b of s.bullets) {
        b.age += dt;
        b.prevPos = { ...b.pos };
        b.pos = { x: b.origin.x + b.v0.x * b.age, y: b.origin.y + b.v0.y * b.age - 9 * b.age * b.age, z: b.origin.z + b.v0.z * b.age };
        if (b.age > 1.2) b.alive = false;
      }
      s.bullets = s.bullets.filter((b) => b.alive);
      for (const m of s.missiles) {
        m.age += dt;
        m.prevPos = { ...m.pos };
        m.pos = { x: m.pos.x + m.vel.x * dt, y: m.pos.y + m.vel.y * dt, z: m.pos.z + m.vel.z * dt };
        if (m.age > 2) m.alive = false;
      }
      s.missiles = s.missiles.filter((m) => m.alive);
      for (const b of s.enemyBullets) {
        b.age += dt;
        b.prevPos = { ...b.pos };
        b.pos = { x: b.pos.x + b.vel.x * dt, y: b.pos.y + b.vel.y * dt, z: b.pos.z + b.vel.z * dt };
        if (b.age > b.maxLife) b.alive = false;
      }
      s.enemyBullets = s.enemyBullets.filter((b) => b.alive);
      acc += dt;
      if (kind === 'mg') {
        while (acc >= 0.1) {
          acc -= 0.1;
          const jitter = 0;
          const v0 = { x: dir.x * 100 + jitter, y: dir.y * 100 + 9, z: dir.z * 100 };
          s.bullets.push({ id: nextId++, pos: { ...muzzle }, prevPos: { ...muzzle }, origin: { ...muzzle }, v0, age: 0, damage: 12, alive: true });
          ev.push({ type: 'mgFire', time: t, origin: { ...muzzle }, dir });
          if (t > 0.3 && rng(nextId) < 0.5) ev.push({ type: 'hit', time: t, pos: v(2 - rng(nextId + 3) * 6, 1, -20), normal: v(0, 1, 0.6), on: 'world', weapon: 'machinegun' });
        }
      } else if (kind === 'beam') {
        while (acc >= 0.5) {
          acc -= 0.5;
          const end = { x: muzzle.x + dir.x * 60, y: 0.2, z: muzzle.z + dir.z * 60 };
          ev.push({ type: 'beamFire', time: t, origin: { ...muzzle }, end, hit: 'world', targetId: null });
        }
      } else if (kind === 'missile') {
        while (acc >= 1.0) {
          acc -= 1.0;
          s.missiles.push({ id: nextId++, pos: { ...muzzle }, prevPos: { ...muzzle }, vel: { x: dir.x * 45, y: dir.y * 45, z: dir.z * 45 }, age: 0, life: 4, damage: 180, targetId: 'G01', lastSeenPos: v(), lastSeenVel: v(), lastSeenAt: 0, alive: true });
          ev.push({ type: 'missileFire', time: t, origin: { ...muzzle }, dir });
        }
      } else if (kind === 'enemy') {
        while (acc >= 0.5) {
          acc -= 0.5;
          const from = v(-6 + 8 * rng(nextId), 2, 14);
          const to = v(0, 2.5, 34);
          const d = norm(sub(to, from));
          const turret = nextId % 2 === 0;
          s.enemyBullets.push({ id: nextId++, ownerId: 'G01', kind: turret ? 'turret' : 'guard', pos: { ...from }, prevPos: { ...from }, vel: { x: d.x * (turret ? 60 : 70), y: d.y * 60, z: d.z * (turret ? 60 : 70) }, age: 0, maxLife: 2, damage: 18, radius: turret ? 0.25 : 0.2, alive: true });
          ev.push({ type: 'enemyFire', time: t, id: 'G01', kind: turret ? 'turret' : 'guard', origin: { ...from }, dir: d });
        }
      } else if (kind === 'explosion') {
        // close=<metres>: the blast happens that far in front of the camera (checks that a near explosion fades instead of whiting out the view)
        const at = (x: number, y: number, z: number): V3 => {
          if (!a.close) return v(x, y, z);
          const c = s.camera;
          const d = Number(a.close);
          return v(c.pos.x + c.forward.x * d, c.pos.y + c.forward.y * d, c.pos.z + c.forward.z * d);
        };
        while (acc >= 1.2) {
          acc -= 1.2;
          ev.push({ type: 'explosion', time: t, pos: at(-2 + rng(nextId++) * 4, 2, 20), size: nextId % 2 ? 2.0 : 2.6 });
        }
        if (t < 0.02) ev.push({ type: 'explosion', time: t, pos: at(0, 2, 20), size: 2.6 }, { type: 'enemyDown', time: t, id: 'G01', kind: 'guard', pos: at(0, 1.5, 20) });
      } else if (kind === 'qb') {
        if (t < 0.02) ev.push({ type: 'qb', time: t, pos: { ...p.pos }, dir: v(0, 0, -1) });
      } else if (kind === 'land') {
        if (t < 0.02) ev.push({ type: 'land', time: t, pos: { ...p.pos }, impactSpeed: 30 }, { type: 'jump', time: t, pos: { ...p.pos } });
      }
    };
  },
  /** long-running stress: every event type, many projectiles, kills/revives, barrier toggles and repeated sorties */
  soak: (a) => {
    newGame(buildDemoStage(), { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    place(game.state, v(0, 1.5, 34), 0, -0.05);
    let nextId = 1;
    let frameNo = 0;
    const retryEvery = Number(a.retryEvery ?? 300);
    updater = (t, dt, ev) => {
      frameNo++;
      if (frameNo % retryEvery === 0) {
        game.retry();
        renderer.showGame();
        place(game.state, v(0, 1.5, 34), 0, -0.05);
      }
      const s = game.state;
      const p = s.player;
      const ph = Math.floor(t / 1.5) % 5;
      p.mv.horizontalMode = ph === 1 ? 'glide' : ph === 2 ? 'quickboost' : 'walk';
      p.mv.qbImpulseRemaining = ph === 2 ? 0.1 : 0;
      p.mv.qbDir = { x: 0, z: -1 };
      p.vel = ph === 0 ? v(0, 0, -8) : ph === 1 ? v(0, 0, -22) : ph === 2 ? v(0, 0, -80) : v(0, 4, -6);
      p.grounded = ph < 3;
      p.mv.verticalMode = ph < 3 ? 'grounded' : ph === 3 ? 'flying' : 'falling';
      p.mv.thrusting = ph === 3;
      p.pos = { x: Math.sin(t) * 6, y: p.grounded ? 1.5 : 9, z: 34 - ((t * 5) % 12) };
      updateCamera(s, game.world);
      const muzzle = playerMuzzlePosition(p);
      const dir = freeFireDirection(s, game.world, muzzle);
      // fake projectiles (positions integrated here; the renderer only draws them)
      for (const b of s.bullets) {
        b.age += dt;
        b.pos = { x: b.origin.x + b.v0.x * b.age, y: b.origin.y + b.v0.y * b.age - 9 * b.age * b.age, z: b.origin.z + b.v0.z * b.age };
        if (b.age > 1.5) b.alive = false;
      }
      s.bullets = s.bullets.filter((b) => b.alive);
      for (const m of s.missiles) {
        m.age += dt;
        m.pos = { x: m.pos.x + m.vel.x * dt, y: m.pos.y + m.vel.y * dt, z: m.pos.z + m.vel.z * dt };
        if (m.age > 2) m.alive = false;
      }
      s.missiles = s.missiles.filter((m) => m.alive);
      for (const b of s.enemyBullets) {
        b.age += dt;
        b.pos = { x: b.pos.x + b.vel.x * dt, y: b.pos.y + b.vel.y * dt, z: b.pos.z + b.vel.z * dt };
        if (b.age > b.maxLife) b.alive = false;
      }
      s.enemyBullets = s.enemyBullets.filter((b) => b.alive);
      for (let k = 0; k < 2; k++) {
        const o = { ...muzzle };
        s.bullets.push({ id: nextId++, pos: o, prevPos: { ...o }, origin: { ...o }, v0: { x: dir.x * 100, y: dir.y * 100 + 9, z: dir.z * 100 }, age: 0, damage: 12, alive: true });
        ev.push({ type: 'mgFire', time: t, origin: { ...muzzle }, dir });
      }
      if (frameNo % 20 === 0) {
        s.missiles.push({ id: nextId++, pos: { ...muzzle }, prevPos: { ...muzzle }, vel: { x: dir.x * 45, y: dir.y * 45, z: dir.z * 45 }, age: 0, life: 4, damage: 180, targetId: 'G01', lastSeenPos: v(), lastSeenVel: v(), lastSeenAt: 0, alive: true });
        ev.push({ type: 'missileFire', time: t, origin: { ...muzzle }, dir }, { type: 'beamFire', time: t, origin: { ...muzzle }, end: v(0, 1, 5), hit: 'enemy', targetId: 'G01' });
      }
      if (frameNo % 6 === 0) {
        for (const e of s.enemies) {
          if (!e.alive) continue;
          const d = norm(sub(p.pos, e.pos));
          s.enemyBullets.push({ id: nextId++, ownerId: e.id, kind: e.kind, pos: { x: e.pos.x, y: e.pos.y + 0.4, z: e.pos.z }, prevPos: { ...e.pos }, vel: { x: d.x * 65, y: d.y * 65, z: d.z * 65 }, age: 0, maxLife: 2, damage: 18, radius: 0.2, alive: true });
          ev.push({ type: 'enemyFire', time: t, id: e.id, kind: e.kind, origin: { ...e.pos }, dir: d });
          e.telegraph = (e.telegraph + 0.3) % 1;
          e.alert = true;
        }
      }
      if (frameNo % 40 === 0) {
        const e = s.enemies[(frameNo / 40) % s.enemies.length];
        e.alive = false;
        ev.push({ type: 'explosion', time: t, pos: { ...e.pos }, size: 2 }, { type: 'enemyDown', time: t, id: e.id, kind: e.kind, pos: { ...e.pos } });
      }
      if (frameNo % 40 === 20) for (const e of s.enemies) e.alive = true;
      if (frameNo % 50 === 0) ev.push({ type: 'qb', time: t, pos: { ...p.pos }, dir: v(0, 0, -1) }, { type: 'land', time: t, pos: { ...p.pos }, impactSpeed: 30 }, { type: 'playerHit', time: t, damage: 18, fromPos: v(0, 2, 10), dirToSource: v(0, 0, -1) });
      const bi = game.world.indexOfBox('B1a');
      game.world.setBoxEnabled(bi, Math.floor(t / 2) % 2 === 0);
    };
  },
  barrier: () => {
    newGame(buildDemoStage(), { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    const s = game.state;
    place(s, v(0, 1.5, -10), 0, 0.0);
    let opened = false;
    updater = (t, _dt, ev) => {
      s.camera.pos = v(4, 5, -14);
      camLook(s, v(6, 6, -14), v(0, 6, -40), 70);
      if (!opened && t > 0.4) {
        opened = true;
        const i = game.world.indexOfBox('B1a');
        game.world.setBoxEnabled(i, false);
        s.objective.openBarrierIds.push('B1');
        killEnemy(s, 'T01');
        ev.push({ type: 'barrierOpen', time: t, barrierId: 'B1' });
      }
    };
  },
  overview: () => {
    newGame(buildDemoStage(), { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    const s = game.state;
    place(s, v(0, 1.5, 34), 0, 0);
    updater = () => camLook(s, v(0, 40, 90), v(0, 4, -10), 62);
  },
  stage: (a) => {
    newGame(buildDemoStage(), { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    const s = game.state;
    place(s, v(0, 1.5, 34), 0, -0.03);
    updater = () => {
      if (a.cam === 'high') camLook(s, v(-50, 12, 50), v(0, 6, -10), 70);
      else if (a.cam === 'gate') {
        const gi = game.world.indexOfBox('GATE1');
        void gi;
        camLook(s, v(30, 4, 40), v(60, 5, 20), 70);
      } else if (a.cam === 'cat') camLook(s, v(-30, 8, 38), v(20, 5, 48), 75);
      else updateCamera(s, game.world);
    };
  },
  /** the real campaign stage (src/stage). at=start | Sxx | x,y,z */
  real: (a) => {
    if (a.chunk) renderer.chunkOpts = { chunkXZ: Number(a.chunk), chunkY: Number(a.chunk) * 0.66 };
    const st = buildStage();
    newGame(st, { fcs: 'medium', generator: 'balanced', legs: a.legs === 'quad' ? 'quadruped' : 'biped' });
    const s = game.state;
    let pos = { ...st.playerStart.pos };
    let yaw = st.playerStart.yaw;
    const at = a.at ?? 'start';
    if (at !== 'start') {
      const sec = st.sectors.find((x) => x.id === at);
      if (sec) {
        pos = { x: (sec.bounds.min.x + sec.bounds.max.x) / 2, y: sec.floorY + 1.5, z: (sec.bounds.min.z + sec.bounds.max.z) / 2 };
      } else {
        const [x, y, z] = at.split(',').map(Number);
        pos = { x, y, z };
      }
    }
    if (a.yaw) yaw = Number(a.yaw);
    let pitch = Number(a.pitch ?? -0.1);
    if (a.look) {
      // aim the camera at an enemy (dev): yaw / pitch from the player toward its centre
      const tgt = s.enemies.find((x) => x.id === a.look);
      if (tgt) {
        const dx = tgt.pos.x - pos.x;
        const dy = tgt.pos.y - (pos.y + 1.2);
        const dz = tgt.pos.z - pos.z;
        yaw = Math.atan2(-dx, -dz) + Number(a.yawoff ?? 0.28); // turn a little so the target is not hidden behind the mech
        pitch = Math.atan2(dy, Math.hypot(dx, dz));
      }
    }
    if (a.lookat) {
      // aim the camera at a world point x,y,z (dev)
      const [tx, ty, tz] = a.lookat.split(',').map(Number);
      const dx = tx - pos.x;
      const dz = tz - pos.z;
      yaw = Math.atan2(-dx, -dz) + Number(a.yawoff ?? 0.28);
      pitch = Math.atan2(ty - (pos.y + 1.2), Math.hypot(dx, dz));
    }
    place(s, pos, yaw, pitch);
    if (a.open === '1') {
      for (const b of st.barriers) for (const id of b.boxIds) game.world.setBoxEnabled(game.world.indexOfBox(id), false);
    }
    updater = () => {
      if (a.mode === 'glide') {
        s.player.mv.horizontalMode = 'glide';
        s.player.vel = { x: 0, y: 0, z: 0 };
      }
      updateCamera(s, game.world);
    };
  },
  /** campaign stage seen from the k-th waypoint of the documented main route, looking toward the next one */
  route: (a) => {
    if (a.chunk) renderer.chunkOpts = { chunkXZ: Number(a.chunk), chunkY: Number(a.chunk) * 0.66 };
    const st = buildStage();
    newGame(st, { fcs: 'medium', generator: 'balanced', legs: a.legs === 'quad' ? 'quadruped' : 'biped' });
    const s = game.state;
    const pts = st.mainRoute.points;
    const k = Math.max(0, Math.min(pts.length - 1, Number(a.wp ?? 0)));
    const p0 = pts[k];
    const p1 = pts[Math.min(k + 1, pts.length - 1)] ?? p0;
    let yaw = Math.atan2(-(p1.x - p0.x), -(p1.z - p0.z));
    if (a.yaw) yaw = Number(a.yaw);
    if (k === pts.length - 1 && !a.yaw) yaw = 0;
    place(s, { x: p0.x, y: p0.y, z: p0.z }, yaw, Number(a.pitch ?? -0.1));
    if (a.open === '1') for (const b of st.barriers) for (const id of b.boxIds) game.world.setBoxEnabled(game.world.indexOfBox(id), false);
    updater = () => updateCamera(s, game.world);
  },
  stress: (a) => {
    newGame(buildStressStage(Number(a.n ?? 4000)), { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    const s = game.state;
    place(s, v(-120 + Number(a.x ?? 0), 1.5, -40 + Number(a.z ?? 0)), Number(a.yaw ?? 0.6), -0.05);
    updater = () => updateCamera(s, game.world);
  },
};

function applyOverrides(): void {
  if (stateOverrideMode) game.state.mode = stateOverrideMode;
}

const px = new Uint8Array(4);
/** force the (software) GPU to finish: readPixels blocks until all queued work is done */
function sync(): void {
  const gl = renderer.webgl.getContext();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
}

let evtBuf: GameEvent[] = [];
function frame(dt: number): void {
  if (game.state.mode !== 'garage') {
    evtBuf = [];
    updater?.(clock, dt, evtBuf);
  }
  applyOverrides();
  renderer.render(game.state, evtBuf, dt);
  evtBuf = [];
  clock += dt;
}

interface ViewerApi {
  setup(name: string, extra?: Record<string, string>): void;
  frames(n: number, dt?: number): void;
  stats(): unknown;
  weapon(): unknown;
  ready: boolean;
  game(): Game;
  renderer(): GameRenderer;
  timeFrames(n: number, dt?: number): number;
  resources(): unknown;
  setMode(m: GameState['mode']): void;
  buildTime(n: number): unknown;
  setCulling(on: boolean): void;
  /** render one frame and return the luminance distribution of the drawing buffer (0..255): dev check for "not too dark" */
  luma(): { mean: number; p05: number; p50: number; p95: number; darkFraction: number };
  /** contact sheet (PNG data URL) of procedural textures, each tiled 2 x 2 at `cell` px: judge the paint without WebGL */
  texSheet(names: string[], cell?: number, mr?: boolean): string;
  /** time [ms] to paint every procedural texture (+ the derived roughness maps) on this machine */
  texTimes(): { total: number; mrTotal: number; each: Record<string, number> };
  /** min / median of n frame times [ms] (each frame is forced to finish on the GPU) */
  bench(n: number, dt?: number): { min: number; median: number };
  /** JS-only cost of renderer.render() (draw submission), no GPU sync */
  cpuMs(n: number, dt?: number): number;
  chunkOpts(xz: number): void;
  /** n x (fly / fight a little, hangar round trip, re-sortie); returns GL resource counts after every iteration */
  /** rebuild the static stage meshes n times (setStage) with a few frames each; returns GL resource counts */
  restage(n: number): { geometries: number; textures: number; programs: number; sceneObjects: number }[];
  cycle(n: number, framesEach?: number): { geometries: number; textures: number; programs: number; sceneObjects: number }[];
}

const api: ViewerApi = {
  ready: false,
  setup(name, extra = {}) {
    const fn = scenes[name];
    if (!fn) throw new Error(`unknown scene ${name}`);
    fn(extra);
    api.ready = true;
  },
  frames(n, dt = 1 / 60) {
    for (let i = 0; i < n; i++) {
      frame(dt);
      sync();
    }
  },
  timeFrames(n, dt = 1 / 60) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      frame(dt);
      sync();
    }
    return (performance.now() - t0) / n;
  },
  stats() {
    return { ...renderer.getStats(), fx: renderer.effectStats, poolObjects: renderer.effectPoolObjects, breakdown: renderer.drawBreakdown(), floorRays: renderer.floorRays, buffer: renderer.bufferInfo };
  },
  weapon() {
    const w = renderer.weaponAlignment();
    const s = game.state;
    const muzzle = playerMuzzlePosition(s.player);
    const aim = visualAimDirection(s, muzzle);
    const err = Math.hypot(w.tip.x - muzzle.x, w.tip.y - muzzle.y, w.tip.z - muzzle.z);
    const dot = w.dir.x * aim.x + w.dir.y * aim.y + w.dir.z * aim.z;
    return { tip: w.tip, muzzle, tipError: err, aim, dir: w.dir, angleErrorDeg: (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI };
  },
  resources() {
    return { objects: renderer.sceneObjectCount, fxObjects: renderer.effectPoolObjects, gl: renderer.glResources, fx: renderer.effectStats };
  },
  setMode(m) {
    game.state.mode = m;
  },
  buildTime(n) {
    const st = buildStressStage(n);
    const lib = new MaterialLibrary();
    const t0 = performance.now();
    const cold = buildStageMeshes(st, lib);
    const t1 = performance.now();
    const warm = buildStageMeshes(st, lib);
    const t2 = performance.now();
    return { boxes: st.boxes.length, coldMs: t1 - t0, warmMs: t2 - t1, chunks: warm.stats.chunks, barrierBoxes: warm.stats.barrierBoxes, triangles: warm.stats.triangles, vertices: warm.stats.vertices, drawCallsIfAllVisible: cold.stats.drawCallsIfAllVisible };
  },
  setCulling(on) {
    renderer.sectorCulling = on;
  },
  luma() {
    frame(1 / 60);
    const gl = renderer.webgl.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const hist = new Uint32Array(256);
    let sum = 0;
    const n = w * h;
    for (let i = 0; i < buf.length; i += 4) {
      const y = Math.round(0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]);
      hist[y]++;
      sum += y;
    }
    const q = (f: number): number => {
      let c = 0;
      for (let i = 0; i < 256; i++) {
        c += hist[i];
        if (c >= f * n) return i;
      }
      return 255;
    };
    let dark = 0;
    for (let i = 0; i < 40; i++) dark += hist[i];
    return { mean: sum / n, p05: q(0.05), p50: q(0.5), p95: q(0.95), darkFraction: dark / n };
  },
  texTimes() {
    const lib = new MaterialLibrary();
    const each: Record<string, number> = {};
    const t0 = performance.now();
    for (const n of TEXTURE_NAMES) {
      const t = performance.now();
      lib.texture(n as never);
      each[n] = performance.now() - t;
    }
    const total = performance.now() - t0;
    const t1 = performance.now();
    for (const k of Object.keys(STAGE_MATS)) lib.mrTexture(k as MaterialKey);
    return { total, mrTotal: performance.now() - t1, each };
  },
  texSheet(names, cell = 256, mr = false) {
    const lib = new MaterialLibrary();
    const cols = Math.min(4, names.length);
    const rows = Math.ceil(names.length / cols);
    const sheet = document.createElement('canvas');
    sheet.width = cols * cell;
    sheet.height = rows * cell;
    const g = sheet.getContext('2d') as CanvasRenderingContext2D;
    names.forEach((n, i) => {
      const key = n as MaterialKey;
      const tex = mr ? lib.mrTexture(key) : lib.texture(STAGE_MATS[key].tex);
      const img = tex?.image as CanvasImageSource | undefined;
      if (!img) return;
      const x = (i % cols) * cell;
      const y = Math.floor(i / cols) * cell;
      const h = cell / 2;
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) g.drawImage(img, x + a * h, y + b * h, h, h);
      g.fillStyle = '#fff';
      g.font = '12px monospace';
      g.fillText(n, x + 4, y + 14);
    });
    return sheet.toDataURL('image/png');
  },
  bench(n, dt = 1 / 60) {
    const t: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      frame(dt);
      sync();
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    return { min: t[0], median: t[Math.floor(t.length / 2)] };
  },
  cpuMs(n, dt = 1 / 60) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      frame(dt);
      sum += performance.now() - t0;
    }
    sync();
    return sum / n;
  },
  chunkOpts(xz) {
    renderer.chunkOpts = { chunkXZ: xz, chunkY: xz * 0.66 };
  },
  restage(n) {
    const out: { geometries: number; textures: number; programs: number; sceneObjects: number }[] = [];
    for (let i = 0; i < n; i++) {
      renderer.setStage(stage);
      renderer.showGame();
      for (let k = 0; k < 3; k++) frame(1 / 60);
      out.push({ ...renderer.glResources, sceneObjects: renderer.sceneObjectCount });
    }
    return out;
  },
  cycle(n, framesEach = 3) {
    const out: { geometries: number; textures: number; programs: number; sceneObjects: number }[] = [];
    const loadout = game.state.loadout;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < framesEach; k++) frame(1 / 60);
      // hangar round trip
      game.toGarage();
      renderer.showHangar(loadout);
      for (let k = 0; k < framesEach; k++) frame(1 / 60);
      renderer.setHangarLoadout({ ...loadout, legs: i % 2 ? 'biped' : 'quadruped' });
      for (let k = 0; k < framesEach; k++) frame(1 / 60);
      renderer.setHangarLoadout(loadout);
      // back into the stage: fresh sortie state (same stage object) and the stage again after a retry
      game.sortie(loadout);
      renderer.showGame();
      for (let k = 0; k < framesEach; k++) frame(1 / 60);
      game.retry();
      renderer.showGame();
      for (let k = 0; k < framesEach; k++) frame(1 / 60);
      const r = renderer.glResources;
      out.push({ ...r, sceneObjects: renderer.sceneObjectCount });
    }
    return out;
  },
  game: () => game,
  renderer: () => renderer,
};
(window as unknown as { __viewer: ViewerApi }).__viewer = api;

// live mode: ?scene=name renders continuously
const sceneName = params.get('scene');
if (sceneName) {
  const extra: Record<string, string> = {};
  params.forEach((val, k) => {
    if (!['scene', 'w', 'h', 'dpr'].includes(k)) extra[k] = val;
  });
  api.setup(sceneName, extra);
  if (params.get('live') !== '0') {
    let last = performance.now();
    const loop = (now: number): void => {
      frame(Math.min((now - last) / 1000, 0.05));
      last = now;
      const st = renderer.getStats();
      if (st) hud.textContent = `calls ${st.drawCalls}  tris ${st.triangles}  chunks ${st.stageChunksVisible}/${st.stageChunks}  sectors ${st.sectorsVisible}/${st.sectorsTotal}  enemies ${st.enemiesVisible}\nparticles ${st.additiveParticles}/${st.smokeParticles}`;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
void WEAPONS;
