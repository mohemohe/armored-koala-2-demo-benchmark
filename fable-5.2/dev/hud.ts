/**
 * Visual test harness for src/ui/hud.ts.
 *
 *   /dev/hud.html?case=<name>
 *                &fcs=wide|medium|narrow  &gen=capacity|balanced|recovery  &legs=biped|quadruped
 *                &bg=mid|dark|bright      backdrop brightness (readability check)
 *                &ref=1                   draw an independent reference circle (magenta) of
 *                                         FCS_PARTS[fcs].radiusFactor × min(innerWidth, innerHeight)
 *                &dt=<s>                  simulation seconds added after the case's events (fade phase)
 *                &live=1                  scripted animation instead of a frozen state
 *
 * A real Sim is created on a flat test stage (with six fake control turrets + barriers so that the real
 * objective code runs), but it is never advanced: each case forces a representative state by writing the
 * sim fields directly and by feeding real / hand-made SimEvents to the HUD. The projector is the real
 * projectToViewport() with a collision-free TPS camera.
 *
 * Cases: none, acquiring, locked-mg, locked-beam, locked-missile, nosolution, missile-reject, missile-nolock,
 *        no-en, no-ammo, no-ammo-persist, low-en, qb, qb-cooldown, qb-reject, glide, brake, flight, rising, fall,
 *        low-hp, mid-hp, barrier, gate, gate-late, damage, telegraph, offscreen, aim-offscreen, hit, nosector, combat
 *
 * Route guidance (src/sim/guide.ts → the "進路" marker and panel row). These cases give the test stage a small
 * hand-made route (a wall that hides control turret T01, a 10 m ledge with barrier B1 on it, a drop) and let the
 * REAL guide code compute the hint for the forced player position. `&route=1` adds the same route to any other case.
 *        route, route-off, route-blocked, route-edge-left, route-edge-right, route-near, route-visible, route-climb,
 *        route-climb-edge, route-drop, route-lock, route-rejoin, route-back, route-exit
 *
 * window.__hud = { sim, hud, cases, measure(), perf(n), perfLive(n), domNodes() }
 *   measure() returns sim.lock.radiusCssPx, the independently computed factor × min(w, h) and the radius /
 *   centre of the lock ring as actually laid out on screen (getBBox × getScreenCTM), for --eval checks.
 */
import { CAMERA, ENEMIES, FCS_PARTS, PLAYER, WEAPONS } from '../src/config';
import { clone, cross, forwardFromYawPitch, normalize, sub, v3, type V3 } from '../src/core/vec';
import { projectToViewport } from '../src/sim/camera';
import { describeGuide, getRouteHint, updateGuide } from '../src/sim/guide';
import { Sim } from '../src/sim/sim';
import type { EnemyDef, FcsId, GeneratorId, LegsId, SimEvent, SolutionStatus, Weapon } from '../src/sim/types';
import { makeGuard, makeTarget, makeTestStage, makeTurret } from '../src/stage/testStages';
import { Hud, type Projector } from '../src/ui/hud';

const q = new URLSearchParams(location.search);
const str = (k: string, d: string): string => q.get(k) ?? d;
const pick = <T extends string>(k: string, allowed: readonly T[], d: T): T => {
  const v = q.get(k);
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : d;
};

const fcs = pick<FcsId>('fcs', ['wide', 'medium', 'narrow'], 'medium');
const gen = pick<GeneratorId>('gen', ['capacity', 'balanced', 'recovery'], 'balanced');
const legs = pick<LegsId>('legs', ['biped', 'quadruped'], 'biped');
const bg = pick('bg', ['mid', 'dark', 'bright'] as const, 'mid');
const showRef = str('ref', '0') === '1';
const live = str('live', '0') === '1';
const caseName = str('case', 'none');

// ───────────────────────── stage + sim ─────────────────────────
const ctrl = (id: string, x: number, z: number, barrierId: string, sectorId: string): EnemyDef => ({
  ...makeTurret(id, x, z),
  isGateControl: true,
  barrierId,
  sectorId,
});
const enemies: EnemyDef[] = [
  makeGuard('G01', -8, -40),
  makeGuard('G02', 30, -35),
  makeGuard('G03', 25, 30),
  makeGuard('G04', -30, 22),
  ctrl('T01', 6, -60, 'B1', 'S03'),
  ctrl('T02', -90, -30, 'B2', 'S07'),
  ctrl('T03', 10, 120, 'B3', 'S09'),
  ctrl('T04', 140, -200, 'B4', 'S09'),
  ctrl('T05', -160, -260, 'B5', 'S07'),
  ctrl('T06', 40, -330, 'B6', 'S09'),
  makeTurret('T07', -34, -52),
  makeTarget('X01', v3(-10, 14, -70), v3(8, 0, 0), 1.2, 240),
  makeTarget('X02', v3(4, 46, -60), v3(0, 6, 0), 1.2, 240),
];
const stage = makeTestStage({ enemies });
{
  const main = stage.sectors[0];
  main.id = 'S03';
  main.name = '圧延棟';
  main.nameEn = 'Rolling mill';
  const b = main.bounds[0];
  const far = b.max.x;
  b.max.x = far - 100;
  stage.sectors.push(
    { id: 'S07', name: '動力棟', nameEn: 'Power house', kind: 'plant', bounds: [{ min: v3(far - 90, b.min.y, b.min.z), max: v3(far - 50, b.max.y, b.max.z) }] },
    { id: 'S09', name: '冷却設備', nameEn: 'Cooling plant', kind: 'plant', bounds: [{ min: v3(far - 40, b.min.y, b.min.z), max: v3(far, b.max.y, b.max.z) }] },
  );
  for (const e of stage.enemies) if (e.sectorId === 'T00') e.sectorId = 'S03';
  for (let i = 0; i < 6; i++) {
    stage.barriers.push({
      id: 'B' + (i + 1),
      name: '隔壁 B' + (i + 1),
      box: { min: v3(far - 95 + i, 0, far - 20), max: v3(far - 94.5 + i, 1, far - 19) },
      controlEnemyId: 'T0' + (i + 1),
      fromSectorId: 'S03',
      toSectorId: 'S07',
    });
  }
}

