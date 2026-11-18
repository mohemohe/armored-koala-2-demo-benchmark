/**
 * Event sources for the audio harness and tests (no DOM, no WebAudio; not part of the game bundle):
 *
 *  - SyntheticFight  a scripted heavy fight: machine gun at 10 shots/s, 15 enemies bursting on the real
 *                    timers of SPEC §2.3, explosions, quick boosts every second, hits, damage, low HP …
 *  - RealFight       a REAL Sim on a test stage driven by a small autopilot through sim.input only
 *                    (exactly what the keyboard does); the events come from sim.drainEvents().
 *  - sampleEvents()  one hand-made instance of every SimEvent variant (exhaustive by type).
 */
import { ENEMIES, PLAYER, WEAPONS } from '../src/config';
import { v3, type V3 } from '../src/core/vec';
import { Sim } from '../src/sim/sim';
import type { EnemyDef, Loadout, SimEvent, StageDef, Weapon } from '../src/sim/types';
import { makeGuard, makeTestStage, makeTurret } from '../src/stage/testStages';
import { makeRandom } from '../src/audio/patch';
import type { AudioSimView } from '../src/audio/cues';

// ───────────────────────────── synthetic heavy fight ─────────────────────────────

interface FakeEnemy {
  id: string;
  kind: 'guard' | 'turret';
  pos: V3;
  alive: boolean;
  burstAt: number;
  shotsDone: number;
  telegraphed: boolean;
}

interface Pending {
  at: number;
  event: SimEvent;
}

export interface SyntheticOptions {
  /** Number of guards / turrets firing (default 10 + 5 = 15 enemies). */
  guards?: number;
  turrets?: number;
  seed?: number;
}

/**
 * Deterministic stand-in for a heavy fight. `step(dt)` advances its clock and returns the events of that
 * interval; `view` is the simulation state the audio engine reads (camera, player, lock, enemies).
 */
export class SyntheticFight {
  time = 0;
  readonly counts: Record<string, number> = {};
  readonly view: {
    time: number;
    status: string;
    camera: { pos: V3; yaw: number };
    player: { pos: V3; vel: V3; yaw: number; hp: number; en: number; horizontalMode: string; flying: boolean; braking: boolean };
    lock: { state: string; targetId: string | null };
    enemyById: Map<string, FakeEnemy>;
  };

  private readonly rnd: () => number;
  private readonly enemies: FakeEnemy[] = [];
  private readonly pending: Pending[] = [];
  private readonly next: Record<string, number> = {};
  private projectileId = 1;
  private qbAt = -10;
  private jumpAt = -10;
  private rejectIndex = 0;
  private weaponIndex = 0;
  private glideManual = true;

  constructor(opts: SyntheticOptions = {}) {
    this.rnd = makeRandom(opts.seed ?? 20260908);
    const guards = opts.guards ?? 10;
    const turrets = opts.turrets ?? 5;
    for (let i = 0; i < guards + turrets; i++) {
      const kind = i < guards ? 'guard' : 'turret';
      const angle = (i / (guards + turrets)) * Math.PI * 2 + this.rnd() * 0.3;
      const dist = kind === 'guard' ? 22 + this.rnd() * 60 : 45 + this.rnd() * 70;
      this.enemies.push({
        id: (kind === 'guard' ? 'G' : 'T') + String(i + 1).padStart(2, '0'),
        kind,
        pos: v3(Math.sin(angle) * dist, kind === 'guard' ? 1.3 : 1.6 + this.rnd() * 8, -Math.cos(angle) * dist),
        alive: true,
        burstAt: 0.5 + this.rnd() * ENEMIES[kind].burstPeriod,
        shotsDone: 0,
        telegraphed: false,
      });
    }
    this.view = {
      time: 0,
      status: 'playing',
      camera: { pos: v3(0, 6.5, 9.5), yaw: 0 },
      player: { pos: v3(0, 2, 0), vel: v3(), yaw: 0, hp: PLAYER.maxHp, en: 120, horizontalMode: 'glide', flying: false, braking: false },
      lock: { state: 'none', targetId: null },
      enemyById: new Map(this.enemies.map((e) => [e.id, e])),
    };
  }

