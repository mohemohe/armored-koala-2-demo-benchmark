/**
 * Dev harness for src/render/enemyModels.ts and src/render/effects.ts (no simulation needed).
 *
 *   /dev/enemies.html?view=lineup|far|sheet      guard / turret / control turret side by side, at 60 m and 100 m,
 *                                                or a front / three-quarter / side / back turnaround of &kind=
 *                    &state=idle|alert|telegraph|dead   (&t=0..1 telegraph progress, default 0.8; &t=anim loops it)
 *                    &speed=6 &move=forward|right|back   guard walking (group really moves)
 *                    &kind=guard|turret|control          lineup: only this one, centred
 *                    &angle=deg &dist=m &height=m &fov=deg   camera orbit (lineup)
 *                    &hp=0..1                             hpFraction
 *                    &mag=3                               magnify the real pixels around the screen centre (far view)
 *                    &light=dim|dark  &tone=aces  &bare=1 (no scenery: draw-call counting)
 *   /dev/enemies.html?fx=beam|explosion|tracers|missile|bolts|qb|hits|muzzle|dust|door|stress
 *                    &at=seconds   simulated time after which the picture is frozen (deterministic screenshots)
 *                    &kind=guard|turret|control (explosion)  &hit=enemy|world|none (beam)  &dir=right|left|forward|back (qb)
 *   /dev/enemies.html?fx=lifecycle   create / animate / dispose 45 enemies + Effects three times: leak and cost report (window.__life)
 *   &live=1 keeps animating / replays the effect every 2.5 s.
 *
 *   /dev/enemies.html?fx=series&ev=<event>&ages=0.02,0.08,0.2,0.5,1   the same event at several ages side by side
 *                    ev = mg-enemy|mg-world|bolt-world|bolt-player|missile|expired-mg|expired-missile|beam-enemy|beam-world|
 *                         explosion-guard|explosion-turret|explosion-control|qb|land|jump|shot-guard|shot-turret|muzzle-mg|muzzle-missile
 * window.__stats = { calls, triangles, activeCount, maxActive, models } for tools/shot.mjs --eval.
 */
import * as THREE from 'three';
import { CAMERA, ENEMIES, GRAVITY, PLAYER, WEAPONS } from '../src/config';
import { Effects } from '../src/render/effects';
import { EnemyView, getEnemyModelStats, type EnemyViewInput } from '../src/render/enemyModels';
import type { Sim } from '../src/sim/sim';
import type { Projectile, SimEvent } from '../src/sim/types';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = q.get(k);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const fxName = q.get('fx');
const view = fxName === 'series' ? 'series' : fxName ? 'tps' : (q.get('view') ?? 'lineup');
const state = q.get('state') ?? (fxName ? 'alert' : 'idle');
const live = q.get('live') === '1';
const bare = q.get('bare') === '1';
const mag = num('mag', 1);

// ───────────────────────────── renderer / scene ─────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
if (q.get('tone') === 'aces') {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
}
document.body.prepend(renderer.domElement);
if (mag !== 1) renderer.domElement.style.transform = `scale(${mag})`;

const scene = new THREE.Scene();
const BG = 0x1b2027;
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 90, 330);

const lightMode = q.get('light') ?? 'factory';
const lk = lightMode === 'dark' ? 0.12 : lightMode === 'dim' ? 0.4 : 1;
scene.add(new THREE.HemisphereLight(0xc4d0dc, 0x4a4238, 1.5 * lk));
const sun = new THREE.DirectionalLight(0xffdfb0, 2.2 * lk); // warm sodium key
sun.position.set(-7, 13, 9);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x66c8d8, 0.35 * lk); // teal emergency fill
fill.position.set(9, 4, -6);
scene.add(fill);

function groundTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6a6e73';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 5000; i++) {
    const v = 90 + Math.floor(Math.random() * 40);
    g.fillStyle = `rgba(${v},${v},${v + 4},0.35)`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 5, 2 + Math.random() * 5);
  }
  g.strokeStyle = 'rgba(30,32,36,0.6)';
  g.lineWidth = 2;
  for (let i = 0; i <= 5; i++) {
    // 2 m joints (the tile is 10 m)
    g.beginPath();
    g.moveTo(i * 102.4, 0);
    g.lineTo(i * 102.4, 512);
    g.moveTo(0, i * 102.4);
    g.lineTo(512, i * 102.4);
    g.stroke();
  }
  g.strokeStyle = 'rgba(232,180,20,0.5)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 508, 508); // 10 m hazard-yellow grid
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(40, 40);
  t.anisotropy = 8;
  return t;
}

if (!bare) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95, metalness: 0 }),
  );
  scene.add(ground);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x565c64, roughness: 0.9 });
  const rustMat = new THREE.MeshStandardMaterial({ color: 0x7a4a2c, roughness: 0.9 });
  const addBox = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material): void => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    scene.add(b);
  };
  if (view === 'lineup' || view === 'sheet') {
    addBox(60, 9, 1, 0, 4.5, -8, wallMat);
    addBox(3, 5, 3, -14, 2.5, -5, rustMat);
  } else if (view === 'series') {
    const big = /^(explosion|qb|missile)/.test(q.get('ev') ?? '');
    addBox(200, 30, 1, 0, 15, -num('depth', big ? 34 : 13) - (big ? 16 : 14), wallMat);
  } else {
    // a back wall and some pillars so far enemies are seen against scenery, not sky
    addBox(160, 16, 2, 0, 8, -125, wallMat);
    for (let i = -3; i <= 3; i++) addBox(3, 16, 3, i * 26 + 5, 8, -112, i % 2 ? rustMat : wallMat);
    addBox(14, 5, 6, -34, 2.5, -62, rustMat);
    addBox(10, 3, 10, 30, 1.5, -40, wallMat);
  }
}