// ── route guidance cases: a route on the flat stage (see the header) ──
const routeCase = caseName.startsWith('route') || str('route', '0') === '1';
if (routeCase) {
  stage.solids.push(
    { min: v3(-30, 0, -31), max: v3(18, 14, -29), material: 'wall', tag: 'hides T01 from the start' },
    { min: v3(-40, 0, -150), max: v3(40, 10, -110), material: 'concrete', tag: 'ledge' },
  );
  stage.barriers[0].box = { min: v3(-10, 10, -131), max: v3(10, 18, -129) };
  const wp = (sectorId: string, x: number, y: number, z: number): { sectorId: string; position: V3 } => ({ sectorId, position: v3(x, y, z) });
  stage.route = [
    wp('S03', 0, 2, 12),
    wp('S03', 26, 2, -18),
    wp('S03', 26, 2, -44),
    wp('S03', 0, 2, -70),
    wp('S03', 0, 2, -98), // take-off
    wp('S07', 0, 12, -114), // landing on the ledge
    wp('S07', 0, 12, -140), // behind barrier B1
    wp('S07', 0, 12, -147), // edge of the ledge
    wp('S09', 0, 2, -160), // floor
    wp('S09', 0, 2, -220),
  ];
}

const sim = new Sim(stage, { loadout: { fcs, generator: gen, legs }, viewport: { width: window.innerWidth, height: window.innerHeight } });
const hud = new Hud(document.getElementById('hud-root') as HTMLElement);
const p = sim.player;
const T0 = 30;

/** Collision-free TPS camera rig (same formula as computeCameraRig without the boom raycast). */
function setCamera(): void {
  const c = sim.camera;
  c.yaw = p.yaw;
  c.pitch = p.pitch;
  c.aspect = sim.viewport.width / sim.viewport.height;
  c.fovY = (CAMERA.fovYDeg * Math.PI) / 180;
  forwardFromYawPitch(p.yaw, p.pitch, c.forward);
  normalize(cross(c.forward, v3(0, 1, 0), c.right), c.right);
  normalize(cross(c.right, c.forward, c.up), c.up);
  c.pos.x = p.pos.x - c.forward.x * CAMERA.boomLength;
  c.pos.y = p.pos.y + CAMERA.pivotUp - c.forward.y * CAMERA.boomLength;
  c.pos.z = p.pos.z - c.forward.z * CAMERA.boomLength;
}
const project: Projector = (pt, out) => projectToViewport(sim.camera, sim.viewport, pt, out);

function applySize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  sim.setViewport(w, h); // the real code path that sizes the judged lock circle
  setCamera();
  hud.resize(w, h);
}