  /** True once per `period` seconds (first time at `first`). A timer that was not polled for a while restarts. */
  private every(key: string, period: number, first: number): boolean {
    let due = this.next[key] ?? first;
    if (this.time < due) return false;
    if (this.time - due > period) due = this.time;
    this.next[key] = due + period;
    return true;
  }

  private later(delay: number, event: SimEvent): void {
    this.pending.push({ at: this.time + delay, event });
  }

  private randomEnemy(): FakeEnemy {
    return this.enemies[Math.floor(this.rnd() * this.enemies.length) % this.enemies.length];
  }

  private nearPlayer(spread: number): V3 {
    const p = this.view.player.pos;
    return v3(p.x + (this.rnd() - 0.5) * spread, p.y + (this.rnd() - 0.5) * 3, p.z + (this.rnd() - 0.5) * spread);
  }

  step(dt: number): SimEvent[] {
    const out: SimEvent[] = [];
    this.time += dt;
    const t = this.time;
    const v = this.view;
    const phase = t % 60;

    // ── delayed consequences (bullet travel) ──
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at <= t) {
        out.push(this.pending[i].event);
        this.pending.splice(i, 1);
      }
    }

    // ── player weapons ──
    const mg = phase < 22 || (phase >= 34 && phase < 46) || phase >= 50;
    const beam = phase >= 22 && phase < 34;
    const missile = phase >= 46;
    if (mg && this.every('mg', WEAPONS.machinegun.interval, 0.2)) {
      const id = this.projectileId++;
      out.push({ type: 'player-shot', weapon: 'machinegun', muzzle: v3(0.9, 2.75, -0.85), dir: v3(0, 0, -1), projectileId: id, locked: true });
      const target = this.randomEnemy();
      const travel = Math.hypot(target.pos.x, target.pos.z) / WEAPONS.machinegun.speed;
      if (this.rnd() < 0.7) {
        this.later(travel, { type: 'projectile-hit', kind: 'mg', pos: { ...target.pos }, target: 'enemy', enemyId: target.id });
        this.later(travel, { type: 'enemy-damaged', enemyId: target.id, amount: 12, pos: { ...target.pos } });
      } else {
        this.later(travel, { type: 'projectile-hit', kind: 'mg', pos: v3(target.pos.x + 3, 0, target.pos.z), target: 'world', enemyId: null });
      }
    }
    if (beam && this.every('beam', WEAPONS.beam.interval, 22)) {
      const target = this.randomEnemy();
      const hit = this.rnd() < 0.6 ? 'enemy' : this.rnd() < 0.7 ? 'world' : 'none';
      out.push({ type: 'player-shot', weapon: 'beam', muzzle: v3(0.9, 2.75, -0.85), dir: v3(0, 0, -1), projectileId: null, locked: true });
      out.push({ type: 'beam', from: v3(0.9, 2.75, -0.85), to: { ...target.pos }, hit, enemyId: hit === 'enemy' ? target.id : null });
      if (hit === 'enemy') out.push({ type: 'enemy-damaged', enemyId: target.id, amount: 40, pos: { ...target.pos } });
    }
    if (missile && this.every('missile', WEAPONS.missile.interval, 46)) {
      const target = this.randomEnemy();
      out.push({ type: 'player-shot', weapon: 'missile', muzzle: v3(0.9, 2.75, -0.85), dir: v3(0, 0, -1), projectileId: this.projectileId++, locked: true });
      const travel = Math.hypot(target.pos.x, target.pos.z) / WEAPONS.missile.speed;
      if (this.rnd() < 0.8) this.later(travel, { type: 'projectile-hit', kind: 'missile', pos: { ...target.pos }, target: 'enemy', enemyId: target.id });
      else this.later(4, { type: 'projectile-expired', kind: 'missile', pos: v3(target.pos.x, 20, target.pos.z) });
    }
    if (this.every('reject', 2.7, 1.1)) {
      const reasons = ['no-lock', 'no-en', 'no-ammo'] as const;
      const weapons: Weapon[] = ['missile', 'beam', 'machinegun'];
      const i = this.rejectIndex++ % 3;
      out.push({ type: 'fire-rejected', weapon: weapons[i], reason: reasons[i] });
    }
    if (this.every('switch', 5.3, 2.4)) {
      const weapons: Weapon[] = ['machinegun', 'beam', 'missile'];
      out.push({ type: 'weapon-switched', weapon: weapons[this.weaponIndex++ % 3] });
    }

    // ── movement ──
    if (this.every('qb', 1.0, 0.6)) {
      this.qbAt = t;
      const a = this.rnd() * Math.PI * 2;
      out.push({ type: 'qb', dir: { x: Math.cos(a), z: Math.sin(a) }, airborne: this.rnd() < 0.3 });
      this.later(PLAYER.qbImpulseSeconds, { type: 'glide', enabled: true, auto: true });
    }
    if (this.every('qbreject', 2.3, 1.45)) out.push({ type: 'qb-rejected', reason: this.rnd() < 0.5 ? 'cooldown' : 'no-en' });
    if (this.every('jump', 3.1, 1.7)) {
      this.jumpAt = t;
      out.push({ type: 'jump' });
      this.later(1.6, { type: 'land', speed: 4 + this.rnd() * 22 });
    }
    if (this.every('glidetoggle', 7, 4.2)) {
      this.glideManual = !this.glideManual;
      out.push({ type: 'glide', enabled: this.glideManual, auto: false });
    }
    if (this.every('sector', 9, 3)) out.push({ type: 'sector-entered', sectorId: 'S0' + (1 + (Math.floor(t / 9) % 9)) });

    // ── enemies: every one on its own timer (SPEC §2.3 numbers) ──
    for (const e of this.enemies) {
      const cfg = ENEMIES[e.kind];
      if (!e.telegraphed && t >= e.burstAt - cfg.telegraph) {
        e.telegraphed = true;
        out.push({ type: 'enemy-telegraph', enemyId: e.id, duration: Math.max(0.01, e.burstAt - t) });
      }
      while (e.shotsDone < cfg.burstCount && t >= e.burstAt + e.shotsDone * cfg.burstInterval) {
        e.shotsDone++;
        out.push({ type: 'enemy-shot', enemyId: e.id, kind: e.kind, muzzle: v3(e.pos.x, e.pos.y + 0.5, e.pos.z), dir: v3(0, 0, 1) });
        const travel = Math.hypot(e.pos.x, e.pos.z) / cfg.bulletSpeed;
        if (this.rnd() < 0.35) {
          this.later(travel, { type: 'projectile-hit', kind: 'enemy', pos: { ...v.player.pos }, target: 'player', enemyId: null });
          this.later(travel, { type: 'player-damaged', amount: cfg.damage, sourcePos: { ...e.pos }, fromEnemyId: e.id });
        } else {
          this.later(travel, { type: 'projectile-hit', kind: 'enemy', pos: this.nearPlayer(30), target: 'world', enemyId: null });
        }
      }
      if (e.shotsDone >= cfg.burstCount) {
        e.burstAt += cfg.burstPeriod;
        e.shotsDone = 0;
        e.telegraphed = false;
      }
    }
    if (this.every('alert', 0.9, 0.3)) out.push({ type: 'enemy-alerted', enemyId: this.randomEnemy().id });

    // ── kills and progress ──
    if (this.every('kill-guard', 1.5, 1.2)) {
      const e = this.randomEnemy();
      out.push({ type: 'enemy-destroyed', enemyId: e.id, kind: 'guard', pos: { ...e.pos }, isGateControl: false });
    }
    if (this.every('kill-turret', 6.2, 3.3)) {
      const e = this.randomEnemy();
      out.push({ type: 'enemy-destroyed', enemyId: e.id, kind: 'turret', pos: { ...e.pos }, isGateControl: false });
    }
    if (this.every('kill-control', 14.5, 8)) {
      const e = this.randomEnemy();
      out.push({ type: 'enemy-destroyed', enemyId: e.id, kind: 'turret', pos: { ...e.pos }, isGateControl: true });
      out.push({ type: 'barrier-opened', barrierId: 'B1', controlEnemyId: e.id });
    }
    if (this.every('gate', 60, 55)) out.push({ type: 'gate-opened' });

    // ── state read by update(): camera, glide speed, flight, lock, HP, EN, brake ──
    v.time = t;
    v.camera.yaw = Math.sin(t * 0.3) * 1.2;
    const sinceQb = t - this.qbAt;
    const speed = sinceQb < PLAYER.qbImpulseSeconds ? PLAYER.qbSpeed : Math.max(PLAYER.glideSpeed, PLAYER.qbSpeed - ((sinceQb - PLAYER.qbImpulseSeconds) / PLAYER.qbDecelSeconds) * (PLAYER.qbSpeed - PLAYER.glideSpeed));
    v.player.braking = t % 9 > 8.6;
    v.player.horizontalMode = v.player.braking ? 'walk' : sinceQb < PLAYER.qbImpulseSeconds ? 'quickboost' : 'glide';
    v.player.vel.x = v.player.braking ? speed * 0.4 : speed;
    const sinceJump = t - this.jumpAt;
    v.player.flying = sinceJump > 0.25 && sinceJump < 1.15;
    v.player.hp = Math.max(60, PLAYER.maxHp - (t % 60) * 15.5);
    v.player.en = 60 + 58 * Math.sin(t * 1.9);
    const locked = t % 2 < 1.5;
    v.lock.state = locked ? 'locked' : t % 2 < 1.8 ? 'none' : 'acquiring';
    v.lock.targetId = locked ? this.enemies[Math.floor(t / 2) % this.enemies.length].id : null;

    for (const e of out) this.counts[e.type] = (this.counts[e.type] ?? 0) + 1;
    return out;
  }
}