const camera = new THREE.PerspectiveCamera(CAMERA.fovYDeg, window.innerWidth / window.innerHeight, CAMERA.near, CAMERA.far);
const info = document.getElementById('info')!;
const labels = document.getElementById('labels')!;

// ───────────────────────────── enemies ─────────────────────────────
type Kind = 'guard' | 'turret' | 'control';
interface Actor {
  kind: Kind;
  view: EnemyView;
  pos: THREE.Vector3;
  yaw: number;
  input: EnemyViewInput;
}
const actors: Actor[] = [];
const target = new THREE.Vector3(); // what alert enemies aim at

function addActor(kind: Kind, x: number, z: number, yaw: number): Actor {
  const v = new EnemyView(kind === 'guard' ? 'guard' : 'turret', kind === 'control');
  const cy = kind === 'guard' ? ENEMIES.guard.centerHeight : ENEMIES.turret.centerHeight;
  v.group.position.set(x, cy, z);
  scene.add(v.group);
  const a: Actor = {
    kind,
    view: v,
    pos: v.group.position,
    yaw,
    input: {
      dt: 0,
      time: 0,
      alive: state !== 'dead',
      yaw,
      aimDir: { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) },
      telegraph: 0,
      alert: state === 'alert' || state === 'telegraph',
      hpFraction: num('hp', 1),
      speed: 0,
    },
  };
  actors.push(a);
  return a;
}

const tParam = q.get('t');
const speed = num('speed', 0);
const moveName = q.get('move') ?? 'forward';

function updateActors(dt: number, time: number): void {
  for (const a of actors) {
    const inp = a.input;
    inp.dt = dt;
    inp.time = time;
    if (inp.alert && Number.isFinite(target.x)) {
      const dx = target.x - a.pos.x;
      const dy = target.y - (a.pos.y + 0.5);
      const dz = target.z - a.pos.z;
      const l = Math.hypot(dx, dy, dz) || 1;
      inp.aimDir.x = dx / l;
      inp.aimDir.y = dy / l;
      inp.aimDir.z = dz / l;
    }
    if (state === 'telegraph') {
      inp.telegraph = tParam === 'anim' ? (time * (a.kind === 'guard' ? 1 / 1.2 : 1 / 1.6)) % 1 : num('t', 0.8);
      if (tParam === 'anim') {
        // the telegraph is only the last 0.15 s / 0.35 s of each period
        const period = a.kind === 'guard' ? ENEMIES.guard.burstPeriod : ENEMIES.turret.burstPeriod;
        const tele = a.kind === 'guard' ? ENEMIES.guard.telegraph : ENEMIES.turret.telegraph;
        const ph = time % period;
        inp.telegraph = ph > period - tele ? (ph - (period - tele)) / tele : 0;
      }
    }
    if (a.kind === 'guard' && speed > 0 && inp.alive) {
      inp.speed = speed;
      const f = moveName === 'right' ? a.yaw - Math.PI / 2 : moveName === 'back' ? a.yaw + Math.PI : a.yaw;
      a.pos.x += -Math.sin(f) * speed * dt;
      a.pos.z += -Math.cos(f) * speed * dt;
    }
    a.view.update(inp);
  }
}