// ───────────────────────── state forcing helpers ─────────────────────────
const enemy = (id: string) => {
  const e = sim.enemyById.get(id);
  if (!e) throw new Error('no enemy ' + id);
  return e;
};
function lockOn(id: string | null, state: 'none' | 'acquiring' | 'locked', progress: number): void {
  sim.lock.state = state;
  sim.lock.targetId = id;
  sim.lock.progress = progress;
  sim.lock.heldSeconds = progress * sim.stats.lockSeconds;
}
/** Hand-made fire-control value with the same structure the FCS produces (fixed-point intercept). */
function solve(weapon: Weapon, id: string, status: SolutionStatus): void {
  const e = enemy(id);
  if (e.scriptedVel) e.vel = clone(e.scriptedVel);
  const m = clone(p.muzzle);
  const tp = clone(e.pos);
  const tv = clone(e.vel);
  let t: number | null = null;
  let aim = clone(tp);
  let intercept: V3 | null = null;
  if (status === 'solved') {
    if (weapon === 'beam') {
      t = 0;
      intercept = clone(tp);
    } else {
      const speed = weapon === 'machinegun' ? WEAPONS.machinegun.speed : WEAPONS.missile.speed;
      const g = weapon === 'machinegun' ? WEAPONS.machinegun.gravity : 0;
      let tt = Math.hypot(tp.x - m.x, tp.y - m.y, tp.z - m.z) / speed;
      for (let i = 0; i < 40; i++) {
        aim = v3(tp.x + tv.x * tt, tp.y + tv.y * tt + 0.5 * g * tt * tt, tp.z + tv.z * tt);
        tt = Math.hypot(aim.x - m.x, aim.y - m.y, aim.z - m.z) / speed;
      }
      t = tt;
      intercept = v3(tp.x + tv.x * tt, tp.y + tv.y * tt, tp.z + tv.z * tt);
    }
  }
  sim.fireControl = {
    status,
    weapon,
    targetId: status === 'inactive' ? null : id,
    evaluatedAt: sim.time,
    muzzle: m,
    targetPos: tp,
    targetVel: tv,
    launchDir: normalize(sub(aim, m)),
    flightSeconds: t,
    intercept,
    aimPoint: aim,
    residual: status === 'solved' ? 0 : null,
  };
  sim.aim.mode = 'fcs';
  sim.aim.point = clone(aim);
  sim.aim.dir = normalize(sub(aim, m));
}
function feed(events: SimEvent[]): void {
  hud.handleEvents(events, sim);
}
/** Feeds whatever the real sim code emitted (damagePlayer / damageEnemy). */
function feedSim(): void {
  hud.handleEvents(sim.drainEvents(), sim);
}
function setWeapon(w: Weapon): void {
  p.weapon = w;
}
function glide(speed: number): void {
  p.horizontalMode = 'glide';
  p.glideEnabled = true;
  p.glideDir = { x: 0, z: -1 };
  p.desiredDir = { x: 0, z: -1 };
  p.vel = v3(0, 0, -speed);
}
function airborne(mode: 'rising' | 'flying' | 'falling', vy: number): void {
  p.grounded = false;
  p.verticalMode = mode;
  p.flying = mode === 'flying';
  p.pos.y = 9;
  p.vel.y = vy;
}

/** Route cases: puts the mech somewhere (hit-box centre) and points the camera. yaw 0 = -Z, positive = left. */
function standAt(x: number, y: number, z: number, yaw = 0, pitch = -0.04): void {
  p.pos.x = x;
  p.pos.y = y;
  p.pos.z = z;
  p.yaw = yaw;
  p.pitch = pitch;
  setCamera();
}
/** Route cases: T01 destroyed through the real objective code → barrier B1 open, the route goes on to its end. */
function openB1(): void {
  sim.damageEnemy(enemy('T01'), 1e6);
  sim.drainEvents();
}

interface Case {
  note: string;
  /** Simulation seconds added after setup (so that fades are caught mid-way). */
  dt?: number;
  setup: () => void;
}

