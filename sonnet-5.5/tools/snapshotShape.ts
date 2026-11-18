/**
 * SPEC §10 の Snapshot 型を「期待キー集合 + typeof + 列挙値」として列挙し、実際の getSnapshot() の返却値と自動比較する。
 * tools/e2e.ts (ブラウザ実機の返却値) と tests/uiLogic.test.ts (Node上の buildSnapshot) の両方が使う。
 * この定義は src/sim/bench.ts の型ではなく SPEC §10 の原文から起こしている (実装側の型と食い違えば検出できるように)。
 */

export type Shape =
  | { t: 'num' }
  | { t: 'int' }
  | { t: 'str' }
  | { t: 'bool' }
  | { t: 'lit'; value: string | number | boolean }
  | { t: 'enum'; values: readonly string[] }
  | { t: 'nullable'; of: Shape }
  | { t: 'tuple'; items: readonly Shape[] }
  | { t: 'array'; of: Shape; maxLen?: number }
  | { t: 'obj'; keys: { readonly [k: string]: Shape } };

const num: Shape = { t: 'num' };
const int: Shape = { t: 'int' };
const str: Shape = { t: 'str' };
const bool: Shape = { t: 'bool' };
const lit = (value: string | number | boolean): Shape => ({ t: 'lit', value });
const en = (...values: string[]): Shape => ({ t: 'enum', values });
const nullable = (of: Shape): Shape => ({ t: 'nullable', of });
const tuple = (...items: Shape[]): Shape => ({ t: 'tuple', items });
const array = (of: Shape, maxLen?: number): Shape => ({ t: 'array', of, maxLen });
const obj = (keys: { [k: string]: Shape }): Shape => ({ t: 'obj', keys });

const vec3: Shape = tuple(num, num, num);
const vec2: Shape = tuple(num, num);
const weapon = en('machinegun', 'beam', 'missile');
const solutionStatus = en('inactive', 'solved', 'no_solution');

export const SNAPSHOT_SHAPE: Shape = obj({
  version: lit('AK2-1.2-candidate'),
  seed: int,
  state: en('garage', 'playing', 'paused', 'cleared', 'failed'),
  elapsedSeconds: num,
  loadout: obj({
    fcs: en('wide', 'medium', 'narrow'),
    generator: en('capacity', 'balanced', 'recovery'),
    legs: en('biped', 'quadruped'),
  }),
  player: obj({
    position: vec3,
    velocity: vec3,
    grounded: bool,
    hp: num,
    en: num,
    weapon,
    ammo: obj({ machinegun: int, missile: int }),
    movement: obj({
      horizontalMode: en('walk', 'glide', 'quickboost'),
      verticalMode: en('grounded', 'rising', 'flying', 'falling'),
      glideEnabled: bool,
      desiredHorizontalDirection: vec2,
      qbSuccessfulCount: int,
      qbLastStartedAtSeconds: nullable(num),
      qbImpulseRemainingSeconds: num,
      qbCooldownRemainingSeconds: num,
      lastEnSpentAtSeconds: nullable(num),
    }),
  }),
  effectiveStats: obj({ maxEn: num, regenPerSecond: num, lockSeconds: num, horizontalSpeedMultiplier: num }),
  lock: obj({ state: en('none', 'acquiring', 'locked'), targetId: nullable(str), progress: num, radiusCssPx: num }),
  fireControl: obj({
    status: solutionStatus,
    weapon,
    targetId: nullable(str),
    evaluatedAtSeconds: nullable(num),
    muzzlePosition: nullable(vec3),
    targetPosition: nullable(vec3),
    targetVelocity: nullable(vec3),
    launchDirection: nullable(vec3),
    predictedFlightSeconds: nullable(num),
    predictedInterceptPosition: nullable(vec3),
    aimPoint: nullable(vec3),
    residualMeters: nullable(num),
  }),
  recentPlayerShots: array(
    obj({
      id: int,
      firedAtSeconds: num,
      weapon,
      targetId: nullable(str),
      solutionStatus,
      muzzlePosition: vec3,
      targetPositionAtFire: nullable(vec3),
      targetVelocityAtFire: nullable(vec3),
      launchDirection: vec3,
      initialVelocity: nullable(vec3),
      accelerationAtFire: vec3,
      predictedFlightSeconds: nullable(num),
      predictedInterceptPosition: nullable(vec3),
    }),
    32,
  ),
  enemies: array(
    obj({
      id: str,
      kind: en('guard', 'turret'),
      isGateControl: bool,
      sectorId: str,
      position: vec3,
      velocity: vec3,
      hp: num,
      alive: bool,
      alert: bool,
      hasLineOfSight: bool,
      shotsFired: int,
      lastShotAtSeconds: nullable(num),
    }),
  ),
  objective: obj({ controlsDestroyed: int, controlsRequired: lit(6), openBarrierIds: array(str), gateOpen: bool }),
  stage: obj({ sectorCount: int, currentSectorId: nullable(str), visitedSectorIds: array(str), totalEnemies: lit(45) }),
});