// ───────────────────────────── real Sim + autopilot ─────────────────────────────

export type FightMode = 'win' | 'lose';

/**
 * 'win': two control turrets with barriers, one guard and one far turret; the exit zone covers the whole
 * floor, so the sortie is cleared the moment the final gate opens (barrier-opened ×2, gate-opened, cleared).
 * 'lose': fifteen enemies around a player — 'failed' follows soon.
 */
export function makeFightStage(mode: FightMode): StageDef {
  const control = (id: string, x: number, z: number, barrierId: string): EnemyDef => ({
    ...makeTurret(id, x, z),
    isGateControl: true,
    barrierId,
  });
  const enemies: EnemyDef[] = [];
  if (mode === 'win') {
    enemies.push(control('T01', -18, -44, 'B1'), control('T02', 26, -52, 'B2'), makeGuard('G01', 4, -62), makeTurret('T03', -40, -70));
  } else {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      enemies.push(makeGuard('G' + String(i + 1).padStart(2, '0'), Math.sin(a) * (34 + (i % 3) * 9), -Math.cos(a) * (34 + (i % 3) * 9)));
    }
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      enemies.push(makeTurret('T' + String(i + 1).padStart(2, '0'), Math.sin(a) * 70, -Math.cos(a) * 70));
    }
  }
  const stage = makeTestStage({ enemies });
  // two sectors (west / east of x = 0) so that the strafing mech produces 'sector-entered'
  const whole = stage.sectors[0].bounds[0];
  stage.sectors = [
    { ...stage.sectors[0], id: 'T00', name: '試験場 西', nameEn: 'Test range west', bounds: [{ min: { ...whole.min }, max: { ...whole.max, x: 0 } }] },
    { ...stage.sectors[0], id: 'T01', name: '試験場 東', nameEn: 'Test range east', bounds: [{ min: { ...whole.min, x: 0 }, max: { ...whole.max } }] },
  ];
  if (mode === 'win') {
    stage.barriers = [
      { id: 'B1', name: '隔壁 B1', box: { min: v3(200, 0, -4), max: v3(202, 8, 4) }, controlEnemyId: 'T01', fromSectorId: 'T00', toSectorId: 'T00' },
      { id: 'B2', name: '隔壁 B2', box: { min: v3(210, 0, -4), max: v3(212, 8, 4) }, controlEnemyId: 'T02', fromSectorId: 'T00', toSectorId: 'T00' },
    ];
    stage.finalGate = { id: 'GATE', name: '最終ゲート', box: { min: v3(220, 0, -4), max: v3(222, 8, 4) } };
    stage.exitZone = { min: v3(-390, -5, -390), max: v3(390, 200, 390) };
  }
  return stage;
}