const cases: Record<string, Case> = {
  none: { note: 'default: no lock, MG, full EN/HP, walking on the ground', setup: () => {} },
  acquiring: {
    note: 'lock acquiring 60 % on control turret T01',
    setup: () => lockOn('T01', 'acquiring', 0.6),
  },
  'locked-mg': {
    note: 'lock complete on moving target X01, machine gun lead + gravity solution',
    setup: () => {
      lockOn('X01', 'locked', 1);
      solve('machinegun', 'X01', 'solved');
      p.ammo.machinegun = 287;
      p.nextFireAt.machinegun = sim.time + 0.06;
    },
  },
  'locked-beam': {
    note: 'lock complete on G01, beam: aim marker coincides with the target marker',
    setup: () => {
      setWeapon('beam');
      lockOn('G01', 'locked', 1);
      solve('beam', 'G01', 'solved');
      p.en = 96;
      p.lastEnSpentAt = sim.time - 0.1;
      p.nextFireAt.beam = sim.time + 0.15;
      enemy('G01').hp = 80;
    },
  },
  'locked-missile': {
    note: 'lock complete on X01, missile lead (no gravity), missile cooling down',
    setup: () => {
      setWeapon('missile');
      lockOn('X01', 'locked', 1);
      solve('missile', 'X01', 'solved');
      p.ammo.missile = 9;
      p.nextFireAt.missile = sim.time + 0.62;
    },
  },
  nosolution: {
    note: 'lock complete but no fire solution: crossed-out marker, direct aim',
    setup: () => {
      lockOn('X01', 'locked', 1);
      solve('machinegun', 'X01', 'no_solution');
    },
  },
  'missile-reject': {
    note: 'missile trigger pulled while the lock is still acquiring (fire-rejected no-lock)',
    setup: () => {
      setWeapon('missile');
      lockOn('T01', 'acquiring', 0.3);
      feed([{ type: 'fire-rejected', weapon: 'missile', reason: 'no-lock' }]);
    },
  },
  'missile-nolock': {
    note: 'missile selected, no lock, no trigger: persistent 要ロック chip only',
    setup: () => setWeapon('missile'),
  },
  'no-en': {
    note: 'beam with EN 5 (< 8): EN不足 notice, QB EN不足, regen waiting',
    setup: () => {
      setWeapon('beam');
      p.en = 5;
      p.lastEnSpentAt = sim.time - 0.1;
      feed([{ type: 'fire-rejected', weapon: 'beam', reason: 'no-en' }]);
    },
  },
  'no-ammo': {
    note: 'machine gun empty + trigger (fire-rejected no-ammo)',
    setup: () => {
      p.ammo.machinegun = 0;
      feed([{ type: 'fire-rejected', weapon: 'machinegun', reason: 'no-ammo' }]);
    },
  },
  'no-ammo-persist': {
    note: 'missiles empty, no trigger: persistent 弾切れ',
    dt: 3,
    setup: () => {
      setWeapon('missile');
      p.ammo.missile = 0;
      p.ammo.machinegun = 41;
    },
  },
  'low-en': {
    note: 'EN 22 (< QB cost), grounded and regenerating',
    setup: () => {
      p.en = 22;
      p.lastEnSpentAt = sim.time - 2;
    },
  },
  qb: {
    note: 'quick boost impulse in progress',
    dt: 0,
    setup: () => {
      p.horizontalMode = 'quickboost';
      p.qbImpulseRemaining = 0.08;
      p.qbLastStartedAt = sim.time - 0.07;
      p.qbSuccessfulCount = 1;
      p.lastEnSpentAt = sim.time - 0.07;
      p.en = sim.stats.maxEn - PLAYER.qbCost;
      p.vel = v3(0, 0, -sim.stats.qbSpeed);
      p.glideEnabled = false;
    },
  },
  'qb-cooldown': {
    note: 'automatic glide after a QB: 0.42 s until the next QB, regen waiting',
    dt: 0,
    setup: () => {
      glide(37.5);
      p.qbLastStartedAt = sim.time - 0.58;
      p.lastEnSpentAt = sim.time - 0.58;
      p.qbSuccessfulCount = 1;
      p.en = sim.stats.maxEn - PLAYER.qbCost;
    },
  },
  'qb-reject': {
    note: 'Q pressed with EN 30: qb-rejected (no-en)',
    setup: () => {
      p.en = 30;
      p.lastEnSpentAt = sim.time - 3;
      feed([{ type: 'qb-rejected', reason: 'no-en' }]);
    },
  },
  glide: {
    note: 'steady glide on the ground, EN regenerating while gliding',
    setup: () => {
      glide(sim.stats.glideSpeed);
      p.en = 71.4;
      p.lastEnSpentAt = sim.time - 2;
    },
  },
  brake: {
    note: 'brake held',
    setup: () => {
      p.braking = true;
      p.vel = v3(0, 0, -8.6);
      p.en = 102;
      p.lastEnSpentAt = sim.time - 2;
    },
  },
  flight: {
    note: 'flying (thrusters on): EN draining, airborne',
    setup: () => {
      airborne('flying', PLAYER.flyClimbSpeed);
      p.vel.z = -sim.stats.airSpeed;
      p.en = 61.3;
      p.lastEnSpentAt = sim.time;
      p.jumpHeldSince = sim.time - 1.4;
    },
  },
  rising: {
    note: 'plain jump, rising: airborne → no regeneration',
    setup: () => {
      airborne('rising', 6.2);
      p.en = 88;
      p.lastEnSpentAt = sim.time - 3;
    },
  },
  fall: {
    note: 'falling with glide enabled in the air',
    setup: () => {
      airborne('falling', -11);
      glide(sim.stats.airSpeed);
      p.en = 12;
      p.lastEnSpentAt = sim.time - 1.5;
    },
  },
  'low-hp': {
    note: 'HP 220 (< 30 %): text warning + restrained vignette',
    setup: () => {
      p.hp = 220;
    },
  },
  'mid-hp': {
    note: 'HP 520',
    setup: () => {
      p.hp = 520;
    },
  },
  barrier: {
    note: 'control turrets T01 and T02 destroyed through sim.damageEnemy → toasts, 2/6',
    dt: 0.6,
    setup: () => {
      sim.damageEnemy(enemy('T01'), 1e6);
      sim.damageEnemy(enemy('T02'), 1e6);
      feedSim();
    },
  },
  gate: {
    note: 'all six control turrets destroyed → banner + toasts',
    dt: 0.6,
    setup: () => {
      for (let i = 1; i <= 6; i++) sim.damageEnemy(enemy('T0' + i), 1e6);
      feedSim();
    },
  },
  'gate-late': {
    note: 'gate open, toasts expired: persistent banner only',
    dt: 12,
    setup: () => {
      for (let i = 1; i <= 6; i++) sim.damageEnemy(enemy('T0' + i), 1e6);
      feedSim();
    },
  },
  damage: {
    note: 'hits from front-left (G01), front-right (G02), behind-right (G03), left (T02 turret)',
    dt: 0,
    setup: () => {
      sim.damagePlayer(ENEMIES.guard.damage, enemy('G01').pos, 'G01');
      feedSim();
      sim.time += 0.3;
      sim.damagePlayer(ENEMIES.guard.damage, enemy('G03').pos, 'G03');
      feedSim();
      sim.time += 0.25;
      sim.damagePlayer(ENEMIES.turret.damage, enemy('T02').pos, 'T02');
      feedSim();
      sim.time += 0.15;
      sim.damagePlayer(ENEMIES.guard.damage, enemy('G02').pos, 'G02');
      feedSim();
      sim.time += 0.1;
    },
  },
  telegraph: {
    note: 'telegraphs: G01 + T07 + G02 on screen, G03 behind, T02 off-screen left',
    dt: 0.05,
    setup: () => {
      feed([
        { type: 'enemy-telegraph', enemyId: 'G01', duration: ENEMIES.guard.telegraph },
        { type: 'enemy-telegraph', enemyId: 'G02', duration: ENEMIES.guard.telegraph },
        { type: 'enemy-telegraph', enemyId: 'G03', duration: ENEMIES.guard.telegraph },
        { type: 'enemy-telegraph', enemyId: 'T07', duration: ENEMIES.turret.telegraph },
        { type: 'enemy-telegraph', enemyId: 'T02', duration: ENEMIES.turret.telegraph },
      ]);
    },
  },
  offscreen: {
    note: 'forced: lock target behind the camera, aim point off-screen, objective off-screen',
    setup: () => {
      p.yaw = 0.9;
      setCamera();
      lockOn('G03', 'locked', 1);
      solve('machinegun', 'G03', 'solved');
    },
  },
  'aim-offscreen': {
    note: 'target inside the circle, corrected aim point above the top edge (lock is kept)',
    setup: () => {
      p.pitch = 0.42;
      setCamera();
      const e = enemy('X02');
      e.scriptedVel = v3(0, Number(q.get('vy') ?? 60), 0);
      lockOn('X02', 'locked', 1);
      solve('machinegun', 'X02', 'solved');
    },
  },
  hit: {
    note: 'hit confirm + DESTROYED tick (non-control guard destroyed)',
    dt: 0.05,
    setup: () => {
      lockOn('G01', 'locked', 1);
      solve('machinegun', 'G01', 'solved');
      sim.damageEnemy(enemy('G02'), 1e6);
      feedSim();
    },
  },
  nosector: {
    note: 'between sectors: currentSectorId = null',
    setup: () => {
      sim.currentSectorId = null;
    },
  },
  combat: {
    note: 'kitchen sink: lock + lead, damage from two sides, telegraphs, toast, mid EN/HP, glide',
    dt: 0,
    setup: () => {
      sim.damageEnemy(enemy('T02'), 1e6);
      feedSim();
      sim.time += 1.2;
      lockOn('X01', 'locked', 1);
      solve('machinegun', 'X01', 'solved');
      p.ammo.machinegun = 143;
      p.ammo.missile = 7;
      p.nextFireAt.machinegun = sim.time + 0.04;
      p.nextFireAt.missile = sim.time + 0.4;
      glide(31);
      p.qbLastStartedAt = sim.time - 0.31;
      p.lastEnSpentAt = sim.time - 0.31;
      p.en = 47.6;
      p.hp = 1000;
      sim.damagePlayer(ENEMIES.turret.damage * 6 + ENEMIES.guard.damage * 6, enemy('T07').pos, 'T07');
      sim.damagePlayer(ENEMIES.guard.damage, enemy('G03').pos, 'G03');
      feedSim();
      sim.time += 0.35;
      sim.damagePlayer(ENEMIES.guard.damage, enemy('G04').pos, 'G04');
      feedSim();
      feed([
        { type: 'enemy-telegraph', enemyId: 'G02', duration: ENEMIES.guard.telegraph },
        { type: 'enemy-telegraph', enemyId: 'G03', duration: ENEMIES.guard.telegraph },
        { type: 'enemy-damaged', enemyId: 'X01', amount: 12, pos: clone(enemy('X01').pos) },
      ]);
      enemy('X01').hp = 156;
      sim.time += 0.06;
    },
  },
  // ── route guidance ──
  route: {
    note: 'route marker on screen: next waypoint on level ground (B1 open)',
    setup: () => {
      openB1();
      standAt(0, 2.001, 12, -0.5);
    },
  },
  'route-off': {
    note: 'route marker behind the camera → edge arrow (open triple chevron) + label',
    setup: () => {
      openB1();
      standAt(0, 2.001, 12, 2.3);
    },
  },
  'route-blocked': {
    note: 'T01 alive: the hint is the firing position, barrier B1 closed → FIRE POS + blocked line',
    setup: () => standAt(0, 2.001, 12, -0.5),
  },
  'route-edge-left': {
    note: 'same, the firing position off-screen to the left: two-line edge label beside its arrow',
    setup: () => standAt(0, 2.001, 12, -2.25),
  },
  'route-edge-right': {
    note: 'same, off-screen to the right',
    setup: () => standAt(0, 2.001, 12, 0.75),
  },
  'route-near': {
    note: 'T01 alive, 4.2 m before the firing position: the marker fades out',
    setup: () => {
      const f = describeGuide(sim)?.gates[0].firePosition ?? v3();
      standAt(f.x - 3.2, 2.001, f.z + 2.7, -0.75);
    },
  },
  'route-visible': {
    note: 'T01 alive, standing on the firing position with the turret in view: no route marker, panel says so',
    setup: () => {
      const f = describeGuide(sim)?.gates[0].firePosition ?? v3();
      standAt(f.x, 2.001, f.z, 0.45);
    },
  },
  'route-climb': {
    note: 'at the take-off: the hint is the landing 10 m up → chevrons up + FLY +10m + Space長押し',
    setup: () => {
      openB1();
      standAt(0, 2.001, -94, 0, 0.3);
    },
  },
  'route-climb-edge': {
    note: 'same, camera level: the landing is above the top edge → edge arrow pointing up',
    setup: () => {
      openB1();
      standAt(0, 2.001, -94, 0, -0.5);
    },
  },
  'route-drop': {
    note: 'on the ledge: the hint is the floor 10 m below → chevrons with ground bar + DROP 10m',
    setup: () => {
      openB1();
      standAt(0, 12.001, -143, 0, -0.42);
    },
  },
  'route-lock': {
    note: 'route marker inside the lock circle while G02 is locked: faded, first line only, under the lock markers',
    setup: () => {
      openB1();
      standAt(26, 2.001, -4, 0);
      lockOn('G02', 'locked', 1);
      solve('machinegun', 'G02', 'solved');
    },
  },
  'route-rejoin': {
    note: '40 m off the route: the marker reads REJOIN, the panel row 経路外',
    setup: () => {
      openB1();
      standAt(-42, 2.001, -62, -1.25);
    },
  },
  'route-back': {
    note: 'T01 alive, in front of closed B1 on the ledge: the hint leads back (drop to the take-off)',
    setup: () => standAt(0, 12.001, -124, Math.PI, -0.3),
  },
  'route-exit': {
    note: 'all six control turrets destroyed: route to its end, exit banner',
    dt: 12,
    setup: () => {
      for (let i = 1; i <= 6; i++) sim.damageEnemy(enemy('T0' + i), 1e6);
      feedSim();
      standAt(0, 2.001, -196, 0);
    },
  },
};