// ───────────────────────────── effects ─────────────────────────────
const effects = new Effects();
scene.add(effects.group);
const player = { pos: { x: 0, y: PLAYER.half.y, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
const fakeStage = {
  barriers: [{ id: 'B1', box: { min: { x: -7, y: 0, z: -24 }, max: { x: 7, y: 8, z: -23 } } }],
  finalGate: { id: 'GATE', box: { min: { x: -9, y: 0, z: -40 }, max: { x: 9, y: 9, z: -39 } } },
};
const sim = { player, stage: fakeStage } as unknown as Sim;
const projectiles: Projectile[] = [];
let nextId = 1;
const MUZZLE = { x: PLAYER.muzzleLocal.right, y: PLAYER.half.y + PLAYER.muzzleLocal.up, z: -PLAYER.muzzleLocal.forward };

function makeProjectile(kind: Projectile['kind'], pos: THREE.Vector3Like, vel: THREE.Vector3Like, origin: THREE.Vector3Like, owner?: 'guard' | 'turret'): Projectile {
  const p: Projectile = {
    id: nextId++,
    kind,
    alive: true,
    spawnTime: 0,
    lifeSeconds: 3,
    damage: 1,
    origin: { x: origin.x, y: origin.y, z: origin.z },
    v0: { x: vel.x, y: vel.y, z: vel.z },
    pos: { x: pos.x, y: pos.y, z: pos.z },
    prevPos: { x: pos.x, y: pos.y, z: pos.z },
    vel: { x: vel.x, y: vel.y, z: vel.z },
    ownerKind: owner,
  };
  projectiles.push(p);
  return p;
}

/** Timeline of the staged effect: [time, action]. `tick` runs every simulated step. */
const timeline: Array<[number, () => void]> = [];
let tick: (dt: number, t: number) => void = () => {};
const emit = (e: SimEvent): void => effects.handleEvent(e, sim);
const label = (text: string, p: THREE.Vector3): void => {
  pendingLabels.push([text, p.clone()]);
};
const pendingLabels: Array<[string, THREE.Vector3]> = [];

let maxActive = 0;

function stageTps(): void {
  document.getElementById('cross')!.style.display = 'block';
  const pitch = -0.12;
  const fwd = new THREE.Vector3(0, Math.sin(pitch), -Math.cos(pitch));
  camera.position.set(0, player.pos.y + CAMERA.pivotUp, 0).addScaledVector(fwd, -CAMERA.boomLength);
  camera.lookAt(camera.position.clone().add(fwd));
  // player stand-in: the 2.6 × 4.0 × 2.6 hit box with a gun stub at the muzzle
  if (!bare) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.6, 1.8), new THREE.MeshStandardMaterial({ color: 0x8f99a6, roughness: 0.7 }));
    body.position.set(0, 1.8, 0);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 1.3), new THREE.MeshStandardMaterial({ color: 0x56616e, roughness: 0.7 }));
    head.position.set(0, 3.55, 0);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 1.6), new THREE.MeshStandardMaterial({ color: 0x30343a }));
    gun.position.set(MUZZLE.x, MUZZLE.y, MUZZLE.z + 0.8);
    scene.add(body, head, gun);
  }
  target.set(0, 2.5, 0);
  addActor('guard', -9, -38, 0);
  addActor('turret', 8, -46, 0);
  addActor('control', 0, -62, 0);
}

function enemyMuzzleOf(a: Actor): THREE.Vector3 {
  return new THREE.Vector3(a.pos.x, a.pos.y + 0.5, a.pos.z);
}