/**
 * A real simulation fought by an autopilot that only writes `sim.input` and calls `sim.applyLook` — the
 * same interface the keyboard and mouse use. step(dt) advances the Sim and returns its drained events.
 */
export class RealFight {
  readonly sim: Sim;
  readonly counts: Record<string, number> = {};
  private clock = 0;
  private readonly next: Record<string, number> = {};
  private weaponIndex = 0;
  private jumpUntil = -1;
  private brakeUntil = -1;
  private strafe = 1;

  constructor(
    readonly mode: FightMode,
    loadout: Loadout = { fcs: 'narrow', generator: 'capacity', legs: 'biped' },
    seed = 20260908,
    /** 'lose' only: seconds of evasive flying before the pilot stops (the fight is then lost quickly). */
    private readonly evadeSeconds = 9,
  ) {
    this.sim = new Sim(makeFightStage(mode), { loadout, seed });
  }

  get finished(): boolean {
    return this.sim.status !== 'playing';
  }

  private every(key: string, period: number, first: number): boolean {
    const due = this.next[key] ?? first;
    if (this.clock < due) return false;
    this.next[key] = due + period;
    return true;
  }

  /** `fixed` = advance exactly dt with whole ticks (deterministic); otherwise sim.advance(dt) like the app. */
  step(dt: number, fixed = true): SimEvent[] {
    const sim = this.sim;
    if (sim.status !== 'playing') return [];
    this.clock += dt;
    const inp = sim.input;
    const p = sim.player;

    // aim: turn the camera towards the nearest living enemy (limited turn rate, like a mouse)
    let target = null as (typeof sim.enemies)[number] | null;
    let best = Infinity;
    for (const e of sim.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y, e.pos.z - p.pos.z);
      if (d < best) {
        best = d;
        target = e;
      }
    }
    if (target) {
      const cam = sim.camera.pos;
      const dx = target.pos.x - cam.x;
      const dy = target.pos.y - cam.y;
      const dz = target.pos.z - cam.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      let dYaw = Math.atan2(-dx, -dz) - p.yaw;
      while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
      while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
      const dPitch = Math.asin(Math.max(-1, Math.min(1, dy / len))) - p.pitch;
      const maxTurn = 7 * dt;
      sim.applyLook(Math.max(-maxTurn, Math.min(maxTurn, dYaw)), Math.max(-maxTurn, Math.min(maxTurn, dPitch)));
    }

