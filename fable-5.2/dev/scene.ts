/**
 * Dev harness for src/render/stageView.ts, src/render/textures.ts and src/render/renderer.ts.
 *
 *   /dev/scene.html?stage=sample|factory|test       game view through GameRenderer.renderGame (test = flat range, no lamps)
 *        &px=&py=&pz=            player hit-box centre (default: the stage's playerStart)
 *        &yaw=&pitch=            camera / body angles in DEGREES (yaw 0 looks along -Z, positive turns left)
 *        &cam=x,y,z,yaw,pitch    free debug camera instead of the chase rig (overview shots)
 *        &legs=biped|quadruped   &weapon=machinegun|beam|missile
 *        &state=idle|walk|glide|qb|fly|fall      fakes the player's motion state
 *        &alert=1  &tele=0..1  &dead=ID,ID  &hp=0..1     fakes enemy states
 *        &open=B1,GATE           opens these doors (&openAt=seconds before the end: door caught mid-animation)
 *        &fx=1                   fakes projectiles and a few events (beam, shots, explosion)
 *        &frames=N               frames simulated before the picture is frozen (default 40, 1/30 s each)
 *        &live=1                 keeps rendering in real time
 *        &resets=5               re-sortie leak test → window.__leak
 *        &check=1 [&dpr=2]       projectToCss vs. the THREE camera, drawing-buffer size → window.__check
 *        &dispose=1              disposes the renderer at the end and reports the remaining GPU resources
 *        &cross=1 &hud=0 &dpr=N  lock-circle stand-in, hide the info text, device pixel ratio passed to resize()
 *        &gov=1                  keeps the render-resolution governor on (off by default here: the harness feeds
 *                                synthetic frame times, and pictures must not depend on how fast they were drawn)
 *   /dev/scene.html?view=garage&legs=biped|quadruped[&t=seconds][&panels=1]   hangar scene (renderGarage)
 *   /dev/scene.html?view=tex[&layer=name][&ch=rgb|rough|height]              texture layer preview
 *
 * window.__info = { drawCalls, triangles, effects, geometries, textures, programs, stage: StageViewStats, ms }.
 * window.__shot(spec) re-poses the scene and redraws it without a reload (screenshot tours):
 *   spec = { p:[x,y,z], yaw, pitch (deg), cam:[x,y,z,yaw,pitch] | null, open:['B1','GATE'], dead:['T01'] | ['all'],
 *            alert:false, fly:true, frames, dt, w, h }
 *   → { calls, tris, seen:[{ id, d, x, y, ctrl }] } (living enemies on screen with a free line from the camera).
 * window.__gov(segments) feeds the governor: segments = [[frameSeconds, frames], …] of renderGame calls at the
 *   current pose ([-1, 0] = resetForSortie) → after each segment { scale, pixelRatio, buffer:[w, h] } (the governor
 *   is switched on by the call).
 */
import { ENEMIES, PLAYER } from '../src/config';
import { forwardFromYawPitch, v3, type V3 } from '../src/core/vec';
import { GameRenderer } from '../src/render/renderer';
import { LAYER, getStageTextureData } from '../src/render/textures';
import { Sim } from '../src/sim/sim';
import type { LegsId, Projectile, SimEvent, StageDef, Weapon } from '../src/sim/types';
import { StageBuilder, box } from '../src/stage/builder';
import { getFactoryStage } from '../src/stage/factory';
import { makeGuard, makeTarget, makeTestStage, makeTurret } from '../src/stage/testStages';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = q.get(k);
  const n = v === null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const view = q.get('view') ?? 'game';
const DEG = Math.PI / 180;
const info = document.getElementById('info')!;
const W = window as unknown as Record<string, unknown>;

// ───────────────────────────── sample stage ─────────────────────────────
/**
 * A compact but rich test level: a 100 × 70 m hall (machines, containers, tanks, a catwalk at +6 m, a mezzanine at
 * +12 m, trusses, pipe trays, lit and unlit zones, a pit), a low corridor behind barrier B1 and an exit hall with the gate.
 */