function stageFx(name: string): number {
  const guard = actors[0];
  const turret = actors[1];
  const control = actors[2];
  const mz = new THREE.Vector3(MUZZLE.x, MUZZLE.y, MUZZLE.z);
  switch (name) {
    case 'beam': {
      const hit = (q.get('hit') ?? 'enemy') as 'enemy' | 'world' | 'none';
      const end = hit === 'enemy' ? guard.pos.clone().add(new THREE.Vector3(0.3, 0.2, 1.1)) : hit === 'world' ? new THREE.Vector3(14, 0, -44) : mz.clone().add(new THREE.Vector3(0.1, 0.05, -1).normalize().multiplyScalar(WEAPONS.beam.range));
      timeline.push([0, () => emit({ type: 'beam', from: mz, to: end, hit, enemyId: hit === 'enemy' ? 'G01' : null })]);
      return 0.03;
    }
    case 'explosion': {
      const kind = (q.get('kind') ?? 'guard') as Kind;
      const a = kind === 'guard' ? guard : kind === 'turret' ? turret : control;
      timeline.push([
        0,
        () => {
          a.input.alive = false;
          emit({ type: 'enemy-destroyed', enemyId: 'X', kind: kind === 'guard' ? 'guard' : 'turret', pos: a.pos, isGateControl: kind === 'control' });
        },
      ]);
      return 0.12;
    }
    case 'tracers': {
      // a stream fired every 0.1 s on a lofted arc so the parabola is visible
      const dir = new THREE.Vector3(-0.12, 0.12, -1).normalize();
      const v0 = dir.clone().multiplyScalar(WEAPONS.machinegun.speed);
      for (let k = 0; k < 14; k++) {
        const age = 0.035 + k * WEAPONS.machinegun.interval;
        const pos = mz.clone().addScaledVector(v0, age);
        pos.y -= 0.5 * GRAVITY * age * age;
        if (pos.y < 0.2) break;
        makeProjectile('mg', pos, new THREE.Vector3(v0.x, v0.y - GRAVITY * age, v0.z), mz);
      }
      // and a flat burst towards the guard
      const d2 = guard.pos.clone().sub(mz).normalize().multiplyScalar(WEAPONS.machinegun.speed);
      for (let k = 0; k < 3; k++) {
        const age = 0.06 + k * 0.1;
        makeProjectile('mg', mz.clone().addScaledVector(d2, age), d2, mz);
      }
      timeline.push([0, () => emit({ type: 'player-shot', weapon: 'machinegun', muzzle: mz, dir, projectileId: 1, locked: false })]);
      return 0.02;
    }
    case 'missile': {
      // two homing missiles (120°/s turn limit) launched 0.45 s apart on curved paths
      const launch = (dirv: THREE.Vector3, tgt: Actor): Projectile => {
        const v = dirv.clone().normalize().multiplyScalar(WEAPONS.missile.speed);
        const p = makeProjectile('missile', mz, v, mz);
        p.targetId = tgt.kind;
        emit({ type: 'player-shot', weapon: 'missile', muzzle: mz, dir: dirv.clone().normalize(), projectileId: p.id, locked: true });
        return p;
      };
      timeline.push([0, () => launch(new THREE.Vector3(0.75, 0.45, -1), turret)]);
      timeline.push([0.45, () => launch(new THREE.Vector3(-0.2, 0.5, -1), guard)]);
      const maxTurn = (WEAPONS.missile.turnRateDeg * Math.PI) / 180;
      const v = new THREE.Vector3();
      const want = new THREE.Vector3();
      tick = (dt) => {
        for (const p of projectiles) {
          if (p.kind !== 'missile' || !p.alive) continue;
          const tgt = p.targetId === 'guard' ? guard : turret;
          v.set(p.vel.x, p.vel.y, p.vel.z).normalize();
          want.set(tgt.pos.x - p.pos.x, tgt.pos.y - p.pos.y, tgt.pos.z - p.pos.z);
          const dist = want.length();
          want.normalize();
          const ang = v.angleTo(want);
          if (ang > 1e-5) v.lerp(want, Math.min(1, (maxTurn * dt) / ang)).normalize();
          v.multiplyScalar(WEAPONS.missile.speed);
          p.vel.x = v.x;
          p.vel.y = v.y;
          p.vel.z = v.z;
          p.pos.x += v.x * dt;
          p.pos.y += v.y * dt;
          p.pos.z += v.z * dt;
          if (dist < 1.6) {
            p.alive = false;
            emit({ type: 'projectile-hit', kind: 'missile', pos: p.pos, target: 'enemy', enemyId: 'X' });
          }
        }
        for (let i = projectiles.length - 1; i >= 0; i--) if (!projectiles[i].alive) projectiles.splice(i, 1);
      };
      return 0.85;
    }
    case 'bolts': {
      const fire = (a: Actor, kind: 'guard' | 'turret', dists: number[], lateral: number): void => {
        const m = enemyMuzzleOf(a);
        const aim = new THREE.Vector3(player.pos.x + lateral, player.pos.y + 0.6, player.pos.z).sub(m).normalize();
        const sp = ENEMIES[kind].bulletSpeed;
        for (const dd of dists) makeProjectile('enemy', m.clone().addScaledVector(aim, dd), aim.clone().multiplyScalar(sp), m, kind);
        timeline.push([0, () => emit({ type: 'enemy-shot', enemyId: 'X', kind, muzzle: m, dir: aim })]);
      };
      fire(guard, 'guard', [4, 12.4, 20.8], -3.5);
      fire(turret, 'turret', [5, 20, 35], 4);
      fire(control, 'turret', [6, 21], 0.5);
      return 0.02;
    }
    case 'qb': {
      const dn = q.get('dir') ?? 'right';
      const dir = dn === 'left' ? { x: -1, z: 0 } : dn === 'forward' ? { x: 0, z: -1 } : dn === 'back' ? { x: 0, z: 1 } : { x: 1, z: 0 };
      timeline.push([0, () => emit({ type: 'qb', dir, airborne: false })]);
      // the stand-in does not move; in the game the mech leaves the burst behind at 80 m/s
      return 0.06;
    }
    case 'hits': {
      const row = (x: number, text: string, e: SimEvent): void => {
        timeline.push([0, () => emit(e)]);
        label(text, new THREE.Vector3(x, 0.2, -16));
      };
      const at = (x: number): THREE.Vector3 => new THREE.Vector3(x, 2.2, -16);
      row(-10, 'MG → enemy', { type: 'projectile-hit', kind: 'mg', pos: at(-10), target: 'enemy', enemyId: 'G01' });
      row(-6, 'MG → world', { type: 'projectile-hit', kind: 'mg', pos: at(-6), target: 'world', enemyId: null });
      row(-2, 'enemy bolt → world', { type: 'projectile-hit', kind: 'enemy', pos: at(-2), target: 'world', enemyId: null });
      row(2.5, 'beam → enemy', { type: 'beam', from: mz, to: at(2.5), hit: 'enemy', enemyId: 'G01' });
      row(7, 'missile hit', { type: 'projectile-hit', kind: 'missile', pos: at(7), target: 'enemy', enemyId: 'G01' });
      row(11.5, 'expired', { type: 'projectile-expired', kind: 'mg', pos: at(11.5) });
      timeline.push([0, () => emit({ type: 'projectile-hit', kind: 'enemy', pos: new THREE.Vector3(-0.6, 3.0, -1.3), target: 'player', enemyId: null })]);
      label('bolt → player', new THREE.Vector3(-3.2, 4.4, -1.3));
      return 0.05;
    }
    case 'muzzle': {
      const dir = new THREE.Vector3(0, 0.02, -1).normalize();
      timeline.push([0, () => emit({ type: 'player-shot', weapon: 'machinegun', muzzle: mz, dir, projectileId: 1, locked: false })]);
      timeline.push([0, () => emit({ type: 'player-shot', weapon: 'missile', muzzle: new THREE.Vector3(-MUZZLE.x, MUZZLE.y, MUZZLE.z), dir, projectileId: 2, locked: true })]);
      return 0.02;
    }
    case 'dust': {
      timeline.push([0, () => emit({ type: 'land', speed: 14 })]);
      return 0.15;
    }
    case 'door': {
      timeline.push([0, () => emit({ type: 'barrier-opened', barrierId: 'B1', controlEnemyId: 'T01' })]);
      return 0.2;
    }
    case 'stress': {
      // 30 s of heavy combat, then 5 s of silence: activeCount must stay bounded and return to 0
      let acc = 0;
      const rp = (): THREE.Vector3 => new THREE.Vector3((Math.random() - 0.5) * 80, 1 + Math.random() * 6, -10 - Math.random() * 80);
      tick = (dt, t) => {
        if (t > 30) {
          projectiles.length = 0;
          return;
        }
        acc += dt;
        while (acc > 1 / 120) {
          acc -= 1 / 120;
          const r = Math.random();
          if (r < 0.25) emit({ type: 'projectile-hit', kind: 'mg', pos: rp(), target: Math.random() < 0.5 ? 'enemy' : 'world', enemyId: null });
          else if (r < 0.4) emit({ type: 'enemy-shot', enemyId: 'X', kind: Math.random() < 0.5 ? 'guard' : 'turret', muzzle: rp(), dir: { x: 0, y: 0, z: 1 } });
          else if (r < 0.5) emit({ type: 'beam', from: mz, to: rp(), hit: 'enemy', enemyId: 'X' });
          else if (r < 0.56) emit({ type: 'enemy-destroyed', enemyId: 'X', kind: 'turret', pos: rp(), isGateControl: Math.random() < 0.3 });
          else if (r < 0.62) emit({ type: 'qb', dir: { x: 1, z: 0 }, airborne: false });
          else if (r < 0.7) emit({ type: 'projectile-hit', kind: 'missile', pos: rp(), target: 'enemy', enemyId: null });
          else if (r < 0.8) emit({ type: 'player-shot', weapon: 'machinegun', muzzle: mz, dir: { x: 0, y: 0, z: -1 }, projectileId: 1, locked: false });
          else if (r < 0.85) emit({ type: 'land', speed: 12 });
          if (projectiles.length < 300 && Math.random() < 0.6) {
            const kinds: Array<Projectile['kind']> = ['mg', 'enemy', 'missile'];
            const k = kinds[Math.floor(Math.random() * 2.2)];
            const p = rp();
            makeProjectile(k, p, new THREE.Vector3(Math.random() * 60 - 30, 0, 60), p, Math.random() < 0.5 ? 'guard' : 'turret');
          }
        }
        for (const p of projectiles) {
          p.pos.x += p.vel.x * dt;
          p.pos.z += p.vel.z * dt;
          if (p.pos.z > 20) p.alive = false;
        }
        for (let i = projectiles.length - 1; i >= 0; i--) if (!projectiles[i].alive) projectiles.splice(i, 1);
      };
      return 36;
    }
    default:
      return 0.05;
  }
}