// ───────────────────────── backdrop (2D canvas: fake scene for context) ─────────────────────────
const canvas = document.getElementById('backdrop') as HTMLCanvasElement;
const g2 = canvas.getContext('2d') as CanvasRenderingContext2D;
const sp = { x: 0, y: 0, depth: 0 };
const PAL = {
  mid: { top: '#39434c', horizon: '#6b6659', floorNear: '#2b2f33', floorFar: '#4a4a46', grid: 'rgba(210,220,225,0.16)' },
  dark: { top: '#0b0e11', horizon: '#1a1c1f', floorNear: '#0c0d0f', floorFar: '#17191b', grid: 'rgba(210,220,225,0.10)' },
  bright: { top: '#d6d9dc', horizon: '#f3ead6', floorNear: '#b9b3a6', floorFar: '#e2dccd', grid: 'rgba(60,60,60,0.25)' },
}[bg];

function drawBackdrop(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  // horizon: projection of a far point at camera height straight ahead (horizontal forward)
  const c = sim.camera;
  const fh = Math.hypot(c.forward.x, c.forward.z) || 1;
  projectToViewport(c, sim.viewport, v3(c.pos.x + (c.forward.x / fh) * 5000, 0, c.pos.z + (c.forward.z / fh) * 5000), sp);
  const hy = Math.max(-h, Math.min(2 * h, sp.y));
  let grad = g2.createLinearGradient(0, 0, 0, Math.max(1, hy));
  grad.addColorStop(0, PAL.top);
  grad.addColorStop(1, PAL.horizon);
  g2.fillStyle = grad;
  g2.fillRect(0, 0, w, h);
  if (hy < h) {
    grad = g2.createLinearGradient(0, hy, 0, h);
    grad.addColorStop(0, PAL.floorFar);
    grad.addColorStop(1, PAL.floorNear);
    g2.fillStyle = grad;
    g2.fillRect(0, hy, w, h - hy);
  }
  // floor grid, 10 m
  g2.strokeStyle = PAL.grid;
  g2.lineWidth = 1;
  const a = v3();
  const b = v3();
  const seg = (ax: number, az: number, bx: number, bz: number): void => {
    // clip against the near plane by sampling
    let started = false;
    g2.beginPath();
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      a.x = ax + (bx - ax) * t;
      a.y = 0;
      a.z = az + (bz - az) * t;
      if (projectToViewport(c, sim.viewport, a, sp) && sp.depth > 1) {
        if (!started) g2.moveTo(sp.x, sp.y);
        else g2.lineTo(sp.x, sp.y);
        started = true;
      } else started = false;
    }
    g2.stroke();
  };
  const cx0 = Math.round(p.pos.x / 10) * 10;
  const cz0 = Math.round(p.pos.z / 10) * 10;
  for (let i = -20; i <= 20; i++) {
    seg(cx0 + i * 10, cz0 - 200, cx0 + i * 10, cz0 + 200);
    seg(cx0 - 200, cz0 + i * 10, cx0 + 200, cz0 + i * 10);
  }
  void b;
  // enemies (far to near)
  const list = sim.enemies.filter((e) => e.alive).sort((e1, e2) => depthOf(e2.pos) - depthOf(e1.pos));
  const f = h / 2 / Math.tan(c.fovY / 2);
  for (const e of list) {
    if (!projectToViewport(c, sim.viewport, e.pos, sp)) continue;
    const r = (e.radius * f) / sp.depth;
    const body = e.kind === 'guard' ? '#6e2630' : e.isGateControl ? '#5c5f3c' : '#4d5340';
    const eye = e.kind === 'guard' ? '#ff9b3d' : '#ff3b3b';
    // stand / mast
    g2.fillStyle = 'rgba(20,22,24,0.9)';
    g2.fillRect(sp.x - r * 0.25, sp.y, r * 0.5, r * 1.15);
    if (e.isGateControl) {
      g2.fillRect(sp.x - r * 0.08, sp.y - r * 2.2, r * 0.16, r * 1.4);
      g2.fillStyle = '#ffb53a';
      g2.beginPath();
      g2.arc(sp.x, sp.y - r * 2.25, Math.max(1.5, r * 0.22), 0, Math.PI * 2);
      g2.fill();
    }
    g2.fillStyle = body;
    g2.beginPath();
    g2.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    g2.fill();
    g2.strokeStyle = 'rgba(0,0,0,0.6)';
    g2.stroke();
    g2.fillStyle = eye;
    g2.beginPath();
    g2.arc(sp.x, sp.y - r * 0.1, Math.max(1.2, r * 0.25), 0, Math.PI * 2);
    g2.fill();
  }
  // the player's mech (rough koala-headed silhouette at the hit-box position)
  if (projectToViewport(c, sim.viewport, p.pos, sp)) {
    const s = f / sp.depth;
    const x = sp.x;
    const y = sp.y;
    g2.fillStyle = '#56616e';
    g2.fillRect(x - 0.55 * s, y + 0.2 * s, 0.4 * s, 1.8 * s);
    g2.fillRect(x + 0.15 * s, y + 0.2 * s, 0.4 * s, 1.8 * s);
    g2.fillStyle = '#8f99a6';
    g2.fillRect(x - 0.95 * s, y - 1.0 * s, 1.9 * s, 1.5 * s);
    g2.fillStyle = '#56616e';
    g2.fillRect(x - 1.3 * s, y - 0.9 * s, 0.4 * s, 1.3 * s);
    g2.fillRect(x + 0.9 * s, y - 0.9 * s, 0.4 * s, 1.3 * s);
    g2.fillStyle = '#8f99a6';
    g2.beginPath();
    g2.arc(x - 0.62 * s, y - 1.75 * s, 0.36 * s, 0, Math.PI * 2);
    g2.arc(x + 0.62 * s, y - 1.75 * s, 0.36 * s, 0, Math.PI * 2);
    g2.fill();
    g2.beginPath();
    g2.arc(x, y - 1.45 * s, 0.56 * s, 0, Math.PI * 2);
    g2.fill();
    g2.fillStyle = '#e8762b';
    g2.fillRect(x - 0.95 * s, y - 0.25 * s, 1.9 * s, 0.12 * s);
  }
  if (showRef) {
    const r = FCS_PARTS[fcs].radiusFactor * Math.min(w, h);
    g2.strokeStyle = '#ff00ff';
    g2.lineWidth = 1;
    g2.beginPath();
    g2.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    g2.stroke();
  }
}
function depthOf(pt: V3): number {
  const c = sim.camera;
  return (pt.x - c.pos.x) * c.forward.x + (pt.y - c.pos.y) * c.forward.y + (pt.z - c.pos.z) * c.forward.z;
}