const typeName = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** value を shape と比較し、食い違いを path 付きで返す (空配列 = 一致)。NaN / Infinity も不一致として報告する */
export function checkShape(value: unknown, shape: Shape = SNAPSHOT_SHAPE, path = '$'): string[] {
  const errs: string[] = [];
  const walk = (v: unknown, s: Shape, p: string): void => {
    switch (s.t) {
      case 'num':
        if (typeof v !== 'number') errs.push(`${p}: expected number, got ${typeName(v)}`);
        else if (!Number.isFinite(v)) errs.push(`${p}: non-finite number (${v})`);
        return;
      case 'int':
        if (typeof v !== 'number') errs.push(`${p}: expected integer, got ${typeName(v)}`);
        else if (!Number.isInteger(v)) errs.push(`${p}: expected integer, got ${v}`);
        return;
      case 'str':
        if (typeof v !== 'string') errs.push(`${p}: expected string, got ${typeName(v)}`);
        return;
      case 'bool':
        if (typeof v !== 'boolean') errs.push(`${p}: expected boolean, got ${typeName(v)}`);
        return;
      case 'lit':
        if (v !== s.value) errs.push(`${p}: expected literal ${JSON.stringify(s.value)}, got ${JSON.stringify(v)}`);
        return;
      case 'enum':
        if (typeof v !== 'string' || !s.values.includes(v)) errs.push(`${p}: expected one of ${s.values.join('|')}, got ${JSON.stringify(v)}`);
        return;
      case 'nullable':
        if (v !== null) walk(v, s.of, p);
        return;
      case 'tuple':
        if (!Array.isArray(v)) {
          errs.push(`${p}: expected array(${s.items.length}), got ${typeName(v)}`);
          return;
        }
        if (v.length !== s.items.length) errs.push(`${p}: expected length ${s.items.length}, got ${v.length}`);
        for (let i = 0; i < s.items.length && i < v.length; i++) walk(v[i], s.items[i], `${p}[${i}]`);
        return;
      case 'array':
        if (!Array.isArray(v)) {
          errs.push(`${p}: expected array, got ${typeName(v)}`);
          return;
        }
        if (s.maxLen !== undefined && v.length > s.maxLen) errs.push(`${p}: length ${v.length} exceeds ${s.maxLen}`);
        v.forEach((x, i) => walk(x, s.of, `${p}[${i}]`));
        return;
      case 'obj': {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) {
          errs.push(`${p}: expected object, got ${typeName(v)}`);
          return;
        }
        const rec = v as Record<string, unknown>;
        for (const k of Object.keys(s.keys)) {
          if (!(k in rec)) errs.push(`${p}.${k}: missing key`);
          else walk(rec[k], s.keys[k], `${p}.${k}`);
        }
        for (const k of Object.keys(rec)) if (!(k in s.keys)) errs.push(`${p}.${k}: unexpected key`);
        return;
      }
    }
  };
  walk(value, shape, path);
  return errs;
}

/** 値の中の NaN / Infinity の場所を全て返す (JSON.stringify は NaN を null にしてしまうので生の値を走査する) */
export function findNonFinite(value: unknown, path = '$', out: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path}=${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((x, i) => findNonFinite(x, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value as object)) findNonFinite((value as Record<string, unknown>)[k], `${path}.${k}`, out);
  }
  return out;
}

/** JSON往復で値が変わらないか (NaN/Infinity/undefined が含まれると変わる)。等しければ true */
export function jsonRoundTripEqual(value: unknown): boolean {
  return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value) && findNonFinite(value).length === 0;
}