/** One event shown at several ages side by side (column i was triggered `ages[i]` seconds before the freeze). */
function stageSeries(): number {
  const ev = q.get('ev') ?? 'mg-enemy';
  const ages = (q.get('ages') ?? '0.02,0.08,0.2,0.5,1').split(',').map(Number).filter((n) => Number.isFinite(n));
  const big = ev.startsWith('explosion') || ev === 'qb' || ev === 'missile';
  const gap = num('gap', big ? 13 : ev.startsWith('beam') || ev === 'land' || ev === 'jump' ? 6.5 : 4.5);
  const depth = num('depth', big ? 34 : ev === 'land' || ev === 'jump' ? 20 : 13);
  const total = Math.max(...ages);
  camera.fov = num('fov', 38);
  camera.position.set(0, num('height', 3.2), 0);
  camera.lookAt(0, big ? 3.2 : 2.4, -depth);
  ages.forEach((age, i) => {
    const x = (i - (ages.length - 1) / 2) * gap;
    const at = new THREE.Vector3(x, 2.2, -depth);
    label(`${ev}  +${age.toFixed(2)} s`, new THREE.Vector3(x, 0, -depth));
    const from = new THREE.Vector3(x + 1.5, 2.8, -depth + 9);
    const fire = (): void => {
      switch (ev) {
        case 'mg-enemy':
          emit({ type: 'projectile-hit', kind: 'mg', pos: at, target: 'enemy', enemyId: 'G01' });
          break;
        case 'mg-world':
          emit({ type: 'projectile-hit', kind: 'mg', pos: at, target: 'world', enemyId: null });
          break;
        case 'bolt-world':
          emit({ type: 'projectile-hit', kind: 'enemy', pos: at, target: 'world', enemyId: null });
          break;
        case 'bolt-player':
          emit({ type: 'projectile-hit', kind: 'enemy', pos: at, target: 'player', enemyId: null });
          break;
        case 'missile':
          emit({ type: 'projectile-hit', kind: 'missile', pos: at, target: 'enemy', enemyId: 'G01' });
          break;
        case 'expired-mg':
          emit({ type: 'projectile-expired', kind: 'mg', pos: at });
          break;
        case 'expired-missile':
          emit({ type: 'projectile-expired', kind: 'missile', pos: at });
          break;
        case 'beam-enemy':
          emit({ type: 'beam', from, to: at, hit: 'enemy', enemyId: 'G01' });
          break;
        case 'beam-world':
          emit({ type: 'beam', from, to: at, hit: 'world', enemyId: null });
          break;
        case 'explosion-guard':
          emit({ type: 'enemy-destroyed', enemyId: 'X', kind: 'guard', pos: new THREE.Vector3(x, 1.3, -depth), isGateControl: false });
          break;
        case 'explosion-turret':
          emit({ type: 'enemy-destroyed', enemyId: 'X', kind: 'turret', pos: new THREE.Vector3(x, 1.6, -depth), isGateControl: false });
          break;
        case 'explosion-control':
          emit({ type: 'enemy-destroyed', enemyId: 'X', kind: 'turret', pos: new THREE.Vector3(x, 1.6, -depth), isGateControl: true });
          break;
        case 'qb': {
          player.pos.x = x;
          player.pos.z = -depth;
          const dn = q.get('dir') ?? 'right';
          emit({ type: 'qb', dir: dn === 'forward' ? { x: 0, z: -1 } : dn === 'back' ? { x: 0, z: 1 } : dn === 'left' ? { x: -1, z: 0 } : { x: 1, z: 0 }, airborne: false });
          break;
        }
        case 'land':
        case 'jump':
          player.pos.x = x;
          player.pos.z = -depth;
          emit(ev === 'land' ? { type: 'land', speed: num('speed', 14) } : { type: 'jump' });
          break;
        case 'shot-guard':
        case 'shot-turret':
          emit({ type: 'enemy-shot', enemyId: 'X', kind: ev === 'shot-guard' ? 'guard' : 'turret', muzzle: at, dir: new THREE.Vector3(0.5, 0, 0.87).normalize() });
          break;
        case 'muzzle-mg':
          emit({ type: 'player-shot', weapon: 'machinegun', muzzle: at, dir: new THREE.Vector3(-0.7, 0.05, -0.7).normalize(), projectileId: 1, locked: false });
          break;
        case 'muzzle-missile':
          emit({ type: 'player-shot', weapon: 'missile', muzzle: at, dir: new THREE.Vector3(-0.7, 0.05, -0.7).normalize(), projectileId: 1, locked: true });
          break;
        default:
          break;
      }
    };
    timeline.push([total - age, fire]);
    // a 2.6 × 4 × 2.6 ghost box for scale where the player would stand
    if (!bare && (ev === 'qb' || ev === 'land' || ev === 'jump' || ev === 'bolt-player')) {
      const ghost = new THREE.Mesh(new THREE.BoxGeometry(2.6, 4, 2.6), new THREE.MeshStandardMaterial({ color: 0x8f99a6, roughness: 0.7 }));
      ghost.position.set(ev === 'bolt-player' ? x : x, 2, ev === 'bolt-player' ? -depth - 1.35 : -depth);
      scene.add(ghost);
    }
  });
  player.vel.x = player.vel.y = player.vel.z = 0;
  return total;
}