    inp.fire = target !== null;
    // 'win' sticks to the beam until the control turrets are down; then (and in 'lose') it cycles weapons
    const controlsLeft = sim.enemies.some((e) => e.alive && e.isGateControl);
    if (this.mode === 'win' && controlsLeft) {
      if (p.weapon !== 'beam') inp.weaponSelect = 'beam';
    } else if (this.every('weapon', 2.6, 0.4)) {
      const order: Weapon[] = ['machinegun', 'missile', 'beam'];
      inp.weaponSelect = order[this.weaponIndex++ % order.length];
    }
    // 'lose': the pilot evades for a while, then brakes and stands still — the enemies finish the job
    const evading = this.mode === 'win' || this.clock < this.evadeSeconds;
    if (this.every('strafe', 1.7, 0.9)) this.strafe = -this.strafe;
    inp.moveX = evading ? this.strafe : 0;
    inp.moveZ = 0;
    if (evading) {
      if (this.every('qb', this.mode === 'win' ? 2.4 : 1.25, 1.0)) inp.qbPressed = true;
      if (this.every('qb-early', 3.3, 1.3)) inp.qbPressed = true; // inside the cooldown now and then → qb-rejected
      if (this.every('glide', 6.5, 4.0)) inp.glideTogglePressed = true;
      if (this.every('jump', 4.2, 2.2)) {
        inp.jumpPressed = true;
        this.jumpUntil = this.clock + 0.9;
      }
      if (this.every('brake', 5.1, 3.1)) this.brakeUntil = this.clock + 0.35;
    }
    inp.jump = this.clock < this.jumpUntil;
    inp.brake = this.clock < this.brakeUntil || !evading;