function buildSampleStage(): StageDef {
  const b = new StageBuilder();
  // ── hall ──
  b.sectorId = 'H';
  const hall = b.room({ x0: 0, x1: 104, z0: 0, z1: 74, floor: 0, ceil: 24 });
  b.sector('H', '試験ホール', 'Test hall', 'factory', [b.roomBounds(hall)], true);
  // north catwalk (+6 m) with stairs-less access, hazard edge towards the hall
  b.platform(2, 2, 70, 10, 6, 1, 'catwalk', 'n');
  for (const x of [10, 30, 50, 68]) b.pillar(x, 9, 1.2, 0, 5, 'metal');
  // mezzanine (+12 m) in the north-east corner
  b.platform(70, 2, 102, 26, 12, 1.2, 'floor', 'nw');
  for (const [x, z] of [[72, 24], [86, 24], [100, 24], [72, 12]] as const) b.pillar(x, z, 2, 0, 10.8, 'concrete');
  b.block(88, 4, 98, 10, 12, 4, 'machine', 'mezz-machine');
  // free-standing platform (+4 m) and a bridge to the catwalk
  b.platform(36, 30, 52, 42, 4, 1, 'catwalk', 'nsew');
  for (const [x, z] of [[37.5, 31.5], [50.5, 31.5], [37.5, 40.5], [50.5, 40.5]] as const) b.pillar(x, z, 1.2, 0, 3, 'metal');
  // production machines
  b.block(12, 22, 22, 30, 0, 6, 'machine', 'press');
  b.block(14, 30, 20, 34, 0, 3, 'machine', 'press-table');
  b.block(12, 44, 26, 50, 0, 5, 'machine', 'line');
  b.block(12, 50, 18, 56, 0, 8, 'machine', 'line-tower');
  b.block(60, 44, 72, 52, 0, 7, 'machine', 'furnace');
  b.block(62, 52, 70, 56, 0, 3.5, 'metal', 'furnace-hopper');
  b.tank(84, 48, 5, 0, 12, 'pipe');
  b.tank(84, 62, 4, 0, 9, 'rust');
  // containers
  b.block(28, 58, 40, 61, 0, 2.9, 'container');
  b.block(28, 61, 40, 64, 0, 2.9, 'container');
  b.block(29, 59.5, 41, 62.5, 2.9, 2.9, 'container');
  b.block(44, 60, 47, 72, 0, 2.9, 'container');
  b.block(50, 62, 62, 65, 0, 2.9, 'container');
  b.block(6, 62, 9, 72, 0, 2.9, 'container');
  // pillars, rubble, a pit with a hazard border
  for (const x of [26, 52, 78]) b.pillar(x, 38, 2.4, 0, 24, 'concrete');
  b.rubble(54, 16, 66, 26, 0, 7);
  b.rubble(4, 36, 10, 44, 0, 4);
  b.pit(90, 30, 98, 38, 0, 2, -40);
  // structure and services
  for (const z of [14, 30, 46, 62]) b.truss('x', z, 2.2, 101.8, 24);
  b.wallTray('x', 72, -1, 4, 100, 24, 'light-warm');
  b.wallTray('z', 2, 1, 14, 70, 24, null);
  b.wallRack('x', 72, -1, 66, 80, 0);
  b.duct('x', 36, 4, 100, 24);
  b.pilasters('x', 2, 1, [20, 40, 60], 0, 24);
  b.dec('cylinder-y', 'pipe', 99.2, 0, 60, 100.6, 24, 61.4);
  b.dec('cylinder-y', 'rust', 99.4, 0, 63, 100.4, 24, 64);
  // lamps: the west and centre are lit warm, the south-east corner only by cyan emergency lights, the north-west is dark
  b.lamps(30, 20, 78, 52, 24, 16, 16);
  b.lamps(14, 52, 30, 68, 24, 16, 16);
  b.lamps(86, 54, 94, 66, 24, 8, 12, 'light-cyan');
  b.lamps(80, 14, 96, 14, 24, 16, 16, 'light-cyan');
  b.beacon(94, 34, 0, 24, 'light-amber');
  b.dec('box', 'glass', 86, 12, 25.6, 100, 15, 25.8);
  // ── door to the corridor (east wall), barrier B1 ──
  b.carve(102, 0, 30, 104, 8, 42);
  b.barrier('B1', '試験隔壁', box(102, 0, 30, 104, 8, 42), 'T01', 'H', 'C');
  b.warnLights('z', 102, -1, 30, 42, 8, 'light-red');
  // ── corridor ──
  b.sectorId = 'C';
  const cor = b.room({ x0: 104, x1: 150, z0: 26, z1: 46, floor: 0, ceil: 9 });
  b.sector('C', '連絡路', 'Corridor', 'corridor', [b.roomBounds(cor)]);
  b.carve(104, 0, 30, 106, 8, 42);
  b.wallRack('x', 28, 1, 110, 130, 0);
  b.wallTray('x', 44, -1, 108, 148, 9, 'light-warm');
  b.block(134, 28, 138, 33, 0, 3, 'container');
  b.lamps(116, 36, 140, 36, 9, 12, 12);
  // ── exit hall with the final gate ──
  b.sectorId = 'E';
  const ex = b.room({ x0: 150, x1: 210, z0: 6, z1: 66, floor: 0, ceil: 18 });
  b.sector('E', '搬出ホール', 'Exit hall', 'gate', [b.roomBounds(ex)]);
  b.carve(148, 0, 30, 152, 8, 42);
  // gatehouse wall across the hall with the gate in it
  b.shell(186, 0, 8, 188, 18, 64, 'wall', 'gate-wall');
  b.carve(186, 0, 24, 188, 10, 48);
  b.warnLights('z', 186, -1, 24, 48, 10, 'light-amber');
  b.lamps(160, 18, 176, 54, 18, 16, 18);
  b.lamps(198, 24, 198, 48, 18, 8, 12, 'light-cyan');
  b.block(154, 50, 166, 53, 0, 2.9, 'container');
  b.block(156, 12, 164, 18, 0, 5, 'machine');
  for (const z of [20, 52]) b.truss('x', z, 152.2, 185.8, 18);
  // ── enemies ──
  b.sectorId = 'H';
  b.guard('G01', 40, 24, 0, Math.PI);
  b.guard('G02', 58, 34, 0, -Math.PI / 2);
  b.guard('G03', 44, 36, 4, Math.PI);
  b.turret('T02', 30, 6, 6, Math.PI);
  b.turretOnPedestal('T03', 76, 60, 0, 2, Math.PI / 2);
  b.turretOnPedestal('T01', 66, 30, 0, 1.5, Math.PI / 2, 'B1');
  b.sectorId = 'E';
  b.guard('G04', 170, 36, 0, Math.PI / 2);
  b.turret('T04', 178, 14, 0, Math.PI / 2);
  return {
    id: 'sample',
    name: 'sample',
    bounds: box(-8, -48, -8, 218, 40, 82),
    killY: -30,
    sectors: b.sectors,
    solids: b.finishSolids(),
    decor: b.decor,
    barriers: b.barriers,
    finalGate: { id: 'GATE', name: '最終搬出ゲート', box: box(186, 0, 24, 188, 10, 48) },
    exitZone: box(190, 0, 14, 208, 12, 58),
    playerStart: { position: v3(20, PLAYER.half.y + 0.001, 40), yaw: -90 * DEG },
    enemies: b.enemies,
    connections: [],
    route: [],
    flightSpots: [],
    branches: [],
    loops: [],
  };
}