// ───────────────────────────── staging ─────────────────────────────
let freezeAt = 1.6; // seconds of pre-simulation before the picture is frozen
if (view === 'series') {
  freezeAt = stageSeries();
} else if (fxName === 'lifecycle') {
  // no persistent enemies here: the shared caches must be created and freed by the test itself
  camera.position.set(0, 9, 14);
  camera.lookAt(0, 1.5, -34);
  freezeAt = 0.05;
} else if (view === 'tps') {
  stageTps();
  freezeAt = num('at', stageFx(fxName!));
} else if (view === 'far') {
  // the game's 60° camera at the player's eye height, enemies at 60 m and 100 m facing the player
  camera.position.set(0, PLAYER.half.y + CAMERA.pivotUp, 9.5);
  camera.lookAt(0, 2.2, -80);
  target.set(0, 2.5, 0);
  addActor('guard', -17, -50.5, Math.PI + 0.3);
  addActor('turret', -9, -50.5, Math.PI + 0.3);
  addActor('control', -1, -50.5, Math.PI + 0.3);
  addActor('guard', 13, -90.5, Math.PI - 0.3);
  addActor('turret', 22, -90.5, Math.PI - 0.3);
  addActor('control', 31, -90.5, Math.PI - 0.3);
  label('60 m', new THREE.Vector3(-9, 0, -50.5));
  label('100 m', new THREE.Vector3(22, 0, -90.5));
} else if (view === 'sheet') {
  // turnaround of one kind: front, 3/4, side, back
  const kind = (q.get('kind') ?? 'guard') as Kind;
  const gap = kind === 'guard' ? 3.6 : 4.6;
  [Math.PI, Math.PI - 0.7, Math.PI / 2, 0].forEach((yaw, i) => addActor(kind, (i - 1.5) * gap, 0, yaw));
  camera.fov = num('fov', 30);
  const dist = num('dist', kind === 'guard' ? 12.5 : kind === 'turret' ? 15.5 : 17);
  const look = new THREE.Vector3(0, kind === 'control' ? 2.3 : kind === 'turret' ? 1.5 : 1.25, 0);
  camera.position.set(0, num('height', 3.2), dist);
  camera.lookAt(look);
  // every copy aims straight ahead of itself
  for (const a of actors) a.input.aimDir = { x: -Math.sin(a.yaw), y: num('pitch', 0), z: -Math.cos(a.yaw) };
  target.set(NaN, NaN, NaN);
} else {
  const only = q.get('kind') as Kind | null;
  const yaw = Math.PI - 0.5 + (num('yawOff', 0) * Math.PI) / 180; // 3/4 view towards the camera
  if (only) addActor(only, 0, 0, yaw);
  else {
    addActor('guard', -5.4, 0, yaw);
    addActor('turret', 0, 0, yaw);
    addActor('control', 6.2, 0, yaw);
  }
  camera.fov = num('fov', 40);
  const ang = (num('angle', 0) * Math.PI) / 180;
  const dist = num('dist', only ? 8.5 : 17.5);
  const look = new THREE.Vector3(only ? 0 : 0.4, only === 'control' ? 2.0 : 1.5, 0);
  camera.position.set(look.x + Math.sin(ang) * dist, num('height', 3.3), look.z + Math.cos(ang) * dist);
  camera.lookAt(look);
  target.copy(camera.position).setY(2);
}
// optional camera override for close-ups: &cam=x,y,z&look=x,y,z (&fov=)
{
  const cam = q.get('cam')?.split(',').map(Number);
  const look = q.get('look')?.split(',').map(Number);
  if (cam && cam.length === 3) camera.position.set(cam[0], cam[1], cam[2]);
  if (look && look.length === 3) camera.lookAt(look[0], look[1], look[2]);
  if (view === 'tps' && q.get('fov')) camera.fov = num('fov', CAMERA.fovYDeg);
}
camera.updateProjectionMatrix();