    if (fixed) sim.runFor(dt);
    else sim.advance(dt);
    const events = sim.drainEvents();
    for (const e of events) this.counts[e.type] = (this.counts[e.type] ?? 0) + 1;
    return events;
  }
}

// ───────────────────────────── one of everything ─────────────────────────────

/** Hand-made instances covering every SimEvent variant and every branch of the sound mapping. */
export function sampleEvents(): Record<SimEvent['type'], SimEvent[]> {
  const pos = v3(20, 3, -40);
  const muzzle = v3(0.9, 2.75, -0.85);
  const dir = v3(0, 0, -1);
  return {
    'player-shot': [
      { type: 'player-shot', weapon: 'machinegun', muzzle, dir, projectileId: 1, locked: false },
      { type: 'player-shot', weapon: 'beam', muzzle, dir, projectileId: null, locked: true },
      { type: 'player-shot', weapon: 'missile', muzzle, dir, projectileId: 2, locked: true },
    ],
    beam: [
      { type: 'beam', from: muzzle, to: pos, hit: 'enemy', enemyId: 'G01' },
      { type: 'beam', from: muzzle, to: pos, hit: 'world', enemyId: null },
      { type: 'beam', from: muzzle, to: pos, hit: 'none', enemyId: null },
    ],
    'fire-rejected': [
      { type: 'fire-rejected', weapon: 'missile', reason: 'no-lock' },
      { type: 'fire-rejected', weapon: 'beam', reason: 'no-en' },
      { type: 'fire-rejected', weapon: 'machinegun', reason: 'no-ammo' },
    ],
    'weapon-switched': [
      { type: 'weapon-switched', weapon: 'machinegun' },
      { type: 'weapon-switched', weapon: 'beam' },
      { type: 'weapon-switched', weapon: 'missile' },
    ],
    qb: [
      { type: 'qb', dir: { x: 1, z: 0 }, airborne: false },
      { type: 'qb', dir: { x: 0, z: -1 }, airborne: true },
    ],
    'qb-rejected': [
      { type: 'qb-rejected', reason: 'no-en' },
      { type: 'qb-rejected', reason: 'cooldown' },
      { type: 'qb-rejected', reason: 'brake' },
    ],
    glide: [
      { type: 'glide', enabled: true, auto: false },
      { type: 'glide', enabled: false, auto: false },
      { type: 'glide', enabled: true, auto: true },
    ],
    jump: [{ type: 'jump' }],
    land: [
      { type: 'land', speed: 0.4 },
      { type: 'land', speed: 9 },
      { type: 'land', speed: 30 },
    ],
    'projectile-hit': [
      { type: 'projectile-hit', kind: 'mg', pos, target: 'enemy', enemyId: 'G01' },
      { type: 'projectile-hit', kind: 'mg', pos, target: 'world', enemyId: null },
      { type: 'projectile-hit', kind: 'missile', pos, target: 'enemy', enemyId: 'T01' },
      { type: 'projectile-hit', kind: 'missile', pos, target: 'world', enemyId: null },
      { type: 'projectile-hit', kind: 'enemy', pos: v3(2, 2, 1), target: 'world', enemyId: null },
      { type: 'projectile-hit', kind: 'enemy', pos: v3(0, 2, 0), target: 'player', enemyId: null },
    ],
    'projectile-expired': [
      { type: 'projectile-expired', kind: 'mg', pos },
      { type: 'projectile-expired', kind: 'missile', pos },
      { type: 'projectile-expired', kind: 'enemy', pos },
    ],
    'enemy-telegraph': [
      { type: 'enemy-telegraph', enemyId: 'G01', duration: ENEMIES.guard.telegraph },
      { type: 'enemy-telegraph', enemyId: 'T01', duration: ENEMIES.turret.telegraph },
      { type: 'enemy-telegraph', enemyId: 'nobody', duration: 0.1 },
    ],
    'enemy-shot': [
      { type: 'enemy-shot', enemyId: 'G01', kind: 'guard', muzzle: pos, dir },
      { type: 'enemy-shot', enemyId: 'T01', kind: 'turret', muzzle: pos, dir },
    ],
    'enemy-damaged': [{ type: 'enemy-damaged', enemyId: 'G01', amount: 12, pos }],
    'enemy-destroyed': [
      { type: 'enemy-destroyed', enemyId: 'G01', kind: 'guard', pos, isGateControl: false },
      { type: 'enemy-destroyed', enemyId: 'T02', kind: 'turret', pos, isGateControl: false },
      { type: 'enemy-destroyed', enemyId: 'T01', kind: 'turret', pos, isGateControl: true },
    ],
    'enemy-alerted': [
      { type: 'enemy-alerted', enemyId: 'G01' },
      { type: 'enemy-alerted', enemyId: 'nobody' },
    ],
    'player-damaged': [
      { type: 'player-damaged', amount: ENEMIES.guard.damage, sourcePos: v3(-30, 2, -10), fromEnemyId: 'G01' },
      { type: 'player-damaged', amount: ENEMIES.turret.damage, sourcePos: v3(40, 2, 10), fromEnemyId: 'T01' },
    ],
    'barrier-opened': [{ type: 'barrier-opened', barrierId: 'B1', controlEnemyId: 'T01' }],
    'gate-opened': [{ type: 'gate-opened' }],
    'sector-entered': [{ type: 'sector-entered', sectorId: 'S02' }],
    cleared: [{ type: 'cleared' }],
    failed: [
      { type: 'failed', reason: 'destroyed' },
      { type: 'failed', reason: 'fell' },
    ],
  };
}

/** A small enemy table for the sample events above (G01 guard, T01 / T02 turrets). */
export function sampleView(): AudioSimView {
  const enemies = new Map<string, { pos: V3; kind: string; alive: boolean }>([
    ['G01', { pos: v3(20, 1.3, -40), kind: 'guard', alive: true }],
    ['T01', { pos: v3(-35, 1.6, -60), kind: 'turret', alive: true }],
    ['T02', { pos: v3(50, 9, 20), kind: 'turret', alive: true }],
  ]);
  return {
    time: 1,
    status: 'playing',
    camera: { pos: v3(0, 6.5, 9.5), yaw: 0 },
    player: { pos: v3(0, 2, 0), vel: v3(), yaw: 0, hp: PLAYER.maxHp, en: 120, horizontalMode: 'walk', flying: false, braking: false },
    lock: { state: 'none', targetId: null },
    enemyById: enemies,
  };
}
