/**
 * Read-only evaluation snapshot — buildSnapshot() (docs/SPEC.md §10, plus the reset / pause sentences of §9
 * that concern it).
 *
 * The expected STRUCTURE is not transcribed by hand: the TypeScript block of §10 is read from docs/SPEC.md,
 * parsed, and every snapshot is checked against it (exact key sets in the spec's order, value kinds, enum
 * members, tuple lengths, finite numbers only). The SEMANTIC sentences that follow the block are checked
 * against the real simulation: everything drives a real Sim through its inputs on isolated test stages
 * (and on the shipped factory stage when it is available); nothing of the code under test is mocked.
 * Measured numbers are printed with the prefix "[snapshot]".
 */
import { describe, expect, it } from 'vitest';
import specText from '../docs/SPEC.md?raw';
import {
  CAMERA,
  DEFAULT_SEED,
  ENEMIES,
  FCS_PARTS,
  PLAYER,
  RECENT_SHOTS_MAX,
  TICK,
  WEAPONS,
  computeEffectiveStats,
} from '../src/config';
import { Rng } from '../src/core/rng';
import { v3, yawFromDir, type V3 } from '../src/core/vec';
import { Sim } from '../src/sim/sim';
import { buildSnapshot } from '../src/sim/snapshot';
import type {
  AppState,
  BarrierDef,
  EnemyDef,
  FcsId,
  GeneratorId,
  LegsId,
  Loadout,
  Snapshot,
  SolidDef,
  StageDef,
  Weapon,
} from '../src/sim/types';
import { getFactoryStage } from '../src/stage/factory';
import { makeGuard, makeTarget, makeTestStage, makeTurret } from '../src/stage/testStages';

// ───────────────────────────── the spec's type block, parsed ─────────────────────────────

type TNode =
  | { k: 'object'; fields: Array<[string, TNode]> }
  | { k: 'tuple'; items: TNode[] }
  | { k: 'array'; item: TNode }
  | { k: 'union'; options: TNode[] }
  | { k: 'lit'; value: string | number }
  | { k: 'prim'; name: 'number' | 'string' | 'boolean' | 'null' }
  | { k: 'ref'; name: string };

const TOKEN = /\/\/[^\n]*|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[{}[\]<>:;,|=]/g;

/** The ```typescript block of §10. */
function extractTypeBlock(md: string): string {
  const section = md.indexOf('## 10.');
  const start = md.indexOf('```typescript', section);
  const end = md.indexOf('```', start + 13);
  if (section < 0 || start < 0 || end < 0) throw new Error('docs/SPEC.md: the §10 type block was not found');
  return md.slice(start + 13, end);
}

function parseSpecTypes(src: string): Map<string, TNode> {
  const toks: string[] = [];
  for (const m of src.matchAll(TOKEN)) if (!m[0].startsWith('//')) toks.push(m[0]);
  let i = 0;
  const eat = (t: string): void => {
    if (toks[i] !== t) throw new Error(`spec type block: expected "${t}" but found "${toks[i]}" (token ${i})`);
    i++;
  };
  const primary = (): TNode => {
    const t = toks[i++];
    if (t === '{') {
      const fields: Array<[string, TNode]> = [];
      while (toks[i] !== '}') {
        const name = toks[i++];
        eat(':');
        fields.push([name, type()]);
        // members are separated by ";" (optional before the closing brace of a one-line object type)
        if (toks[i] !== '}') eat(';');
      }
      i++;
      return { k: 'object', fields };
    }
    if (t === '[') {
      const items = [type()];
      while (toks[i] === ',') {
        i++;
        items.push(type());
      }
      eat(']');
      return { k: 'tuple', items };
    }
    if (t === 'Array') {
      eat('<');
      const item = type();
      eat('>');
      return { k: 'array', item };
    }
    if (t === undefined) throw new Error('spec type block: unexpected end');
    if (t.startsWith('"')) return { k: 'lit', value: t.slice(1, -1) };
    if (/^\d/.test(t)) return { k: 'lit', value: Number(t) };
    if (t === 'number' || t === 'string' || t === 'boolean' || t === 'null') return { k: 'prim', name: t };
    if (/^[A-Za-z_]/.test(t)) return { k: 'ref', name: t };
    throw new Error(`spec type block: unexpected token "${t}"`);
  };
  const postfix = (): TNode => {
    let n = primary();
    while (toks[i] === '[' && toks[i + 1] === ']') {
      i += 2;
      n = { k: 'array', item: n };
    }
    return n;
  };
  function type(): TNode {
    const options = [postfix()];
    while (toks[i] === '|') {
      i++;
      options.push(postfix());
    }
    return options.length === 1 ? options[0] : { k: 'union', options };
  }
  const types = new Map<string, TNode>();
  while (i < toks.length) {
    eat('type');
    const name = toks[i++];
    eat('=');
    types.set(name, type());
    eat(';');
  }
  return types;
}

const show = (v: unknown): string => (typeof v === 'number' ? String(v) : (JSON.stringify(v) ?? String(v)));

/**
 * Appends to `errs` every way in which `value` differs from the spec type `node`.
 * Objects must be plain and carry exactly the spec's keys in the spec's order; numbers must be finite.
 * `relaxCounts`: a NUMERIC literal type (controlsRequired: 6, totalEnemies: 45) accepts any non-negative
 * integer — used for the small test stages, which do not have 6 controls / 45 enemies.
 */
function conform(value: unknown, node: TNode, types: Map<string, TNode>, path: string, errs: string[], relaxCounts: boolean): void {
  switch (node.k) {
    case 'ref': {
      const t = types.get(node.name);
      if (!t) errs.push(`${path}: unknown spec type ${node.name}`);
      else conform(value, t, types, path, errs, relaxCounts);
      return;
    }
    case 'prim':
      if (node.name === 'null') {
        if (value !== null) errs.push(`${path}: expected null, got ${show(value)}`);
      } else if (node.name === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) errs.push(`${path}: expected a finite number, got ${show(value)}`);
      } else if (typeof value !== node.name) {
        errs.push(`${path}: expected ${node.name}, got ${show(value)}`);
      }
      return;
    case 'lit':
      if (typeof node.value === 'number' && relaxCounts) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) errs.push(`${path}: expected a count, got ${show(value)}`);
      } else if (value !== node.value) {
        errs.push(`${path}: expected the literal ${show(node.value)}, got ${show(value)}`);
      }
      return;
    case 'union': {
      for (const o of node.options) {
        const e: string[] = [];
        conform(value, o, types, path, e, relaxCounts);
        if (e.length === 0) return;
      }
      errs.push(`${path}: ${show(value)} matches no member of the spec's union`);
      return;
    }
    case 'tuple':
      if (!Array.isArray(value) || value.length !== node.items.length || Object.keys(value).length !== node.items.length) {
        errs.push(`${path}: expected an array of exactly ${node.items.length}, got ${show(value)}`);
        return;
      }
      node.items.forEach((it, k) => conform(value[k], it, types, `${path}[${k}]`, errs, relaxCounts));
      return;
    case 'array':
      if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
        errs.push(`${path}: expected a dense array, got ${show(value)}`);
        return;
      }
      value.forEach((v, k) => conform(v, node.item, types, `${path}[${k}]`, errs, relaxCounts));
      return;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        errs.push(`${path}: expected a plain object, got ${show(value)}`);
        return;
      }
      const rec = value as Record<string, unknown>;
      const have = Reflect.ownKeys(rec).map(String).join(',');
      const want = node.fields.map((f) => f[0]).join(',');
      if (have !== want) errs.push(`${path}: keys [${have}] differ from the spec's [${want}]`);
      for (const [name, t] of node.fields) {
        if (Object.prototype.hasOwnProperty.call(rec, name)) conform(rec[name], t, types, `${path}.${name}`, errs, relaxCounts);
      }
      return;
    }
  }
}

const SPEC_TYPES = parseSpecTypes(extractTypeBlock(specText));
const SNAPSHOT_TYPE = SPEC_TYPES.get('Snapshot') as TNode;

/** Differences between a snapshot and the §10 type (strict = the literals 6 and 45 are enforced too). */
function specErrors(snapshot: unknown, strict: boolean): string[] {
  const errs: string[] = [];
  conform(snapshot, SNAPSHOT_TYPE, SPEC_TYPES, 'snapshot', errs, !strict);
  return errs;
}

// ───────────────────────────── simulation helpers ─────────────────────────────

const MG = WEAPONS.machinegun;
const MSL = WEAPONS.missile;
const ticksOf = (seconds: number): number => Math.round(seconds / TICK);
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Turns the camera so that its centre ray passes through `target` (the ray always passes through the boom pivot). */
function lookAt(sim: Sim, target: V3): void {
  const p = sim.player;
  const dx = target.x - p.pos.x;
  const dy = target.y - (p.pos.y + CAMERA.pivotUp);
  const dz = target.z - p.pos.z;
  let dYaw = yawFromDir(dx, dz) - p.yaw;
  dYaw -= 2 * Math.PI * Math.round(dYaw / (2 * Math.PI));
  sim.applyLook(dYaw, Math.atan2(dy, Math.hypot(dx, dz)) - p.pitch);
}

/** Runs `n` ticks, keeping the crosshair on enemy `id` (when given) before every tick. */
function run(sim: Sim, n: number, trackId?: string, each?: () => void): void {
  for (let k = 0; k < n && sim.status === 'playing'; k++) {
    if (trackId) lookAt(sim, sim.enemyById.get(trackId)!.pos);
    sim.tick();
    if (each) each();
  }
}

/** Y of the camera-centre ray for the mech standing at the origin of a test stage, looking level. */
const EYE_Y = PLAYER.half.y + 0.001 + CAMERA.pivotUp;

/** Flat stage, mech at the origin looking along −Z. */
function mk(enemies: EnemyDef[] = [], opts: { loadout?: Loadout; seed?: number; solids?: SolidDef[]; floorSize?: number } = {}): Sim {
  return new Sim(makeTestStage({ enemies, solids: opts.solids, floorSize: opts.floorSize }), { loadout: opts.loadout, seed: opts.seed });
}

/**
 * Every piece of simulation state as one string (non-finite numbers are kept distinguishable). Used to prove
 * that something did NOT change the simulation.
 */
function fingerprint(sim: Sim): string {
  const rep = (_k: string, v: unknown): unknown => (typeof v === 'number' && !Number.isFinite(v) ? `#${String(v)}` : v);
  const ids = [...sim.stage.barriers.map((b) => b.id), sim.stage.finalGate.id];
  return JSON.stringify(
    {
      time: sim.time,
      tickIndex: sim.tickIndex,
      accumulator: sim.accumulator,
      status: sim.status,
      failReason: sim.failReason,
      seed: sim.seed,
      rng: (sim.rng as unknown as { s: number }).s,
      loadout: sim.loadout,
      stats: sim.stats,
      viewport: sim.viewport,
      input: sim.input,
      player: sim.player,
      camera: sim.camera,
      enemies: sim.enemies.map((e) => ({ ...e, def: e.def.id })),
      projectiles: sim.projectiles,
      nextProjectileId: sim.nextProjectileId,
      lock: sim.lock,
      fireControl: sim.fireControl,
      aim: sim.aim,
      shots: sim.shots,
      nextShotId: sim.nextShotId,
      objective: sim.objective,
      controlsRequired: sim.controlsRequired,
      currentSectorId: sim.currentSectorId,
      visitedSectorIds: sim.visitedSectorIds,
      events: sim.events,
      barriers: ids.map((id) => [id, sim.world.isBarrierOpen(id), sim.nav.isBarrierOpen(id)]),
    },
    rep,
  );
}

/** All objects / arrays reachable from `root` (identity set). */
function collectRefs(root: unknown, into: Set<object> = new Set()): Set<object> {
  if (typeof root !== 'object' || root === null || into.has(root)) return into;
  into.add(root);
  for (const v of Object.values(root as Record<string, unknown>)) collectRefs(v, into);
  return into;
}