// ───────────────────────────── stepping ─────────────────────────────
let simTime = 0;
let nextEvent = 0;
timeline.sort((a, b) => a[0] - b[0]);

function step(dt: number): void {
  while (nextEvent < timeline.length && timeline[nextEvent][0] <= simTime + 1e-9) timeline[nextEvent++][1]();
  tick(dt, simTime);
  simTime += dt;
  updateActors(dt, simTime);
  effects.syncProjectiles(projectiles, 0);
  effects.update(dt, camera.position);
  if (effects.activeCount > maxActive) maxActive = effects.activeCount;
}

function presimulate(): void {
  // enemy poses settle for a while first (blends, IK), then the staged effect runs up to `freezeAt`
  if (view === 'series') {
    const n = Math.max(1, Math.round(freezeAt * 120));
    for (let i = 0; i < n; i++) step(1 / 120);
    return;
  }
  if (view !== 'tps') {
    const start = actors.map((a) => a.pos.clone());
    for (let i = 0; i < Math.round(freezeAt * 60); i++) step(1 / 60);
    // put walkers back where the camera expects them (the pose is what matters)
    const drift = actors.map((a, i) => a.pos.clone().sub(start[i]));
    if (!live) actors.forEach((a, i) => a.pos.sub(drift[i]));
    return;
  }
  for (let i = 0; i < 90; i++) updateActors(1 / 60, (simTime += 1 / 60));
  simTime = 0;
  const n = Math.max(1, Math.round(freezeAt * 120));
  for (let i = 0; i < n; i++) step(1 / 120);
}
presimulate();

function placeLabels(): void {
  labels.innerHTML = '';
  const v = new THREE.Vector3();
  for (const [text, p] of pendingLabels) {
    v.copy(p).project(camera);
    if (v.z > 1) continue;
    const el = document.createElement('div');
    el.textContent = text;
    const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (0.5 - v.y * 0.5) * window.innerHeight;
    // labels follow the magnified canvas
    el.style.left = `${(sx - window.innerWidth / 2) * mag + window.innerWidth / 2}px`;
    el.style.top = `${(sy - window.innerHeight / 2) * mag + window.innerHeight / 2 + 4}px`;
    labels.appendChild(el);
  }
}

/**
 * fx=lifecycle: three "sorties" of 45 enemies + an Effects instance are created, animated, rendered and
 * disposed. GPU resource counts must return to the baseline (shared caches are reference counted), and the
 * per-frame cost of 45 live enemies is measured.
 */