// ───────────────────────────── texture preview ─────────────────────────────
function texturePreview(): void {
  const host = document.getElementById('tex')!;
  host.style.display = 'block';
  const d = getStageTextureData();
  const names = Object.keys(LAYER);
  const only = q.get('layer');
  const mode = q.get('ch') ?? 'rgb';
  const scale = num('scale', only ? 1 : 0.5);
  const rep = num('rep', 1);
  for (let l = 0; l < d.layers; l++) {
    if (only && names[l] !== only) continue;
    const cv = document.createElement('canvas');
    cv.width = cv.height = d.size * rep;
    cv.style.width = cv.style.height = `${d.size * rep * scale}px`;
    cv.title = names[l]!;
    const g = cv.getContext('2d')!;
    const img = g.createImageData(d.size, d.size);
    const src = d.albedo.subarray(l * d.size * d.size * 4, (l + 1) * d.size * d.size * 4);
    for (let y = 0; y < d.size; y++) {
      for (let x = 0; x < d.size; x++) {
        const s = ((d.size - 1 - y) * d.size + x) * 4;
        const o = (y * d.size + x) * 4;
        if (mode === 'rough') {
          img.data[o] = img.data[o + 1] = img.data[o + 2] = src[s + 3]!;
        } else if (mode === 'height') {
          const hs = d.heightSize;
          const v = d.height[l * hs * hs + (hs - 1 - (y >> 1)) * hs + (x >> 1)]!;
          img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
        } else {
          img.data[o] = src[s]!;
          img.data[o + 1] = src[s + 1]!;
          img.data[o + 2] = src[s + 2]!;
        }
        img.data[o + 3] = 255;
      }
    }
    for (let ry = 0; ry < rep; ry++) for (let rx = 0; rx < rep; rx++) g.putImageData(img, rx * d.size, ry * d.size);
    host.appendChild(cv);
  }
  W.__tex = { ms: d.ms, layerMs: d.layerMs.map((v) => Math.round(v)) };
}