/** Overwrites every leaf of `root` with garbage and grows / shrinks its containers. */
function vandalise(root: unknown, depth = 0): void {
  if (typeof root !== 'object' || root === null) return;
  if (Array.isArray(root)) {
    for (let k = 0; k < root.length; k++) {
      if (typeof root[k] === 'object' && root[k] !== null) vandalise(root[k], depth + 1);
      else root[k] = Number.NaN;
    }
    root.push('junk', { injected: true });
    return;
  }
  const rec = root as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    if (typeof v === 'object' && v !== null) vandalise(v, depth + 1);
    else if (typeof v === 'number') rec[key] = key.length % 2 === 0 ? Number.NaN : -1e9;
    else if (typeof v === 'boolean') rec[key] = !v;
    else rec[key] = 'vandalised';
  }
  rec.injected = Number.POSITIVE_INFINITY;
  if (depth > 0) delete rec[Object.keys(rec)[0]];
}

const ALL_LOADOUTS: Loadout[] = [];
for (const fcs of ['wide', 'medium', 'narrow'] as FcsId[]) {
  for (const generator of ['capacity', 'balanced', 'recovery'] as GeneratorId[]) {
    for (const legs of ['biped', 'quadruped'] as LegsId[]) ALL_LOADOUTS.push({ fcs, generator, legs });
  }
}

/**
 * A flat stage with the shipped stage's head count — 30 guards + 15 turrets, six of the turrets being
 * control turrets with one barrier each — so that the literal types `controlsRequired: 6` and
 * `totalEnemies: 45` can be checked strictly without depending on the factory stage. Control turret T01
 * stands 50 m in front of the mech; everything else is far outside every sight range.
 */
function headCountStage(): StageDef {
  const enemies: EnemyDef[] = [];
  for (let i = 0; i < 30; i++) enemies.push(makeGuard(`G${pad2(i + 1)}`, -145 + (i % 10) * 30, -230 - Math.floor(i / 10) * 20));
  for (let i = 0; i < 15; i++) {
    const def = i === 0 ? makeTurret('T01', 0, -50) : makeTurret(`T${pad2(i + 1)}`, -140 + i * 20, -330);
    if (i < 6) {
      def.isGateControl = true;
      def.barrierId = `B${i + 1}`;
    }
    enemies.push(def);
  }
  const barriers: BarrierDef[] = [];
  for (let i = 0; i < 6; i++) {
    barriers.push({
      id: `B${i + 1}`,
      name: `隔壁${i + 1}`,
      box: { min: v3(-200 + i * 10, 0, 150), max: v3(-195 + i * 10, 10, 151) },
      controlEnemyId: `T${pad2(i + 1)}`,
      fromSectorId: 'T00',
      toSectorId: 'T00',
    });
  }
  return { ...makeTestStage({ enemies }), barriers };
}

let factoryStage: StageDef | null = null;
let factoryNote = '';
try {
  const s = getFactoryStage();
  if (s.enemies.length === 45) factoryStage = s;
  else factoryNote = `src/stage/factory.ts currently places ${s.enemies.length} enemies (not the 45-enemy stage)`;
} catch (err) {
  factoryNote = `getFactoryStage() threw: ${String(err)}`;
}
if (!factoryStage) console.log(`[snapshot] factory-stage checks SKIPPED — ${factoryNote}`);

// ───────────────────────────── structure ─────────────────────────────