let lifecycle = '';
function runLifecycle(): void {
  const mem = (): string => `geo ${renderer.info.memory.geometries} tex ${renderer.info.memory.textures}`;
  renderer.render(scene, camera);
  const before = mem();
  const lines: string[] = [];
  const allEvents: SimEvent[] = [
    { type: 'fire-rejected', weapon: 'missile', reason: 'no-lock' },
    { type: 'weapon-switched', weapon: 'beam' },
    { type: 'qb-rejected', reason: 'cooldown' },
    { type: 'glide', enabled: true, auto: true },
    { type: 'jump' },
    { type: 'land', speed: 9 },
    { type: 'enemy-telegraph', enemyId: 'G01', duration: 0.15 },
    { type: 'enemy-damaged', enemyId: 'G01', amount: 12, pos: { x: 0, y: 2, z: -20 } },
    { type: 'enemy-alerted', enemyId: 'G01' },
    { type: 'player-damaged', amount: 18, sourcePos: { x: 0, y: 2, z: -20 }, fromEnemyId: 'G01' },
    { type: 'barrier-opened', barrierId: 'B1', controlEnemyId: 'T01' },
    { type: 'barrier-opened', barrierId: 'nope', controlEnemyId: 'T01' },
    { type: 'gate-opened' },
    { type: 'sector-entered', sectorId: 'S01' },
    { type: 'cleared' },
    { type: 'failed', reason: 'fell' },
    { type: 'projectile-expired', kind: 'enemy', pos: { x: 1, y: 2, z: -20 } },
    { type: 'beam', from: { x: 0, y: 2, z: 0 }, to: { x: 0, y: 2, z: 0 }, hit: 'none', enemyId: null },
    { type: 'qb', dir: { x: 0, z: 0 }, airborne: true },
    { type: 'enemy-shot', enemyId: 'T01', kind: 'turret', muzzle: { x: 0, y: 2, z: -30 }, dir: { x: 0, y: 1, z: 0 } },
  ];
  for (let cycle = 0; cycle < 3; cycle++) {
    const fxs = new Effects();
    scene.add(fxs.group);
    const views: EnemyView[] = [];
    const inputs: EnemyViewInput[] = [];
    for (let i = 0; i < 45; i++) {
      const kind: Kind = i < 30 ? 'guard' : i < 39 ? 'turret' : 'control';
      const v = new EnemyView(kind === 'guard' ? 'guard' : 'turret', kind === 'control');
      v.group.position.set(((i % 9) - 4) * 6, kind === 'guard' ? 1.3 : 1.6, -22 - Math.floor(i / 9) * 7);
      scene.add(v.group);
      views.push(v);
      inputs.push({ dt: 1 / 60, time: 0, alive: true, yaw: Math.PI, aimDir: { x: 0, y: 0.05, z: 1 }, telegraph: 0, alert: i % 2 === 0, hpFraction: 1 - (i % 5) * 0.2, speed: i % 3 === 0 ? 6 : 0 });
    }
    for (const e of allEvents) fxs.handleEvent(e, sim);
    // a sim-less object must not break event handling either
    fxs.handleEvent({ type: 'qb', dir: { x: 1, z: 0 }, airborne: false }, {} as unknown as Sim);
    fxs.handleEvent({ type: 'barrier-opened', barrierId: 'B1', controlEnemyId: 'T01' }, {} as unknown as Sim);
    let t = 0;
    let ms = 0;
    let fxMs = 0;
    const FRAMES = 240;
    for (let f = 0; f < FRAMES; f++) {
      t += 1 / 60;
      const t0 = performance.now();
      for (let i = 0; i < views.length; i++) {
        const inp = inputs[i];
        inp.time = t;
        inp.telegraph = f % 40 > 30 && inp.alert ? (f % 40 - 30) / 10 : 0;
        if (f === 150 && i % 4 === 0) inp.alive = false; // some die …
        if (f === 200 && i % 8 === 0) inp.alive = true; // … and a re-sortie revives a few
        if (inp.speed > 0) views[i].group.position.x += Math.sin(t) * 0.05;
        views[i].update(inp);
      }
      const t1 = performance.now();
      if (f % 2 === 0) fxs.handleEvent({ type: 'enemy-destroyed', enemyId: 'X', kind: 'turret', pos: { x: Math.random() * 40 - 20, y: 1.6, z: -30 }, isGateControl: f % 4 === 0 }, sim);
      fxs.syncProjectiles(projectiles, 0);
      fxs.update(1 / 60, camera.position);
      fxMs += performance.now() - t1;
      ms += t1 - t0;
      if (f === 120 || f === 239) renderer.render(scene, camera);
      if (f === 120) lines.push(`cycle ${cycle}: 45 alive → draw calls ${renderer.info.render.calls}, tris ${renderer.info.render.triangles}, ${mem()}, fx active ${fxs.activeCount}`);
    }
    fxs.clear();
    const afterClear = fxs.activeCount;
    lines.push(`cycle ${cycle}: 45 × EnemyView.update ${(ms / FRAMES).toFixed(3)} ms/frame, Effects (full pools) ${(fxMs / FRAMES).toFixed(3)} ms/frame, after clear() active ${afterClear}`);
    for (const v of views) v.dispose();
    fxs.dispose();
    renderer.render(scene, camera);
    lines.push(`cycle ${cycle}: disposed → ${mem()} (baseline ${before})`);
  }
  lifecycle = lines.join('\n');
  (window as unknown as { __life: string }).__life = lifecycle;
}
if (fxName === 'lifecycle') runLifecycle();

const models = getEnemyModelStats();
let last = performance.now();
let replayAt = 2.5;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (live) {
    if (view === 'series' && simTime > freezeAt + 1.5) {
      nextEvent = 0;
      simTime = 0;
    }
    if (view === 'tps' && fxName !== 'stress' && simTime > replayAt) {
      // replay the staged effect
      nextEvent = 0;
      simTime = 0;
      if (fxName !== 'tracers' && fxName !== 'bolts') projectiles.length = 0;
      for (const a of actors) a.input.alive = true;
    }
    step(dt);
  }
  renderer.render(scene, camera);
  const r = renderer.info.render;
  const stats = { calls: r.calls, triangles: r.triangles, activeCount: effects.activeCount, maxActive, simTime, models };
  (window as unknown as { __stats: unknown }).__stats = stats;
  info.textContent =
    `${view}${fxName ? ' fx=' + fxName : ' state=' + state}  t=${simTime.toFixed(2)}s  draw calls ${r.calls}  tris ${r.triangles}\n` +
    `effects active ${effects.activeCount} (max ${maxActive})   model tris  guard ${models.guard.live}/${models.guard.wreck}  turret ${models.turret.live}/${models.turret.wreck}  control ${models.control.live}/${models.control.wreck}` +
    (lifecycle ? '\n' + lifecycle : '');
  requestAnimationFrame(frame);
}
placeLabels();
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  placeLabels();
});