// ───────────────────────── scripted live animation ─────────────────────────
let liveT = 0;
function animate(dt: number): void {
  liveT += dt;
  sim.time += dt;
  const t = liveT;
  p.yaw = Math.sin(t * 0.35) * 0.5;
  p.pitch = -0.04 + Math.sin(t * 0.5) * 0.05;
  setCamera();
  for (const e of sim.enemies) {
    if (e.scriptedVel && e.alive) {
      e.pos.x = e.def.position.x + Math.sin(t * 0.6 + e.index) * 14;
      e.vel.x = Math.cos(t * 0.6 + e.index) * 14 * 0.6;
    }
  }
  // lock cycle on X01: none → acquiring → locked
  const ph = t % 6;
  if (ph < 1) lockOn(null, 'none', 0);
  else if (ph < 1 + sim.stats.lockSeconds) lockOn('X01', 'acquiring', (ph - 1) / sim.stats.lockSeconds);
  else lockOn('X01', 'locked', 1);
  if (sim.lock.state === 'locked') solve(p.weapon, 'X01', 'solved');
  else {
    sim.fireControl.status = 'inactive';
    sim.fireControl.aimPoint = null;
    sim.fireControl.targetId = null;
  }
  // weapon cycle + firing
  const wi = Math.floor(t / 6) % 3;
  setWeapon((['machinegun', 'beam', 'missile'] as const)[wi]);
  const w = p.weapon;
  if (sim.time >= p.nextFireAt[w] && sim.lock.state === 'locked') {
    if (w === 'beam' && p.en >= WEAPONS.beam.enCost) {
      p.en -= WEAPONS.beam.enCost;
      p.lastEnSpentAt = sim.time;
      p.nextFireAt.beam = sim.time + WEAPONS.beam.interval;
    } else if (w === 'machinegun' && p.ammo.machinegun > 0) {
      p.ammo.machinegun--;
      p.nextFireAt.machinegun = sim.time + WEAPONS.machinegun.interval;
    } else if (w === 'missile' && p.ammo.missile > 0) {
      p.ammo.missile--;
      p.nextFireAt.missile = sim.time + WEAPONS.missile.interval;
    }
  }
  // QB every 2.5 s when affordable, then glide
  const cd = p.qbLastStartedAt === null ? 0 : p.qbLastStartedAt + PLAYER.qbCooldownSeconds - sim.time;
  if (t % 2.5 < dt && cd <= 0) {
    if (p.en >= PLAYER.qbCost) {
      p.en -= PLAYER.qbCost;
      p.qbLastStartedAt = sim.time;
      p.lastEnSpentAt = sim.time;
      p.qbImpulseRemaining = PLAYER.qbImpulseSeconds;
      p.horizontalMode = 'quickboost';
      p.vel = v3(0, 0, -sim.stats.qbSpeed);
    } else feed([{ type: 'qb-rejected', reason: 'no-en' }]);
  }
  if (p.qbImpulseRemaining > 0) {
    p.qbImpulseRemaining -= dt;
    if (p.qbImpulseRemaining <= 0) {
      p.qbImpulseRemaining = 0;
      p.horizontalMode = 'glide';
      p.glideEnabled = true;
    }
  } else if (p.horizontalMode === 'glide') {
    const sp2 = Math.hypot(p.vel.x, p.vel.z);
    p.vel.z = -Math.max(sim.stats.glideSpeed, sp2 - dt * 96);
  }
  if (p.grounded && (p.lastEnSpentAt === null || sim.time >= p.lastEnSpentAt + PLAYER.enRegenDelaySeconds)) {
    p.en = Math.min(sim.stats.maxEn, p.en + sim.stats.regenPerSecond * dt);
  }
  // enemy fire: telegraph, then damage
  if (t % 1.2 < dt) {
    const ids = ['G01', 'G02', 'G03', 'G04', 'T07'];
    const id = ids[Math.floor(t / 1.2) % ids.length];
    const e = enemy(id);
    feed([{ type: 'enemy-telegraph', enemyId: id, duration: ENEMIES[e.kind].telegraph }]);
    sim.damagePlayer(ENEMIES[e.kind].damage, e.pos, id);
    feedSim();
    if (p.hp <= 60) p.hp = PLAYER.maxHp;
  }
}