describe('structure: exactly the type of SPEC §10', () => {
  it('the §10 type block of docs/SPEC.md is parsed completely', () => {
    const block = extractTypeBlock(specText);
    // every character of the block is either white space or part of a recognised token
    expect(block.replace(TOKEN, '').trim()).toBe('');
    expect([...SPEC_TYPES.keys()]).toEqual(['Vec3', 'Weapon', 'SolutionStatus', 'Snapshot']);
    expect(SNAPSHOT_TYPE.k).toBe('object');
    const fields = (n: TNode | undefined): string[] => (n && n.k === 'object' ? n.fields.map((f) => f[0]) : []);
    const top = SNAPSHOT_TYPE.k === 'object' ? new Map(SNAPSHOT_TYPE.fields) : new Map<string, TNode>();
    expect(fields(SNAPSHOT_TYPE)).toEqual([
      'version',
      'seed',
      'state',
      'elapsedSeconds',
      'loadout',
      'player',
      'effectiveStats',
      'lock',
      'fireControl',
      'recentPlayerShots',
      'enemies',
      'objective',
      'stage',
    ]);
    expect(fields(top.get('fireControl')).length).toBe(12);
    const shots = top.get('recentPlayerShots');
    expect(shots && shots.k === 'array' ? fields(shots.item).length : 0).toBe(13);
    const enemies = top.get('enemies');
    expect(enemies && enemies.k === 'array' ? fields(enemies.item).length : 0).toBe(12);
    expect(fields(top.get('player'))).toEqual(['position', 'velocity', 'grounded', 'hp', 'en', 'weapon', 'ammo', 'movement']);
  });

  it('the structure check is not vacuous: every kind of deviation is reported', () => {
    const sim = mk([makeTarget('X', v3(0, EYE_Y, -40))]);
    sim.input.fire = true;
    run(sim, ticksOf(1.2), 'X');
    const good = buildSnapshot(sim, 'playing');
    expect(specErrors(good, false)).toEqual([]);
    expect(good.recentPlayerShots.length).toBeGreaterThan(0);
    const broken = (edit: (s: Record<string, any>) => void): number => {
      const s = JSON.parse(JSON.stringify(good)) as Record<string, any>;
      edit(s);
      return specErrors(s, false).length;
    };
    expect(broken((s) => delete s.seed)).toBeGreaterThan(0);
    expect(broken((s) => (s.extra = 1))).toBeGreaterThan(0);
    expect(broken((s) => (s.player.hp = Number.NaN))).toBeGreaterThan(0);
    expect(broken((s) => (s.player.en = Number.POSITIVE_INFINITY))).toBeGreaterThan(0);
    expect(broken((s) => (s.player.en = undefined))).toBeGreaterThan(0);
    expect(broken((s) => (s.player.position = [0, 0]))).toBeGreaterThan(0);
    expect(broken((s) => (s.player.position = { x: 0, y: 0, z: 0 }))).toBeGreaterThan(0);
    expect(broken((s) => (s.player.velocity[1] = null))).toBeGreaterThan(0);
    expect(broken((s) => (s.player.weapon = 'railgun'))).toBeGreaterThan(0);
    expect(broken((s) => (s.player.ammo.beam = 1))).toBeGreaterThan(0);
    expect(broken((s) => (s.player.movement.qbLastStartedAtSeconds = undefined))).toBeGreaterThan(0);
    expect(broken((s) => (s.lock.targetId = 7))).toBeGreaterThan(0);
    expect(broken((s) => (s.fireControl.status = 'locked'))).toBeGreaterThan(0);
    expect(broken((s) => (s.recentPlayerShots[0].initialVelocity = [1, 2, 3, 4]))).toBeGreaterThan(0);
    expect(broken((s) => delete s.recentPlayerShots[0].accelerationAtFire)).toBeGreaterThan(0);
    expect(broken((s) => (s.enemies[0].kind = 'drone'))).toBeGreaterThan(0);
    expect(broken((s) => (s.enemies[0].lastShotAtSeconds = Number.NaN))).toBeGreaterThan(0);
    expect(broken((s) => (s.objective.openBarrierIds = null))).toBeGreaterThan(0);
    expect(broken((s) => (s.stage.visitedSectorIds = [1]))).toBeGreaterThan(0);
    expect(broken((s) => (s.version = 'AK2-1.2'))).toBeGreaterThan(0);
    // key order is part of the comparison
    expect(broken((s) => {
      const { seed, ...rest } = s;
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, rest, { seed });
    })).toBeGreaterThan(0);
    // the literal counts are only enforced in strict mode (this stage has 1 enemy and no control turret)
    expect(specErrors(good, true).some((e) => e.includes('snapshot.objective.controlsRequired'))).toBe(true);
    expect(specErrors(good, true).some((e) => e.includes('snapshot.stage.totalEnemies'))).toBe(true);
  });

  it('a 30 guard + 15 turret stage with 6 control turrets satisfies the type literally (6 and 45 included)', () => {
    const sim = new Sim(headCountStage());
    for (const state of ['garage', 'playing', 'paused', 'cleared', 'failed'] as AppState[]) {
      const s = buildSnapshot(sim, state);
      expect(specErrors(s, true)).toEqual([]);
      expect(s.state).toBe(state);
    }
    const first = buildSnapshot(sim, 'playing');
    expect(first.enemies.length).toBe(45);
    expect(first.stage.totalEnemies).toBe(45);
    expect(first.objective).toEqual({ controlsDestroyed: 0, controlsRequired: 6, openBarrierIds: [], gateOpen: false });
    expect(first.enemies.filter((e) => e.kind === 'guard').length).toBe(30);
    expect(first.enemies.filter((e) => e.kind === 'turret').length).toBe(15);
    expect(first.enemies.filter((e) => e.isGateControl).map((e) => e.id)).toEqual(['T01', 'T02', 'T03', 'T04', 'T05', 'T06']);
    expect(new Set(first.enemies.map((e) => e.id)).size).toBe(45);

    // a real fight: missiles destroy the control turret T01, its barrier opens; every snapshot on the way conforms
    sim.input.weaponSelect = 'missile';
    sim.input.fire = true;
    const problems: string[] = [];
    run(sim, ticksOf(8), 'T01', () => {
      if (sim.enemyById.get('T01')!.alive || sim.projectiles.length > 0) {
        const e = specErrors(buildSnapshot(sim, 'playing'), true);
        if (e.length) problems.push(`t=${sim.time}: ${e.join('; ')}`);
      }
    });
    expect(problems).toEqual([]);
    const after = buildSnapshot(sim, 'playing');
    expect(specErrors(after, true)).toEqual([]);
    expect(after.objective).toEqual({ controlsDestroyed: 1, controlsRequired: 6, openBarrierIds: ['B1'], gateOpen: false });
    expect(after.enemies.length).toBe(45);
    expect(after.enemies[30]).toMatchObject({ id: 'T01', alive: false, hp: 0, isGateControl: true });
    expect(after.recentPlayerShots.length).toBeGreaterThanOrEqual(2);
    expect(after.recentPlayerShots.every((s) => s.weapon === 'missile' && s.targetId === 'T01')).toBe(true);
  });

  it.skipIf(!factoryStage)('the shipped factory stage: 45 enemies, 6 controls, real sector data — strict type at the start and in play', () => {
    const sim = new Sim(factoryStage as StageDef);
    const s0 = buildSnapshot(sim, 'garage', { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' });
    expect(specErrors(s0, true)).toEqual([]);
    const s = buildSnapshot(sim, 'playing');
    expect(specErrors(s, true)).toEqual([]);
    expect(s.enemies.length).toBe(45);
    expect(s.enemies.filter((e) => e.kind === 'guard').length).toBe(30);
    expect(s.enemies.filter((e) => e.kind === 'turret').length).toBe(15);
    expect(new Set(s.enemies.map((e) => e.id)).size).toBe(45);
    const controls = s.enemies.filter((e) => e.isGateControl);
    expect(controls.length).toBe(6);
    expect(controls.every((e) => e.kind === 'turret')).toBe(true);
    expect(s.objective).toEqual({ controlsDestroyed: 0, controlsRequired: 6, openBarrierIds: [], gateOpen: false });
    expect(s.stage.totalEnemies).toBe(45);
    expect(s.stage.sectorCount).toBe(sim.stage.sectors.length);
    expect(s.stage.sectorCount).toBeGreaterThanOrEqual(15);
    const sectorIds = new Set(sim.stage.sectors.map((x) => x.id));
    expect(s.stage.currentSectorId).not.toBeNull();
    expect(sectorIds.has(s.stage.currentSectorId as string)).toBe(true);
    expect(s.stage.visitedSectorIds).toEqual([s.stage.currentSectorId]);
    expect(s.enemies.every((e) => sectorIds.has(e.sectorId))).toBe(true);
    expect(s.enemies.every((e) => e.alive && e.shotsFired === 0 && e.lastShotAtSeconds === null)).toBe(true);
    expect(s.player.hp).toBe(1000);
    expect(s.player.en).toBe(120);

    // two seconds of play with every kind of input: still the exact type, ids and order unchanged
    sim.input.moveZ = 1;
    sim.input.fire = true;
    sim.input.qbPressed = true;
    const problems: string[] = [];
    run(sim, ticksOf(2), undefined, () => {
      const e = specErrors(buildSnapshot(sim, 'playing'), true);
      if (e.length) problems.push(`t=${sim.time}: ${e.join('; ')}`);
    });
    expect(problems).toEqual([]);
    const later = buildSnapshot(sim, 'paused');
    expect(later.enemies.map((e) => e.id)).toEqual(s.enemies.map((e) => e.id));
    expect(later.recentPlayerShots.length).toBeGreaterThan(0);
    expect(later.player.movement.qbSuccessfulCount).toBe(1);
    // a re-sortie hands out the same ids to the same enemies
    sim.reset();
    const again = buildSnapshot(sim, 'playing');
    expect(again.enemies).toEqual(s.enemies);
    expect(again.recentPlayerShots).toEqual([]);
  });
});

// ───────────────────────────── values ─────────────────────────────

describe('values are the raw simulation state', () => {
  it('a fresh sortie: version, seed, time 0, default loadout, null for every unused time', () => {
    const sim = mk([makeTurret('T1', 0, -300), makeGuard('G1', 20, -300)]);
    const s = buildSnapshot(sim, 'playing');
    expect(s.version).toBe('AK2-1.2-candidate');
    expect(s.seed).toBe(20260908);
    expect(DEFAULT_SEED).toBe(20260908);
    expect(s.state).toBe('playing');
    expect(s.elapsedSeconds).toBe(0);
    expect(s.loadout).toEqual({ fcs: 'medium', generator: 'balanced', legs: 'biped' });
    expect(s.effectiveStats).toEqual({ maxEn: 120, regenPerSecond: 15, lockSeconds: 0.8, horizontalSpeedMultiplier: 1 });
    expect(s.player).toEqual({
      position: [0, PLAYER.half.y + 0.001, 0],
      velocity: [0, 0, 0],
      grounded: true,
      hp: 1000,
      en: 120,
      weapon: 'machinegun',
      ammo: { machinegun: 300, missile: 12 },
      movement: {
        horizontalMode: 'walk',
        verticalMode: 'grounded',
        glideEnabled: false,
        desiredHorizontalDirection: [0, 0],
        qbSuccessfulCount: 0,
        qbLastStartedAtSeconds: null,
        qbImpulseRemainingSeconds: 0,
        qbCooldownRemainingSeconds: 0,
        lastEnSpentAtSeconds: null,
      },
    });
    // the beam has no ammunition entry
    expect(Object.keys(s.player.ammo)).toEqual(['machinegun', 'missile']);
    expect(s.lock).toEqual({ state: 'none', targetId: null, progress: 0, radiusCssPx: 0.2 * 720 });
    expect(s.fireControl).toEqual({
      status: 'inactive',
      weapon: 'machinegun',
      targetId: null,
      evaluatedAtSeconds: null,
      muzzlePosition: null,
      targetPosition: null,
      targetVelocity: null,
      launchDirection: null,
      predictedFlightSeconds: null,
      predictedInterceptPosition: null,
      aimPoint: null,
      residualMeters: null,
    });
    expect(s.recentPlayerShots).toEqual([]);
    expect(s.enemies).toEqual([
      {
        id: 'T1',
        kind: 'turret',
        isGateControl: false,
        sectorId: 'T00',
        position: [0, ENEMIES.turret.centerHeight, -300],
        velocity: [0, 0, 0],
        hp: 240,
        alive: true,
        alert: false,
        hasLineOfSight: false,
        shotsFired: 0,
        lastShotAtSeconds: null,
      },
      {
        id: 'G1',
        kind: 'guard',
        isGateControl: false,
        sectorId: 'T00',
        position: [20, ENEMIES.guard.centerHeight, -300],
        velocity: [0, 0, 0],
        hp: 120,
        alive: true,
        alert: false,
        hasLineOfSight: false,
        shotsFired: 0,
        lastShotAtSeconds: null,
      },
    ]);
    expect(s.objective).toEqual({ controlsDestroyed: 0, controlsRequired: 0, openBarrierIds: [], gateOpen: false });
    expect(s.stage).toEqual({ sectorCount: 1, currentSectorId: 'T00', visitedSectorIds: ['T00'], totalEnemies: 2 });
    expect(specErrors(s, false)).toEqual([]);
  });

  it('the seed is reported as the unsigned 32-bit value the sortie really uses', () => {
    expect(buildSnapshot(mk([], { seed: 4294967295 }), 'playing').seed).toBe(4294967295);
    expect(buildSnapshot(mk([], { seed: 0 }), 'playing').seed).toBe(0);
    expect(buildSnapshot(mk([], { seed: 12345 }), 'playing').seed).toBe(12345);
    const sim = mk([], { seed: 7 });
    sim.reset(undefined, 99);
    expect(buildSnapshot(sim, 'playing').seed).toBe(99);
    expect(sim.seed).toBe(99);
  });

  it('numbers are unrounded copies of the state the game uses (movement, EN, QB clocks, enemies)', () => {
    const sim = mk([makeGuard('G1', 6, -40), makeTurret('T1', -8, -60)]);
    sim.input.moveZ = 1;
    sim.input.moveX = 1;
    run(sim, 37);
    sim.input.qbPressed = true;
    run(sim, 7); // inside the 0.15 s impulse
    const p = sim.player;
    let s = buildSnapshot(sim, 'playing');
    expect(s.elapsedSeconds).toBe(sim.time);
    expect(s.elapsedSeconds).toBe(44 * TICK);
    expect(s.player.position).toEqual([p.pos.x, p.pos.y, p.pos.z]);
    expect(s.player.velocity).toEqual([p.vel.x, p.vel.y, p.vel.z]);
    expect(s.player.en).toBe(p.en);
    expect(s.player.en).toBe(120 - 36);
    expect(s.player.hp).toBe(p.hp);
    const m = s.player.movement;
    expect(m.horizontalMode).toBe('quickboost');
    expect(m.verticalMode).toBe('grounded');
    expect(m.qbSuccessfulCount).toBe(1);
    expect(m.qbLastStartedAtSeconds).toBe(37 * TICK);
    expect(m.lastEnSpentAtSeconds).toBe(37 * TICK);
    expect(m.qbImpulseRemainingSeconds).toBe(p.qbImpulseRemaining);
    expect(m.qbImpulseRemainingSeconds).toBeCloseTo(0.15 - 7 * TICK, 12);
    expect(m.qbCooldownRemainingSeconds).toBeCloseTo(1 - 7 * TICK, 12);
    expect(m.desiredHorizontalDirection).toEqual([p.desiredDir.x, p.desiredDir.z]);
    expect(Math.hypot(m.desiredHorizontalDirection[0], m.desiredHorizontalDirection[1])).toBeCloseTo(1, 12);
    expect(Math.hypot(s.player.velocity[0], s.player.velocity[2])).toBeCloseTo(80, 9);

    // after the impulse: the inertia phase is reported as glide, glide is on, the cooldown keeps running
    sim.input.moveZ = 0;
    sim.input.moveX = 0;
    run(sim, 30);
    s = buildSnapshot(sim, 'playing');
    expect(s.player.movement.horizontalMode).toBe('glide');
    expect(s.player.movement.glideEnabled).toBe(true);
    expect(s.player.movement.qbImpulseRemainingSeconds).toBe(0);
    expect(s.player.movement.qbCooldownRemainingSeconds).toBeCloseTo(1 - 37 * TICK, 12);
    expect(Math.hypot(s.player.velocity[0], s.player.velocity[2])).toBeGreaterThan(22);
    // brake: walk mode, no desired direction, the speed does not vanish at once
    sim.input.brake = true;
    run(sim, 2);
    s = buildSnapshot(sim, 'playing');
    expect(s.player.movement.horizontalMode).toBe('walk');
    expect(s.player.movement.glideEnabled).toBe(false);
    expect(s.player.movement.desiredHorizontalDirection).toEqual([0, 0]);
    expect(Math.hypot(s.player.velocity[0], s.player.velocity[2])).toBeGreaterThan(10);
    sim.input.brake = false;
    run(sim, ticksOf(1));
    s = buildSnapshot(sim, 'playing');
    expect(s.player.movement.qbCooldownRemainingSeconds).toBe(0);
    expect(s.player.movement.qbLastStartedAtSeconds).toBe(37 * TICK);

    // enemies: the fields are the live state; velocity is the actual velocity of the hit-volume centre
    run(sim, ticksOf(1.5));
    s = buildSnapshot(sim, 'playing');
    sim.enemies.forEach((e, k) => {
      const q = s.enemies[k];
      expect(q.id).toBe(e.id);
      expect(q.position).toEqual([e.pos.x, e.pos.y, e.pos.z]);
      expect(q.velocity).toEqual([e.vel.x, e.vel.y, e.vel.z]);
      expect(q.hp).toBe(e.hp);
      expect(q.alert).toBe(e.alert);
      expect(q.hasLineOfSight).toBe(e.hasLos);
      expect(q.shotsFired).toBe(e.shotsFired);
      expect(q.lastShotAtSeconds).toBe(e.lastShotAt);
    });
    const guard = s.enemies[0];
    const turret = s.enemies[1];
    expect(guard.alert && guard.hasLineOfSight && turret.alert && turret.hasLineOfSight).toBe(true);
    expect(guard.shotsFired).toBeGreaterThan(0);
    expect(turret.shotsFired).toBeGreaterThan(0);
    expect(typeof guard.lastShotAtSeconds).toBe('number');
    expect(turret.velocity).toEqual([0, 0, 0]);
    expect(Math.hypot(guard.velocity[0], guard.velocity[2])).toBeGreaterThan(1); // it is manoeuvring
    // shotsFired counts bullets that were really created
    const fired = sim.enemies.reduce((n, e) => n + e.shotsFired, 0);
    expect(fired).toBeGreaterThan(0);
    expect(s.player.hp).toBeLessThan(1000);
    expect(specErrors(s, false)).toEqual([]);
  });

  it('lock.progress runs 0 → 1 with the real lock time; radiusCssPx follows the viewport', () => {
    const sim = mk([makeTarget('X', v3(0, EYE_Y, -60))], { loadout: { fcs: 'wide', generator: 'balanced', legs: 'quadruped' } });
    // the target is on the crosshair from the first instant: the lock is judged at t = 0 and starts at progress 0
    expect(buildSnapshot(sim, 'playing').lock).toEqual({ state: 'acquiring', targetId: 'X', progress: 0, radiusCssPx: 0.3 * 720 });
    const seen: number[] = [];
    run(sim, ticksOf(0.8) + 2, undefined, () => {
      const l = buildSnapshot(sim, 'playing').lock;
      seen.push(l.progress);
      expect(l.progress).toBe(sim.lock.progress);
      expect(l.targetId).toBe('X');
      expect(l.state).toBe(l.progress < 1 ? 'acquiring' : 'locked');
    });
    for (let k = 1; k < seen.length; k++) expect(seen[k]).toBeGreaterThanOrEqual(seen[k - 1]);
    // wide FCS on four legs: 1.2 s / 1.5 = 0.8 s → complete 96 ticks after the sortie began (seen[k] = after tick k + 1)
    expect(seen[0]).toBeCloseTo(1 / ticksOf(0.8), 12);
    expect(seen[ticksOf(0.8) - 2]).toBeLessThan(1);
    expect(seen[ticksOf(0.8) - 1]).toBe(1);
    sim.setViewport(1920, 1000);
    expect(buildSnapshot(sim, 'playing').lock.radiusCssPx).toBeCloseTo(300, 9);
    sim.setViewport(600, 2000);
    expect(buildSnapshot(sim, 'playing').lock.radiusCssPx).toBeCloseTo(180, 9);
    // target gone from the circle: target and progress are dropped at once
    sim.applyLook(Math.PI / 2, 0);
    sim.tick();
    expect(buildSnapshot(sim, 'playing').lock).toEqual({ state: 'none', targetId: null, progress: 0, radiusCssPx: 180 });
  });
});

// ───────────────────────────── copy semantics ─────────────────────────────

/** A stage with one barrier and a control turret, plus targets, for snapshots with every array filled. */
function busyStage(): StageDef {
  const control = makeTurret('C1', 0, -45);
  control.isGateControl = true;
  control.barrierId = 'B1';
  const base = makeTestStage({
    enemies: [control, makeTarget('X', v3(6, EYE_Y, -50), v3(1, 0, 0), 0.5, 1e9), makeGuard('G1', -15, -70)],
  });
  return {
    ...base,
    barriers: [
      {
        id: 'B1',
        name: '隔壁',
        box: { min: v3(-30, 0, 120), max: v3(30, 12, 121) },
        controlEnemyId: 'C1',
        fromSectorId: 'T00',
        toSectorId: 'T00',
      },
    ],
  };
}

/** Brings a busyStage sim into a state where every part of the snapshot carries data. */
function makeBusy(sim: Sim): void {
  sim.input.weaponSelect = 'missile';
  sim.input.fire = true;
  run(sim, ticksOf(4.5), 'C1'); // two missiles destroy the control turret → barrier and gate open
  sim.input.weaponSelect = 'machinegun';
  sim.input.qbPressed = true;
  run(sim, ticksOf(1.5), 'X'); // lock X, machine-gun burst with a live solution
}

describe('copy semantics', () => {
  it('every call returns fresh objects; equal content while the simulation stands still', () => {
    const sim = new Sim(busyStage());
    makeBusy(sim);
    const a = buildSnapshot(sim, 'playing');
    const b = buildSnapshot(sim, 'playing');
    expect(a).toStrictEqual(b);
    expect(a.objective.openBarrierIds).toEqual(['B1']);
    expect(a.objective.gateOpen).toBe(true);
    expect(a.recentPlayerShots.length).toBeGreaterThan(5);
    expect(a.fireControl.status).toBe('solved');
    expect(a.enemies[0].alive).toBe(false);
    const refsA = collectRefs(a);
    const refsB = collectRefs(b);
    expect(refsA.size).toBeGreaterThan(50);
    for (const r of refsA) expect(refsB.has(r)).toBe(false);
    // nothing in a snapshot is an object of the simulation
    const simRefs = collectRefs({
      player: sim.player,
      lock: sim.lock,
      fireControl: sim.fireControl,
      shots: sim.shots,
      objective: sim.objective,
      visited: sim.visitedSectorIds,
      loadout: sim.loadout,
      stats: sim.stats,
      aim: sim.aim,
      enemies: sim.enemies.map((e) => [e.pos, e.vel, e.prevPos]),
    });
    for (const r of refsA) expect(simRefs.has(r)).toBe(false);
    // the garage loadout object handed in is not handed back
    const mine: Loadout = { fcs: 'wide', generator: 'capacity', legs: 'quadruped' };
    const g = buildSnapshot(sim, 'garage', mine);
    expect(g.loadout).toEqual(mine);
    expect(g.loadout).not.toBe(mine);
  });

  it('editing a returned snapshot in every possible place changes nothing in the game', () => {
    const sim = new Sim(busyStage());
    makeBusy(sim);
    const before = fingerprint(sim);
    const pristine = JSON.stringify(buildSnapshot(sim, 'playing'));
    const victim = buildSnapshot(sim, 'playing');
    vandalise(victim);
    expect(JSON.stringify(victim)).not.toBe(pristine);
    expect(fingerprint(sim)).toBe(before);
    expect(JSON.stringify(buildSnapshot(sim, 'playing'))).toBe(pristine);
    // … and the game goes on exactly as a game whose snapshot was never touched
    const twin = new Sim(busyStage());
    makeBusy(twin);
    sim.input.fire = true;
    twin.input.fire = true;
    run(sim, ticksOf(2), 'X');
    run(twin, ticksOf(2), 'X');
    expect(fingerprint(sim)).toBe(fingerprint(twin));
  });

  it('calling it does not change any simulation state (not even the random stream or the events)', () => {
    const script = (sim: Sim, k: number): void => {
      if (k === 0) sim.input.fire = true;
      if (k === 60) sim.input.weaponSelect = 'beam';
      if (k === 200) sim.input.weaponSelect = 'missile';
      if (k === 90) sim.input.qbPressed = true;
      if (k === 300) {
        sim.input.jump = true;
        sim.input.jumpPressed = true;
      }
      if (k === 420) sim.input.jump = false;
      sim.input.moveX = k % 240 < 120 ? 1 : -1;
    };
    const observed = new Sim(busyStage());
    const blind = new Sim(busyStage());
    const garage: Loadout = { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' };
    for (let k = 0; k < ticksOf(6); k++) {
      script(observed, k);
      script(blind, k);
      lookAt(observed, observed.enemyById.get(k < 500 ? 'C1' : 'X')!.pos);
      lookAt(blind, blind.enemyById.get(k < 500 ? 'C1' : 'X')!.pos);
      const f = k % 40 === 0 ? fingerprint(observed) : '';
      buildSnapshot(observed, 'playing');
      buildSnapshot(observed, 'paused');
      buildSnapshot(observed, 'garage', garage);
      if (f) expect(fingerprint(observed)).toBe(f);
      observed.tick();
      blind.tick();
    }
    expect(observed.enemies.some((e) => e.shotsFired > 0)).toBe(true); // the random stream was in use
    expect(observed.events.length).toBeGreaterThan(0);
    expect(fingerprint(observed)).toBe(fingerprint(blind));
    expect(observed.rng.next()).toBe(blind.rng.next());
    expect(observed.loadout).toEqual({ fcs: 'medium', generator: 'balanced', legs: 'biped' });
  });

  it('a snapshot is a value: it does not follow the simulation after it was taken', () => {
    const sim = new Sim(busyStage());
    const s = buildSnapshot(sim, 'playing');
    const frozen = JSON.stringify(s);
    makeBusy(sim);
    expect(JSON.stringify(s)).toBe(frozen);
    expect(s.objective.openBarrierIds).toEqual([]);
    expect(s.stage.visitedSectorIds).toEqual(['T00']);
    expect(buildSnapshot(sim, 'playing').objective.openBarrierIds).toEqual(['B1']);
  });
});

// ───────────────────────────── fire control ─────────────────────────────

const INACTIVE_NULLS = {
  targetId: null,
  evaluatedAtSeconds: null,
  muzzlePosition: null,
  targetPosition: null,
  targetVelocity: null,
  launchDirection: null,
  predictedFlightSeconds: null,
  predictedInterceptPosition: null,
  aimPoint: null,
  residualMeters: null,
};
const len3 = (a: readonly number[]): number => Math.hypot(a[0], a[1], a[2]);
const dist3 = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('fireControl: the solution the game really uses, with the nulling rules of §10', () => {
  it('inactive (no target / still acquiring): only status and weapon are set', () => {
    const empty = mk();
    for (const w of ['machinegun', 'beam', 'missile'] as Weapon[]) {
      empty.input.weaponSelect = w;
      empty.tick();
      expect(buildSnapshot(empty, 'playing').fireControl).toEqual({ status: 'inactive', weapon: w, ...INACTIVE_NULLS });
    }
    const sim = mk([makeTarget('X', v3(0, EYE_Y, -80), v3(3, 0, 0))]);
    run(sim, ticksOf(0.5), 'X');
    const s = buildSnapshot(sim, 'playing');
    expect(s.lock.state).toBe('acquiring');
    expect(s.lock.targetId).toBe('X');
    expect(s.lock.progress).toBeGreaterThan(0.5);
    expect(s.lock.progress).toBeLessThan(1);
    // the lock knows its target already, the fire control must not claim a correction before completion
    expect(s.fireControl).toEqual({ status: 'inactive', weapon: 'machinegun', ...INACTIVE_NULLS });
    // free fire while acquiring is recorded as an uncorrected shot
    sim.input.fire = true;
    run(sim, 2, 'X');
    const shot = buildSnapshot(sim, 'playing').recentPlayerShots[0];
    expect(shot.solutionStatus).toBe('inactive');
    expect(shot.targetId).toBeNull();
    expect(shot.targetPositionAtFire).toBeNull();
    expect(shot.targetVelocityAtFire).toBeNull();
    expect(shot.predictedFlightSeconds).toBeNull();
    expect(shot.predictedInterceptPosition).toBeNull();
  });

  it('solved: machine gun (lead + drop), beam (flight 0, residual 0), missile (45 m/s lead) — same target, same instant', () => {
    const sim = mk([makeTarget('X', v3(-6, EYE_Y + 4, -90), v3(8, 0, 2))]);
    run(sim, ticksOf(1), 'X');
    const target = sim.enemyById.get('X')!;
    const p = [target.pos.x, target.pos.y, target.pos.z];
    const m = [sim.player.muzzle.x, sim.player.muzzle.y, sim.player.muzzle.z];

    // machine gun
    let s = buildSnapshot(sim, 'playing');
    let fc = s.fireControl;
    expect(s.lock).toMatchObject({ state: 'locked', targetId: 'X', progress: 1 });
    expect(fc.status).toBe('solved');
    expect(fc.weapon).toBe('machinegun');
    expect(fc.targetId).toBe('X');
    expect(fc.evaluatedAtSeconds).toBe(sim.time);
    expect(fc.muzzlePosition).toEqual(m);
    expect(fc.targetPosition).toEqual(p);
    expect(fc.targetVelocity).toEqual([8, 0, 2]);
    const t = fc.predictedFlightSeconds as number;
    expect(t).toBeGreaterThan(0.8);
    expect(t).toBeLessThanOrEqual(MG.lifeSeconds);
    expect(fc.residualMeters as number).toBeLessThanOrEqual(0.01);
    expect(fc.residualMeters as number).toBeGreaterThanOrEqual(0);
    expect(len3(fc.launchDirection as number[])).toBeCloseTo(1, 12);
    // predicted hit point = p + v t; aim point = hit point + ½·18·t² straight up (it lies ABOVE the hit point)
    const hit = fc.predictedInterceptPosition as number[];
    expect(dist3(hit, [p[0] + 8 * t, p[1], p[2] + 2 * t])).toBeLessThan(1e-9);
    const aim = fc.aimPoint as number[];
    expect(dist3(aim, [hit[0], hit[1] + 9 * t * t, hit[2]])).toBeLessThan(1e-9);
    expect(aim[1]).toBeGreaterThan(hit[1] + 5);
    // the launch direction is the direction muzzle → aim point, and it reproduces the hit point to 0.01 m
    const d = fc.launchDirection as number[];
    const toAim = [aim[0] - m[0], aim[1] - m[1], aim[2] - m[2]];
    expect(dist3(d, toAim.map((c) => c / len3(toAim)))).toBeLessThan(1e-9);
    const bullet = [m[0] + 100 * d[0] * t, m[1] + 100 * d[1] * t - 9 * t * t, m[2] + 100 * d[2] * t];
    expect(dist3(bullet, hit)).toBeLessThanOrEqual(0.01);
    // it IS sim.fireControl, field by field
    const raw = sim.fireControl;
    expect(fc.predictedFlightSeconds).toBe(raw.flightSeconds);
    expect(fc.residualMeters).toBe(raw.residual);
    expect(fc.launchDirection).toEqual([raw.launchDir!.x, raw.launchDir!.y, raw.launchDir!.z]);
    expect(fc.aimPoint).toEqual([raw.aimPoint!.x, raw.aimPoint!.y, raw.aimPoint!.z]);
    console.log(`[snapshot] MG solution at ${len3([p[0] - m[0], p[1] - m[1], p[2] - m[2]]).toFixed(2)} m: t=${t.toFixed(6)} s, residual=${(fc.residualMeters as number).toExponential(2)} m`);

    // beam: the lock is untouched by the switch; the solution is for the same-time state
    sim.input.weaponSelect = 'beam';
    run(sim, 1, 'X');
    s = buildSnapshot(sim, 'playing');
    fc = s.fireControl;
    const pb = [target.pos.x, target.pos.y, target.pos.z];
    const mb = [sim.player.muzzle.x, sim.player.muzzle.y, sim.player.muzzle.z];
    expect(s.lock).toMatchObject({ state: 'locked', targetId: 'X', progress: 1 });
    expect(fc.status).toBe('solved');
    expect(fc.weapon).toBe('beam');
    expect(fc.targetId).toBe('X');
    expect(fc.evaluatedAtSeconds).toBe(sim.time);
    expect(fc.predictedFlightSeconds).toBe(0);
    expect(fc.residualMeters).toBe(0);
    expect(fc.targetPosition).toEqual(pb);
    expect(fc.predictedInterceptPosition).toEqual(pb); // the CURRENT position: no lead, no drop
    expect(fc.aimPoint).toEqual(pb);
    expect(fc.targetVelocity).toEqual([8, 0, 2]);
    const toP = [pb[0] - mb[0], pb[1] - mb[1], pb[2] - mb[2]];
    expect(dist3(fc.launchDirection as number[], toP.map((c) => c / len3(toP)))).toBeLessThan(1e-12);

    // missile
    sim.input.weaponSelect = 'missile';
    run(sim, 1, 'X');
    s = buildSnapshot(sim, 'playing');
    fc = s.fireControl;
    const pm = [target.pos.x, target.pos.y, target.pos.z];
    const mm = [sim.player.muzzle.x, sim.player.muzzle.y, sim.player.muzzle.z];
    expect(fc.status).toBe('solved');
    expect(fc.weapon).toBe('missile');
    const tm = fc.predictedFlightSeconds as number;
    expect(tm).toBeGreaterThan(0);
    expect(tm).toBeLessThanOrEqual(MSL.lifeSeconds);
    const lead = [pm[0] + 8 * tm, pm[1], pm[2] + 2 * tm];
    expect(dist3(fc.predictedInterceptPosition as number[], lead)).toBeLessThan(1e-9);
    expect(fc.aimPoint).toEqual(fc.predictedInterceptPosition); // no gravity term
    const toLead = [lead[0] - mm[0], lead[1] - mm[1], lead[2] - mm[2]];
    expect(dist3(fc.launchDirection as number[], toLead.map((c) => c / len3(toLead)))).toBeLessThan(1e-9);
    expect(Math.abs(len3(toLead) - 45 * tm)).toBeLessThan(1e-6); // 45 m/s reaches the lead point at tm
    expect(fc.residualMeters as number).toBeLessThan(1e-6);
    expect(specErrors(s, false)).toEqual([]);
  });

  it('no_solution: the lock stays, direct aim + aimPoint are given, time / hit point / residual are null', () => {
    // A target running away at 50 m/s: no 45 m/s missile can ever catch it; the 100 m/s bullet can while it is near.
    const sim = mk([makeTarget('X', v3(0, EYE_Y, -30), v3(0, 0, -50))]);
    run(sim, ticksOf(1), 'X');
    const target = sim.enemyById.get('X')!;
    let s = buildSnapshot(sim, 'playing');
    expect(s.lock).toMatchObject({ state: 'locked', targetId: 'X', progress: 1 });
    expect(s.fireControl.status).toBe('solved'); // machine gun at ~79 m: t ≈ 1.6 s
    expect(s.fireControl.predictedFlightSeconds as number).toBeGreaterThan(1.2); // beyond the ENEMY cap of 1.2 s: still valid
    expect(s.fireControl.predictedFlightSeconds as number).toBeLessThanOrEqual(2);

    sim.input.weaponSelect = 'missile';
    run(sim, 1, 'X');
    s = buildSnapshot(sim, 'playing');
    let fc = s.fireControl;
    const p = [target.pos.x, target.pos.y, target.pos.z];
    const m = [sim.player.muzzle.x, sim.player.muzzle.y, sim.player.muzzle.z];
    expect(s.lock).toMatchObject({ state: 'locked', targetId: 'X', progress: 1 }); // lock state ≠ solution state
    expect(fc.status).toBe('no_solution');
    expect(fc.weapon).toBe('missile');
    expect(fc.targetId).toBe('X');
    expect(fc.evaluatedAtSeconds).toBe(sim.time);
    expect(fc.muzzlePosition).toEqual(m);
    expect(fc.targetPosition).toEqual(p);
    expect(fc.targetVelocity).toEqual([0, 0, -50]);
    expect(fc.aimPoint).toEqual(p); // direct aim at the current position
    const toP = [p[0] - m[0], p[1] - m[1], p[2] - m[2]];
    expect(dist3(fc.launchDirection as number[], toP.map((c) => c / len3(toP)))).toBeLessThan(1e-12);
    expect(fc.predictedFlightSeconds).toBeNull();
    expect(fc.predictedInterceptPosition).toBeNull();
    expect(fc.residualMeters).toBeNull();
    expect(specErrors(s, false)).toEqual([]);

    // the missile still launches (lock + ammo are enough); its record says no_solution with null predictions
    sim.input.fire = true;
    run(sim, 1, 'X');
    sim.input.fire = false;
    s = buildSnapshot(sim, 'playing');
    expect(s.player.ammo.missile).toBe(11);
    const rec = s.recentPlayerShots[s.recentPlayerShots.length - 1];
    expect(rec).toMatchObject({ weapon: 'missile', targetId: 'X', solutionStatus: 'no_solution', predictedFlightSeconds: null, predictedInterceptPosition: null });
    expect(rec.targetVelocityAtFire).toEqual([0, 0, -50]);
    expect(len3(rec.initialVelocity as number[])).toBeCloseTo(45, 9);

    // machine gun once the target is past ~96 m: the 2 s life is not enough any more → no_solution, still locked
    sim.input.weaponSelect = 'machinegun';
    let sawSolved = false;
    let noSolutionAt: number | null = null;
    run(sim, ticksOf(0.7), 'X', () => {
      const q = buildSnapshot(sim, 'playing');
      if (q.lock.state !== 'locked') return;
      if (q.fireControl.status === 'solved') {
        sawSolved = true;
        expect(q.fireControl.predictedFlightSeconds as number).toBeLessThanOrEqual(2);
      } else if (noSolutionAt === null) {
        noSolutionAt = len3([q.fireControl.targetPosition![0] - q.fireControl.muzzlePosition![0], q.fireControl.targetPosition![1] - q.fireControl.muzzlePosition![1], q.fireControl.targetPosition![2] - q.fireControl.muzzlePosition![2]]);
        fc = q.fireControl;
      }
    });
    expect(sawSolved).toBe(true);
    expect(noSolutionAt).not.toBeNull();
    expect(noSolutionAt as unknown as number).toBeLessThanOrEqual(120);
    expect(fc.status).toBe('no_solution');
    expect(fc.weapon).toBe('machinegun');
    expect(fc.aimPoint).toEqual(fc.targetPosition);
    expect(fc.predictedFlightSeconds).toBeNull();
    expect(fc.predictedInterceptPosition).toBeNull();
    expect(fc.residualMeters).toBeNull();
    console.log(`[snapshot] MG no_solution first reported at a muzzle distance of ${(noSolutionAt as unknown as number).toFixed(2)} m (target receding at 50 m/s)`);
  });

  it('an expired target leaves no stale values: out of the circle, out of range, destroyed', () => {
    // out of the circle
    let sim = mk([makeTarget('X', v3(0, EYE_Y, -50))]);
    run(sim, ticksOf(1), 'X');
    expect(buildSnapshot(sim, 'playing').fireControl.status).toBe('solved');
    sim.applyLook(1.2, 0);
    sim.tick();
    let s = buildSnapshot(sim, 'playing');
    expect(s.lock).toMatchObject({ state: 'none', targetId: null, progress: 0 });
    expect(s.fireControl).toEqual({ status: 'inactive', weapon: 'machinegun', ...INACTIVE_NULLS });
    // back on it: the lock starts from zero again, the fire control stays inactive until it completes
    run(sim, ticksOf(0.4), 'X');
    s = buildSnapshot(sim, 'playing');
    expect(s.lock.state).toBe('acquiring');
    expect(s.lock.progress).toBeLessThan(0.55);
    expect(s.fireControl).toEqual({ status: 'inactive', weapon: 'machinegun', ...INACTIVE_NULLS });

    // out of range (120 m from the muzzle)
    sim = mk([makeTarget('X', v3(0, EYE_Y, -100), v3(0, 0, -10))]);
    const statuses: string[] = [];
    run(sim, ticksOf(2.6), 'X', () => {
      const q = buildSnapshot(sim, 'playing');
      statuses.push(`${q.lock.state}/${q.fireControl.status}`);
      if (q.lock.state !== 'locked') expect(q.fireControl).toEqual({ status: 'inactive', weapon: 'machinegun', ...INACTIVE_NULLS });
    });
    expect(statuses.includes('locked/solved')).toBe(true);
    expect(statuses[statuses.length - 1]).toBe('none/inactive');

    // destroyed by the shot itself (beam, 40 damage against 30 HP)
    sim = mk([makeTarget('X', v3(0, EYE_Y, -50), v3(), 0.5, 30)]);
    sim.input.weaponSelect = 'beam';
    run(sim, ticksOf(1), 'X');
    expect(buildSnapshot(sim, 'playing').fireControl.status).toBe('solved');
    sim.input.fire = true;
    run(sim, 1, 'X');
    s = buildSnapshot(sim, 'playing');
    expect(s.enemies[0]).toMatchObject({ id: 'X', alive: false, hp: 0 });
    expect(s.lock).toMatchObject({ state: 'none', targetId: null, progress: 0 });
    expect(s.fireControl).toEqual({ status: 'inactive', weapon: 'beam', ...INACTIVE_NULLS });
    // the record of that shot keeps the solution it was fired with
    expect(s.recentPlayerShots[0]).toMatchObject({ weapon: 'beam', targetId: 'X', solutionStatus: 'solved', predictedFlightSeconds: 0, initialVelocity: null });
  });

  it('status is about the solution, not about obstacles: a beam over the parabola does not change it', () => {
    // A low beam 30 m ahead, above the straight line to the target but inside the bullet's arc.
    const sim = mk([makeTarget('X', v3(0, 3.5, -110))], {
      solids: [{ min: v3(-4, 4.4, -62), max: v3(4, 9, -58), material: 'metal', tag: 'low beam' }],
    });
    run(sim, ticksOf(1), 'X');
    const s = buildSnapshot(sim, 'playing');
    expect(s.lock.state).toBe('locked'); // the straight line to the current centre is free
    expect(s.fireControl.status).toBe('solved');
    const before = sim.enemyById.get('X')!.hp;
    sim.input.fire = true;
    run(sim, 2, 'X');
    sim.input.fire = false;
    const events: string[] = [];
    run(sim, ticksOf(1.6), 'X', () => {
      for (const e of sim.drainEvents()) if (e.type === 'projectile-hit') events.push(e.target);
    });
    expect(events).toEqual(['world']); // the compensated arc ends in the obstacle …
    expect(sim.enemyById.get('X')!.hp).toBe(before);
    expect(buildSnapshot(sim, 'playing').fireControl.status).toBe('solved'); // … and the status never claimed otherwise
  });
});

// ───────────────────────────── shot records ─────────────────────────────

describe('recentPlayerShots', () => {
  it('one record per real shot with the values of the instant of fire; later events never change it', () => {
    const sim = mk([makeTarget('X', v3(-10, EYE_Y + 2, -70), v3(6, 1, 0)), makeTarget('Y', v3(40, EYE_Y, -60))]);
    run(sim, ticksOf(1), 'X');
    const target = sim.enemyById.get('X')!;
    sim.input.fire = true;
    lookAt(sim, target.pos);
    sim.tick();
    sim.input.fire = false;
    const fireTime = sim.time;
    const pAtFire = [target.pos.x, target.pos.y, target.pos.z];
    const mAtFire = [sim.player.muzzle.x, sim.player.muzzle.y, sim.player.muzzle.z];
    const bullet = sim.projectiles[sim.projectiles.length - 1];
    let s = buildSnapshot(sim, 'playing');
    expect(s.recentPlayerShots.length).toBe(1);
    const rec = s.recentPlayerShots[0];
    expect(rec.id).toBe(1);
    expect(rec.firedAtSeconds).toBe(fireTime);
    expect(rec.weapon).toBe('machinegun');
    expect(rec.targetId).toBe('X');
    expect(rec.solutionStatus).toBe('solved');
    expect(rec.muzzlePosition).toEqual(mAtFire);
    expect(rec.targetPositionAtFire).toEqual(pAtFire);
    expect(rec.targetVelocityAtFire).toEqual([6, 1, 0]);
    expect(rec.accelerationAtFire).toEqual([0, -18, 0]);
    // initialVelocity is what the projectile really got: exactly 100 m/s along the recorded direction
    expect(rec.initialVelocity).toEqual([bullet.v0.x, bullet.v0.y, bullet.v0.z]);
    expect(Math.abs(len3(rec.initialVelocity as number[]) - 100)).toBeLessThanOrEqual(0.001);
    expect(dist3(rec.initialVelocity as number[], rec.launchDirection.map((c) => c * 100))).toBeLessThan(1e-9);
    expect([bullet.origin.x, bullet.origin.y, bullet.origin.z]).toEqual(rec.muzzlePosition);
    // it is the solution the fire control showed at that very instant
    expect(s.fireControl.evaluatedAtSeconds).toBe(fireTime);
    expect(rec.launchDirection).toEqual(s.fireControl.launchDirection);
    expect(rec.predictedFlightSeconds).toBe(s.fireControl.predictedFlightSeconds);
    expect(rec.predictedInterceptPosition).toEqual(s.fireControl.predictedInterceptPosition);
    const frozen = JSON.stringify(rec);

    // later: the target moves on, the weapon changes, more shots, the lock is lost, another target is locked
    sim.input.weaponSelect = 'beam';
    sim.input.fire = true;
    run(sim, ticksOf(0.6), 'X');
    sim.input.weaponSelect = 'missile';
    run(sim, ticksOf(1.2), 'X');
    sim.input.fire = false;
    run(sim, ticksOf(1.5), 'Y');
    sim.input.weaponSelect = 'machinegun';
    sim.input.fire = true;
    run(sim, ticksOf(0.35), 'Y');
    sim.input.fire = false;
    s = buildSnapshot(sim, 'playing');
    expect(JSON.stringify(s.recentPlayerShots[0])).toBe(frozen);
    expect(s.recentPlayerShots.map((r) => r.id)).toEqual(s.recentPlayerShots.map((_, k) => k + 1));
    const byWeapon = (w: Weapon) => s.recentPlayerShots.filter((r) => r.weapon === w);
    expect(byWeapon('beam').length).toBe(3);
    expect(byWeapon('missile').length).toBe(2);
    expect(byWeapon('machinegun').length).toBe(1 + 4);
    for (const r of byWeapon('beam')) {
      expect(r.initialVelocity).toBeNull();
      expect(r.accelerationAtFire).toEqual([0, 0, 0]);
      expect(r.solutionStatus).toBe('solved');
      expect(r.predictedFlightSeconds).toBe(0);
      expect(r.predictedInterceptPosition).toEqual(r.targetPositionAtFire);
    }
    for (const r of byWeapon('missile')) {
      expect(r.accelerationAtFire).toEqual([0, 0, 0]);
      expect(len3(r.initialVelocity as number[])).toBeCloseTo(45, 9);
      expect(dist3(r.initialVelocity as number[], r.launchDirection.map((c) => c * 45))).toBeLessThan(1e-9);
      expect(r.targetId).toBe('X');
      expect(r.solutionStatus).toBe('solved');
      // the predicted time is the straight-line lead solution: |intercept − muzzle| = 45 · t
      expect(Math.abs(dist3(r.predictedInterceptPosition as number[], r.muzzlePosition) - 45 * (r.predictedFlightSeconds as number))).toBeLessThan(1e-6);
    }
    expect(byWeapon('machinegun').slice(1).every((r) => r.targetId === 'Y' && r.solutionStatus === 'solved')).toBe(true);
    for (let k = 1; k < s.recentPlayerShots.length; k++) {
      expect(s.recentPlayerShots[k].firedAtSeconds).toBeGreaterThanOrEqual(s.recentPlayerShots[k - 1].firedAtSeconds);
    }
    expect(specErrors(s, false)).toEqual([]);
  });

  it('refused shots add nothing; free fire is recorded as inactive with null target and predictions', () => {
    const sim = mk([makeTarget('X', v3(0, EYE_Y, -50))]);
    // missile without a lock (looking away), beam without EN, machine gun without ammunition
    sim.applyLook(Math.PI / 2, 0);
    sim.input.fire = true;
    sim.input.weaponSelect = 'missile';
    run(sim, ticksOf(0.5));
    sim.player.en = 7.99;
    sim.player.lastEnSpentAt = sim.time; // keeps the regeneration away for this check
    sim.input.weaponSelect = 'beam';
    run(sim, ticksOf(0.5));
    sim.player.ammo.machinegun = 0;
    sim.input.weaponSelect = 'machinegun';
    run(sim, ticksOf(0.5));
    let s = buildSnapshot(sim, 'playing');
    expect(s.recentPlayerShots).toEqual([]);
    expect(s.player.ammo).toEqual({ machinegun: 0, missile: 12 });
    expect(sim.nextShotId).toBe(1);

    // free fire (no lock): beam and machine gun
    sim.player.en = 120;
    sim.player.ammo.machinegun = 5;
    sim.input.weaponSelect = 'beam';
    run(sim, 2);
    sim.input.weaponSelect = 'machinegun';
    run(sim, 2);
    sim.input.fire = false;
    s = buildSnapshot(sim, 'playing');
    expect(s.recentPlayerShots.map((r) => r.weapon)).toEqual(['beam', 'machinegun']);
    for (const r of s.recentPlayerShots) {
      expect(r.solutionStatus).toBe('inactive');
      expect(r.targetId).toBeNull();
      expect(r.targetPositionAtFire).toBeNull();
      expect(r.targetVelocityAtFire).toBeNull();
      expect(r.predictedFlightSeconds).toBeNull();
      expect(r.predictedInterceptPosition).toBeNull();
      expect(len3(r.launchDirection)).toBeCloseTo(1, 12);
    }
    expect(s.recentPlayerShots[0].initialVelocity).toBeNull();
    expect(s.recentPlayerShots[0].accelerationAtFire).toEqual([0, 0, 0]);
    expect(len3(s.recentPlayerShots[1].initialVelocity as number[])).toBeCloseTo(100, 9);
    expect(s.recentPlayerShots[1].accelerationAtFire).toEqual([0, -18, 0]);
  });

  it(`keeps the newest ${RECENT_SHOTS_MAX}, oldest first, ids keep counting; a re-sortie empties the list and restarts at 1`, () => {
    expect(RECENT_SHOTS_MAX).toBe(32);
    const sim = mk([makeTarget('X', v3(0, EYE_Y, -50))]);
    sim.input.fire = true;
    const seen = new Map<number, string>();
    let changed = 0;
    run(sim, ticksOf(5), 'X', () => {
      const shots = buildSnapshot(sim, 'playing').recentPlayerShots;
      expect(shots.length).toBeLessThanOrEqual(32);
      for (const r of shots) {
        const json = JSON.stringify(r);
        const old = seen.get(r.id);
        if (old !== undefined && old !== json) changed++;
        seen.set(r.id, json);
      }
    });
    sim.input.fire = false;
    expect(changed).toBe(0);
    const s = buildSnapshot(sim, 'playing');
    const total = 300 - s.player.ammo.machinegun;
    expect(total).toBe(50); // the first at t = 1/120 (end of the first tick), then exactly every 0.1 s until 5.0 s
    expect(s.recentPlayerShots.length).toBe(32);
    expect(s.recentPlayerShots.map((r) => r.id)).toEqual(Array.from({ length: 32 }, (_, k) => total - 31 + k));
    expect(s.recentPlayerShots[0].firedAtSeconds).toBeLessThan(s.recentPlayerShots[31].firedAtSeconds);
    // free-fire shots first, FCS-corrected ones once the lock (0.8 s) was complete
    expect(seen.size).toBe(total);
    expect(JSON.parse(seen.get(1) as string).solutionStatus).toBe('inactive');
    expect(s.recentPlayerShots.every((r) => r.solutionStatus === 'solved')).toBe(true);

    sim.reset();
    let again = buildSnapshot(sim, 'playing');
    expect(again.recentPlayerShots).toEqual([]);
    sim.input.fire = true;
    run(sim, 2, 'X');
    again = buildSnapshot(sim, 'playing');
    expect(again.recentPlayerShots.map((r) => r.id)).toEqual([1]);
    expect(JSON.stringify(again.recentPlayerShots[0])).toBe(seen.get(1));
  });
});

// ───────────────────────────── enemies ─────────────────────────────

describe('enemies', () => {
  it('destroyed enemies stay in the list with alive = false; ids and order never change; a re-sortie revives them under the same ids', () => {
    const sim = mk([
      makeTarget('A', v3(0, EYE_Y, -40), v3(), 0.5, 30),
      makeGuard('G1', 12, -60),
      makeTarget('B', v3(-20, EYE_Y, -45), v3(1, 0, 0), 0.5, 1e9),
      makeTurret('T1', -10, -300), // out of its 120 m range: it never joins the fight
    ]);
    const ids = ['A', 'G1', 'B', 'T1'];
    const first = buildSnapshot(sim, 'playing');
    expect(first.enemies.map((e) => e.id)).toEqual(ids);

    sim.input.fire = true;
    const problems: string[] = [];
    const check = (): void => {
      const s = buildSnapshot(sim, 'playing');
      if (s.enemies.map((e) => e.id).join() !== ids.join()) problems.push(`ids changed at t=${sim.time}`);
      for (const e of s.enemies) {
        if (!e.alive && (e.hp !== 0 || e.hasLineOfSight || e.alert || len3(e.velocity) !== 0)) problems.push(`dead ${e.id} not inert at t=${sim.time}`);
      }
    };
    // lock (0.8 s), then three corrected machine-gun hits destroy A (30 HP)
    run(sim, ticksOf(2), 'A', check);
    expect(sim.enemyById.get('A')!.alive).toBe(false);
    // the guard (120 HP) needs ten hits while it manoeuvres and shoots back
    for (let k = 0; k < ticksOf(12) && sim.enemyById.get('G1')!.alive; k++) run(sim, 1, 'G1', check);
    expect(sim.enemyById.get('G1')!.alive).toBe(false);
    expect(sim.status).toBe('playing');
    sim.input.fire = false;
    run(sim, ticksOf(1), 'B', check);
    expect(problems).toEqual([]);

    const s = buildSnapshot(sim, 'playing');
    expect(s.enemies.length).toBe(4);
    expect(s.stage.totalEnemies).toBe(4);
    expect(s.enemies[0]).toMatchObject({ id: 'A', kind: 'turret', alive: false, hp: 0, velocity: [0, 0, 0] });
    expect(s.enemies[1]).toMatchObject({ id: 'G1', kind: 'guard', alive: false, hp: 0, velocity: [0, 0, 0], alert: false, hasLineOfSight: false });
    // what the dead guard did while it lived is still reported
    expect(s.enemies[1].shotsFired).toBe(sim.enemies[1].shotsFired);
    expect(s.enemies[1].shotsFired).toBeGreaterThan(0);
    expect(typeof s.enemies[1].lastShotAtSeconds).toBe('number');
    expect(s.enemies[2]).toMatchObject({ id: 'B', alive: true, hp: 1e9, velocity: [1, 0, 0] });
    expect(s.enemies[3]).toMatchObject({ id: 'T1', kind: 'turret', alive: true, hp: 240, shotsFired: 0, lastShotAtSeconds: null });
    // a dead enemy's position stays where it died
    const deadPos = JSON.stringify(s.enemies[1].position);
    run(sim, ticksOf(1), 'B');
    expect(JSON.stringify(buildSnapshot(sim, 'playing').enemies[1].position)).toBe(deadPos);

    sim.reset();
    const again = buildSnapshot(sim, 'playing');
    expect(again.enemies).toEqual(first.enemies);
    expect(again.enemies.every((e) => e.alive)).toBe(true);
  });
});

// ───────────────────────────── garage ─────────────────────────────

describe('garage state', () => {
  it('reports the loadout selected in the garage and its effective stats for all 18 combinations', () => {
    const sim = mk();
    const untouched = fingerprint(sim);
    expect(ALL_LOADOUTS.length).toBe(18);
    const table: string[] = [];
    for (const lo of ALL_LOADOUTS) {
      const s = buildSnapshot(sim, 'garage', lo);
      expect(s.state).toBe('garage');
      expect(s.loadout).toEqual(lo);
      const maxEn = { capacity: 180, balanced: 120, recovery: 90 }[lo.generator];
      const regen = { capacity: 10, balanced: 15, recovery: 20 }[lo.generator] * (lo.legs === 'quadruped' ? 0.75 : 1);
      const lockSeconds = { wide: 1.2, medium: 0.8, narrow: 0.4 }[lo.fcs] / (lo.legs === 'quadruped' ? 1.5 : 1);
      expect(s.effectiveStats.maxEn).toBe(maxEn);
      expect(s.effectiveStats.regenPerSecond).toBeCloseTo(regen, 12);
      expect(s.effectiveStats.lockSeconds).toBeCloseTo(lockSeconds, 12);
      expect(s.effectiveStats.horizontalSpeedMultiplier).toBe(lo.legs === 'quadruped' ? 0.8 : 1);
      expect(Object.keys(s.effectiveStats)).toEqual(['maxEn', 'regenPerSecond', 'lockSeconds', 'horizontalSpeedMultiplier']);
      // the same function the simulation uses on the sortie
      const eff = computeEffectiveStats(lo);
      expect(s.effectiveStats).toEqual({
        maxEn: eff.maxEn,
        regenPerSecond: eff.regenPerSecond,
        lockSeconds: eff.lockSeconds,
        horizontalSpeedMultiplier: eff.horizontalSpeedMultiplier,
      });
      // the lock circle that loadout will have on this viewport: 0.30 / 0.20 / 0.10 × min(1280, 720)
      expect(s.lock.radiusCssPx).toBeCloseTo(FCS_PARTS[lo.fcs].radiusFactor * 720, 9);
      expect(s.lock.radiusCssPx).toBeCloseTo({ wide: 216, medium: 144, narrow: 72 }[lo.fcs], 9);
      expect(specErrors(s, false)).toEqual([]);
      table.push(`${lo.fcs}/${lo.generator}/${lo.legs}: ${s.effectiveStats.maxEn}, ${s.effectiveStats.regenPerSecond}, ${s.effectiveStats.lockSeconds.toFixed(4)}, ${s.effectiveStats.horizontalSpeedMultiplier}`);
    }
    console.log(`[snapshot] garage effectiveStats (maxEn, regen/s, lock s, speed ×):\n  ${table.join('\n  ')}`);
    // SPEC §6 example: medium FCS + balanced generator + four legs
    const ex = buildSnapshot(sim, 'garage', { fcs: 'medium', generator: 'balanced', legs: 'quadruped' }).effectiveStats;
    expect(ex.maxEn).toBe(120);
    expect(ex.regenPerSecond).toBe(11.25);
    expect(ex.lockSeconds).toBeCloseTo(0.5333333333, 9);
    expect(ex.horizontalSpeedMultiplier).toBe(0.8);
    // looking at the garage never touches the simulation (its loadout stays that of the last sortie)
    expect(fingerprint(sim)).toBe(untouched);
    expect(sim.loadout).toEqual({ fcs: 'medium', generator: 'balanced', legs: 'biped' });
  });

  it('without a garage loadout, and in every other app state, the sortie loadout is reported', () => {
    const lo: Loadout = { fcs: 'narrow', generator: 'capacity', legs: 'quadruped' };
    const other: Loadout = { fcs: 'wide', generator: 'recovery', legs: 'biped' };
    const sim = mk([], { loadout: lo });
    const g = buildSnapshot(sim, 'garage');
    expect(g.state).toBe('garage');
    expect(g.loadout).toEqual(lo);
    expect(g.effectiveStats).toEqual({ maxEn: 180, regenPerSecond: 7.5, lockSeconds: 0.4 / 1.5, horizontalSpeedMultiplier: 0.8 });
    expect(g.lock.radiusCssPx).toBeCloseTo(72, 9);
    for (const state of ['playing', 'paused', 'cleared', 'failed'] as AppState[]) {
      const s = buildSnapshot(sim, state, other); // a stray garage selection must not leak into a sortie
      expect(s.state).toBe(state);
      expect(s.loadout).toEqual(lo);
      expect(s.effectiveStats).toEqual(g.effectiveStats);
      expect(s.lock.radiusCssPx).toBeCloseTo(72, 9);
      expect(s.player.en).toBe(180);
    }
    // sortie with the garage selection: the snapshot now shows it as the real thing, EN at its maximum
    sim.reset(other);
    const s = buildSnapshot(sim, 'playing');
    expect(s.loadout).toEqual(other);
    expect(s.effectiveStats).toEqual({ maxEn: 90, regenPerSecond: 20, lockSeconds: 1.2, horizontalSpeedMultiplier: 1 });
    expect(s.player.en).toBe(90);
    expect(s.lock.radiusCssPx).toBeCloseTo(216, 9);
    expect(buildSnapshot(sim, 'garage', other)).toEqual({ ...s, state: 'garage' });
  });
});

// ───────────────────────────── fuzz ─────────────────────────────

/**
 * A 200 m × 200 m slab (walking off it is an unrecoverable fall) with real guards and turrets all around
 * the start, cover, a raised platform and passive targets of every kind.
 */
function fuzzStage(): StageDef {
  const enemies: EnemyDef[] = [
    makeGuard('G01', -30, -40),
    makeGuard('G02', 32, -45),
    makeGuard('G03', -25, 42),
    makeGuard('G04', 36, 30),
    makeTurret('T01', -60, -60),
    makeTurret('T02', 0, -75),
    makeTurret('T03', 60, 55),
    makeTarget('P01', v3(-12, 7, -40), v3(2, 0, 0), 0.5, 400), // slow mover
    // out-runs every missile. It starts on the crosshair of the fresh sortie: the lock is judged at t = 0, before
    // the first look input, and the target picked there is kept (sticky) — so the prologue below gets this one
    makeTarget('P02', v3(0, EYE_Y, -26), v3(0, 0, -50), 0.5, 1e9),
    makeTarget('P03', v3(16, 4, -30), v3(), 0.5, 60), // dies quickly
    makeTarget('P04', v3(-20, 9, -60), v3(3, 1, 2), 0.5, 1e9),
  ];
  const solids: SolidDef[] = [
    { min: v3(-22, 0, -30), max: v3(-12, 6, -28), material: 'concrete' },
    { min: v3(10, 0, -24), max: v3(18, 5, -22), material: 'container' },
    { min: v3(-3, 0, 12), max: v3(3, 3, 14), material: 'machine' },
    { min: v3(-40, 8, -20), max: v3(-20, 9, 0), material: 'catwalk' },
  ];
  return makeTestStage({ floorSize: 200, enemies, solids });
}

describe('fuzz: 60 s of random play, a snapshot after every tick', () => {
  it('is always the exact §10 structure, JSON-clean, and consistent with the semantic rules', () => {
    const sim = new Sim(fuzzStage(), { loadout: ALL_LOADOUTS[0], seed: 4242 });
    const rnd = new Rng(987654321);
    const weapons: Weapon[] = ['machinegun', 'beam', 'missile'];
    const problems: string[] = [];
    const note = (msg: string): void => {
      if (problems.length < 25) problems.push(`sortie ${sortie} t=${sim.time.toFixed(4)}: ${msg}`);
    };
    const cover = {
      sorties: 1,
      failed: 0,
      fell: 0,
      status: {} as Record<string, number>,
      shots: { machinegun: 0, beam: 0, missile: 0 } as Record<Weapon, number>,
      shotStatus: {} as Record<string, number>,
      kills: 0,
      qb: 0,
      flyingTicks: 0,
      glideTicks: 0,
      airborneTicks: 0,
      lockedTicks: 0,
      enemyShots: 0,
      roundTrips: 0,
      maxShots: 0,
    };
    let sortie = 1;
    let trackId: string | null = null;
    let trackUntil = 0;
    let shotJson = new Map<number, string>();
    let lastShotId = 0;
    let prev: Snapshot | null = null;
    const enemyIds = sim.enemies.map((e) => e.id).join();
    const total = ticksOf(60);

    let sortieStart = 0;
    let jumpUntil = -1;
    for (let k = 0; k < total; k++) {
      // ── random input ──
      const age = k - sortieStart;
      if (age === 0) {
        // prologue of every sortie: missiles at the target that out-runs them (it is gone after two seconds)
        sim.input.weaponSelect = 'missile';
        sim.input.fire = true;
        trackId = 'P02';
        trackUntil = k + ticksOf(1.7);
      }
      // every third sortie the pilot stands still and only shoots: the enemies end it quickly ('failed' snapshots)
      const sitting = sortie % 3 === 0;
      if (k % 6 === 0) {
        const r = sitting ? 0.33 + 0.67 * rnd.next() : rnd.next();
        if (r < 0.18) {
          sim.input.moveX = rnd.int(3) - 1;
          sim.input.moveZ = rnd.int(3) - 1;
        } else if (r < 0.23) sim.input.qbPressed = true;
        else if (r < 0.26) sim.input.glideTogglePressed = true;
        else if (r < 0.31) {
          if (!sim.input.jump) {
            sim.input.jump = true;
            sim.input.jumpPressed = true;
            jumpUntil = k + 6 + rnd.int(rnd.next() < 0.5 ? 20 : 200);
          }
        } else if (r < 0.33) sim.input.brake = !sim.input.brake;
        else if (r < 0.39 && age > ticksOf(1.7)) sim.input.weaponSelect = weapons[rnd.int(3)];
        else if (r < 0.45 && age > ticksOf(1.7)) sim.input.fire = rnd.next() < 0.8;
        if (sim.input.brake && rnd.next() < 0.3) sim.input.brake = false;
        // far from the middle of the slab: usually head back (camera-relative keys for a world direction)
        const pp = sim.player.pos;
        if (!sitting && Math.hypot(pp.x, pp.z) > 55 && rnd.next() < 0.7) {
          const yaw = sim.player.yaw;
          const fwd = pp.x * Math.sin(yaw) + pp.z * Math.cos(yaw); // (−pos) · forward
          const right = -pp.x * Math.cos(yaw) + pp.z * Math.sin(yaw); // (−pos) · right
          sim.input.moveZ = Math.abs(fwd) > 5 ? Math.sign(fwd) : 0;
          sim.input.moveX = Math.abs(right) > 5 ? Math.sign(right) : 0;
          sim.input.brake = false;
        }
      }
      if (sim.input.jump && k >= jumpUntil) sim.input.jump = false;
      if (k >= trackUntil) {
        const alive = sim.enemies.filter((e) => e.alive);
        trackId = alive.length > 0 && rnd.next() < 0.8 ? alive[rnd.int(alive.length)].id : null;
        trackUntil = k + 60 + rnd.int(300);
      }
      const tracked = trackId ? sim.enemyById.get(trackId) : undefined;
      if (tracked && tracked.alive) lookAt(sim, tracked.pos);
      else sim.applyLook(rnd.range(-0.03, 0.03), rnd.range(-0.012, 0.012));

      sim.tick();

      // ── the snapshot of this tick ──
      const state: AppState = sim.status;
      const s = buildSnapshot(sim, state);
      const errs = specErrors(s, false);
      if (errs.length) note(errs.slice(0, 3).join('; '));
      if (k % 25 === 0 || state !== 'playing') {
        // loss-free through JSON: nothing undefined, non-finite or non-plain anywhere
        const back = JSON.parse(JSON.stringify(s)) as Snapshot;
        try {
          expect(back).toStrictEqual(s);
        } catch {
          note('JSON round trip changed the snapshot');
        }
        cover.roundTrips++;
      }
      const P = s.player;
      const M = P.movement;
      const eff = s.effectiveStats;
      if (s.elapsedSeconds !== sim.time) note('elapsedSeconds is not sim.time');
      if (P.hp < 0 || P.hp > 1000) note(`hp ${P.hp}`);
      if (P.en < 0 || P.en > eff.maxEn) note(`en ${P.en} of ${eff.maxEn}`);
      if (!Number.isInteger(P.ammo.machinegun) || P.ammo.machinegun < 0 || P.ammo.machinegun > 300) note(`mg ammo ${P.ammo.machinegun}`);
      if (!Number.isInteger(P.ammo.missile) || P.ammo.missile < 0 || P.ammo.missile > 12) note(`missile ammo ${P.ammo.missile}`);
      if ((M.verticalMode === 'grounded') !== P.grounded) note('verticalMode / grounded disagree');
      if ((M.horizontalMode === 'quickboost') !== M.qbImpulseRemainingSeconds > 0) note('quickboost mode / impulse clock disagree');
      if (M.qbImpulseRemainingSeconds < 0 || M.qbImpulseRemainingSeconds > 0.15 + 1e-12) note(`impulse ${M.qbImpulseRemainingSeconds}`);
      if (M.horizontalMode === 'glide' && !M.glideEnabled) note('glide mode without glideEnabled');
      const dirLen = Math.hypot(M.desiredHorizontalDirection[0], M.desiredHorizontalDirection[1]);
      if (dirLen !== 0 && Math.abs(dirLen - 1) > 1e-9) note(`desired direction length ${dirLen}`);
      const cd = M.qbLastStartedAtSeconds === null ? 0 : Math.max(0, 1 - (s.elapsedSeconds - M.qbLastStartedAtSeconds));
      if (Math.abs(M.qbCooldownRemainingSeconds - cd) > 2e-9) note(`cooldown ${M.qbCooldownRemainingSeconds} vs ${cd}`);
      if ((M.qbLastStartedAtSeconds === null) !== (M.qbSuccessfulCount === 0)) note('qb count / start time disagree');
      if (M.lastEnSpentAtSeconds !== null && M.lastEnSpentAtSeconds > s.elapsedSeconds + 1e-9) note('lastEnSpentAt in the future');

      // lock ↔ fire control
      const L = s.lock;
      const F = s.fireControl;
      if (L.progress < 0 || L.progress > 1) note(`progress ${L.progress}`);
      if (L.state === 'none' && (L.targetId !== null || L.progress !== 0)) note('lock none with target / progress');
      if (L.state === 'acquiring' && (L.targetId === null || L.progress >= 1)) note('acquiring without target / at 1');
      if (L.state === 'locked' && (L.targetId === null || L.progress !== 1)) note('locked without target / below 1');
      if (Math.abs(L.radiusCssPx - FCS_PARTS[s.loadout.fcs].radiusFactor * 720) > 1e-9) note(`radius ${L.radiusCssPx}`);
      if (F.weapon !== P.weapon) note('fireControl.weapon is not the selected weapon');
      if ((F.status === 'inactive') !== (L.state !== 'locked')) note(`fireControl ${F.status} while lock ${L.state}`);
      if (F.status === 'inactive') {
        for (const [key, v] of Object.entries(F)) if (key !== 'status' && key !== 'weapon' && v !== null) note(`inactive but ${key} is set`);
      } else {
        if (F.targetId !== L.targetId) note('fireControl target is not the lock target');
        if (!F.muzzlePosition || !F.targetPosition || !F.targetVelocity || !F.launchDirection || !F.aimPoint || F.evaluatedAtSeconds === null) {
          note(`${F.status} with a missing mandatory field`);
        } else {
          if (Math.abs(F.evaluatedAtSeconds - s.elapsedSeconds) > 1e-9) note('fireControl is not of the current time');
          if (Math.abs(len3(F.launchDirection) - 1) > 1e-9) note('launchDirection is not a unit vector');
          const live = s.enemies.find((e) => e.id === F.targetId);
          if (!live || !live.alive) note('fireControl for a dead / unknown enemy');
          else if (dist3(live.position, F.targetPosition) > 1e-9 || dist3(live.velocity, F.targetVelocity) > 1e-9) note('fireControl target state is stale');
          if (F.status === 'solved') {
            if (F.predictedFlightSeconds === null || !F.predictedInterceptPosition || F.residualMeters === null) note('solved with null predictions');
            else if (F.weapon === 'beam') {
              if (F.predictedFlightSeconds !== 0 || F.residualMeters !== 0) note('beam flight / residual not 0');
              if (dist3(F.aimPoint, F.targetPosition) !== 0 || dist3(F.predictedInterceptPosition, F.targetPosition) !== 0) note('beam aims elsewhere than the current position');
            } else {
              const life = F.weapon === 'machinegun' ? 2 : 4;
              if (!(F.predictedFlightSeconds > 0 && F.predictedFlightSeconds <= life)) note(`flight time ${F.predictedFlightSeconds}`);
              if (!(F.residualMeters >= 0 && F.residualMeters <= 0.01)) note(`residual ${F.residualMeters}`);
            }
          } else {
            if (F.predictedFlightSeconds !== null || F.predictedInterceptPosition !== null || F.residualMeters !== null) note('no_solution with predictions');
            if (dist3(F.aimPoint, F.targetPosition) !== 0) note('no_solution aim point is not the current position');
            if (F.weapon === 'beam') note('beam can not be without a solution');
          }
        }
      }
      cover.status[`${F.weapon}:${F.status}`] = (cover.status[`${F.weapon}:${F.status}`] ?? 0) + 1;

      // shots
      const shots = s.recentPlayerShots;
      if (shots.length > 32) note(`${shots.length} shot records`);
      if (shots.length > cover.maxShots) cover.maxShots = shots.length;
      for (let q = 0; q < shots.length; q++) {
        const r = shots[q];
        if (q > 0 && r.id !== shots[q - 1].id + 1) note('shot ids are not consecutive');
        if (q > 0 && r.firedAtSeconds < shots[q - 1].firedAtSeconds) note('shots are not oldest first');
        const json = JSON.stringify(r);
        const old = shotJson.get(r.id);
        if (old === undefined) {
          shotJson.set(r.id, json);
          if (r.id !== lastShotId + 1) note(`shot id ${r.id} after ${lastShotId}`);
          lastShotId = r.id;
          cover.shots[r.weapon]++;
          cover.shotStatus[`${r.weapon}:${r.solutionStatus}`] = (cover.shotStatus[`${r.weapon}:${r.solutionStatus}`] ?? 0) + 1;
          if (Math.abs(r.firedAtSeconds - s.elapsedSeconds) > TICK + 1e-9) note('a new shot record is older than one tick');
          if (Math.abs(len3(r.launchDirection) - 1) > 1e-9) note('shot direction is not a unit vector');
          const acc = r.weapon === 'machinegun' ? -18 : 0;
          if (r.accelerationAtFire[0] !== 0 || r.accelerationAtFire[1] !== acc || r.accelerationAtFire[2] !== 0) note('accelerationAtFire');
          if (r.weapon === 'beam') {
            if (r.initialVelocity !== null) note('beam with an initial velocity');
          } else if (!r.initialVelocity) note('projectile shot without initial velocity');
          else {
            const speed = r.weapon === 'machinegun' ? 100 : 45;
            if (Math.abs(len3(r.initialVelocity) - speed) > 0.001) note(`initial speed ${len3(r.initialVelocity)}`);
            if (dist3(r.initialVelocity, r.launchDirection.map((c) => c * speed)) > 1e-9) note('initial velocity is not speed × direction');
          }
          if (r.solutionStatus === 'inactive') {
            if (r.targetId !== null || r.targetPositionAtFire || r.targetVelocityAtFire || r.predictedFlightSeconds !== null || r.predictedInterceptPosition) note('free-fire record with target data');
            if (r.weapon === 'missile') note('missile fired without a lock');
          } else {
            if (r.targetId === null || !r.targetPositionAtFire || !r.targetVelocityAtFire) note('locked record without target data');
            if ((r.solutionStatus === 'solved') !== (r.predictedFlightSeconds !== null && r.predictedInterceptPosition !== null)) note('record predictions / status disagree');
          }
        } else if (old !== json) note(`shot ${r.id} changed after it was recorded`);
      }

      // enemies
      if (s.enemies.map((e) => e.id).join() !== enemyIds) note('enemy ids / order changed');
      for (let q = 0; q < s.enemies.length; q++) {
        const e = s.enemies[q];
        if (!e.alive && (e.hp !== 0 || e.alert || e.hasLineOfSight || len3(e.velocity) !== 0)) note(`dead ${e.id} is not inert`);
        if (e.alive && !(e.hp > 0)) note(`${e.id} alive with hp ${e.hp}`);
        if (e.kind === 'turret' && e.id.startsWith('T') && len3(e.velocity) !== 0) note(`turret ${e.id} moves`);
        if ((e.lastShotAtSeconds === null) !== (e.shotsFired === 0)) note(`${e.id}: shotsFired / lastShotAt disagree`);
        if (e.hasLineOfSight && !e.alert) note(`${e.id} sees without being alert`);
        if (prev) {
          const o = prev.enemies[q];
          if (e.shotsFired < o.shotsFired) note(`${e.id}: shotsFired went down`);
          if (!o.alive && e.alive) note(`${e.id} came back to life`);
          if (o.alive && !e.alive) cover.kills++;
          cover.enemyShots += e.shotsFired - o.shotsFired;
        }
      }
      if (prev) {
        if (s.elapsedSeconds < prev.elapsedSeconds) note('time went backwards');
        if (M.qbSuccessfulCount < prev.player.movement.qbSuccessfulCount) note('qb count went down');
        cover.qb += M.qbSuccessfulCount - prev.player.movement.qbSuccessfulCount;
        if (P.hp > prev.player.hp) note('hp went up');
      }
      if (s.stage.currentSectorId !== null && !s.stage.visitedSectorIds.includes(s.stage.currentSectorId)) note('current sector not in visited');
      if (M.verticalMode === 'flying') cover.flyingTicks++;
      if (M.horizontalMode === 'glide') cover.glideTicks++;
      if (!P.grounded) cover.airborneTicks++;
      if (L.state === 'locked') cover.lockedTicks++;
      prev = s;

      // ── end of a sortie (destroyed / fell, or after 12 s: "re-sortie" from the pause menu), then the next loadout ──
      if (sim.status !== 'playing' || age + 1 >= ticksOf(12)) {
        if (sim.status === 'failed') cover.failed++;
        if (sim.failReason === 'fell') cover.fell++;
        if (sim.status === 'failed' && sim.failReason === 'destroyed' && s.player.hp !== 0) note('destroyed with hp left');
        sim.reset(ALL_LOADOUTS[sortie % ALL_LOADOUTS.length]);
        sortie++;
        cover.sorties++;
        const r0 = buildSnapshot(sim, 'playing');
        const e0 = specErrors(r0, false);
        if (e0.length) note(`after reset: ${e0[0]}`);
        if (r0.recentPlayerShots.length !== 0 || r0.elapsedSeconds !== 0 || r0.player.hp !== 1000 || r0.player.en !== r0.effectiveStats.maxEn) note('re-sortie snapshot is not initial');
        if (r0.enemies.some((e) => !e.alive || e.shotsFired !== 0 || e.lastShotAtSeconds !== null)) note('re-sortie enemies are not initial');
        shotJson = new Map();
        lastShotId = 0;
        prev = null;
        sortieStart = k + 1;
        jumpUntil = -1;
      }
    }

    console.log(`[snapshot] fuzz coverage: ${JSON.stringify(cover)}`);
    expect(problems).toEqual([]);
    // the run really exercised what it claims to
    expect(cover.sorties).toBeGreaterThanOrEqual(5);
    expect(cover.failed).toBeGreaterThanOrEqual(1);
    expect(cover.shots.machinegun).toBeGreaterThan(20);
    expect(cover.shots.beam).toBeGreaterThan(5);
    expect(cover.shots.missile).toBeGreaterThan(2);
    expect(cover.status['machinegun:solved']).toBeGreaterThan(0);
    expect(cover.status['beam:solved']).toBeGreaterThan(0);
    expect(cover.status['missile:solved']).toBeGreaterThan(0);
    expect(cover.status['missile:no_solution']).toBeGreaterThan(0);
    expect(cover.status['machinegun:inactive']).toBeGreaterThan(0);
    expect(cover.shotStatus['machinegun:inactive']).toBeGreaterThan(0);
    expect(cover.shotStatus['machinegun:solved']).toBeGreaterThan(0);
    expect(cover.kills).toBeGreaterThan(0);
    expect(cover.qb).toBeGreaterThan(3);
    expect(cover.flyingTicks).toBeGreaterThan(0);
    expect(cover.glideTicks).toBeGreaterThan(0);
    expect(cover.enemyShots).toBeGreaterThan(50);
    expect(cover.maxShots).toBe(32);
  }, 900_000);
});