// ───────────────────────────── main ─────────────────────────────
function main(): void {
  if (view === 'tex') {
    texturePreview();
    return;
  }
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const t0 = performance.now();
  const renderer = new GameRenderer(canvas);
  if (q.get('gov') !== '1') renderer.setResolutionGovernor(false);
  const fullW = window.innerWidth;
  const fullH = window.innerHeight;
  const legs = (q.get('legs') === 'quadruped' ? 'quadruped' : 'biped') as LegsId;
  const frames = Math.max(1, Math.round(num('frames', 40)));
  const live = q.get('live') === '1';
  const dt = 1 / 30;

  if (view === 'garage') {
    if (q.get('panels') === '1') for (const id of ['panelL', 'panelR']) document.getElementById(id)!.style.display = 'block';
    const loadout = { fcs: 'medium', generator: 'balanced', legs } as const;
    const pre = Math.max(1, Math.round(num('t', 1.4) / dt));
    renderer.resize(64, 36, 1);
    for (let i = 0; i < pre; i++) renderer.renderGarage(loadout, dt);
    renderer.resize(fullW, fullH, 1);
    renderer.renderGarage(loadout, dt);
    const publish = (): void => {
      W.__info = { ...renderer.getDebugInfo(), ms: performance.now() - t0 };
      info.textContent = `garage legs=${legs}  calls ${renderer.getDebugInfo().drawCalls}  tris ${renderer.getDebugInfo().triangles}`;
    };
    publish();
    if (q.get('swap') === '1') {
      // legs swap must be immediate
      const other = { ...loadout, legs: legs === 'biped' ? 'quadruped' : 'biped' } as const;
      renderer.renderGarage(other, dt);
      publish();
    }
    if (live) {
      let last = performance.now();
      const loop = (now: number): void => {
        renderer.renderGarage(loadout, (now - last) / 1000);
        last = now;
        publish();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    window.addEventListener('resize', () => {
      renderer.resize(window.innerWidth, window.innerHeight, 1);
      renderer.renderGarage(loadout, 0);
    });
    return;
  }

  const stageName = q.get('stage') ?? 'sample';
  const stage =
    stageName === 'factory'
      ? getFactoryStage()
      : stageName === 'test'
        ? makeTestStage({ enemies: [makeGuard('G1', -12, -40), makeGuard('G2', 14, -46), makeTurret('T1', 0, -60), makeTarget('X1', v3(8, 6, -30), v3(), 0.5)] })
        : buildSampleStage();
  const sim = new Sim(stage, { viewport: { width: fullW, height: fullH }, loadout: { fcs: 'medium', generator: 'balanced', legs } });
  const tSim = performance.now();
  renderer.setStage(stage);
  const tStage = performance.now();
  renderer.resetForSortie(sim);

  // ── player pose ──
  const p = sim.player;
  p.pos.x = num('px', stage.playerStart.position.x);
  p.pos.y = num('py', stage.playerStart.position.y);
  p.pos.z = num('pz', stage.playerStart.position.z);
  p.yaw = q.has('yaw') ? num('yaw', 0) * DEG : stage.playerStart.yaw;
  p.pitch = num('pitch', 0) * DEG;
  const weapon = q.get('weapon');
  if (weapon === 'beam' || weapon === 'missile' || weapon === 'machinegun') p.weapon = weapon as Weapon;
  const fwd = forwardFromYawPitch(p.yaw, p.pitch);
  const fwdH = forwardFromYawPitch(p.yaw, 0);
  sim.aim.dir = { ...fwd };
  const state = q.get('state') ?? 'idle';
  if (state === 'walk') {
    p.vel = v3(fwdH.x * 10, 0, fwdH.z * 10);
  } else if (state === 'glide') {
    p.vel = v3(fwdH.x * 22, 0, fwdH.z * 22);
    p.horizontalMode = 'glide';
    p.glideEnabled = true;
  } else if (state === 'qb') {
    p.vel = v3(fwdH.x * 80, 0, fwdH.z * 80);
    p.horizontalMode = 'quickboost';
  } else if (state === 'fly') {
    p.vel = v3(fwdH.x * 16, 8, fwdH.z * 16);
    p.grounded = false;
    p.verticalMode = 'flying';
    p.flying = true;
  } else if (state === 'fall') {
    p.vel = v3(fwdH.x * 16, -12, fwdH.z * 16);
    p.grounded = false;
    p.verticalMode = 'falling';
  }
  const moving = { ...p.vel };
  const anchor = { ...p.pos };

  // ── enemy states ──
  const dead = (q.get('dead') ?? '').split(',').filter(Boolean);
  const tele = num('tele', 0);
  for (const e of sim.enemies) {
    if (q.get('alert') === '1') {
      e.alert = true;
      const dx = p.pos.x - e.pos.x;
      const dy = p.pos.y - e.pos.y;
      const dz = p.pos.z - e.pos.z;
      const l = Math.hypot(dx, dy, dz) || 1;
      e.aimDir = v3(dx / l, dy / l, dz / l);
      e.yaw = Math.atan2(-dx, -dz);
    }
    if (q.has('hp')) e.hp = e.maxHp * num('hp', 1);
    if (dead.includes(e.id) || dead.includes('all')) {
      e.alive = false;
      e.hp = 0;
    }
    if (tele > 0 && e.alive) {
      const span = e.kind === 'guard' ? ENEMIES.guard.telegraph : ENEMIES.turret.telegraph;
      e.telegraphStartAt = sim.time - span * tele;
      e.burstStartAt = e.telegraphStartAt + span;
    }
  }

  // ── doors ──
  const open = (q.get('open') ?? '').split(',').filter(Boolean);
  const openAt = num('openAt', -1);
  const applyOpen = (): void => {
    const ev: SimEvent[] = [];
    for (const id of open) {
      if (id === stage.finalGate.id) {
        sim.objective.gateOpen = true;
        ev.push({ type: 'gate-opened' });
      } else {
        const b = stage.barriers.find((x) => x.id === id);
        if (!b) continue;
        sim.objective.openBarrierIds.push(id);
        sim.world.setBarrierOpen(id, true);
        ev.push({ type: 'barrier-opened', barrierId: id, controlEnemyId: b.controlEnemyId });
      }
    }
    renderer.handleEvents(ev, sim);
  };
  if (open.length > 0 && openAt < 0) applyOpen();

  // ── fake projectiles / events ──
  const fakeFx = (): void => {
    const m = p.muzzle.x === 0 && p.muzzle.y === 0 ? v3(p.pos.x, p.pos.y + 0.75, p.pos.z) : p.muzzle;
    const mk = (kind: Projectile['kind'], pos: V3, vel: V3, extra: Partial<Projectile> = {}): Projectile => ({
      id: sim.nextProjectileId++,
      kind,
      alive: true,
      spawnTime: sim.time,
      lifeSeconds: 3,
      damage: 1,
      origin: { ...pos },
      v0: { ...vel },
      pos: { ...pos },
      prevPos: { ...pos },
      vel: { ...vel },
      ...extra,
    });
    for (let i = 1; i <= 5; i++) sim.projectiles.push(mk('mg', v3(m.x + fwd.x * i * 9, m.y + fwd.y * i * 9 - 0.2, m.z + fwd.z * i * 9), v3(fwd.x * 100, fwd.y * 100, fwd.z * 100)));
    sim.projectiles.push(mk('missile', v3(m.x + fwd.x * 22 + 3, m.y + 2, m.z + fwd.z * 22), v3(fwd.x * 45, 0, fwd.z * 45), { targetId: null }));
    const ev: SimEvent[] = [];
    let k = 0;
    for (const e of sim.enemies) {
      if (!e.alive) continue;
      const dx = p.pos.x - e.pos.x;
      const dy = p.pos.y - e.pos.y;
      const dz = p.pos.z - e.pos.z;
      const l = Math.hypot(dx, dy, dz) || 1;
      if (l > 110) continue;
      const dir = v3(dx / l, dy / l, dz / l);
      const sp = e.kind === 'guard' ? 70 : 60;
      for (const f of [0.25, 0.5]) {
        sim.projectiles.push(mk('enemy', v3(e.pos.x + dx * f, e.pos.y + 0.5 + dy * f, e.pos.z + dz * f), v3(dir.x * sp, dir.y * sp, dir.z * sp), { ownerEnemyId: e.id, ownerKind: e.kind }));
      }
      if (k++ === 0) {
        ev.push({ type: 'beam', from: { ...m }, to: { ...e.pos }, hit: 'enemy', enemyId: e.id });
        ev.push({ type: 'enemy-shot', enemyId: e.id, kind: e.kind, muzzle: v3(e.pos.x, e.pos.y + 0.5, e.pos.z), dir });
      }
    }
    ev.push({ type: 'player-shot', weapon: p.weapon, muzzle: { ...m }, dir: { ...fwd }, projectileId: null, locked: false });
    const boom = sim.enemies.find((e) => !e.alive);
    if (boom) ev.push({ type: 'enemy-destroyed', enemyId: boom.id, kind: boom.kind, pos: { ...boom.pos }, isGateControl: boom.isGateControl });
    renderer.handleEvents(ev, sim);
  };

  // ── debug camera ──
  const camArg = q.get('cam');
  if (camArg) {
    const c = camArg.split(',').map(Number);
    renderer.setDebugCamera({ x: c[0] ?? 0, y: c[1] ?? 20, z: c[2] ?? 0, yaw: (c[3] ?? 0) * DEG, pitch: (c[4] ?? 0) * DEG });
  }
  if (q.get('cross') === '1') document.getElementById('cross')!.style.display = 'block';

  // ── leak test: repeated re-sorties ──
  const resets = Math.round(num('resets', 0));
  if (resets > 0) {
    renderer.resize(64, 36, 1);
    const rows: Array<Record<string, number>> = [];
    for (let r = 0; r < resets; r++) {
      sim.reset();
      p.pos.x = anchor.x;
      renderer.resetForSortie(sim);
      Object.assign(sim.player.pos, anchor);
      sim.player.yaw = p.yaw;
      fakeFx();
      for (let i = 0; i < 20; i++) renderer.renderGame(sim, dt);
      const d = renderer.getDebugInfo();
      rows.push({ reset: r + 1, geometries: d.geometries, textures: d.textures, programs: d.programs, effects: d.effects });
    }
    W.__leak = rows;
    renderer.resize(fullW, fullH, 1);
  }

  // ── pre-roll at a tiny resolution, then one full-size frame ──
  const sp = sim.player;
  const stepFrame = (i: number, n: number): void => {
    if (openAt >= 0 && open.length > 0 && Math.abs((n - i) * dt - openAt) < dt / 2) applyOpen();
    if (q.get('fx') === '1' && i === n - 2) fakeFx();
    // the simulation is not advanced here; a moving state keeps its velocity while staying in place
    sp.vel = { ...moving };
    renderer.renderGame(sim, dt);
  };
  renderer.resize(64, 36, 1);
  for (let i = 0; i < frames - 1; i++) stepFrame(i, frames);
  const dpr = num('dpr', 1);
  renderer.resize(fullW, fullH, dpr);
  const tFrame = performance.now();
  stepFrame(frames - 1, frames);
  const frameMs = performance.now() - tFrame;

  if (q.get('check') === '1') {
    // projectToCss must agree with the THREE camera that drew the frame; the drawing buffer must follow resize()
    let maxErr = 0;
    let n = 0;
    let behindMismatch = 0;
    const a = { x: 0, y: 0, depth: 0 };
    const b = { x: 0, y: 0, depth: 0 };
    const pts: V3[] = sim.enemies.map((e) => e.pos);
    for (let i = 0; i < 400; i++) pts.push(v3(sp.pos.x + Math.sin(i * 1.7) * (5 + i * 0.4), sp.pos.y + Math.cos(i * 0.9) * 12, sp.pos.z + Math.cos(i * 2.3) * (5 + i * 0.4)));
    for (const pt of pts) {
      const fa = renderer.projectToCss(pt, a);
      const fb = renderer.debugProjectWithThree(pt, b);
      if (fa !== fb) behindMismatch++;
      if (fa && fb) {
        n++;
        maxErr = Math.max(maxErr, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    W.__check = { points: n, maxErrPx: maxErr, behindMismatch, canvasWidth: canvas.width, canvasHeight: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, dpr };
  }

  const publish = (): void => {
    const d = renderer.getDebugInfo();
    const st = renderer.getStageView()?.getStats();
    W.__info = { ...d, stage: st, simMs: tSim - t0, stageMs: tStage - tSim, frameMs };
    info.textContent =
      `${stage.id}  pos ${sp.pos.x.toFixed(1)}, ${sp.pos.y.toFixed(1)}, ${sp.pos.z.toFixed(1)}  yaw ${(sp.yaw / DEG).toFixed(0)}  pitch ${(sp.pitch / DEG).toFixed(0)}\n` +
      `calls ${d.drawCalls}  tris ${d.triangles}  fx ${d.effects}  geo ${d.geometries}  tex ${d.textures}  prog ${d.programs}\n` +
      (st ? `stage: ${st.solids} solids, ${st.decor} decor → ${st.chunks} chunks, ${st.triangles} tris, ${st.lamps} lamps, build ${st.buildMs.toFixed(0)} ms (bake ${st.bakeMs.toFixed(0)} ms)` : '');
  };
  publish();
  if (q.get('dispose') === '1') {
    // everything this renderer created must be released (the garage scene is built first so it is covered too)
    renderer.renderGarage({ fcs: 'medium', generator: 'balanced', legs }, dt);
    renderer.renderGame(sim, dt);
    const before = renderer.getDebugInfo();
    renderer.dispose();
    const after = renderer.getDebugInfo();
    W.__check = { ...(W.__check as object), disposeBefore: `geo ${before.geometries} tex ${before.textures} prog ${before.programs}`, disposeAfter: `geo ${after.geometries} tex ${after.textures} prog ${after.programs}` };
  }
  if (q.get('hud') === '0') info.style.display = 'none';
  W.__sim = sim;
  W.__renderer = renderer;

  // ── scripted poses for screenshot tours: window.__shot(spec) re-poses and redraws without a reload ──
  //   spec = { p:[x,y,z] player hit-box centre, yaw, pitch (deg), cam:[x,y,z,yaw,pitch] | null (free camera),
  //            open:['B1','GATE'], dead:['T01'], alert:true|false, fly:true, frames:n, w, h }
  // Returns the frame statistics and every living enemy that is on screen with a free line from the camera.
  interface ShotSpec {
    p?: number[];
    yaw?: number;
    pitch?: number;
    cam?: number[] | null;
    open?: string[];
    dead?: string[];
    alert?: boolean;
    fly?: boolean;
    frames?: number;
    dt?: number;
    w?: number;
    h?: number;
  }
  W.__shot = (s: ShotSpec): unknown => {
    const pl = sim.player;
    if (s.p) {
      pl.pos.x = s.p[0]!;
      pl.pos.y = s.p[1]!;
      pl.pos.z = s.p[2]!;
    }
    pl.yaw = (s.yaw ?? 0) * DEG;
    pl.pitch = (s.pitch ?? 0) * DEG;
    pl.vel = s.fly ? v3(0, 8, 0) : v3();
    pl.grounded = !s.fly;
    pl.verticalMode = s.fly ? 'flying' : 'grounded';
    pl.flying = !!s.fly;
    pl.horizontalMode = 'walk';
    sim.aim.dir = forwardFromYawPitch(pl.yaw, pl.pitch);
    const deadIds = s.dead ?? [];
    for (const e of sim.enemies) {
      const isDead = deadIds.includes(e.id) || deadIds.includes('all');
      e.alive = !isDead;
      e.hp = isDead ? 0 : e.maxHp;
      e.telegraphStartAt = null;
      e.burstStartAt = null;
      e.alert = s.alert !== false;
      if (e.alert) {
        const dx = pl.pos.x - e.pos.x;
        const dy = pl.pos.y - e.pos.y;
        const dz = pl.pos.z - e.pos.z;
        const l = Math.hypot(dx, dy, dz) || 1;
        e.aimDir = v3(dx / l, dy / l, dz / l);
        e.yaw = Math.atan2(-dx, -dz);
      }
    }
    const openIds = s.open ?? [];
    const sv = renderer.getStageView();
    sim.objective.openBarrierIds = stage.barriers.filter((b) => openIds.includes(b.id)).map((b) => b.id);
    for (const b of stage.barriers) {
      const o = openIds.includes(b.id);
      sim.world.setBarrierOpen(b.id, o);
      sv?.setBarrierOpen(b.id, o, false);
    }
    sim.objective.gateOpen = openIds.includes(stage.finalGate.id);
    sv?.setBarrierOpen(stage.finalGate.id, sim.objective.gateOpen, false);
    const c = s.cam ?? null;
    renderer.setDebugCamera(c ? { x: c[0]!, y: c[1]!, z: c[2]!, yaw: (c[3] ?? 0) * DEG, pitch: (c[4] ?? 0) * DEG } : null);
    const n = Math.max(1, s.frames ?? 5);
    const sdt = s.dt ?? 0.1;
    const w = s.w ?? window.innerWidth;
    const h = s.h ?? window.innerHeight;
    renderer.resize(64, 36, 1);
    for (let i = 0; i < n - 1; i++) renderer.renderGame(sim, sdt);
    renderer.resize(w, h, 1);
    renderer.renderGame(sim, sdt);
    publish();
    // enemies on screen with a free line from the camera
    const seen: Array<{ id: string; d: number; x: number; y: number; ctrl: boolean }> = [];
    const out = { x: 0, y: 0, depth: 0 };
    const camPos = c ? v3(c[0]!, c[1]!, c[2]!) : null;
    for (const e of sim.enemies) {
      if (!e.alive) continue;
      const ok = c ? renderer.debugProjectWithThree(e.pos, out) : renderer.projectToCss(e.pos, out);
      if (!ok || out.x < 0 || out.y < 0 || out.x > w || out.y > h) continue;
      // camera position: the debug pose, or reconstructed from the projection depth along the view ray is not
      // needed — the chase camera sits within the boom length of the player, so test from the player's head
      const from = camPos ?? v3(pl.pos.x, pl.pos.y + 2.5, pl.pos.z);
      const dx = e.pos.x - from.x;
      const dy = e.pos.y - from.y;
      const dz = e.pos.z - from.z;
      const d = Math.hypot(dx, dy, dz);
      const hit = sim.world.raycast(from, v3(dx / d, dy / d, dz / d), d);
      if (hit && hit.dist < d - 1.6) continue;
      seen.push({ id: e.id, d: Math.round(d), x: Math.round(out.x), y: Math.round(out.y), ctrl: e.isGateControl });
    }
    const dbg = renderer.getDebugInfo();
    return { calls: dbg.drawCalls, tris: dbg.triangles, seen };
  };

  // ── governor test: synthetic frame times in, drawing-buffer size out ──
  W.__gov = (segments: Array<[number, number]>): unknown => {
    renderer.setResolutionGovernor(true);
    const out: Array<{ scale: number; pixelRatio: number; buffer: number[] }> = [];
    for (const [frameSeconds, count] of segments) {
      if (frameSeconds < 0) renderer.resetForSortie(sim); // (a new sortie: the governor starts observing afresh)
      else for (let i = 0; i < count; i++) renderer.renderGame(sim, frameSeconds);
      const d = renderer.getDebugInfo();
      out.push({ scale: d.resolutionScale, pixelRatio: d.pixelRatio, buffer: [canvas.width, canvas.height] });
    }
    return out;
  };

  if (live) {
    let last = performance.now();
    const keys = new Set<string>();
    window.addEventListener('keydown', (e) => keys.add(e.code));
    window.addEventListener('keyup', (e) => keys.delete(e.code));
    canvas.addEventListener('mousemove', (e) => {
      if (e.buttons & 1) {
        sp.yaw -= e.movementX * 0.004;
        sp.pitch = Math.max(-1.2, Math.min(1.3, sp.pitch - e.movementY * 0.004));
      }
    });
    const loop = (now: number): void => {
      const rdt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const f = forwardFromYawPitch(sp.yaw, 0);
      const mv = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      const st = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      const up = (keys.has('Space') ? 1 : 0) - (keys.has('ControlLeft') ? 1 : 0);
      const speed = keys.has('ShiftLeft') ? 60 : 20;
      sp.vel = v3((f.x * mv - f.z * st) * speed, up * speed * 0.5, (f.z * mv + f.x * st) * speed);
      sp.pos.x += sp.vel.x * rdt;
      sp.pos.y += sp.vel.y * rdt;
      sp.pos.z += sp.vel.z * rdt;
      sim.aim.dir = forwardFromYawPitch(sp.yaw, sp.pitch);
      renderer.renderGame(sim, rdt);
      publish();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  window.addEventListener('resize', () => {
    renderer.resize(window.innerWidth, window.innerHeight, 1);
    if (!live) renderer.renderGame(sim, 0);
  });
}

main();