// ───────────────────────── boot ─────────────────────────
applySize();
sim.time = T0;
p.pitch = -0.04;
setCamera();
const chosen = cases[caseName] ?? cases.none;
document.title = 'AK2 dev — HUD — ' + caseName + ' — ' + chosen.note;
chosen.setup();
sim.drainEvents();
if (routeCase) {
  // the real guide code computes the hint for the forced position (a jump in position → fresh search)
  sim.currentSectorId = sim.world.sectorAt(p.pos) ?? sim.currentSectorId;
  updateGuide(sim);
  updateGuide(sim);
}
const dtParam = q.get('dt');
sim.time += dtParam !== null && Number.isFinite(Number(dtParam)) ? Number(dtParam) : (chosen.dt ?? 0.25);
drawBackdrop();

window.addEventListener('resize', () => {
  applySize();
  drawBackdrop();
});

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (live) {
    animate(dt);
    drawBackdrop();
  }
  if (routeCase) updateGuide(sim);
  hud.update(sim, project, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function measure(): Record<string, unknown> {
  const ring = document.querySelector('.hud-lock-ring') as SVGCircleElement;
  const root = (document.querySelector('.ak2-hud') as HTMLElement).getBoundingClientRect();
  const bb = ring.getBoundingClientRect();
  const box = ring.getBBox();
  const ctm = ring.getScreenCTM() as DOMMatrix;
  const strokeW = parseFloat(getComputedStyle(ring).strokeWidth);
  return {
    window: [window.innerWidth, window.innerHeight],
    simViewport: [sim.viewport.width, sim.viewport.height],
    fcs,
    radiusFactor: FCS_PARTS[fcs].radiusFactor,
    expectedRadius: FCS_PARTS[fcs].radiusFactor * Math.min(window.innerWidth, window.innerHeight),
    simRadiusCssPx: sim.lock.radiusCssPx,
    attrR: Number(ring.getAttribute('r')),
    // geometry (centre line of the stroke) in CSS px on screen
    drawnRadiusX: (box.width * ctm.a) / 2,
    drawnRadiusY: (box.height * ctm.d) / 2,
    drawnCentre: [ctm.e + (box.x + box.width / 2) * ctm.a - root.left, ctm.f + (box.y + box.height / 2) * ctm.d - root.top],
    expectedCentre: [sim.viewport.width / 2, sim.viewport.height / 2],
    clientRectHalf: [bb.width / 2, bb.height / 2],
    strokeWidthPx: strokeW,
    hudFontPx: parseFloat(getComputedStyle(document.querySelector('.ak2-hud') as HTMLElement).fontSize),
    lockState: sim.lock.state,
    case: caseName,
    note: chosen.note,
  };
}
/** Average cost (ms) of hud.update() with an unchanged state. */
function perf(n = 2000): number {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) hud.update(sim, project, 1 / 60);
  return (performance.now() - t0) / n;
}
/** Average cost (ms) of hud.update() while everything changes (scripted animation at 60 Hz). */
function perfLive(n = 2000): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    animate(1 / 60);
    const t0 = performance.now();
    hud.update(sim, project, 1 / 60);
    total += performance.now() - t0;
  }
  return total / n;
}
(window as unknown as { __hud: unknown }).__hud = { sim, hud, cases, measure, perf, perfLive, domNodes: () => document.querySelectorAll('.ak2-hud *').length, routeHint: () => getRouteHint(sim) };
