/**
 * 敵対的監査 (audit-enemies-state): 「実装は仕様に反しているはずだ」という立場で書いた、仕様条項ごとの実行可能テスト。
 *
 * 担当: SPEC §2.1 (進行・敵の数と固有ID・制御砲台6体/隔壁/最終ゲート/クリア/失敗/失敗優先)
 *       SPEC §2.3 (敵の攻撃と行動の全条項)
 *       SPEC §9  (一時停止/再開/再出撃の初期化の完全性・シード・決定性・弾とエフェクトの寿命)
 *       SPEC §10 (getSnapshot の全フィールドと意味・コピー・NaN/Infinity無し・破壊済み敵の扱い・IDの安定)
 *
 * 方針:
 *  - 数値は config.ts からではなく SPEC の表から直接書く (config.ts が SPEC と食い違っていても検出するため)。
 *  - 実際の Game を tick 実行して検証する。実ステージ(buildStage())と、小さな合成アリーナの両方を使う。
 *  - テストは仕様を直接表現し、実装の癖に合わせて緩めない。落ちたテストは消さない・skipしない。
 *  - 敵AIの内部(getEnemyAI)は「観測の補助」にだけ使い、期待値には使わない。
 *
 * 構成: §2.1 進行 / §2.3 敵の攻撃と行動 / §9 状態管理 / §10 getSnapshot (型・意味・コピー) / 補足 (通し確認・不規則フレーム等)。
 * 現在落ちるテスト = 確定した実装の違反だけ:
 *   - 「射線を失った警備は…障害物に押し付いて止まらない」の2件 (床の継ぎ目/縁に押し付く警備。SPEC §2.3 の「押し付き続ける挙動は不可」)
 *   - 「sim/rng.ts の parseSeed は、不正なパーセントエンコードで例外を投げない」 (本番未使用の重複実装。minor)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/game';
import { buildSnapshot } from '../src/sim/bench';
import type { Snapshot } from '../src/sim/bench';
import { damageEnemy } from '../src/sim/combat';
import { enemyMuzzlePosition, getEnemyAI, stepEnemyBullets } from '../src/sim/enemies';
import { getNav } from '../src/sim/nav';
import { Rng, parseSeed as parseSeedRng } from '../src/sim/rng';
import { makeScriptedTarget } from '../src/sim/scenario';
import { buildTestArenaStage } from '../src/sim/testArena';
import { World } from '../src/sim/world';
import { buildStage } from '../src/stage';
import { validateStage } from '../src/stage/validate';
import { applyKeyDown, applyKeyUp } from '../src/ui/input';
import { parseSeed as parseSeedUi } from '../src/ui/seed';
import type { BoxDef, EnemyBullet, EnemySpawn, GameState, Loadout, StageDef, V3 } from '../src/sim/types';

// ---------------------------------------------------------------------------------------------------------------------
// SPEC の数値 (§2.1 / §2.3 の表)。config.ts は参照しない。
// ---------------------------------------------------------------------------------------------------------------------
const DT = 1 / 120;
/** プレイヤー当たり判定 1.6 x 3.0 x 1.6 (ARCH §5) の中心高さ */
const PH = 1.5;
const SPEC = {
  guard: { range: 90, first: 0.5, damage: 18, speed: 70, shots: 3, interval: 0.12, period: 1.2, telegraph: 0.15, life: 2, hp: 120 },
  turret: { range: 120, first: 0.7, damage: 40, speed: 60, shots: 2, interval: 0.25, period: 1.6, telegraph: 0.35, life: 3, hp: 240 },
  predictMax: 1.2,
  jitterDeg: 0.5,
  memory: 8,
  reactSeconds: 0.5,
  share: 60,
  aiLatency: 0.05,
} as const;
type Kind = 'guard' | 'turret';
const CENTER_H: Record<Kind, number> = { guard: 1.5, turret: 1.6 };

// ---------------------------------------------------------------------------------------------------------------------
// 小さなベクトル道具 (実装の math.ts に依存しない)
// ---------------------------------------------------------------------------------------------------------------------
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const dist = (a: V3, b: V3): number => len(sub(a, b));
const unit = (a: V3): V3 => {
  const l = len(a);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const addS = (a: V3, b: V3, s: number): V3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
const angleDeg = (a: V3, b: V3): number => (Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (len(a) * len(b))))) * 180) / Math.PI;
const hspeed = (v: V3): number => Math.hypot(v.x, v.z);

/** SPEC §2.3: 定速の弾で動く目標を迎撃する最小の正の実数解 (tMax=Infinity なら上限なし)。実装のソルバーとは別に書いた検算用。 */
function interceptOracle(m: V3, p: V3, v: V3, s: number, tMax: number): { t: number; dir: V3 } | null {
  const r = sub(p, m);
  const a = dot(v, v) - s * s;
  const b = 2 * dot(r, v);
  const c = dot(r, r);
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (b < 0) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      roots.push((-b - sq) / (2 * a), (-b + sq) / (2 * a));
    }
  }
  const ok = roots.filter((t) => t > 0 && t <= tMax + 1e-9).sort((x, y) => x - y);
  if (ok.length === 0) return null;
  const t = ok[0];
  return { t, dir: unit(addS(r, v, t)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// シーン道具
// ---------------------------------------------------------------------------------------------------------------------
let boxSeq = 0;
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, extra: Partial<BoxDef> = {}): BoxDef {
  return { id: `au${boxSeq++}`, min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 }, mat: 'concrete', sectorId: 'T00', ...extra };
}
/** テスト中にON/OFFする壁。barrierId を付けるので、ナビ(nav.ts)は本物の隔壁と同じ扱いで有効状態を追跡する */
function switchable(id: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BoxDef {
  return box(x0, y0, z0, x1, y1, z1, { id, barrierId: 'AUDITBLK' });
}
function spawn(kind: Kind, id: string, x: number, z: number, y?: number): EnemySpawn {
  return { id, kind, sectorId: 'T00', pos: { x, y: y ?? CENTER_H[kind], z }, yaw: 0, isGateControl: false, controlIndex: null, barrierId: null };
}
interface Scene {
  enemies: EnemySpawn[];
  boxes?: BoxDef[];
  player?: { x: number; z: number; y?: number };
  yaw?: number;
  hp?: number;
  seed?: number;
  floorHalf?: number;
  loadout?: Loadout;
}
function arena(sc: Scene): Game {
  const stage = buildTestArenaStage({ floorHalf: sc.floorHalf ?? 400 });
  stage.boxes.push(...(sc.boxes ?? []));
  stage.enemies = sc.enemies;
  const p = sc.player ?? { x: 0, z: 0 };
  stage.playerStart = { pos: { x: p.x, y: p.y ?? PH, z: p.z }, yaw: sc.yaw ?? 0 };
  const g = new Game({ stage, seed: sc.seed, loadout: sc.loadout });
  g.sortie(sc.loadout, sc.seed);
  g.state.player.hp = sc.hp ?? 1e9;
  return g;
}
const setBox = (g: Game, id: string, on: boolean): void => g.world.setBoxEnabled(g.world.indexOfBox(id), on);
const enemyOf = (g: Game, id: string) => g.state.enemies.find((e) => e.id === id)!;

interface FireRec {
  time: number;
  id: string;
  origin: V3;
  dir: V3;
  /** 射撃tickの開始時点(=AIが見た時点)のプレイヤー位置・速度 */
  pre: { pos: V3; vel: V3 };
}
/** tick を進めながら敵の発射・予告・被弾イベントを記録する */
class Rec {
  fires: FireRec[] = [];
  tele: { time: number; id: string }[] = [];
  playerHits: { time: number; damage: number }[] = [];
  worldHits: { time: number; pos: V3 }[] = [];
  hitOnPlayerEvents = 0;
  constructor(readonly g: Game) {}
  step(): void {
    const s = this.g.state;
    const pre = { pos: { ...s.player.pos }, vel: { ...s.player.vel } };
    this.g.step();
    for (const ev of this.g.drainEvents()) {
      if (ev.type === 'enemyFire') this.fires.push({ time: ev.time, id: ev.id, origin: ev.origin, dir: ev.dir, pre });
      else if (ev.type === 'enemyTelegraph') this.tele.push({ time: ev.time, id: ev.id });
      else if (ev.type === 'playerHit') this.playerHits.push({ time: ev.time, damage: ev.damage });
      else if (ev.type === 'hit' && ev.on === 'world' && ev.weapon === 'enemy') this.worldHits.push({ time: ev.time, pos: ev.pos });
      else if (ev.type === 'hit' && ev.on === 'player' && ev.weapon === 'enemy') this.hitOnPlayerEvents++;
    }
  }
  /** before(g, T) は各tickの開始時(状態は時刻T)、after(g) はtick後に呼ぶ */
  run(seconds: number, before?: (g: Game, t: number) => void, after?: (g: Game) => void): void {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      before?.(this.g, this.g.state.time);
      this.step();
      after?.(this.g);
    }
  }
  of(id: string): FireRec[] {
    return this.fires.filter((f) => f.id === id);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 状態の全フィールド走査用: 再帰的に素データ化して Object.is で比較する
// ---------------------------------------------------------------------------------------------------------------------
const SKIP_KEYS = new Set(['world', 'stage', 'rng']);
function plain(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(plain);
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).sort()) {
    if (SKIP_KEYS.has(k)) continue;
    o[k] = plain((v as Record<string, unknown>)[k]);
  }
  return o;
}
function diffPaths(a: unknown, b: unknown, path = '$', out: string[] = [], max = 25): string[] {
  if (out.length >= max) return out;
  if (typeof a !== typeof b) {
    out.push(`${path}: type ${typeof a} vs ${typeof b}`);
    return out;
  }
  if (a === null || b === null || typeof a !== 'object') {
    if (!Object.is(a, b)) out.push(`${path}: ${String(a)} vs ${String(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: array vs object`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length: ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffPaths(a[i], b[i], `${path}[${i}]`, out, max);
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of [...keys].sort()) {
    if (!(k in ao)) out.push(`${path}.${k}: missing in first`);
    else if (!(k in bo)) out.push(`${path}.${k}: missing in second`);
    else diffPaths(ao[k], bo[k], `${path}.${k}`, out, max);
  }
  return out;
}
/** ゲーム全体のダンプ: GameState 全フィールド + 乱数状態 + 無効化されているワールドの箱 */
function dumpGame(g: Game): unknown {
  const disabled: number[] = [];
  for (let i = 0; i < g.world.boxes.length; i++) if (!g.world.isBoxEnabled(i)) disabled.push(i);
  return { state: plain(g.state), rng: g.state.rng.getState(), disabledBoxes: disabled };
}

// ---------------------------------------------------------------------------------------------------------------------
// 実ステージ
// ---------------------------------------------------------------------------------------------------------------------
const REAL: StageDef = buildStage();
function realGame(o: { seed?: number; loadout?: Loadout; stage?: StageDef } = {}): Game {
  const g = new Game({ stage: o.stage ?? REAL, seed: o.seed, loadout: o.loadout });
  g.sortie(o.loadout, o.seed);
  return g;
}
function sectorCenter(id: string): V3 {
  const s = REAL.sectors.find((x) => x.id === id)!;
  return { x: (s.bounds.min.x + s.bounds.max.x) / 2, y: s.floorY + PH, z: (s.bounds.min.z + s.bounds.max.z) / 2 };
}
/** ハーネス操作: プレイヤーを指定位置(中心座標)へ置く。速度は0 */
function teleport(g: Game, p: V3): void {
  const pl = g.state.player;
  pl.pos = { ...p };
  pl.prevPos = { ...p };
  pl.vel = { x: 0, y: 0, z: 0 };
}
const controlsOf = (g: Game) => [...g.state.enemies.filter((e) => e.isGateControl)].sort((a, b) => (a.controlIndex ?? 0) - (b.controlIndex ?? 0));
/** 制御砲台を全て破壊してゲートを開ける (実際の damageEnemy + 実際の tick) */
function destroyAllControls(g: Game): void {
  for (const c of controlsOf(g)) damageEnemy(g.state, c, 1e9, 'machinegun');
  g.step();
  g.drainEvents();
}

// =====================================================================================================================
// §2.1 進行
// =====================================================================================================================
describe('§2.1 敵の編成: 警備30+固定砲台15=45体、固有ID、HP 120/240', () => {
  it('本編の敵は45体 (警備30・砲台15)、IDは全て固有、初期HPは警備120・砲台240、全員生存・試験用標的ではない', () => {
    const g = realGame();
    const s = g.state;
    expect(s.enemies.length).toBe(45);
    const guards = s.enemies.filter((e) => e.kind === 'guard');
    const turrets = s.enemies.filter((e) => e.kind === 'turret');
    expect(guards.length).toBe(30);
    expect(turrets.length).toBe(15);
    expect(new Set(s.enemies.map((e) => e.id)).size).toBe(45);
    for (const e of s.enemies) {
      expect(e.id.length).toBeGreaterThan(0);
      expect(e.alive).toBe(true);
      expect(e.scripted, `${e.id} は試験用標的であってはならない`).toBe(false);
    }
    for (const e of guards) {
      expect(e.hp).toBe(120);
      expect(e.maxHp).toBe(120);
    }
    for (const e of turrets) {
      expect(e.hp).toBe(240);
      expect(e.maxHp).toBe(240);
    }
    const snap = buildSnapshot(s);
    expect(snap.enemies.length).toBe(45);
    expect(snap.stage.totalEnemies).toBe(45);
    expect(snap.enemies.filter((e) => e.kind === 'guard').every((e) => e.hp === 120)).toBe(true);
    expect(snap.enemies.filter((e) => e.kind === 'turret').every((e) => e.hp === 240)).toBe(true);
  });

  it('全45体は埋まっておらず、床の上にあり、警備は移動可能 (攻撃不能なダミー・浮いた飾りではない)', () => {
    const g = realGame();
    for (const e of g.state.enemies) {
      const r = e.hitRadius;
      const muzzle = enemyMuzzlePosition(e);
      expect(g.world.pointInSolid(e.pos), `${e.id} 中心が箱の中`).toBe(false);
      expect(g.world.pointInSolid(muzzle), `${e.id} 銃口が箱の中`).toBe(false);
      expect(g.world.overlapAABB(e.pos, { x: r, y: r, z: r }, 0.01), `${e.id} の当たり球が箱にめり込む`).toBe(false);
      const down = g.world.raycast(e.pos, { x: 0, y: -1, z: 0 }, 6);
      expect(down, `${e.id} の直下6m以内に床/台座が無い (浮いている)`).not.toBeNull();
    }
    g.step();
    for (const e of g.state.enemies.filter((x) => x.kind === 'guard')) {
      expect(getEnemyAI(e)!.movable, `${e.id} は足場が見つからず砲台扱いになっている(移動する警備ではない)`).toBe(true);
    }
  });

  it('制御砲台は6体で全て固定砲台(15体の内数)、6つの異なる区画に分散し、隔壁と1対1に対応する', () => {
    const g = realGame();
    const controls = controlsOf(g);
    expect(controls.length).toBe(6);
    for (const c of controls) expect(c.kind).toBe('turret');
    expect(new Set(controls.map((c) => c.sectorId)).size, '制御砲台は同じ部屋へ集めない').toBe(6);
    expect(new Set(controls.map((c) => c.barrierId)).size).toBe(6);
    const nonFinal = REAL.barriers.filter((b) => !b.isFinal);
    expect(nonFinal.length).toBe(6);
    expect(REAL.barriers.filter((b) => b.isFinal).length).toBe(1);
    for (const b of nonFinal) {
      const c = controls.find((x) => x.id === b.controlEnemyId);
      expect(c, `${b.id} の制御砲台`).toBeDefined();
      expect(c!.barrierId).toBe(b.id);
    }
    expect(REAL.barriers.find((b) => b.isFinal)!.controlEnemyId).toBeNull();
    // 15体の砲台のうち制御は6体だけ
    expect(g.state.enemies.filter((e) => e.kind === 'turret' && !e.isGateControl).length).toBe(9);
    // 「同じ部屋へ集めず」: 制御砲台同士は少なくとも60m(戦闘区画の最小寸法)離れる
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) expect(dist(controls[i].pos, controls[j].pos)).toBeGreaterThan(60);
    }
    // 「攻略開始から終盤までに分散」: 主経路上の順序で、最初の制御砲台は序盤・最後の制御砲台は終盤
    const order = REAL.mainRoute.sectorIds;
    const idx = controls.map((c) => order.indexOf(c.sectorId)).sort((a, b) => a - b);
    expect(idx[0]).toBeGreaterThanOrEqual(0);
    expect(idx[0]).toBeLessThanOrEqual(Math.floor(order.length * 0.25));
    expect(idx[5]).toBeGreaterThanOrEqual(Math.ceil(order.length * 0.75) - 1);
    // 警備・砲台も複数の区画に配置されている
    expect(new Set(g.state.enemies.filter((e) => e.kind === 'guard').map((e) => e.sectorId)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(g.state.enemies.filter((e) => e.kind === 'turret').map((e) => e.sectorId)).size).toBeGreaterThanOrEqual(8);
    // getSnapshot でも同じ (isGateControl が6体)
    expect(buildSnapshot(g.state).enemies.filter((e) => e.isGateControl).length).toBe(6);
  });

  it('隔壁は箱の集合として一貫している: barrierId付きの箱は全て対応するBarrierDefに属し、初期状態では全て閉じている', () => {
    const g = realGame();
    const flagged = REAL.boxes.filter((b) => b.barrierId !== undefined);
    for (const b of flagged) {
      const def = REAL.barriers.find((x) => x.id === b.barrierId);
      expect(def, `箱 ${b.id} の barrierId ${b.barrierId}`).toBeDefined();
      expect(def!.boxIds).toContain(b.id);
    }
    for (const def of REAL.barriers) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.boxIds.length).toBeGreaterThan(0);
      for (const id of def.boxIds) {
        const i = g.world.indexOfBox(id);
        expect(i, `箱 ${id}`).toBeGreaterThanOrEqual(0);
        expect(g.world.isBoxEnabled(i), `${def.id} は出撃時は閉じている`).toBe(true);
      }
    }
    expect(new Set(REAL.barriers.map((b) => b.label)).size, '隔壁の方向ヒント(ラベル)は互いに区別できる').toBe(REAL.barriers.length);
    const s = g.state;
    expect(s.objective).toEqual({ controlsDestroyed: 0, openBarrierIds: [], gateOpen: false });
  });
});

describe('§2.1 到達可能配置: 全45体は実際のプレイ経路から到達・交戦できる', () => {
  it('検証済み主経路(validateStage)の上から、全ての敵へ射線が通る(警備は最悪でも歩いて到達可能)。制御砲台は自分の隔壁を通る前に交戦可能', () => {
    const rep = validateStage(REAL, { runClimbBot: false, relaxedRoute: false, altRouteGrid: false });
    expect(rep.route.found).toBe(true);
    const pts = rep.route.points;
    const samples: { p: V3; at: number }[] = [];
    let at = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const L = dist(a, b);
      for (let s = 0; s < L; s += 2) samples.push({ p: { x: a.x + ((b.x - a.x) * s) / L, y: a.y + ((b.y - a.y) * s) / L, z: a.z + ((b.z - a.z) * s) / L }, at: at + s });
      at += L;
    }
    const world = new World(REAL.boxes); // 全隔壁が閉じた状態 (保守的: 開いた後の見通しは含めない)
    const nav = getNav(world, REAL);
    const crossing = new Map(rep.route.barrierCrossings.map((c) => [c.barrierId, c.atMeters]));
    const g = realGame();
    const notVisible: string[] = [];
    const unreachableGuards: string[] = [];
    for (const e of g.state.enemies) {
      const m = enemyMuzzlePosition(e);
      const limit = e.barrierId !== null ? crossing.get(e.barrierId) ?? Infinity : Infinity;
      let seen = false;
      for (const sm of samples) {
        if (sm.at > limit) break; // 制御砲台は自分の隔壁を通る前に破壊できなければならない
        if (dist(sm.p, m) <= 120 && !world.segmentBlocked(m, sm.p)) {
          seen = true;
          break;
        }
      }
      if (seen) continue;
      notVisible.push(e.id);
      if (e.kind !== 'guard' || e.isGateControl) continue;
      // 警備は歩いて動く: 経路上の接地サンプルから歩行ナビで到達できればよい
      let reachable = false;
      const feetE = { x: e.pos.x, y: e.pos.y - 1.5, z: e.pos.z };
      for (const sm of samples) {
        const f = nav.floorBelow(sm.p.x, sm.p.z, sm.p.y - PH, 1.0);
        if (f === null) continue;
        if (Math.hypot(sm.p.x - e.pos.x, sm.p.z - e.pos.z) > 200) continue;
        const path = nav.findPath({ x: sm.p.x, y: f, z: sm.p.z }, feetE);
        if (path !== null && !path.partial) {
          reachable = true;
          break;
        }
      }
      if (!reachable) unreachableGuards.push(e.id);
    }
    console.info(`[reachability] enemies not directly visible from the verified route: ${notVisible.join(',') || '(none)'}; walk-unreachable guards: ${unreachableGuards.join(',') || '(none)'}`);
    expect(notVisible.filter((id) => id.startsWith('T')), '経路から一度も射線が通らない砲台').toEqual([]);
    expect(unreachableGuards, '到達も交戦もできない警備').toEqual([]);
  });
});

describe('§2.1 制御砲台の破壊と隔壁・最終ゲート', () => {
  const barrierBoxes = (g: Game, bid: string): number[] => REAL.barriers.find((b) => b.id === bid)!.boxIds.map((id) => g.world.indexOfBox(id));

  it('各制御砲台の破壊で対応する隔壁だけが開く / 6体でゲートが開く (順序: 昇順・降順・ばらばら)', () => {
    for (const order of [[0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [3, 0, 5, 1, 4, 2]]) {
      const g = realGame();
      const s = g.state;
      const opened = new Set<string>();
      const eventsBarrier: string[] = [];
      let gateEvents = 0;
      for (const k of order) {
        const ctl = s.enemies.find((e) => e.controlIndex === k)!;
        // 体力を削っただけ(生存)では開かない
        ctl.hp = 1;
        g.step();
        expect(s.objective.openBarrierIds).not.toContain(ctl.barrierId);
        damageEnemy(s, ctl, 1, 'machinegun'); // 破壊
        expect(ctl.alive).toBe(false);
        for (let i = 0; i < 3; i++) g.step();
        for (const ev of g.drainEvents()) {
          if (ev.type === 'barrierOpen') eventsBarrier.push(ev.barrierId);
          if (ev.type === 'gateOpen') gateEvents++;
        }
        opened.add(ctl.barrierId as string);
        expect([...s.objective.openBarrierIds].sort(), `破壊済み制御: ${[...opened].join(',')}`).toEqual([...opened].sort());
        expect(s.objective.controlsDestroyed).toBe(opened.size);
        for (const b of REAL.barriers.filter((x) => !x.isFinal)) {
          const shouldBeOpen = opened.has(b.id);
          for (const i of barrierBoxes(g, b.id)) expect(g.world.isBoxEnabled(i), `${b.id} の箱 (制御破壊数 ${opened.size})`).toBe(!shouldBeOpen);
        }
        const gateOpen = opened.size === 6;
        expect(s.objective.gateOpen).toBe(gateOpen);
        for (const i of barrierBoxes(g, 'GATE')) expect(g.world.isBoxEnabled(i), `GATE の箱 (制御破壊数 ${opened.size})`).toBe(!gateOpen);
        const snap = buildSnapshot(s);
        expect(snap.objective.controlsDestroyed).toBe(opened.size);
        expect(snap.objective.gateOpen).toBe(gateOpen);
        expect([...snap.objective.openBarrierIds].sort()).toEqual([...opened].sort());
      }
      // イベントは1回ずつ (何tick経っても重複しない)
      expect(eventsBarrier.sort()).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
      expect(gateEvents).toBe(1);
      for (let i = 0; i < 30; i++) g.step();
      expect(g.drainEvents().filter((e) => e.type === 'barrierOpen' || e.type === 'gateOpen').length).toBe(0);
    }
  });

  it('各隔壁 (6+ゲート) は自分の通路の開口(ポータル)を実際に塞いでいる: 閉じている間はプレイヤーの当たり判定が開口の中心に入れず、対応する制御砲台を壊すと(そのポータルだけ)通れるようになる', () => {
    const H = { x: 0.8, y: 1.5, z: 0.8 };
    const g = realGame();
    const portalsOf = (bid: string) => REAL.portals.filter((p) => p.barrierId === bid);
    const blocked = (bid: string): boolean[] => portalsOf(bid).map((p) => g.world.overlapAABB(p.center, H, 0.01));
    for (const b of REAL.barriers) {
      expect(portalsOf(b.id).length, `${b.id} が閉じる通路 (ポータル)`).toBeGreaterThanOrEqual(1);
      expect(blocked(b.id).every((x) => x), `${b.id} は閉じている間、開口を塞ぐ`).toBe(true);
    }
    const ctl = controlsOf(g);
    for (let k = 0; k < 6; k++) {
      damageEnemy(g.state, ctl[k], 1e9, 'machinegun');
      g.step();
      for (const b of REAL.barriers) {
        const open = !b.isFinal && g.state.objective.openBarrierIds.includes(b.id);
        expect(blocked(b.id).every((x) => !x) === (open || (b.isFinal && g.state.objective.gateOpen)), `${b.id}: 制御${k + 1}/6 破壊後の開口`).toBe(true);
      }
    }
    for (const b of REAL.barriers) expect(blocked(b.id).some((x) => x), `${b.id} は全て開いた後は開口が空く`).toBe(false);
  });

  it('制御砲台以外の39体を全滅させても隔壁もゲートも開かず、制御破壊数は0のまま。5体破壊でもゲートは閉じている', () => {
    const g = realGame();
    const s = g.state;
    for (const e of s.enemies.filter((x) => !x.isGateControl)) damageEnemy(s, e, 1e9, 'machinegun');
    for (let i = 0; i < 5; i++) g.step();
    expect(s.enemies.filter((e) => !e.alive).length).toBe(39);
    expect(s.objective).toEqual({ controlsDestroyed: 0, openBarrierIds: [], gateOpen: false });
    for (const b of REAL.barriers) for (const i of barrierBoxes(g, b.id)) expect(g.world.isBoxEnabled(i)).toBe(true);
    const ctls = controlsOf(g);
    for (const c of ctls.slice(0, 5)) damageEnemy(s, c, 1e9, 'machinegun');
    g.step();
    expect(s.objective.controlsDestroyed).toBe(5);
    expect(s.objective.gateOpen).toBe(false);
    for (const i of barrierBoxes(g, 'GATE')) expect(g.world.isBoxEnabled(i)).toBe(true);
    damageEnemy(s, ctls[5], 1e9, 'machinegun');
    g.step();
    expect(s.objective.gateOpen).toBe(true);
    expect(s.objective.controlsDestroyed).toBe(6);
    // 残る敵が生存していても (今回は全滅済み) ゲートは制御砲台の数だけで決まる: 別の実行で確認
    const g2 = realGame();
    destroyAllControls(g2);
    expect(g2.state.enemies.filter((e) => e.alive).length).toBe(39);
    expect(g2.state.objective.gateOpen).toBe(true);
  });

  it('実際の武器(ビーム)で制御砲台T03を撃破すると、対応するB1だけが開く (HP240=40x6射)', () => {
    const g = realGame();
    const s = g.state;
    const t03 = s.enemies.find((e) => e.id === 'T03')!;
    // T03 が見える経路上の位置を探し、その方へカメラを向けて自由射撃する (ロックや偏差に依存しないビーム直射)
    const world = g.world;
    const muzzleOf = (yaw: number, pos: V3): V3 => ({ x: pos.x + Math.cos(yaw) * 1.05 + -Math.sin(yaw) * 1.25, y: pos.y + 0.75, z: pos.z + -Math.sin(yaw) * 1.05 + -Math.cos(yaw) * 1.25 });
    let placed = false;
    for (let r = 25; r <= 60 && !placed; r += 5) {
      for (let a = 0; a < 24 && !placed; a++) {
        const th = (a / 24) * Math.PI * 2;
        const x = t03.pos.x + Math.cos(th) * r;
        const z = t03.pos.z + Math.sin(th) * r;
        const feet = getNav(world, REAL).floorBelow(x, z, t03.pos.y, 12);
        if (feet === null) continue;
        const pos = { x, y: feet + PH, z };
        // 銃口が T03 の中心を見通せ、プレイヤー箱が自由で、水平方向に近い射線
        const yaw0 = Math.atan2(-(t03.pos.x - x), -(t03.pos.z - z));
        const m = muzzleOf(yaw0, pos);
        if (world.overlapAABB(pos, { x: 0.8, y: 1.5, z: 0.8 }, 0.05)) continue;
        if (world.segmentBlocked(m, t03.pos)) continue;
        teleport(g, pos);
        g.state.player.yaw = yaw0;
        placed = true;
      }
    }
    expect(placed, 'T03 を撃てる位置が見つかる').toBe(true);
    s.player.hp = 1e9;
    s.player.weapon = 'beam';
    // ビームは発射位置から中心へ (銃口→中心の方向にピッチ/ヨーを合わせる)
    const aimAtT03 = (): void => {
      const pl = s.player;
      const f = { x: -Math.sin(pl.yaw), z: -Math.cos(pl.yaw) };
      const m = { x: pl.pos.x + Math.cos(pl.yaw) * 1.05 + f.x * 1.25, y: pl.pos.y + 0.75, z: pl.pos.z - Math.sin(pl.yaw) * 1.05 + f.z * 1.25 };
      const d = sub(t03.pos, m);
      pl.yaw = Math.atan2(-d.x, -d.z);
      pl.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      g.look(0, 0);
    };
    aimAtT03();
    g.input.fire = true;
    let shots = 0;
    for (let i = 0; i < 240 && t03.alive; i++) {
      g.step();
      for (const ev of g.drainEvents()) if (ev.type === 'beamFire') shots++;
    }
    expect(t03.alive).toBe(false);
    expect(shots, '240HP / 40 = 6射').toBe(6);
    g.input.fire = false;
    for (let i = 0; i < 3; i++) g.step();
    expect(s.objective.openBarrierIds).toEqual(['B1']);
    expect(s.objective.controlsDestroyed).toBe(1);
  });

  it('クリア: 全制御砲台破壊後、生存したプレイヤーが脱出領域に入るとクリア (endReason=escaped)。ゲートが閉じている間・5/6では入ってもクリアしない', () => {
    const zone = REAL.escapeZone;
    const inZone: V3 = { x: (zone.min.x + zone.max.x) / 2, y: (zone.min.y + zone.max.y) / 2, z: (zone.min.z + zone.max.z) / 2 };
    // ゲートが閉じている(制御0/6, 5/6)
    for (const kills of [0, 5]) {
      const g = realGame();
      const s = g.state;
      for (const c of controlsOf(g).slice(0, kills)) damageEnemy(s, c, 1e9, 'machinegun');
      g.step();
      teleport(g, inZone);
      s.player.hp = 1e9;
      for (let i = 0; i < 30; i++) g.step();
      expect(s.mode, `制御${kills}/6で脱出領域に入っても`).toBe('playing');
      expect(s.endReason).toBeNull();
    }
    const g = realGame();
    const s = g.state;
    destroyAllControls(g);
    expect(s.objective.gateOpen).toBe(true);
    expect(s.mode).toBe('playing'); // 開いただけではクリアしない
    teleport(g, inZone);
    s.player.hp = 500;
    g.step();
    expect(s.mode).toBe('cleared');
    expect(s.endReason).toBe('escaped');
    expect(s.player.hp).toBeGreaterThan(0);
    expect(buildSnapshot(s).state).toBe('cleared');
  });

  it('一定時間の経過・隔壁への接近・未開放ゲートへの接触だけではクリアにならない', () => {
    const g = realGame();
    const s = g.state;
    for (let i = 0; i < 120 * 40; i++) g.step();
    expect(s.mode).toBe('playing');
    // 未開放ゲートの直前へ置いて60tick (接触)
    const gate = REAL.barriers.find((b) => b.isFinal)!;
    const gb = REAL.boxes.find((b) => b.id === gate.boxIds[0])!;
    const near: V3 = { x: gb.min.x - 1.2, y: (gb.min.y + gb.max.y) / 2, z: (gb.min.z + gb.max.z) / 2 };
    teleport(g, near);
    s.player.hp = 1e9;
    for (let i = 0; i < 60; i++) g.step();
    expect(s.mode).toBe('playing');
    expect(s.objective.gateOpen).toBe(false);
    // 開いた隔壁B1の位置へ行っても(=接近)クリアではない
    destroyAllControls(g);
    const b1 = REAL.barriers.find((b) => b.id === 'B1')!;
    teleport(g, { x: b1.pos.x - 3, y: b1.pos.y, z: b1.pos.z });
    s.player.hp = 1e9;
    for (let i = 0; i < 30; i++) g.step();
    expect(s.mode).toBe('playing');
  });

  it('クリア条件とHP<=0が同じ更新内で成立したら失敗を優先する (ゲート開放済み・脱出領域内・被弾致死)', () => {
    const g = realGame();
    const s = g.state;
    destroyAllControls(g);
    const zone = REAL.escapeZone;
    const inZone: V3 = { x: (zone.min.x + zone.max.x) / 2, y: (zone.min.y + zone.max.y) / 2, z: (zone.min.z + zone.max.z) / 2 };
    teleport(g, inZone);
    s.player.hp = 18;
    // 実際の敵弾処理(stepEnemyBullets)で、この更新中に致死ダメージを受ける
    const b: EnemyBullet = {
      id: s.nextProjectileId++, ownerId: 'G01', kind: 'guard', pos: { ...inZone }, prevPos: { ...inZone }, vel: { x: 1, y: 0, z: 0 },
      age: 0, maxLife: 2, damage: 18, radius: 0.2, alive: true,
    };
    s.enemyBullets.push(b);
    g.step();
    expect(s.player.hp).toBe(0);
    expect(s.mode, 'クリアと死亡が同時なら失敗').toBe('failed');
    expect(s.endReason).toBe('hp');
    expect(buildSnapshot(s).state).toBe('failed');
  });

  it('失敗: HPが0以下で失敗 / ステージ外(復帰不能)への落下で失敗 (endReason)', () => {
    const g1 = realGame();
    g1.state.player.hp = 0;
    g1.step();
    expect(g1.state.mode).toBe('failed');
    expect(g1.state.endReason).toBe('hp');
    const g2 = realGame();
    teleport(g2, { x: 12, y: -200, z: 14 });
    g2.step();
    expect(g2.state.mode).toBe('failed');
    expect(g2.state.endReason).toBe('fall');
    // 通常の地面の上では落下失敗しない
    const g3 = realGame();
    for (let i = 0; i < 240; i++) g3.step();
    expect(g3.state.mode).toBe('playing');
  });

  it('クリア/失敗後は戦闘の更新を停止する (時間・敵・弾・入力・視点・一時停止/再開の全てで状態が変わらない)。再出撃(同構成)と格納庫へ戻る操作は可能', () => {
    for (const how of ['failed', 'cleared'] as const) {
      const g = realGame({ loadout: { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' } });
      const s = g.state;
      teleport(g, sectorCenter('S02'));
      s.player.hp = 1e9;
      for (let i = 0; i < 360; i++) g.step(); // 弾が飛び交う状態にする
      expect(s.enemyBullets.length).toBeGreaterThan(0);
      if (how === 'failed') s.player.hp = 0;
      else {
        destroyAllControls(g);
        const z = REAL.escapeZone;
        teleport(g, { x: (z.min.x + z.max.x) / 2, y: (z.min.y + z.max.y) / 2, z: (z.min.z + z.max.z) / 2 });
      }
      g.step();
      expect(s.mode).toBe(how);
      const before = dumpGame(g);
      const snapBefore = buildSnapshot(s);
      g.input.fire = true;
      g.input.qb = true;
      g.input.forward = true;
      expect(g.advance(3)).toBe(0);
      for (let i = 0; i < 100; i++) g.step();
      g.look(300, 300);
      g.pause();
      g.resume();
      g.input.fire = false;
      g.input.qb = false;
      g.input.forward = false;
      const after = dumpGame(g);
      expect(diffPaths(before, after), `${how} 後に状態が進んだ`).toEqual([]);
      expect(buildSnapshot(s)).toEqual(snapBefore);
      expect(s.mode).toBe(how);
      // 同じ構成での再出撃
      const lo = g.getLoadout();
      g.retry();
      expect(g.state.mode).toBe('playing');
      expect(g.state.loadout).toEqual(lo);
      expect(lo).toEqual({ fcs: 'narrow', generator: 'recovery', legs: 'quadruped' });
      g.toGarage();
      expect(g.state.mode).toBe('garage');
      expect(g.state.loadout).toEqual(lo);
    }
  });
});

// =====================================================================================================================
// §2.3 敵の攻撃と行動
// =====================================================================================================================
const speedOfId = (id: string): number => (id.startsWith('G') ? SPEC.guard.speed : SPEC.turret.speed);
const kindOfId = (id: string): Kind => (id.startsWith('G') ? 'guard' : 'turret');
/** 種別ごとの試験用ID (speedOfId が先頭文字で弾速を決めるため G/T を守る) */
const idOf = (kind: Kind): string => (kind === 'guard' ? 'G01' : 'T01');

describe('§2.3 攻撃の表: 初動・バースト・周期・予告 (実測)', () => {
  for (const kind of ['guard', 'turret'] as const) {
    const S = SPEC[kind];
    it(`${kind === 'guard' ? '警備ロボット' : '固定砲台'}: 射線取得から${S.first}秒後に初弾 / ${S.shots}発 / 発射間隔${S.interval}秒 / 開始周期${S.period}秒(予告${S.telegraph}秒は周期に含む) / 遅れ<=0.05秒 (30秒間)`, () => {
      const g = arena({ enemies: [spawn(kind, idOf(kind), 0, kind === 'guard' ? -45 : -70)], player: { x: 0, z: 0 } });
      const e = enemyOf(g, idOf(kind));
      const rec = new Rec(g);
      const teleLog: { t: number; v: number }[] = [];
      const speeds: number[] = [];
      let prevBullets = new Set<number>();
      let firstLosT = -1;
      rec.run(
        30,
        (gg) => {
          prevBullets = new Set(gg.state.enemyBullets.map((b) => b.id));
        },
        (gg) => {
          if (firstLosT < 0 && e.hasLineOfSight) firstLosT = gg.state.time - DT; // 判断時刻T
          teleLog.push({ t: gg.state.time - DT, v: e.telegraph });
          for (const b of gg.state.enemyBullets) {
            if (!prevBullets.has(b.id)) {
              // 生成したtickで1dt進んでいる。初速・ダメージ・寿命は表どおり
              speeds.push(len(b.vel));
              expect(b.damage).toBe(S.damage);
              expect(b.maxLife).toBe(S.life);
            }
          }
        },
      );
      expect(firstLosT).toBe(0); // 開始tickから射線あり
      const expected: number[] = [];
      const burstStarts: number[] = [];
      for (let k = 0; S.first + k * S.period < 29.8; k++) {
        const st = S.first + k * S.period;
        burstStarts.push(st);
        for (let j = 0; j < S.shots; j++) expected.push(st + j * S.interval);
      }
      const fired = rec.fires.map((f) => f.time).filter((t) => t < 29.8 + SPEC.aiLatency);
      const expectedTrim = expected.filter((t) => t < 29.8);
      expect(fired.slice(0, expectedTrim.length).length).toBe(expectedTrim.length);
      expect(rec.fires.length).toBeGreaterThanOrEqual(expectedTrim.length);
      expectedTrim.forEach((due, i) => {
        const t = rec.fires[i].time;
        expect(t, `${i}発目 (予定 ${due.toFixed(4)})`).toBeGreaterThanOrEqual(due - 1e-9);
        expect(t, `${i}発目 (予定 ${due.toFixed(4)}) の遅れ`).toBeLessThanOrEqual(due + SPEC.aiLatency + 1e-9);
      });
      // バーストごとにちょうど S.shots 発 (予定時刻の窓ごと)
      burstStarts.forEach((st, k) => {
        const inWin = rec.fires.filter((f) => f.time >= st - 1e-9 && f.time < st + S.period - 1e-9);
        expect(inWin.length, `バースト${k}の弾数`).toBe(S.shots);
      });
      // 周期は「バースト開始→次の開始」で、予告0.15/0.35は周期に含まれる (追加されない)
      for (let k = 1; k < burstStarts.length; k++) {
        const a = rec.fires[(k - 1) * S.shots].time;
        const b = rec.fires[k * S.shots].time;
        expect(b - a, `開始周期 ${k}`).toBeGreaterThanOrEqual(S.period - DT - 1e-9);
        expect(b - a).toBeLessThanOrEqual(S.period + DT + 1e-9);
      }
      // 予告イベントは各バーストのちょうど予告時間前
      expect(rec.tele.length).toBeGreaterThanOrEqual(burstStarts.length - 1);
      burstStarts.slice(0, rec.tele.length).forEach((st, k) => expect(rec.tele[k].time).toBeCloseTo(st - S.telegraph, 6));
      // 予告の進行度: 予告窓の外では0、窓の中では0より大きい
      for (const s of teleLog) {
        const inWindow = burstStarts.some((st) => s.t >= st - S.telegraph - 1e-9 && s.t < st - 1e-9);
        if (!inWindow) expect(s.v, `t=${s.t.toFixed(3)} 窓外の予告値`).toBe(0);
        else expect(s.v).toBeGreaterThanOrEqual(0);
      }
      const inside = teleLog.filter((s) => burstStarts.some((st) => s.t >= st - S.telegraph + DT && s.t < st - 1e-9));
      expect(inside.length).toBeGreaterThan(10);
      for (const s of inside) expect(s.v).toBeGreaterThan(0);
      // 弾速(生成時の速度ベクトルの大きさ)
      expect(speeds.length).toBe(rec.fires.length);
      for (const v of speeds) expect(v).toBeCloseTo(S.speed, 9);
      // 撃った数 = shotsFired = 生成した敵弾の数
      expect(e.shotsFired).toBe(rec.fires.length);
      expect(e.lastShotAt).toBeCloseTo(rec.fires[rec.fires.length - 1].time, 9);
    });

    it(`${kind === 'guard' ? '警備ロボット' : '固定砲台'}: 被弾ごとのダメージは${S.damage}、1発1回・全弾命中の静止プレイヤーで HP減少 = ${S.damage} x 命中数`, () => {
      const g = arena({ enemies: [spawn(kind, idOf(kind), 0, kind === 'guard' ? -40 : -60)], player: { x: 0, z: 0 }, hp: 1000 });
      const rec = new Rec(g);
      rec.run(9);
      const hp = g.state.player.hp;
      expect(rec.playerHits.length).toBeGreaterThan(3);
      for (const h of rec.playerHits) expect(h.damage).toBe(S.damage);
      expect(1000 - hp).toBe(rec.playerHits.length * S.damage);
      expect(rec.hitOnPlayerEvents).toBe(rec.playerHits.length);
      expect(rec.playerHits.length).toBeLessThanOrEqual(rec.fires.length);
      expect(g.state.damageTaken).toBe(1000 - hp);
    });

    it(`${kind === 'guard' ? '警備ロボット' : '固定砲台'}: 弾は直進し (重力・誘導なし)、寿命${S.life}秒で消え、射程は 速度x寿命`, () => {
      // プレイヤーを銃口と同じ高さの足場に立たせ、弾がほぼ水平に飛ぶようにする (床に当たって寿命前に消えないため)
      const muzzleY = CENTER_H[kind] + 0.4;
      const pad = box(-6, muzzleY - PH - 2, -6, 6, muzzleY - PH, 6);
      const g = arena({ enemies: [spawn(kind, idOf(kind), 0, kind === 'guard' ? -45 : -60)], boxes: [pad], player: { x: 0, z: 0, y: muzzleY } });
      const s = g.state;
      let first: { id: number; origin: V3; vel: V3; tSpawn: number } | null = null;
      // 初弾の生成を待つ
      for (let i = 0; i < 240 && !first; i++) {
        g.step();
        g.drainEvents();
        if (s.enemyBullets.length > 0) {
          const b = s.enemyBullets[0];
          first = { id: b.id, origin: { x: b.pos.x - b.vel.x * b.age, y: b.pos.y - b.vel.y * b.age, z: b.pos.z - b.vel.z * b.age }, vel: { ...b.vel }, tSpawn: s.time - DT };
        }
      }
      expect(first).not.toBeNull();
      // プレイヤーを射程外の遠方へ動かす (弾は当たらず、その後の射撃も止まる)
      teleport(g, { x: 350, y: PH, z: 350 });
      let alive = 0;
      let last: V3 | null = null;
      for (let i = 0; i < Math.round((S.life + 1) / DT); i++) {
        g.step();
        g.drainEvents();
        const b = s.enemyBullets.find((x) => x.id === first!.id);
        if (!b) break;
        alive++;
        const expected = addS(first!.origin, first!.vel, b.age);
        expect(dist(b.pos, expected), '直進 (重力・誘導なし)').toBeLessThan(1e-7);
        expect(b.vel).toEqual(first!.vel);
        last = b.pos;
      }
      const lifeSeen = (alive + 1) * DT; // 生成tick(age=dt)を含む
      expect(lifeSeen).toBeGreaterThanOrEqual(S.life - 2 * DT);
      expect(lifeSeen).toBeLessThanOrEqual(S.life + 2 * DT);
      expect(last).not.toBeNull();
      expect(dist(last as V3, first!.origin)).toBeGreaterThan(S.speed * (S.life - 3 * DT));
      expect(dist(last as V3, first!.origin)).toBeLessThan(S.speed * S.life + 1e-6);
      expect(s.player.hp).toBe(1e9);
    });
  }
});

describe('§2.3 索敵・攻撃距離 (90m/120m) と、カメラ・視線・プレイヤーの攻撃に依存しないこと', () => {
  it('距離は3次元で判定: 警備 89/91m、砲台 119/121m の境界 (水平)、および水平85m+高さ35m(3D 91.9m)では射線なし', () => {
    const cases: [Kind, number, boolean][] = [['guard', 89, true], ['guard', 91, false], ['turret', 119, true], ['turret', 121, false]];
    for (const [kind, d, expected] of cases) {
      const g = arena({ enemies: [spawn(kind, idOf(kind), 0, -d)], player: { x: 0, z: 0 } });
      g.step();
      expect(enemyOf(g, idOf(kind)).hasLineOfSight, `${kind} ${d}m`).toBe(expected);
      const rec = new Rec(g);
      rec.run(1.5);
      expect(rec.fires.length > 0, `${kind} ${d}m で撃つか`).toBe(expected);
    }
    const g = arena({ enemies: [spawn('guard', 'G01', 0, -85)], player: { x: 0, z: 0, y: PH + 35 } });
    g.step();
    expect(enemyOf(g, 'G01').hasLineOfSight, '3D距離 91.9m > 90m').toBe(false);
    const g2 = arena({ enemies: [spawn('guard', 'G01', 0, -85)], player: { x: 0, z: 0, y: PH + 20 } });
    g2.step();
    expect(enemyOf(g2, 'G01').hasLineOfSight, '3D距離 87.3m <= 90m').toBe(true);
  });

  it('警戒中(記憶あり)でも射程外・遮蔽中は撃たない。砲台は射程外の間ずっと沈黙し、射程内に戻れば再開する', () => {
    const g = arena({ enemies: [spawn('turret', 'T01', 0, -60)], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    rec.run(1.5);
    const n0 = rec.fires.length;
    expect(n0).toBeGreaterThan(0);
    teleport(g, { x: 0, y: PH, z: 70 }); // 130m: 射程外(障害物なし)
    const after = rec.fires.length;
    let alertSamples = 0;
    rec.run(5, undefined, (gg) => {
      const e = enemyOf(gg, 'T01');
      expect(e.hasLineOfSight).toBe(false);
      alertSamples += e.alert ? 1 : 0;
    });
    expect(alertSamples, '射程外でも8秒間は警戒を保つ').toBeGreaterThan(5 * 120 - 5);
    // 弾が飛び終わった後は新しい発射がない
    expect(rec.fires.length).toBe(after);
    teleport(g, { x: 0, y: PH, z: 0 });
    rec.run(1.5);
    expect(rec.fires.length).toBeGreaterThan(after);
  });

  it('全敵が独立して同時に攻撃する: 同時攻撃・カメラ外(背後)の敵・プレイヤーが撃たなくても攻撃 (合成アリーナ)', () => {
    const g = arena({
      enemies: [spawn('guard', 'G01', 0, -40), spawn('guard', 'G02', 40, 40), spawn('guard', 'G03', -40, 40), spawn('turret', 'T01', 0, -70), spawn('turret', 'T02', 0, 90)],
      player: { x: 0, z: 0 },
      yaw: 0,
    });
    const s = g.state;
    const behind = ['G02', 'G03', 'T02'];
    for (const id of behind) expect(dot(sub(enemyOf(g, id).pos, s.camera.pos), s.camera.forward), `${id} はカメラの後方`).toBeLessThan(0);
    const rec = new Rec(g);
    rec.run(4);
    expect([...new Set(rec.fires.map((f) => f.id))].sort()).toEqual(['G01', 'G02', 'G03', 'T01', 'T02']);
    const together = rec.fires.some((f) => new Set(rec.fires.filter((x) => x.time >= f.time && x.time <= f.time + 0.3).map((x) => x.id)).size >= 4);
    expect(together, '0.3秒の窓に4体が撃つ').toBe(true);
    expect(s.input.fire).toBe(false);
    expect(s.bullets.length + s.missiles.length).toBe(0);
    expect(s.player.ammo).toEqual({ machinegun: 300, missile: 12 });
  });

  it('全敵が独立して攻撃する (実ステージS02の中央): 3体以上が同時に撃ち、カメラ外の敵も撃ち、初弾は射線取得から0.5/0.7秒(+0.05秒以内)', () => {
    const g = realGame();
    const s = g.state;
    teleport(g, sectorCenter('S02'));
    s.player.hp = 1e9;
    s.player.yaw = 0;
    g.look(0, 0);
    const rec = new Rec(g);
    const losSince = new Map<string, number>();
    const firstShotDelay = new Map<string, number>();
    const lostBeforeFirst = new Set<string>();
    let behind = 0;
    rec.run(6, undefined, (gg) => {
      const T = gg.state.time - DT;
      for (const e of gg.state.enemies) {
        if (e.hasLineOfSight) {
          if (!losSince.has(e.id)) losSince.set(e.id, T);
        } else if (losSince.has(e.id) && e.shotsFired === 0) {
          lostBeforeFirst.add(e.id);
        }
      }
    });
    for (const f of rec.fires) {
      const e = enemyOf(g, f.id);
      if (!firstShotDelay.has(f.id)) firstShotDelay.set(f.id, f.time - (losSince.get(f.id) ?? NaN));
      if (dot(sub(e.pos, g.state.camera.pos), g.state.camera.forward) < 0) behind++;
    }
    const ids = [...new Set(rec.fires.map((f) => f.id))];
    expect(ids.length, `撃った敵: ${ids.join(',')}`).toBeGreaterThanOrEqual(3);
    const together = rec.fires.some((f) => new Set(rec.fires.filter((x) => x.time >= f.time && x.time <= f.time + 0.5).map((x) => x.id)).size >= 3);
    expect(together).toBe(true);
    expect(behind, 'カメラの後方の敵の発射数').toBeGreaterThan(0);
    for (const [id, d] of firstShotDelay) {
      if (lostBeforeFirst.has(id)) continue; // 途中で射線を失った敵は別条項(保持タイマー)
      const S = SPEC[kindOfId(id)];
      expect(d, `${id} の初弾遅延`).toBeGreaterThanOrEqual(S.first - 1e-9);
      expect(d, `${id} の初弾遅延`).toBeLessThanOrEqual(S.first + SPEC.aiLatency + 1e-9);
    }
    expect(s.input.fire).toBe(false);
    expect(s.player.ammo.machinegun).toBe(300);
  });

  it('プレイヤーのHPで手加減しない: HP1000固定とHP100固定(毎tick再設定)で、全敵の発射時刻・方向が同一 (合成アリーナと実ステージS02)', () => {
    const run = (mk: () => Game, hp: number) => {
      const g = mk();
      const rec = new Rec(g);
      rec.run(5, (gg) => {
        gg.state.player.hp = hp;
      });
      return rec.fires.map((f) => ({ t: f.time, id: f.id, d: f.dir }));
    };
    const mkArena = () => arena({ enemies: [spawn('guard', 'G01', 0, -50), spawn('guard', 'G02', 30, -30), spawn('turret', 'T01', -20, -80)], player: { x: 0, z: 0 } });
    const a1 = run(mkArena, 1000);
    const a2 = run(mkArena, 100);
    expect(a1.length).toBeGreaterThan(10);
    expect(a2).toEqual(a1);
    const mkReal = () => {
      const g = realGame();
      teleport(g, sectorCenter('S02'));
      return g;
    };
    const r1 = run(mkReal, 1000);
    const r2 = run(mkReal, 100);
    expect(r1.length).toBeGreaterThan(10);
    expect(r2).toEqual(r1);
  });
});

describe('§2.3 偏差射撃: 現在位置と実速度・上限1.20秒・未来入力/意図を参照しない・ばらつき0.5度以内', () => {
  interface AimStats { shots: number; lead: number; unled: number; direct: number; capped: number; maxDev: number; angles: number[] }
  /** 各発を独立に実装した迎撃オラクルと比較する */
  function checkAim(rec: Rec, from = 0): AimStats {
    const st: AimStats = { shots: 0, lead: 0, unled: 0, direct: 0, capped: 0, maxDev: 0, angles: [] };
    for (const f of rec.fires) {
      if (f.time < from) continue;
      const s = speedOfId(f.id);
      const cur = unit(sub(f.pre.pos, f.origin));
      const orc = interceptOracle(f.origin, f.pre.pos, f.pre.vel, s, SPEC.predictMax);
      const expectDir = orc ? orc.dir : cur;
      const unc = interceptOracle(f.origin, f.pre.pos, f.pre.vel, s, Infinity);
      const dev = angleDeg(f.dir, expectDir);
      st.shots++;
      st.maxDev = Math.max(st.maxDev, dev);
      st.angles.push(dev);
      if (orc) {
        if (angleDeg(orc.dir, cur) > 1) st.lead++;
        else st.unled++;
      }
      if (!orc) {
        st.direct++;
        if (unc && angleDeg(unc.dir, cur) > 1) st.capped++; // 上限が無ければ先読みしたはずの発 (上限が効いた発)
      }
      expect(dev, `t=${f.time.toFixed(3)} ${f.id} 偏差${dev.toFixed(3)}度 (許容${SPEC.jitterDeg}度)`).toBeLessThanOrEqual(SPEC.jitterDeg + 1e-6);
    }
    return st;
  }

  it('静止プレイヤー: 現在位置を狙い(ばらつき0.5度以内)、固定オフセットではなく毎回異なり、全弾が命中する (警備88m・砲台118m を含む)', () => {
    const g = arena({
      enemies: [spawn('guard', 'G01', 0, -40), spawn('guard', 'G02', 60, -60), spawn('turret', 'T01', 30, -50), spawn('turret', 'T02', -20, -117)],
      player: { x: 0, z: 0 },
      hp: 1e9,
    });
    const rec = new Rec(g);
    rec.run(12);
    const st = checkAim(rec);
    expect(st.shots).toBeGreaterThan(50);
    expect(st.lead).toBe(0); // 静止標的へ先読みしない
    // ばらつきは実在し(固定オフセットでも常に0でもない)、上限は0.5度
    expect(new Set(st.angles.map((a) => a.toFixed(3))).size).toBeGreaterThan(st.shots * 0.8);
    expect(st.maxDev).toBeGreaterThan(0.3);
    expect(st.maxDev).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(st.angles.filter((a) => a < 0.2).length, '中心付近にも当たる').toBeGreaterThan(st.shots * 0.1);
    // 静止標的には外れない: 十分飛んだ弾は全て命中 (命中数 = 到達済みの発数)
    const arrived = rec.fires.filter((f) => f.time <= 12 - 3.2);
    expect(rec.playerHits.length).toBeGreaterThanOrEqual(arrived.length);
    expect(rec.playerHits.length).toBeLessThanOrEqual(rec.fires.length);
  });

  it('横移動するプレイヤー(実速度10m/s): 各発が定速迎撃解へ0.5度以内で先読みし、現在位置狙いではない。命中する', () => {
    for (const kind of ['guard', 'turret'] as const) {
      const g = arena({ enemies: [spawn(kind, idOf(kind), 0, kind === 'guard' ? -45 : -60)], player: { x: -25, z: 0 } });
      g.input.right = true;
      const rec = new Rec(g);
      rec.run(4);
      const st = checkAim(rec, 0.4);
      expect(st.shots).toBeGreaterThanOrEqual(kind === 'guard' ? 8 : 3);
      expect(st.lead).toBe(st.shots);
      const early = rec.fires.filter((f) => f.time <= 4 - (kind === 'guard' ? 1.6 : 2));
      expect(rec.playerHits.length).toBeGreaterThanOrEqual(Math.floor(early.length * 0.9));
    }
  });

  it('実速度を使い、入力/意図は使わない: 壁に押し付けて実際は動けない(入力=右)プレイヤーへは先読みしない / 入力なしでもQB後の慣性で動くプレイヤーには先読みする', () => {
    // (1) 右の壁に接して、入力は右 (実速度 ~0)
    const g1 = arena({ enemies: [spawn('turret', 'T01', 0, -50), spawn('guard', 'G01', -30, -40)], boxes: [box(0.85, 0, -3, 4, 10, 3)], player: { x: 0, z: 0 } });
    g1.input.right = true;
    const rec1 = new Rec(g1);
    rec1.run(3);
    const st1 = checkAim(rec1, 0.4);
    expect(st1.shots).toBeGreaterThan(4);
    for (const f of rec1.fires) if (f.time > 0.4) expect(hspeed(f.pre.vel), '壁に押し付け: 実速度').toBeLessThan(0.5);
    expect(st1.lead, '意図(入力)で先読みしてはいけない').toBe(0);
    for (const f of rec1.fires) if (f.time > 0.4) expect(angleDeg(f.dir, unit(sub(f.pre.pos, f.origin))), '現在位置を狙う').toBeLessThanOrEqual(0.5 + 1e-6);
    // (2) QBを1回(0.02秒時点)出してから全入力を離す: 実速度22m/sの慣性グライドで移動
    const g2 = arena({ enemies: [spawn('turret', 'T01', 0, -50)], player: { x: -60, z: 0 } });
    const rec2 = new Rec(g2);
    rec2.run(
      5,
      (gg, t) => {
        gg.input.right = t < 0.03;
        gg.input.qb = t >= 0.01 && t < 0.03;
      },
    );
    const st2 = checkAim(rec2, 0.4);
    expect(st2.shots).toBeGreaterThan(2);
    for (const f of rec2.fires) expect(hspeed(f.pre.vel), '慣性で動いている').toBeGreaterThan(15);
    expect(st2.lead, '入力が無くても実速度から先読みする').toBeGreaterThanOrEqual(3);
    expect(st2.unled, '迎撃解がある発は必ず先読みする').toBe(0);
  });

  it('予測時間の上限1.20秒: 遠ざかる(22m/s)プレイヤーへ、迎撃解が1.2秒以内なら先読み・超えるなら現在位置を狙う (境界をまたぐ)', () => {
    const g = arena({ enemies: [spawn('turret', 'T01', 0, -25)], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    rec.run(6, (gg) => {
      gg.input.shift = true; // グライドで加速
      gg.input.back = true; // 斜め後ろ(砲台から遠ざかりつつ横へ): 迎撃方向が現在方向からずれる
      gg.input.right = true;
    });
    const st = checkAim(rec, 0);
    expect(st.lead, '1.2秒以内: 先読み').toBeGreaterThanOrEqual(1);
    expect(st.unled, '解がある発は先読みしている').toBe(0);
    expect(st.capped, '1.2秒超: 上限が効いた発 (先読みせず現在位置)').toBeGreaterThanOrEqual(1);
  });

  it('接近するプレイヤー・上昇/落下するプレイヤー(3次元速度)にも実速度で先読みする', () => {
    const g = arena({ enemies: [spawn('turret', 'T01', 0, -70), spawn('guard', 'G01', 25, -55)], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    rec.run(4, (gg, t) => {
      gg.input.forward = true; // 接近
      gg.input.jump = t >= 0.05; // 押し続けて飛行 (上昇8m/s)
    });
    const st = checkAim(rec, 0.5);
    expect(st.shots).toBeGreaterThan(3);
    expect(rec.fires.some((f) => f.pre.vel.y > 5 && f.time > 0.5), '上昇中の発がある').toBe(true);
  });
});

describe('§2.3 遮蔽・記憶(8秒)・再露出・各発の射線確認', () => {
  it('隠れたら撃たない・警戒は最後の確認から8秒(tick単位で)保つ・8秒後に解除 (警備と砲台)。遮蔽中に現在位置を透視しない', () => {
    for (const kind of ['guard', 'turret'] as const) {
      const wall = switchable('blk', -150, 0, -22, 150, 14, -20);
      const g = arena({ enemies: [spawn(kind, idOf(kind), 0, kind === 'guard' ? -40 : -60)], boxes: [wall], player: { x: 0, z: 0 } });
      setBox(g, 'blk', false);
      const e = enemyOf(g, idOf(kind));
      const rec = new Rec(g);
      const log: { t: number; los: boolean; alert: boolean }[] = [];
      let moved = false;
      rec.run(
        14,
        (gg, t) => {
          if (Math.abs(t - 1) < 1e-9) setBox(gg, 'blk', true);
          if (Math.abs(t - 3) < 1e-9) gg.state.player.pos = { x: 0, y: PH, z: 60 }; // 隠れたまま別の場所へ
          if (t > 3) moved = moved || false;
        },
        (gg) => log.push({ t: gg.state.time - DT, los: e.hasLineOfSight, alert: e.alert }),
      );
      const lastLos = Math.max(...log.filter((l) => l.los).map((l) => l.t));
      expect(lastLos).toBeGreaterThan(0.9);
      expect(lastLos).toBeLessThan(1.02);
      for (const f of rec.fires) expect(f.time, '遮蔽後は撃たない').toBeLessThanOrEqual(lastLos + 1e-9);
      for (const l of log) {
        if (l.t <= lastLos + 1e-9) continue;
        const since = l.t - lastLos;
        if (since < SPEC.memory - 1e-6) expect(l.alert, `${kind} 遮蔽から${since.toFixed(3)}秒`).toBe(true);
        else if (since > SPEC.memory + DT + 1e-6) expect(l.alert, `${kind} 遮蔽から${since.toFixed(3)}秒`).toBe(false);
        expect(l.los).toBe(false);
      }
      const release = log.find((l) => l.t > lastLos && !l.alert)!;
      expect(release.t - lastLos).toBeGreaterThanOrEqual(SPEC.memory - 1e-6);
      expect(release.t - lastLos).toBeLessThanOrEqual(SPEC.memory + DT + 1e-6);
      void moved;
    }
  });

  it('警備ロボット: 射線を失った直後から0.50秒以内に移動を始め、最後に確認した位置へ向かう(現在位置ではなく)。8秒後は解除して持ち場へ戻る', () => {
    const wall = switchable('blk', -150, 0, -22, 150, 14, -20);
    const g = arena({ enemies: [spawn('guard', 'G01', 0, -40)], boxes: [wall], player: { x: -30, z: 0 } });
    setBox(g, 'blk', false);
    const e = enemyOf(g, 'G01');
    const rec = new Rec(g);
    rec.run(1);
    setBox(g, 'blk', true);
    teleport(g, { x: 30, y: PH, z: 0 }); // 隠れたまま反対側(東)へ
    const t0 = g.state.time;
    const start = { ...e.pos };
    let firstMove = -1;
    let minX = Infinity;
    rec.run(3, undefined, (gg) => {
      if (firstMove < 0 && hspeed(e.vel) > 1) firstMove = gg.state.time - DT - t0;
      minX = Math.min(minX, e.pos.x);
    });
    expect(e.hasLineOfSight).toBe(false);
    expect(firstMove, '移動開始までの秒数').toBeGreaterThanOrEqual(0);
    expect(firstMove).toBeLessThanOrEqual(SPEC.reactSeconds + 1e-9);
    // 確認位置は西(x=-30)。壁沿いに西へ動く (現在位置=東を透視して東へ行かない)
    expect(e.pos.x).toBeLessThan(start.x - 5);
  });

  it('フリッカー遮蔽(ランダムに0.05〜0.6秒ごとに壁をON/OFF, 20秒): 各発に射線・初弾は取得後0.5/0.7秒以降・バースト間隔/周期の下限・再露出後は予告時間を満たす・連続露出中は任意の長い待機なし', () => {
    for (const kind of ['guard', 'turret'] as const) {
      const S = SPEC[kind];
      const rng = new Rng(4242 + (kind === 'guard' ? 0 : 1));
      const wall = switchable('blk', -30, 0, -21, 30, 14, -19);
      const g = arena({ enemies: [spawn(kind, idOf(kind), 0, kind === 'guard' ? -45 : -70)], boxes: [wall], player: { x: 0, z: 0 } });
      setBox(g, 'blk', false);
      const e = enemyOf(g, idOf(kind));
      // 壁の東西に回り込まないよう、警備には壁の外側へ出る時間を与えない(20秒の間に壁の端 (x=±30) へは届くので、動かない砲台/警備の両方で不変条件だけを見る)
      const rec = new Rec(g);
      const events: { t: number; los: boolean }[] = [];
      let nextToggle = 0.3;
      let wallOn = false;
      rec.run(
        20,
        (gg, t) => {
          if (t + 1e-9 >= nextToggle) {
            wallOn = !wallOn;
            setBox(gg, 'blk', wallOn);
            nextToggle = t + 0.05 + rng.next() * 0.55;
          }
        },
        (gg) => events.push({ t: gg.state.time - DT, los: e.hasLineOfSight }),
      );
      expect(rec.fires.length).toBeGreaterThan(3);
      // 射線が取得された時刻の一覧 (false->true)
      const acquire: number[] = [];
      let prev = false;
      for (const ev of events) {
        if (ev.los && !prev) acquire.push(ev.t);
        prev = ev.los;
      }
      const losAt = (t: number): boolean => events[Math.round(t / DT)]?.los ?? false;
      // I1: 各発の発射tickに射線がある (遮蔽中の発は撃たない)
      for (const f of rec.fires) expect(losAt(f.time), `${kind} t=${f.time.toFixed(3)} に射線`).toBe(true);
      expect(acquire.length, '複数回の再露出').toBeGreaterThan(5);
      // I2: 初弾は最初の射線取得から S.first 以降
      expect(rec.fires[0].time).toBeGreaterThanOrEqual(acquire[0] + S.first - 1e-9);
      // I3: 任意の発の直後 S.period 未満に、最大 S.shots 発まで (バースト開始の間隔 >= 周期)
      for (const f of rec.fires) {
        const n = rec.fires.filter((x) => x.time >= f.time - 1e-9 && x.time < f.time + S.period - 1e-9).length;
        expect(n, `${kind} t=${f.time.toFixed(3)} からの${S.period}秒間の発数`).toBeLessThanOrEqual(S.shots);
      }
      // 個々の発は1tick(=AI更新)ぶん遅れ得る (SPEC: 遅れは最大0.05秒) ので、間隔は 表の値 - 遅れの許容 を下回らない
      for (let i = 1; i < rec.fires.length; i++) expect(rec.fires[i].time - rec.fires[i - 1].time).toBeGreaterThanOrEqual(S.interval - DT - 1e-9);
      // I4: 再露出後の最初の発は 再露出 + 予告時間 以降
      for (const tr of acquire) {
        const nextShot = rec.fires.find((f) => f.time >= tr - 1e-9);
        if (!nextShot) continue;
        // その発の前に再び射線を失っていない場合だけ(=同じ露出内の発)
        const lostBetween = events.some((ev) => ev.t > tr && ev.t < nextShot.time && !ev.los);
        if (!lostBetween) expect(nextShot.time, `${kind} 再露出 t=${tr.toFixed(3)} 後の初弾`).toBeGreaterThanOrEqual(tr + S.telegraph - 1e-9);
      }
      // I5: 十分長く続く露出では、周期+遅れの内に必ず撃つ (任意の長い待機なし)
      let i = 0;
      while (i < events.length) {
        if (!events[i].los) {
          i++;
          continue;
        }
        let j = i;
        while (j < events.length && events[j].los) j++;
        const dur = (j - i) * DT;
        const t0 = events[i].t;
        if (dur >= S.period + SPEC.aiLatency + 2 * DT) {
          const shot = rec.fires.find((f) => f.time >= t0 - 1e-9);
          expect(shot, `${kind} 露出 t=${t0.toFixed(2)} (${dur.toFixed(2)}秒)`).toBeDefined();
          expect(shot!.time - t0, `${kind} 露出 t=${t0.toFixed(2)} の初弾までの待ち`).toBeLessThanOrEqual(Math.max(S.period, S.first) + SPEC.aiLatency + DT);
        }
        i = j;
      }
    }
  });

  it('各バーストの各発で射線を確認: 3発のバースト途中で遮蔽が入ると残りは撃たず、遮蔽の間に予定された発は失われる', () => {
    const wall = switchable('blk', -30, 0, -21, 30, 14, -19);
    const g = arena({ enemies: [spawn('guard', 'G01', 0, -45)], boxes: [wall], player: { x: 0, z: 0 } });
    setBox(g, 'blk', false);
    const rec = new Rec(g);
    rec.run(
      1.0,
      (gg, t) => {
        if (Math.abs(t - 0.55) < 1e-9) setBox(gg, 'blk', true); // 1発目(0.5)の後、2発目(0.62)の前
        if (Math.abs(t - 0.8) < 1e-9) setBox(gg, 'blk', false);
      },
    );
    const during = rec.fires.filter((f) => f.time >= 0.55 - 1e-9 && f.time < 0.8 - 1e-9);
    expect(during.length, '遮蔽中(0.55〜0.8)の発').toBe(0);
    expect(rec.fires[0].time).toBeCloseTo(0.5, 6);
    // 再露出(0.8)後の発は、保持された次回バースト時刻(1.7)以降
    rec.run(1.5);
    const later = rec.fires.filter((f) => f.time >= 0.8);
    expect(later[0].time).toBeGreaterThanOrEqual(1.7 - 1e-9);
    expect(later[0].time).toBeLessThanOrEqual(1.7 + SPEC.aiLatency + 1e-9);
  });
});

describe('§2.3 情報共有: 通路でつながる60m以内の警備だけに最後の確認位置を共有し、受信側は射線が無ければ撃てない', () => {
  // プレイヤー(0,0)。北(z<0)に幅60mの壁(z=-21)。警備Aは壁の東端の外側(25,-5)でプレイヤーを見ている (A→B の歩行経路は約49m)
  const scene = (): Game => {
    const wall = box(-30, 0, -22, 30, 14, -20);
    return arena({
      enemies: [
        spawn('guard', 'GA', 25, -5), // 射線あり
        spawn('guard', 'GB', 0, -30), // 壁の裏 (直線35m・歩行経路40m)
        spawn('guard', 'GC', -45, -45), // 壁の裏 (直線80m)
        spawn('guard', 'GD', 0, -150), // 遠方
      ],
      boxes: [wall],
      player: { x: 0, z: 0 },
    });
  };
  it('射線のある警備Aの確認位置は、経路60m以内で射線の無いBだけが受け取る (遠いC・Dは受け取らず動かない)。受信者Bは0.5秒以内に動き出し、壁越しには撃たない', () => {
    const g = scene();
    const rec = new Rec(g);
    g.step();
    expect(enemyOf(g, 'GA').hasLineOfSight).toBe(true);
    expect(enemyOf(g, 'GB').hasLineOfSight, 'Bは壁の裏').toBe(false);
    expect(enemyOf(g, 'GC').hasLineOfSight).toBe(false);
    expect(enemyOf(g, 'GB').alert, 'Bは共有を受け取る').toBe(true);
    expect(getEnemyAI(enemyOf(g, 'GB'))!.lastKnownPos).toEqual({ x: 0, y: PH, z: 0 });
    expect(enemyOf(g, 'GC').alert).toBe(false);
    expect(enemyOf(g, 'GD').alert).toBe(false);
    const startB = { ...enemyOf(g, 'GB').pos };
    const startC = { ...enemyOf(g, 'GC').pos };
    const startD = { ...enemyOf(g, 'GD').pos };
    let moveStart = -1;
    rec.run(6, undefined, (gg) => {
      const b = enemyOf(gg, 'GB');
      if (moveStart < 0 && hspeed(b.vel) > 1) moveStart = gg.state.time - DT;
      // 受信側は自分に射線が無い間は撃たない
      if (!b.hasLineOfSight) expect(b.shotsFired === 0 || rec.of('GB').every((f) => !g.world.segmentBlocked(f.origin, f.pre.pos))).toBe(true);
    });
    expect(moveStart, 'Bの移動開始').toBeGreaterThanOrEqual(0);
    expect(moveStart).toBeLessThanOrEqual(SPEC.reactSeconds + 1e-9);
    for (const f of rec.of('GB')) expect(g.world.segmentBlocked(f.origin, f.pre.pos), 'Bの各発に射線').toBe(false);
    expect(Math.hypot(enemyOf(g, 'GB').pos.x - startB.x, enemyOf(g, 'GB').pos.z - startB.z), 'Bは確認位置へ向かって動いた').toBeGreaterThan(8);
    // 共有されていない遠方の警備は、プレイヤーの正確な現在位置を知らず、持ち場を離れず撃たない。
    // (Cは最初のtickでは受信しない。後でBが射線を得て認識すればBから共有され得るので、Cについては最初のtickの結果だけを見る)
    void startC;
    const d = enemyOf(g, 'GD');
    expect(d.alert, 'GD').toBe(false);
    expect(d.shotsFired, 'GD').toBe(0);
    expect(Math.hypot(d.pos.x - startD.x, d.pos.z - startD.z), 'GD は動かない').toBeLessThan(0.5);
  });

  it('共有は「警備ロボットが認識したとき」に限る: 砲台は警備へ共有せず、共有を受けた警備は8秒後に警戒を解除する', () => {
    const wall = box(-30, 0, -22, 30, 14, -20);
    const g = arena({ enemies: [spawn('turret', 'T01', 25, -5), spawn('guard', 'GB', 0, -30)], boxes: [wall], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    rec.run(1);
    expect(enemyOf(g, 'T01').hasLineOfSight).toBe(true);
    // 砲台の認識では警備が持ち場を離れて追跡することはない (SPEC: 共有するのは警備ロボット)
    const b = enemyOf(g, 'GB');
    expect(b.alert, '砲台からの共有は受けない').toBe(false);
    // 別実行: 警備Aが見ているが、Aが死んだ後は受信者は8秒だけ警戒を保つ
    const g2 = scene();
    g2.step();
    const gb = enemyOf(g2, 'GB');
    expect(gb.alert).toBe(true);
    damageEnemy(g2.state, enemyOf(g2, 'GA'), 1e9, 'machinegun');
    teleport(g2, { x: 300, y: PH, z: 300 }); // 誰にも見えない遠方へ (受信者は確認位置 (0,0) へ向かうが、プレイヤーは見えない)
    const t0 = g2.state.time;
    let releasedAt = -1;
    for (let i = 0; i < 12 * 120; i++) {
      g2.step();
      g2.drainEvents();
      if (releasedAt < 0 && !gb.alert) releasedAt = g2.state.time - DT - t0;
    }
    // 共有時刻(t=0)から8秒後に解除 (t0 は最初のtick後)
    expect(releasedAt).toBeGreaterThanOrEqual(SPEC.memory - 0.03);
    expect(releasedAt).toBeLessThanOrEqual(SPEC.memory + 0.05);
  });
});

describe('§2.3 敵弾: 掃引衝突・壁/床/設備で止まる・敵に当たらない・重力/誘導なし・時間だけでHPを減らさない', () => {
  it('飛行中の弾は、途中に現れた壁で止まりプレイヤーに当たらない (壁側にhitイベント)', () => {
    const wall = switchable('blk', -30, 0, -21, 30, 14, -20.8);
    const g = arena({ enemies: [spawn('turret', 'T01', 0, -60)], boxes: [wall], player: { x: 0, z: 0 }, hp: 1000 });
    setBox(g, 'blk', false);
    const rec = new Rec(g);
    while (g.state.enemyBullets.length === 0) rec.step();
    setBox(g, 'blk', true); // 弾は約1秒の飛行の途中(まだ壁の手前)
    rec.run(3);
    expect(rec.worldHits.length, '壁に当たった弾').toBeGreaterThanOrEqual(1);
    for (const h of rec.worldHits) expect(h.pos.z).toBeLessThan(-20.5);
    expect(rec.playerHits.length).toBe(0);
    expect(g.state.player.hp).toBe(1000);
  });

  it('床・設備(箱)で止まる: 下向きの弾は床で、横向きの弾は機械設備の箱で止まり、プレイヤーには当たらない', () => {
    const g = arena({ enemies: [], boxes: [box(10, 0, -5, 14, 6, 5, { mat: 'machine' })], player: { x: 30, z: 0 }, hp: 1000 });
    const s = g.state;
    const mk = (pos: V3, vel: V3): EnemyBullet => {
      const b: EnemyBullet = { id: s.nextProjectileId++, ownerId: 'G01', kind: 'guard', pos: { ...pos }, prevPos: { ...pos }, vel: { ...vel }, age: 0, maxLife: 2, damage: 18, radius: 0.2, alive: true };
      s.enemyBullets.push(b);
      return b;
    };
    s.player.prevPos = { ...s.player.pos };
    const down = mk({ x: 0, y: 0.6, z: 0 }, { x: 0, y: -70, z: 0 });
    stepEnemyBullets(s, g.world);
    expect(down.alive).toBe(false);
    expect(down.pos.y).toBeGreaterThanOrEqual(0 - 1e-6);
    const side = mk({ x: 0, y: 2, z: 0 }, { x: 900, y: 0, z: 0 }); // 7.5m/tick: 機械設備(x=10)まで
    for (let i = 0; i < 3; i++) stepEnemyBullets(s, g.world);
    expect(side.alive).toBe(false);
    expect(side.pos.x).toBeLessThanOrEqual(10 + 1e-6);
    expect(s.player.hp).toBe(1000);
    expect(s.events.filter((e) => e.type === 'hit' && e.on === 'world').length).toBe(2);
  });

  it('敵同士には当たらない: 砲台の弾は間にいる警備(標的用の静止体)を素通りし、警備のHPは変わらず、プレイヤーには当たる', () => {
    const g = arena({ enemies: [spawn('turret', 'T01', 0, -60), spawn('guard', 'G01', 0, -30)], player: { x: 0, z: 0 }, hp: 1000 });
    const mid = enemyOf(g, 'G01');
    mid.scripted = true; // 動かない・撃たない障害物代わりの標的 (この検査用)
    const rec = new Rec(g);
    rec.run(4);
    expect(mid.hp).toBe(120);
    expect(mid.alive).toBe(true);
    expect(rec.playerHits.length, '弾は敵を素通りしてプレイヤーへ').toBeGreaterThan(2);
  });

  it('移動区間の掃引衝突: QB(80m/s)でプレイヤーが射線を横切る/弾を追い越す/すり抜ける場合も、連続体としての基準判定と全tickで一致 (実Game)', () => {
    // 砲台2体が射撃し続ける中、プレイヤーがQBで往復する。各tickで、敵弾の[開始,終了]線分とプレイヤーAABBの相対運動を細かくサンプリングして基準を作る
    const g = arena({ enemies: [spawn('turret', 'T01', 0, -45), spawn('turret', 'T02', 30, -40), spawn('guard', 'G01', -30, -35)], player: { x: -20, z: 0 }, hp: 1e9 });
    const s = g.state;
    const H = { x: 0.8, y: 1.5, z: 0.8 };
    let checked = 0;
    let hits = 0;
    let misses = 0;
    let borderline = 0;
    for (let i = 0; i < 30 * 120; i++) {
      // 1.2秒ごとにQB(右/左交互): 押す→離すを1tickずつ
      const k = i % 144;
      g.input.right = Math.floor(i / 144) % 2 === 0;
      g.input.left = !g.input.right;
      g.input.qb = k === 0 || k === 1;
      // 各弾のtick開始時点の状態
      const before = new Map<number, { pos: V3; vel: V3; age: number; life: number; damage: number; radius: number }>();
      for (const b of s.enemyBullets) before.set(b.id, { pos: { ...b.pos }, vel: { ...b.vel }, age: b.age, life: b.maxLife, damage: b.damage, radius: b.radius });
      const hp0 = s.player.hp;
      g.step();
      const events = g.drainEvents();
      // このtickに生成された弾 (fire イベントの origin/dir から)
      const fresh: { pos: V3; vel: V3; life: number; damage: number; radius: number }[] = [];
      for (const ev of events) {
        if (ev.type !== 'enemyFire') continue;
        const S = SPEC[kindOfId(ev.id)];
        fresh.push({ pos: ev.origin, vel: { x: ev.dir.x * S.speed, y: ev.dir.y * S.speed, z: ev.dir.z * S.speed }, life: S.life, damage: S.damage, radius: ev.id.startsWith('G') ? 0.2 : 0.25 });
      }
      const all = [...[...before.values()].map((b) => ({ ...b })), ...fresh.map((f) => ({ ...f, age: 0 }))];
      // プレイヤーの移動 (prevPos -> pos)
      const pp = s.player.prevPos;
      const pc = s.player.pos;
      let expectedDamage = 0;
      let border = false;
      for (const b of all) {
        const dtEff = Math.min(DT, b.life - b.age);
        if (!(dtEff > 0)) continue;
        const frac = dtEff / DT;
        const overlapAt = (m: number): boolean => {
          const N = 400;
          for (let q = 0; q <= N; q++) {
            const t = q / N;
            const bx = b.pos.x + b.vel.x * dtEff * t;
            const by = b.pos.y + b.vel.y * dtEff * t;
            const bz = b.pos.z + b.vel.z * dtEff * t;
            const cx = pp.x + (pc.x - pp.x) * t * frac;
            const cy = pp.y + (pc.y - pp.y) * t * frac;
            const cz = pp.z + (pc.z - pp.z) * t * frac;
            if (Math.abs(bx - cx) <= H.x + b.radius + m && Math.abs(by - cy) <= H.y + b.radius + m && Math.abs(bz - cz) <= H.z + b.radius + m) return true;
          }
          return false;
        };
        const strict = overlapAt(-0.03);
        const loose = overlapAt(0.03);
        if (strict !== loose) border = true;
        else if (strict) expectedDamage += b.damage;
      }
      const dmg = hp0 - s.player.hp;
      if (border) {
        borderline++;
        continue;
      }
      expect(dmg, `tick ${s.tick}: 基準判定のダメージと一致`).toBe(expectedDamage);
      checked++;
      if (dmg > 0) hits++;
      else misses++;
    }
    console.info(`[swept QB] ticks checked ${checked}, damaging ticks ${hits}, non-damaging ${misses}, borderline skipped ${borderline}`);
    expect(checked).toBeGreaterThan(3000);
    expect(hits).toBeGreaterThan(3);
    expect(misses).toBeGreaterThan(100);
  });

  it('時間だけではHPが減らない: 射線のない実ステージ出撃地点で120秒放置してもHPは1000のまま、敵弾も生成されない', () => {
    const g = realGame();
    const s = g.state;
    expect(s.enemies.some((e) => e.hasLineOfSight)).toBe(false);
    let bulletsSeen = 0;
    for (let i = 0; i < 120 * 120; i++) {
      g.step();
      g.drainEvents();
      bulletsSeen += s.enemyBullets.length;
      if (i < 5) expect(s.player.hp, '開始直後(入力受付前)に被弾しない').toBe(1000);
    }
    expect(s.player.hp).toBe(1000);
    expect(s.damageTaken).toBe(0);
    expect(bulletsSeen).toBe(0);
    expect(s.enemies.every((e) => e.shotsFired === 0 && !e.alert)).toBe(true);
    expect(s.mode).toBe('playing');
  });

  it('HPの減少は全て被弾イベントに対応する: 全部の敵が撃つ実ステージの戦闘で HP = 初期値 - Σ(playerHitのダメージ)、被弾ごとに敵弾が1発消える', () => {
    const g = realGame();
    const s = g.state;
    teleport(g, sectorCenter('S02'));
    s.player.hp = 1000;
    const rec = new Rec(g);
    rec.run(8);
    const total = rec.playerHits.reduce((a, h) => a + h.damage, 0);
    expect(total).toBeGreaterThan(0);
    expect(1000 - s.player.hp).toBe(Math.min(1000, total));
    expect(rec.hitOnPlayerEvents).toBe(rec.playerHits.length);
    expect(s.damageTaken).toBe(total);
    for (const h of rec.playerHits) expect([18, 40]).toContain(h.damage);
  });
});

describe('§2.3 警備ロボットの移動 (距離帯・速度) と固定砲台は動かない', () => {
  interface Tick { d: number; speed: number; radial: number; lateral: number; vy: number }
  function trace(dist0: number, seconds: number, playerForward = false): Tick[] {
    const g = arena({ enemies: [spawn('guard', 'G01', 0, -dist0)], player: { x: 0, z: 400 - 400 } });
    const e = enemyOf(g, 'G01');
    const out: Tick[] = [];
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      g.input.forward = playerForward;
      const gp = { ...e.pos };
      const pp = { ...g.state.player.pos };
      g.step();
      g.drainEvents();
      const dx = pp.x - gp.x;
      const dz = pp.z - gp.z;
      const dh = Math.hypot(dx, dz);
      const d3 = dist(gp, pp);
      out.push({ d: d3, speed: hspeed(e.vel), radial: (e.vel.x * dx + e.vel.z * dz) / dh, lateral: (-e.vel.x * dz + e.vel.z * dx) / dh, vy: e.vel.y });
    }
    return out;
  }
  const inBand = (ticks: Tick[], lo: number, hi: number): Tick[] => ticks.filter((k) => k.d > lo && k.d < hi);

  it('55mを超える距離では8m/sで接近する (静止プレイヤー / 前進するプレイヤー)', () => {
    for (const fwd of [false, true]) {
      const t = inBand(trace(85, 2.5, fwd), 55.05, 1e9);
      expect(t.length).toBeGreaterThan(30);
      for (const k of t) {
        expect(k.speed).toBeCloseTo(8, 6);
        expect(k.radial, '接近').toBeGreaterThan(8 * 0.95);
        expect(k.vy).toBe(0);
      }
    }
  });

  it('25〜55mでは6m/sの側方移動 (視線変更): 速度6m/s、半径方向成分はほぼ0、向きを何度も切り替える', () => {
    const ticks = trace(40, 16);
    for (const k of inBand(ticks, 30, 50)) {
      expect(k.speed).toBeCloseTo(6, 6);
      expect(Math.abs(k.radial)).toBeLessThan(0.6);
    }
    for (const k of ticks) expect(k.speed).toBeCloseTo(6, 6); // 40mを保つ間、常に側方移動
    let flips = 0;
    let last = 0;
    for (const k of ticks) {
      const sgn = Math.sign(k.lateral);
      if (sgn !== 0 && sgn !== last) {
        if (last !== 0) flips++;
        last = sgn;
      }
    }
    expect(flips, '側方移動の向きの切り替え').toBeGreaterThanOrEqual(3);
    // 帯の端(25〜30, 50〜55)でも速度は6m/s
    for (const k of [...inBand(trace(28, 3), 25.05, 30), ...inBand(trace(53, 3), 50, 54.95)]) expect(k.speed).toBeCloseTo(6, 6);
  });

  it('15m未満は8m/sを上限に距離を取る (遠ざかる)。15〜25mは状況に応じて距離を調整 (8m/s以下)', () => {
    for (const fwd of [false, true]) {
      const near = inBand(trace(9, 1.5, fwd), 0, 14.95);
      expect(near.length).toBeGreaterThan(30);
      for (const k of near) {
        expect(k.speed).toBeLessThanOrEqual(8 + 1e-6);
        expect(k.speed).toBeGreaterThan(8 - 1e-6);
        expect(k.radial, '距離を取る').toBeLessThan(0);
      }
      const mid = inBand(trace(20, 1.5, fwd), 15.05, 24.95);
      expect(mid.length).toBeGreaterThan(30);
      for (const k of mid) expect(k.speed).toBeLessThanOrEqual(8 + 1e-6);
    }
    // どの状況でも8m/sを超えない
    for (const d0 of [10, 20, 40, 70, 100]) for (const k of trace(d0, 2, true)) expect(k.speed).toBeLessThanOrEqual(8 + 1e-6);
  });

  it('固定砲台は動かない: 合成アリーナで撃ちながらも位置・速度が不変。実ステージS02/S05/S12でプレイヤーが動き回る60秒間も全砲台の位置は初期のまま', () => {
    const g = arena({ enemies: [spawn('turret', 'T01', 0, -60)], player: { x: 0, z: 0 } });
    const home = { ...enemyOf(g, 'T01').pos };
    const rec = new Rec(g);
    rec.run(5, undefined, (gg) => {
      const e = enemyOf(gg, 'T01');
      expect(e.pos).toEqual(home);
      expect(e.vel).toEqual({ x: 0, y: 0, z: 0 });
    });
    for (const sec of ['S02', 'S05', 'S12']) {
      const gr = realGame();
      teleport(gr, sectorCenter(sec));
      gr.state.player.hp = 1e9;
      const homes = new Map(gr.state.enemies.filter((e) => e.kind === 'turret').map((e) => [e.id, { ...e.pos }]));
      for (let i = 0; i < 60 * 120; i++) {
        gr.input.right = Math.floor(i / 240) % 2 === 0;
        gr.input.left = !gr.input.right;
        gr.input.qb = i % 360 === 0;
        gr.step();
        gr.drainEvents();
        for (const e of gr.state.enemies) {
          if (e.kind !== 'turret') continue;
          expect(e.pos, `${e.id} の位置`).toEqual(homes.get(e.id));
          expect(e.vel.x === 0 && e.vel.y === 0 && e.vel.z === 0, `${e.id} の速度`).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 実ステージでの検証
// ---------------------------------------------------------------------------------------------------------------------
/**
 * 敵の周囲で、プレイヤーが立てる接地位置(中心座標)のうち、銃口から射線が通り、弾(球)も遮られないものを、
 * 方位が90度以上離れたものから最大 n 個返す (見え方が縁ぎりぎりの位置を避けるため複数用意する)
 */
function standPositionsNear(g: Game, e: { pos: V3; kind: Kind }, rMin: number, rMax: number, maxRange: number, n = 1): V3[] {
  const nav = getNav(g.world, REAL);
  const m = { x: e.pos.x, y: e.pos.y + 0.4, z: e.pos.z };
  const bulletR = e.kind === 'guard' ? 0.2 : 0.25;
  const out: V3[] = [];
  const azimuths: number[] = [];
  for (let r = rMin; r <= rMax; r += 4) {
    for (let a = 0; a < 32; a++) {
      const th = ((a + (r % 8 === 0 ? 0.5 : 0)) / 32) * Math.PI * 2;
      if (azimuths.some((t) => Math.abs(Math.atan2(Math.sin(th - t), Math.cos(th - t))) < Math.PI / 2)) continue;
      const x = e.pos.x + Math.cos(th) * r;
      const z = e.pos.z + Math.sin(th) * r;
      for (const refY of [e.pos.y, e.pos.y - 6, e.pos.y - 12]) {
        const feet = nav.floorBelow(x, z, refY, 4);
        if (feet === null) continue;
        const pos = { x, y: feet + PH, z };
        if (dist(m, pos) > maxRange) continue;
        if (g.world.overlapAABB(pos, { x: 0.8, y: 1.5, z: 0.8 }, 0.05)) continue;
        if (g.world.segmentBlocked(m, pos)) continue;
        if (g.world.sweepSphere(m, pos, bulletR)) continue;
        out.push(pos);
        azimuths.push(th);
        if (out.length >= n) return out;
        break;
      }
    }
  }
  return out;
}
const standPositionNear = (g: Game, e: { pos: V3; kind: Kind }, rMin: number, rMax: number, maxRange: number): V3 | null => standPositionsNear(g, e, rMin, rMax, maxRange, 1)[0] ?? null;

describe('§2.3 実ステージ: 全45体がそれぞれ実際に攻撃でき、弾が届く (攻撃不能なダミーがいない)', () => {
  it('各敵を単独で置き、射線の通る接地位置(方位の異なる最大3か所)に静止したプレイヤーを立たせると、撃ち、5秒以内に少なくとも1発が命中する', () => {
    const failed: string[] = [];
    const noPos: string[] = [];
    const late: string[] = [];
    for (const sp of REAL.enemies) {
      const iso: StageDef = { ...REAL, enemies: [sp] };
      const g = new Game({ stage: iso });
      g.sortie();
      const e = g.state.enemies[0];
      const range = sp.kind === 'guard' ? 90 : 120;
      const poss = standPositionsNear(g, e, sp.kind === 'guard' ? 25 : 30, sp.kind === 'guard' ? 60 : 100, range * 0.85, 3);
      if (poss.length === 0) {
        noPos.push(sp.id);
        continue;
      }
      // 警備は横移動するので、縁ぎりぎりの見え方では0.5秒の露出が続かないことがある。方位の異なる最大3か所のどれかで撃てばよい
      let fired = false;
      let hit = false;
      for (const pos of poss) {
        const g2 = new Game({ stage: iso });
        g2.sortie();
        teleport(g2, pos);
        g2.state.player.hp = 1e9;
        const rec = new Rec(g2);
        rec.run(1.5);
        if (rec.fires.length > 0) fired = true;
        rec.run(4);
        if (rec.playerHits.length > 0) hit = true;
        if (fired && hit) break;
      }
      if (!fired) late.push(sp.id);
      if (!hit) failed.push(sp.id);
    }
    console.info(`[attack ability] no stand position: ${noPos.join(',') || '(none)'}; no shot within 1.5 s at any of 3 spots: ${late.join(',') || '(none)'}; no hit within 5 s: ${failed.join(',') || '(none)'}`);
    expect(noPos, '射線の通る立ち位置が見つからない敵').toEqual([]);
    expect(late, '射線がある(3か所の立ち位置のどれでも)のに撃たない敵').toEqual([]);
    expect(failed, '5秒間 静止したプレイヤーに1発も当たらない敵').toEqual([]);
  });

  it('警備30体は実際に動く: 各警備を単独で置き、離れた場所で射線を得た後に動き回る。5秒間に必ず2m以上移動する (足場が無い・壁に埋まって動けない警備がいない)', () => {
    const stuck: string[] = [];
    for (const sp of REAL.enemies.filter((x) => x.kind === 'guard')) {
      const iso: StageDef = { ...REAL, enemies: [sp] };
      const g = new Game({ stage: iso });
      g.sortie();
      const e = g.state.enemies[0];
      const pos = standPositionNear(g, e, 40, 70, 80);
      if (!pos) continue;
      teleport(g, pos);
      g.state.player.hp = 1e9;
      g.step();
      const p0 = { ...e.pos };
      let maxDisp = 0;
      for (let i = 0; i < 5 * 120; i++) {
        g.step();
        g.drainEvents();
        maxDisp = Math.max(maxDisp, Math.hypot(e.pos.x - p0.x, e.pos.z - p0.z));
      }
      if (maxDisp < 2) stuck.push(`${sp.id}(${maxDisp.toFixed(2)}m)`);
    }
    expect(stuck).toEqual([]);
  });
});

describe('§2.3 実ステージ: 射線を失った警備は最後の確認位置へ向かって動き続け、障害物に押し付いて止まらない', () => {
  it('30体の警備それぞれ・方位の異なる最大3か所で: 射線を得て交戦した後プレイヤーが消えても、警戒中は5秒間に0.5秒を超えて立ち止まらない (確認位置へ歩いて到達できる場合)', () => {
    const problems: string[] = [];
    let trials = 0;
    for (const sp of REAL.enemies.filter((x) => x.kind === 'guard')) {
      const iso: StageDef = { ...REAL, enemies: [sp] };
      const g0 = new Game({ stage: iso });
      g0.sortie();
      const poss = standPositionsNear(g0, g0.state.enemies[0], 30, 60, 80, 3);
      for (const pos of poss) {
        const g = new Game({ stage: iso });
        g.sortie();
        const s = g.state;
        const e = s.enemies[0];
        teleport(g, pos);
        s.player.hp = 1e9;
        for (let i = 0; i < 120; i++) g.step(); // 1秒交戦
        g.drainEvents();
        if (!e.hasLineOfSight) continue;
        // プレイヤーは遠方(別の区画)へ消える。確認位置はposのまま
        teleport(g, { x: 700, y: 25.5, z: 400 });
        const nav = getNav(g.world, REAL);
        let stillFor = 0;
        let worst = 0;
        const ai = getEnemyAI(e)!;
        let reachable: boolean | null = null;
        let stuckAt = '';
        trials++;
        for (let i = 0; i < 5 * 120; i++) {
          g.step();
          g.drainEvents();
          expect(e.hasLineOfSight).toBe(false);
          const lk = ai.lastKnownPos;
          if (i === 0) reachable = lk ? nav.pathLength({ x: e.pos.x, y: ai.floorY, z: e.pos.z }, { x: lk.x, y: lk.y - PH, z: lk.z }) !== null : false;
          const far = lk ? Math.hypot(lk.x - e.pos.x, lk.z - e.pos.z) > 4 : false;
          if (e.alert && far && hspeed(e.vel) < 0.3) stillFor += DT;
          else stillFor = 0;
          if (stillFor > worst) {
            worst = stillFor;
            stuckAt = `(${e.pos.x.toFixed(1)}, ${e.pos.y.toFixed(1)}, ${e.pos.z.toFixed(1)})`;
          }
        }
        if (reachable && worst > SPEC.reactSeconds + 1e-9) problems.push(`${sp.id} 立ち位置(${pos.x.toFixed(0)},${pos.z.toFixed(0)}): 警戒中・確認位置まで4m以上・歩いて到達可能なのに ${worst.toFixed(2)} 秒立ち止まった @${stuckAt}`);
      }
    }
    console.info(`[pursuit] guard x stand-position trials: ${trials}; stuck: ${problems.length}\n${problems.join('\n')}`);
    expect(trials).toBeGreaterThanOrEqual(60);
    expect(problems).toEqual([]);
  });

  it('最小再現: 床が12m途切れる隙間を挟んで隣の翼にいたプレイヤーを見失った警備は、隣の広い床を歩いて回り込めるのに、翼の端(床の縁の格子線)に押し付いて警戒が切れるまで立ち止まってはならない', () => {
    // 床は3枚の格子床: A(x -22..0, z 0..150), B1(x 0..8, z 0..60), B2(x 0..8, z 72..150)。B1とB2の間は12mの空洞。
    // 警備はB1、プレイヤーはB2に立つ。1秒交戦した後プレイヤーが遠方へ消える。警備の最後の確認位置はB2 (Aを歩いて回り込める)。
    const slab = (id: string, x0: number, z0: number, x1: number, z1: number): BoxDef => ({ id, min: { x: x0, y: -2, z: z0 }, max: { x: x1, y: 0, z: z1 }, mat: 'grating', sectorId: 'T00' });
    for (const gx of [1, 4, 7]) {
      const stage = buildTestArenaStage({ floorHalf: 0 });
      stage.boxes.push(slab('A', -22, 0, 0, 150), slab('B1', 0, 0, 8, 60), slab('B2', 0, 72, 8, 150));
      stage.enemies = [spawn('guard', 'G01', gx, 30)];
      stage.playerStart = { pos: { x: 4, y: PH, z: 78 }, yaw: 0 };
      const g = new Game({ stage });
      g.sortie();
      const s = g.state;
      s.player.hp = 1e9;
      const e = s.enemies[0];
      for (let i = 0; i < 120; i++) g.step();
      g.drainEvents();
      expect(e.hasLineOfSight, '交戦している').toBe(true);
      let still = 0;
      let worst = 0;
      for (let i = 0; i < 8 * 120; i++) {
        teleport(g, { x: 4, y: PH, z: 400 }); // 遠方(射程外)へ消えたまま
        g.step();
        g.drainEvents();
        if (e.alert && hspeed(e.vel) < 0.3) still += DT;
        else still = 0;
        worst = Math.max(worst, still);
      }
      expect(e.alert || worst > 0, 'まだ警戒中に評価している').toBe(true);
      expect(worst, `警備(x=${gx})が警戒中に立ち止まった最長秒数 (最終位置 ${e.pos.x.toFixed(2)}, ${e.pos.z.toFixed(2)})`).toBeLessThanOrEqual(SPEC.reactSeconds + 1e-9);
    }
  });

  it('実ステージS02 (警備4体): 1体の認識が共有され、受信者は0.5秒以内に動き出し、確認位置へ向かい続ける。共有を受けた警備は自分に射線が無い間は撃たない', () => {
    const g = realGame();
    const s = g.state;
    const rec = new Rec(g);
    // G04 (168,40) の近くに立つ
    const g04 = enemyOf(g, 'G04');
    const pos = standPositionNear(g, g04, 30, 50, 80)!;
    expect(pos).not.toBeNull();
    teleport(g, pos);
    s.player.hp = 1e9;
    const alertedAt = new Map<string, number>();
    const firstMove = new Map<string, number>();
    rec.run(4, undefined, (gg) => {
      const T = gg.state.time - DT;
      for (const e of gg.state.enemies) {
        if (e.kind !== 'guard') continue;
        if (e.alert && !e.hasLineOfSight && !alertedAt.has(e.id)) alertedAt.set(e.id, T);
        const a = alertedAt.get(e.id);
        if (a !== undefined && !firstMove.has(e.id) && hspeed(e.vel) > 1) firstMove.set(e.id, T - a);
      }
    });
    for (const [id, a] of alertedAt) {
      const e = enemyOf(g, id);
      const moved = firstMove.get(id);
      // 共有で警戒になった警備は0.5秒以内に動き始める (すでに動いている・到達不能な位置は除く: 動き出した時刻が記録されていること)
      expect(moved, `${id} (警戒 t=${a.toFixed(2)}) の移動開始`).toBeDefined();
      expect(moved!, `${id} の移動開始までの秒数`).toBeLessThanOrEqual(SPEC.reactSeconds + 1e-9);
      void e;
    }
    expect(alertedAt.size, '共有・視認で警戒に入った警備').toBeGreaterThanOrEqual(1);
    for (const f of rec.fires) expect(g.world.segmentBlocked(f.origin, f.pre.pos), `${f.id} の各発に射線`).toBe(false);
  });
});

describe('§2.3 実ステージ: 距離55m超の警備は (歩いて到達できる場所にいるプレイヤーへ) 実際に接近する', () => {
  it('30体の警備それぞれ・射線のある57〜88mの到達可能な立ち位置(最大3か所)で静止するプレイヤーへ、8秒以内に 8m以上近づくか55m以内に入る (立ち止まって動かない警備がいない)', () => {
    const failed: string[] = [];
    let trials = 0;
    for (const sp of REAL.enemies.filter((x) => x.kind === 'guard')) {
      const iso: StageDef = { ...REAL, enemies: [sp] };
      const g0 = new Game({ stage: iso });
      g0.sortie();
      const nav = getNav(g0.world, REAL);
      const e0 = g0.state.enemies[0];
      const feetE = { x: e0.pos.x, y: e0.pos.y - 1.5, z: e0.pos.z };
      const cands = standPositionsNear(g0, e0, 58, 84, 88, 12).filter((p) => nav.pathLength(feetE, { x: p.x, y: p.y - PH, z: p.z }) !== null && dist(enemyMuzzlePosition(e0), p) > 57);
      for (const pos of cands.slice(0, 3)) {
        const g = new Game({ stage: iso });
        g.sortie();
        teleport(g, pos);
        g.state.player.hp = 1e9;
        const e = g.state.enemies[0];
        const d0 = dist(e.pos, pos);
        let dMin = d0;
        for (let i = 0; i < 8 * 120; i++) {
          g.step();
          g.drainEvents();
          dMin = Math.min(dMin, dist(e.pos, pos));
        }
        trials++;
        if (!(d0 - dMin >= 8 || dMin <= 55)) failed.push(`${sp.id} 立ち位置(${pos.x.toFixed(0)},${pos.y.toFixed(1)},${pos.z.toFixed(0)}): ${d0.toFixed(1)}m -> 最小 ${dMin.toFixed(1)}m`);
      }
    }
    console.info(`[approach] guard x stand-position trials: ${trials}; not approaching: ${failed.length}\n${failed.join('\n')}`);
    expect(trials).toBeGreaterThanOrEqual(50);
    expect(failed).toEqual([]);
  });
});

describe('§2.3 攻撃の積極性 (HP1000の静止プレイヤー / 35〜50mの警備2体+固定砲台1体 / 遮蔽なし): 15秒以内に撃破される', () => {
  it('シード・配置を変えた60通りの全てで15秒以内に撃破される。ダメージは通常の敵弾のみ (HP減少 = 命中した弾のダメージ合計)', () => {
    const times: number[] = [];
    for (let n = 0; n < 60; n++) {
      const rng = new Rng(31337 + n);
      const at = (id: string, kind: Kind): EnemySpawn => {
        const d = rng.range(35, 50);
        const a = rng.range(0, Math.PI * 2);
        return spawn(kind, id, Math.cos(a) * d, Math.sin(a) * d);
      };
      const g = arena({ enemies: [at('G01', 'guard'), at('G02', 'guard'), at('T01', 'turret')], player: { x: 0, z: 0 }, yaw: rng.range(0, 6.2), hp: 1000, seed: 1000 + n * 977 });
      const rec = new Rec(g);
      for (let i = 0; i < 20 * 120 && g.state.mode === 'playing'; i++) rec.step();
      expect(g.state.mode, `配置${n}`).toBe('failed');
      expect(g.state.endReason).toBe('hp');
      expect(g.state.damageTaken).toBe(rec.playerHits.reduce((a, h) => a + h.damage, 0));
      times.push(g.state.time);
    }
    console.info(`[aggressiveness] kill time over 60 arrangements: min ${Math.min(...times).toFixed(2)} s, max ${Math.max(...times).toFixed(2)} s`);
    expect(Math.max(...times)).toBeLessThanOrEqual(15);
  });
});

// =====================================================================================================================
// §9 状態管理と安定性
// =====================================================================================================================
const ALL_LOADOUTS: Loadout[] = [];
for (const fcs of ['wide', 'medium', 'narrow'] as const) for (const generator of ['capacity', 'balanced', 'recovery'] as const) for (const legs of ['biped', 'quadruped'] as const) ALL_LOADOUTS.push({ fcs, generator, legs });
const MAX_EN: Record<Loadout['generator'], number> = { capacity: 180, balanced: 120, recovery: 90 };

/**
 * 決定的な入力スクリプト (tick の関数)。全機能を使う: 3武器・射撃・ロック・QB(パルス)・グライド切替(パルス)・飛行(押し続け)・視点。
 * エッジ入力(QB/Shift)は2tickのパルス、Space は押し続けなので、一時停止は「パルス/押し続けの最中」を避ける。
 */
function chaosScript(g: Game, tick: number): void {
  const t = tick / 120;
  const i = g.input;
  i.fire = t >= 0.2;
  i.right = Math.floor(t / 1.7) % 2 === 0;
  i.left = !i.right;
  i.forward = Math.floor(t / 2.3) % 3 === 0;
  i.back = Math.floor(t / 2.3) % 3 === 1;
  i.qb = [36, 180, 324, 470].some((k) => tick >= k && tick < k + 2);
  i.shift = tick >= 60 && tick < 62;
  i.jump = tick >= 360 && tick < 430;
  if (tick === 0) i.weaponSelect = 'machinegun';
  if (tick === 150) i.weaponSelect = 'beam';
  if (tick === 300) i.weaponSelect = 'missile';
  if (tick === 450) i.weaponSelect = 'machinegun';
  if (tick % 10 === 0) g.look(Math.sin(tick / 50) * 8, Math.cos(tick / 70) * 3);
}
/** 実ステージS02で戦闘を始める (プレイヤーを戦闘区画へ置く) */
function combatGame(o: { seed?: number; loadout?: Loadout; hp?: number } = {}): Game {
  const g = realGame({ seed: o.seed, loadout: o.loadout });
  teleport(g, sectorCenter('S02'));
  g.state.player.hp = o.hp ?? 1e9;
  return g;
}
/**
 * 合成アリーナの戦闘場面 (ロック完了・ミサイル・ビーム・QB・飛行・敵弾が全て起きる)。砲台2体と警備2体が前方にいて、プレイヤーは動かず狙う。
 * 実ステージの chaosScript ではENが尽きてQB/ミサイルが不成立になるので、それを補う。
 */
function richArena(seed: number): Game {
  return arena({
    enemies: [spawn('turret', 'T01', 0, -60), spawn('turret', 'T02', 25, -80), spawn('guard', 'G01', -20, -50), spawn('guard', 'G02', 30, -35)],
    player: { x: 0, z: 0 },
    seed,
    hp: 1e9,
  });
}
function richScript(g: Game, tick: number): void {
  const t = tick / 120;
  const i = g.input;
  i.fire = t >= 0.2 && t < 5.5;
  i.forward = tick >= 200 && tick < 202;
  i.back = tick >= 500 && tick < 502;
  i.qb = (tick >= 200 && tick < 202) || (tick >= 500 && tick < 502);
  i.jump = tick >= 380 && tick < 440;
  if (tick === 0) i.weaponSelect = 'machinegun';
  if (tick === 110) i.weaponSelect = 'missile';
  if (tick === 250) i.weaponSelect = 'beam';
  if (tick === 350) i.weaponSelect = 'missile';
  if (tick === 480) i.weaponSelect = 'machinegun';
}
function runScript(g: Game, from: number, to: number, script: (g: Game, tick: number) => void = chaosScript, pauseAt: readonly number[] = []): void {
  for (let tick = from; tick < to; tick++) {
    if (pauseAt.includes(tick)) {
      g.pause();
      const d0 = dumpGame(g);
      expect(g.advance(0.25)).toBe(0);
      for (let k = 0; k < 40; k++) g.advance(1);
      g.step();
      g.look(30, 30);
      expect(diffPaths(d0, dumpGame(g)), `一時停止中(tick ${tick})に状態が進んだ`).toEqual([]);
      g.resume();
    }
    script(g, g.state.tick);
    g.step();
  }
}

describe('§9 一時停止・再開', () => {
  it('一時停止中は敵・弾・HP・EN・ロック・待ち時間・QB・敵の予告/バースト/警戒記憶・ミサイルの全てが進まない (全フィールド比較・advance/step/look を呼んでも不変)', () => {
    const g = combatGame({ hp: 100000 });
    const s = g.state;
    runScript(g, 0, 452); // QB(パルス470手前)・ミサイル発射後・敵弾が飛んでいる
    // ミサイルとQB噴射・敵の予告/バーストが進行中の状態を作る: ミサイルを撃つ
    expect(s.enemyBullets.length + s.bullets.length).toBeGreaterThan(0);
    g.pause();
    expect(s.mode).toBe('paused');
    const before = dumpGame(g);
    const snap = buildSnapshot(s);
    expect(snap.state).toBe('paused');
    for (let i = 0; i < 30; i++) {
      expect(g.advance(0.25)).toBe(0);
      g.step();
      g.look(500, -500);
      g.setViewport(1280, 720);
      g.input.fire = false;
    }
    expect(diffPaths(before, dumpGame(g))).toEqual([]);
    expect(buildSnapshot(s)).toEqual(snap);
    // 敵の内部(予告・バースト・警戒記憶)も不変であることを明示的に
    for (const e of s.enemies) {
      const ai = getEnemyAI(e);
      if (!ai) continue;
      expect(plain(ai)).toEqual((plain(getEnemyAI(e)) as object));
    }
    expect(s.time).toBeCloseTo(snap.elapsedSeconds, 12);
  });

  it('一時停止は時間の進行に対して透明: 入力スクリプトが同じなら、途中で何度(長時間)一時停止・再開しても最終状態が(乱数を含めて)完全に同一', () => {
    const A = combatGame();
    runScript(A, 0, 600);
    const B = combatGame();
    runScript(B, 0, 600, chaosScript, [100, 250, 340, 440, 520]);
    expect(diffPaths(dumpGame(A), dumpGame(B))).toEqual([]);
    expect(B.state.tick).toBe(600);
    expect(B.state.time).toBe(A.state.time);
    // 何かが実際に起きた (自明な一致ではない)。QBのパルスは4回だが、ビーム連射でENが尽きた後の2回はEN不足で不成立になる(SPEC §6: 不成立)
    expect(A.state.player.mv.qbSuccessCount).toBeGreaterThanOrEqual(2);
    expect(A.state.enemies.reduce((a, e) => a + e.shotsFired, 0)).toBeGreaterThan(10);
    expect(A.state.player.ammo.machinegun).toBeLessThan(300);
  });

  it('一時停止は時間の進行に対して透明 (合成アリーナ: ロック完了・ミサイル飛行中・QB噴射中・ビーム・敵弾多数): 噴射/ミサイル/バースト/予告の途中で何度停止・再開しても最終状態が完全に同一', () => {
    const A = richArena(5);
    runScript(A, 0, 700, richScript);
    const B = richArena(5);
    // 100: ロック進行中/敵弾飛行中, 125: ミサイル飛行中(ロック完了), 205: QB噴射中, 260: 2発目のミサイル飛行中, 350/470: ビーム後・敵バースト中
    runScript(B, 0, 700, richScript, [100, 125, 205, 260, 350, 470]);
    expect(diffPaths(dumpGame(A), dumpGame(B))).toEqual([]);
    expect(B.state.tick).toBe(700);
    // 自明な一致ではない: 3武器・QB・ロック完了・ミサイル・被弾・撃破が実際に起きている
    const weapons = new Set(A.state.shots.map((x) => x.weapon));
    expect(weapons.has('machinegun') && weapons.has('beam') && weapons.has('missile')).toBe(true);
    expect(A.state.player.mv.qbSuccessCount).toBe(2);
    expect(A.state.player.ammo.missile).toBeLessThan(12);
    expect(A.state.damageTaken).toBeGreaterThan(0);
    expect(A.state.enemies.filter((e) => !e.alive).length).toBeGreaterThanOrEqual(1);
    expect(A.state.enemies.reduce((a, e) => a + e.shotsFired, 0)).toBeGreaterThan(30);
  });

  it('一時停止中の全フィールド不変 (合成アリーナ・ミサイル飛行中かつQB噴射中に停止): ミサイル/QB/ロック/待ち時間/敵の予告・バースト記憶/射撃解の更新時刻が停止中に進まない', () => {
    const g = richArena(5);
    runScript(g, 0, 205, richScript); // tick 205: QB噴射(200開始, 0.15秒)の途中, 第1ミサイル飛行中
    const s = g.state;
    expect(s.missiles.length, '飛行中のミサイルがある').toBeGreaterThanOrEqual(1);
    expect(s.player.mv.qbImpulseRemaining, 'QB噴射の途中').toBeGreaterThan(0);
    expect(s.lock.state).toBe('locked');
    expect(s.enemyBullets.length).toBeGreaterThan(0);
    expect(s.enemies.some((e) => e.telegraph > 0 || (getEnemyAI(e)?.nextBurstAt ?? null) !== null)).toBe(true);
    g.pause();
    const before = dumpGame(g);
    const snap = buildSnapshot(s);
    const missile = { ...s.missiles[0], pos: { ...s.missiles[0].pos } };
    for (let i = 0; i < 20; i++) {
      expect(g.advance(0.25)).toBe(0);
      g.step();
      g.look(200, 200);
      g.input.qb = true; // 入力は一時停止中は無視される (状態を進めない)
      g.input.fire = true;
    }
    g.input.qb = false;
    g.input.fire = false;
    expect(diffPaths(before, dumpGame(g))).toEqual([]);
    expect(buildSnapshot(s)).toEqual(snap);
    expect(s.missiles[0].pos).toEqual(missile.pos);
    expect(s.missiles[0].age).toBe(missile.age);
    expect(s.player.mv.qbImpulseRemaining).toBe(snap.player.movement.qbImpulseRemainingSeconds);
    expect(s.player.mv.qbCooldownRemaining).toBe(snap.player.movement.qbCooldownRemainingSeconds);
    expect(s.fc.evaluatedAtSeconds).toBe(snap.fireControl.evaluatedAtSeconds);
    g.resume();
    // 再開後は1 tickずつ普通に進む
    expect(g.advance(1 / 120)).toBe(1);
    expect(s.tick).toBe(206);
    expect(s.player.mv.qbImpulseRemaining).toBeLessThan(snap.player.movement.qbImpulseRemainingSeconds);
  });

  it('QB噴射の途中(0.15秒の噴射・慣性)で一時停止して長時間経っても、再開後の移動は中断なしと同一 (噴射時間・慣性・グライドが停止中に進まない)', () => {
    const mk = () => arena({ enemies: [], player: { x: 0, z: 0 } });
    const script = (g: Game, tick: number) => {
      g.input.qb = tick === 5;
      g.input.right = tick < 200;
    };
    const A = mk();
    runScript(A, 0, 120, script);
    const B = mk();
    runScript(B, 0, 120, script, [8, 30]); // 8: 噴射中(残り約0.09秒) / 30: 慣性減速中 (入力qbは離れているのでパルス/エッジ問題なし)
    expect(diffPaths(dumpGame(A), dumpGame(B))).toEqual([]);
    const snap = buildSnapshot(B.state);
    expect(snap.player.movement.qbSuccessfulCount).toBe(1);
    expect(snap.player.movement.horizontalMode).toBe('glide');
    // 0.75秒で約42.6m (SPEC §7.2) が中断なしと同じ
    expect(Math.hypot(B.state.player.pos.x, B.state.player.pos.z)).toBeGreaterThan(40);
  });

  it('復帰時に停止中の経過時間をまとめて加算しない: 停止中に100秒相当のフレームを流しても、再開後の advance(1/120) は1tick、advance(1/60) は2tick', () => {
    const g = combatGame();
    runScript(g, 0, 60);
    const tick0 = g.state.tick;
    g.pause();
    for (let i = 0; i < 400; i++) g.advance(0.25);
    expect(g.state.tick).toBe(tick0);
    g.resume();
    expect(g.advance(1 / 120)).toBe(1);
    expect(g.advance(0)).toBe(0);
    expect(g.advance(1 / 60)).toBe(2);
    expect(g.state.tick).toBe(tick0 + 3);
    expect(g.state.time).toBeCloseTo((tick0 + 3) / 120, 12);
  });

  it('復帰時にQが押されたままでも新しい押下として処理しない (キーイベント経由): 押下→一時停止→再開→Qのキーリピート(repeat=true)・押しっぱなしでQBは追加されず、離してから押し直したときだけ成立する', () => {
    const g = arena({ enemies: [], player: { x: 0, z: 0 } });
    const s = g.state;
    applyKeyDown(g.input, 'KeyQ', false);
    for (let i = 0; i < 4; i++) g.step();
    expect(s.player.mv.qbSuccessCount).toBe(1);
    // Qを押したまま2秒(キーリピート)。QBは追加されない
    for (let i = 0; i < 240; i++) {
      applyKeyDown(g.input, 'KeyQ', true);
      g.step();
    }
    expect(s.player.mv.qbSuccessCount).toBe(1);
    g.pause();
    expect(g.input.qb, '一時停止で入力は解除される').toBe(false);
    g.resume();
    // まだQを押したまま: OSのキーリピートが来る
    for (let i = 0; i < 240; i++) {
      applyKeyDown(g.input, 'KeyQ', true);
      g.step();
    }
    expect(s.player.mv.qbSuccessCount, '再開後もリピートでは再発動しない').toBe(1);
    // 一時停止中にQが(非リピートの keydown で)押され、押されたまま再開しても、それは新しい押下として処理されない
    g.pause();
    applyKeyDown(g.input, 'KeyQ', false);
    g.resume();
    expect(g.input.qb, '再開で入力は解除される').toBe(false);
    for (let i = 0; i < 240; i++) {
      applyKeyDown(g.input, 'KeyQ', true);
      g.step();
    }
    expect(s.player.mv.qbSuccessCount, '一時停止中に押されたQは、再開時に新しい押下ではない').toBe(1);
    // 離して押し直すと成立する
    applyKeyUp(g.input, 'KeyQ');
    g.step();
    applyKeyDown(g.input, 'KeyQ', false);
    g.step();
    expect(s.player.mv.qbSuccessCount).toBe(2);
  });
});

describe('§9 再出撃: 位置・速度・HP・EN・残弾・45体・隔壁・ゲート・目標・弾体・ロック・入力・待ち時間・経過時間・グライド/QB・敵の記憶と攻撃タイマー・射撃解/履歴・ミサイル記憶を初期化', () => {
  it('実ステージ: 戦闘・隔壁/ゲート開放・被弾・死亡の後の retry() の状態は、初回出撃直後の状態と全フィールドで一致する (GameState全体・乱数・隔壁の箱)', () => {
    const fresh = realGame();
    const freshDump = dumpGame(fresh);
    const g = combatGame({ hp: 1000 });
    runScript(g, 0, 600);
    g.pause();
    g.resume();
    const s = g.state;
    // 目標・隔壁・ゲートを進める
    destroyAllControls(g);
    expect(s.objective.gateOpen).toBe(true);
    // 状態が確かに汚れている (自明な一致ではない)
    expect(s.time).toBeGreaterThan(5);
    expect(s.player.mv.qbSuccessCount).toBeGreaterThan(0);
    expect(s.shots.length).toBeGreaterThan(0);
    expect(s.enemies.some((e) => e.shotsFired > 0 && getEnemyAI(e) !== undefined)).toBe(true);
    expect(s.player.ammo.machinegun).toBeLessThan(300);
    expect(s.player.en).toBeLessThan(120);
    expect(s.progress.visitedSectorIds.length).toBeGreaterThan(1);
    // 死亡して結果画面 → 再出撃
    s.player.hp = 0;
    g.step();
    expect(s.mode).toBe('failed');
    g.input.fire = true;
    g.input.forward = true;
    const inputRef = g.input;
    g.retry();
    expect(g.input, '入力オブジェクトは安定(リスナー側が保持する参照)').toBe(inputRef);
    expect(g.state.input).toBe(inputRef);
    const retryDump = dumpGame(g);
    expect(diffPaths(freshDump, retryDump), '初回出撃直後と再出撃直後の差').toEqual([]);
    // 個別に明示 (SPEC §9 の列挙)
    const r = g.state;
    expect(r.mode).toBe('playing');
    expect(r.time).toBe(0);
    expect(r.tick).toBe(0);
    expect(r.player.pos).toEqual(REAL.playerStart.pos);
    expect(r.player.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(r.player.hp).toBe(1000);
    expect(r.player.en).toBe(120);
    expect(r.player.ammo).toEqual({ machinegun: 300, missile: 12 });
    expect(r.player.nextFireAt).toEqual({ machinegun: 0, beam: 0, missile: 0 });
    expect(r.player.weapon).toBe('machinegun');
    expect(r.enemies.length).toBe(45);
    expect(r.enemies.every((e) => e.alive && e.shotsFired === 0 && e.lastShotAt === null && !e.alert && !e.hasLineOfSight && getEnemyAI(e) === undefined)).toBe(true);
    expect(r.enemies.map((e) => e.hp)).toEqual(REAL.enemies.map((e) => (e.kind === 'guard' ? 120 : 240)));
    expect(r.objective).toEqual({ controlsDestroyed: 0, openBarrierIds: [], gateOpen: false });
    for (const b of REAL.barriers) for (const id of b.boxIds) expect(g.world.isBoxEnabled(g.world.indexOfBox(id))).toBe(true);
    expect(r.bullets.length + r.missiles.length + r.enemyBullets.length).toBe(0);
    expect(r.lock).toMatchObject({ state: 'none', targetId: null, progress: 0, elapsed: 0 });
    expect(r.fc.status).toBe('inactive');
    expect(r.shots).toEqual([]);
    expect(r.shotSeq).toBe(0);
    expect(r.player.mv).toMatchObject({ glideEnabled: false, qbSuccessCount: 0, qbLastStartedAt: null, qbImpulseRemaining: 0, qbCooldownRemaining: 0, lastEnSpentAt: null, horizontalMode: 'walk' });
    expect(g.input.fire).toBe(false); // 入力は初期化 (再出撃で押しっぱなしを引き継がない)
    expect(g.input.forward).toBe(false);
    expect(r.rng.getState()).toBe(20260908);
    expect(r.progress.visitedSectorIds).toEqual(['S01']);
    expect(r.killCount).toBe(0);
    expect(r.damageTaken).toBe(0);
    expect(r.nextProjectileId).toBe(1);
    expect(buildSnapshot(r)).toEqual(buildSnapshot(fresh.state));
  });

  it('全18構成: 再出撃で構成は保持され、ENは構成の最大値(180/120/90)・全状態が初回出撃直後と一致する。garageへ戻って構成変更→出撃も同様', () => {
    for (const lo of ALL_LOADOUTS) {
      const mk = (): Game => arena({ enemies: [spawn('guard', 'G01', 0, -40), spawn('turret', 'T01', 30, -60)], player: { x: 0, z: 0 }, loadout: lo, hp: 1e9 });
      const fresh = mk();
      const g = mk();
      runScript(g, 0, 300);
      // ENを消費した状態・被弾した状態にする
      g.state.player.en = 3;
      g.state.player.hp = 55;
      g.retry();
      expect(g.getLoadout()).toEqual(lo);
      expect(g.state.loadout).toEqual(lo);
      expect(g.state.player.en, `${JSON.stringify(lo)} のEN`).toBe(MAX_EN[lo.generator]);
      expect(g.state.player.hp).toBe(1000);
      // arena() が sortie 後に hp を 1e9 に上書きしているので、比較用に合わせる
      g.state.player.hp = 1e9;
      expect(diffPaths(dumpGame(fresh), dumpGame(g)), JSON.stringify(lo)).toEqual([]);
    }
    // 構成を変えて出撃
    const g = arena({ enemies: [], player: { x: 0, z: 0 } });
    runScript(g, 0, 60);
    g.toGarage({ fcs: 'wide', generator: 'capacity', legs: 'quadruped' });
    expect(g.state.mode).toBe('garage');
    expect(g.state.player.en).toBe(180);
    g.sortie();
    expect(g.state.mode).toBe('playing');
    expect(g.state.loadout).toEqual({ fcs: 'wide', generator: 'capacity', legs: 'quadruped' });
    expect(g.state.stats).toMatchObject({ maxEn: 180, horizontalSpeedMultiplier: 0.8 });
  });

  it('再出撃を50回繰り返しても更新ループ・状態が重複しない: advance(1/120)は常に1tick、箱の数・入力オブジェクト・イベント数は一定、経過時間は0から', () => {
    const g = arena({ enemies: [spawn('guard', 'G01', 0, -40)], player: { x: 0, z: 0 } });
    const inputRef = g.input;
    const nBoxes = g.world.boxes.length;
    for (let k = 0; k < 50; k++) {
      runScript(g, 0, 10);
      g.retry();
      expect(g.input).toBe(inputRef);
      expect(g.world.boxes.length).toBe(nBoxes);
      expect(g.state.time).toBe(0);
      expect(g.advance(1 / 120), `${k}回目の再出撃後`).toBe(1);
      expect(g.state.tick).toBe(1);
      expect(g.state.events.length).toBeLessThanOrEqual(2);
      g.drainEvents();
    }
  });
});

describe('§9 シード・決定性', () => {
  /** 実ステージの戦闘を tick 実行して、指定tickでの全状態ダンプを返す (入力は tick の関数) */
  function traceRun(g: Game, checkpoints: number[]): Map<number, unknown> {
    const out = new Map<number, unknown>();
    for (let tick = 0; tick <= Math.max(...checkpoints); tick++) {
      if (checkpoints.includes(tick)) out.set(tick, dumpGame(g));
      if (tick < Math.max(...checkpoints)) {
        chaosScript(g, g.state.tick);
        g.step();
      }
    }
    return out;
  }
  const CHK = [1, 120, 360, 600, 840];

  it('同一シード・構成・入力なら、別のGameインスタンスでも 再出撃後でも、全状態(乱数状態を含む)が全チェックポイントで完全に同一', () => {
    const a = traceRun(combatGame({ seed: 777 }), CHK);
    const b = traceRun(combatGame({ seed: 777 }), CHK);
    for (const c of CHK) expect(diffPaths(a.get(c), b.get(c)), `別インスタンス tick ${c}`).toEqual([]);
    // 同じGameを retry() して同じことをする (nav キャッシュ等が持ち越されても結果は同じ)
    const g = combatGame({ seed: 777 });
    traceRun(g, [400]);
    g.retry();
    teleport(g, sectorCenter('S02'));
    g.state.player.hp = 1e9;
    const c2 = traceRun(g, CHK);
    for (const c of CHK) expect(diffPaths(a.get(c), c2.get(c)), `再出撃後 tick ${c}`).toEqual([]);
  });

  it('描画フレームレート(15/24/30/45/60/120/144fps)に依存しない: 同じ時間(2秒)の後の全状態が同一。射撃・移動・敵の全てが固定ステップで進む', () => {
    const run = (fps: number): unknown => {
      const g = combatGame({ seed: 4242 });
      // 入力は tick 開始時に適用する (advance の内部stepを包む)
      const orig = g.step.bind(g);
      g.step = (): void => {
        chaosScript(g, g.state.tick);
        orig();
      };
      let elapsed = 0;
      const frames = Math.round(2 * fps);
      for (let f = 0; f < frames; f++) {
        g.advance(1 / fps);
        elapsed += 1 / fps;
      }
      expect(elapsed).toBeCloseTo(2, 9);
      return { tick: g.state.tick, dump: dumpGame(g) };
    };
    const ref = run(120) as { tick: number; dump: unknown };
    expect(ref.tick).toBe(240);
    for (const fps of [15, 24, 30, 45, 60, 144]) {
      const r = run(fps) as { tick: number; dump: unknown };
      expect(r.tick, `${fps}fps の tick 数`).toBe(240);
      expect(diffPaths(ref.dump, r.dump), `${fps}fps`).toEqual([]);
    }
  });

  it('シードを変えると変わるのは乱数使用部分のみ: 砲台だけの場面で、発射時刻・予告・移動は全シードで同一、発射方向(ばらつき)はシードごとに異なり、プレイヤーの状態は同じ入力なら同一', () => {
    const run = (seed: number) => {
      const g = arena({ enemies: [spawn('turret', 'T01', 0, -60), spawn('turret', 'T02', 40, -80)], player: { x: 0, z: 0 }, seed, hp: 1e9 });
      const rec = new Rec(g);
      rec.run(6, (gg) => {
        gg.input.right = true; // 動くプレイヤー (乱数を使わない状態量)
      });
      return { fires: rec.fires, tele: rec.tele, player: plain(g.state.player), snapSeed: buildSnapshot(g.state).seed };
    };
    const base = run(20260908);
    for (const seed of [0, 1, 12345, 4294967295]) {
      const r = run(seed);
      expect(r.snapSeed).toBe(seed);
      expect(r.fires.map((f) => [f.time, f.id, f.origin])).toEqual(base.fires.map((f) => [f.time, f.id, f.origin]));
      expect(r.tele).toEqual(base.tele);
      // 弾のばらつきは乱数由来なので、方向はシードごとに変わる (全発が同一ではない)
      expect(r.fires.some((f, i) => angleDeg(f.dir, base.fires[i].dir) > 1e-6), `seed ${seed} で発射方向が変わる`).toBe(true);
      // 同一入力ならプレイヤーの移動(乱数を使わない)は同一
      const pa = base.player as { pos: unknown; vel: unknown; en: unknown };
      const pb = r.player as { pos: unknown; vel: unknown; en: unknown };
      expect(pb.pos).toEqual(pa.pos);
      expect(pb.vel).toEqual(pa.vel);
      expect(pb.en).toEqual(pa.en);
    }
    expect(base.snapSeed).toBe(20260908);
  });

  it('プレイヤーの武器・移動は乱数を使わない: 敵のいない場面で3武器を撃ち尽くしても乱数状態は変化しない (プレイヤー武器のランダム散布なし)', () => {
    const g = arena({ enemies: [], player: { x: 0, z: 0 }, seed: 99 });
    const before = g.state.rng.getState();
    expect(before).toBe(99);
    g.input.fire = true;
    for (let k = 0; k < 3; k++) {
      g.input.weaponSelect = (['machinegun', 'beam', 'missile'] as const)[k];
      for (let i = 0; i < 120; i++) g.step();
    }
    expect(g.state.shots.length).toBeGreaterThan(10);
    expect(g.state.rng.getState()).toBe(before);
  });

  it('シードの既定値と範囲: 未指定は 20260908。sortie(loadout, seed) は 32bit符号なしに正規化し、再出撃は同じシードを再利用する。snapshot.seed に反映される', () => {
    const g = new Game({ stage: buildTestArenaStage() });
    expect(buildSnapshot(g.state).seed).toBe(20260908);
    g.sortie();
    expect(g.state.rng.getState()).toBe(20260908);
    g.sortie(undefined, 4294967295);
    expect(buildSnapshot(g.state).seed).toBe(4294967295);
    expect(g.state.rng.getState()).toBe(4294967295);
    g.retry();
    expect(buildSnapshot(g.state).seed).toBe(4294967295);
    g.sortie(undefined, 0);
    expect(buildSnapshot(g.state).seed).toBe(0);
    g.toGarage();
    expect(buildSnapshot(g.state).seed, 'garage でもシードを保持').toBe(0);
    const g2 = new Game({ stage: buildTestArenaStage(), seed: 4294967295 });
    expect(buildSnapshot(g2.state).seed).toBe(4294967295);
  });

  it('URLクエリの seed: 32bit符号なし整数を受け付け、未指定・不正は 20260908 (ui/seed.ts)', () => {
    const D = 20260908;
    const cases: [string, number][] = [
      ['', D], ['?', D], ['?foo=1', D], ['?seed=', D], ['?seed=0', 0], ['?seed=1', 1], ['?seed=20260908', D], ['?seed=123456789', 123456789],
      ['?seed=4294967295', 4294967295], ['?seed=4294967296', D], ['?seed=99999999999', D], ['?seed=-1', D], ['?seed=1.5', D], ['?seed=1e3', D],
      ['?seed=0x10', D], ['?seed=abc', D], ['?seed=%20', D], ['?a=1&seed=77&b=2', 77], ['?seed=12&seed=34', 12], ['?seed=007', 7], ['?seed=%E0%A4%A', D],
    ];
    for (const [q, expected] of cases) expect(parseSeedUi(q), `ui/seed parseSeed(${JSON.stringify(q)})`).toBe(expected);
    // 結果は常に 32bit 符号なし整数
    for (const [q] of cases) {
      const v = parseSeedUi(q);
      expect(Number.isInteger(v) && v >= 0 && v <= 4294967295).toBe(true);
    }
  });

  it('sim/rng.ts の parseSeed (公開されている別実装。本番は ui/seed.ts を使う) は、正規の入力では ui/seed.parseSeed と同じ結果を返す', () => {
    const cases: string[] = ['', '?seed=5', '?seed=0', '?seed=4294967295', '?seed=4294967296', '?seed=-3', '?seed=1.5', '?seed=', '?seed=abc', '?a=1&seed=8', '?seed=12&seed=34', '?seed=007', '?foo=1'];
    for (const q of cases) expect(parseSeedRng(q, 20260908), `rng.parseSeed と ui/seed.parseSeed の一致 (${JSON.stringify(q)})`).toBe(parseSeedUi(q));
  });

  it('sim/rng.ts の parseSeed は、不正なパーセントエンコード(?seed=%E0%A4%A など)で例外を投げず、既定値 20260908 に戻る (ui/seed.ts は戻る)', () => {
    for (const q of ['?seed=%E0%A4%A', '?seed=%zz', '?seed=%', '?seed=1%2']) {
      expect(parseSeedUi(q), `ui/seed.parseSeed(${JSON.stringify(q)})`).toBe(20260908);
      let r: number | 'threw' = 0;
      try {
        r = parseSeedRng(q, 20260908);
      } catch {
        r = 'threw';
      }
      expect(r, `rng.parseSeed(${JSON.stringify(q)}) が例外を投げない`).toBe(20260908);
    }
  });

  it('シミュレーションのソースは DOM・Three.js・Math.random・Date.now・performance.now を使わない (src/sim/*.ts)', () => {
    const dir = join(__dirname, '..', 'src', 'sim');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const code = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const bad of ['Math.random', 'Date.now', 'performance.now', 'new Date', "from 'three'", 'document.', 'window.', 'requestAnimationFrame']) {
        expect(code.includes(bad), `src/sim/${f} が ${bad} を使っている`).toBe(false);
      }
    }
  });
});

describe('§9 弾体と一時エフェクトの寿命・削除', () => {
  it('実ステージの戦闘60秒(イベントを吸い出さない): 敵弾/プレイヤー弾/ミサイルは寿命(2s/3s, 2s, 4s)を超えて残らず、配列は生存弾だけ。events<=1024, 被弾方向<=16, 射撃履歴<=32', () => {
    const g = combatGame();
    const s = g.state;
    let maxEnemyBullets = 0;
    for (let tick = 0; tick < 60 * 120; tick++) {
      chaosScript(g, tick % 600);
      g.input.fire = true;
      if (tick % 300 === 299) g.input.weaponSelect = (['machinegun', 'beam', 'missile'] as const)[Math.floor(tick / 300) % 3];
      g.step();
      maxEnemyBullets = Math.max(maxEnemyBullets, s.enemyBullets.length);
      for (const b of s.enemyBullets) {
        expect(b.alive).toBe(true);
        expect(b.age).toBeLessThanOrEqual(b.maxLife + 1e-9);
      }
      for (const b of s.bullets) {
        expect(b.alive).toBe(true);
        expect(b.age).toBeLessThanOrEqual(2 + 1e-9);
      }
      for (const m of s.missiles) {
        expect(m.alive).toBe(true);
        expect(m.age).toBeLessThanOrEqual(4 + 1e-9);
      }
      expect(s.events.length).toBeLessThanOrEqual(1024);
      expect(s.damageIndicators.length).toBeLessThanOrEqual(16);
      expect(s.shots.length).toBeLessThanOrEqual(32);
      if (s.mode !== 'playing') s.player.hp = 1e9;
    }
    console.info(`[lifetime] max enemy bullets alive at once: ${maxEnemyBullets}`);
    // 上限の目安: 同時に撃てる敵(5体)が寿命の間に撃つ最大弾数
    expect(maxEnemyBullets).toBeLessThan(120);
  });

  it('射撃が止まり敵の射線も無くなれば、全ての弾体は寿命の内に消える (敵弾3秒・マシンガン2秒・ミサイル4秒)。命中エフェクトのフラッシュも0.12秒で消える', () => {
    const g = combatGame();
    const s = g.state;
    runScript(g, 0, 480);
    expect(s.enemyBullets.length + s.bullets.length).toBeGreaterThan(0);
    // 射撃を止め、プレイヤーを敵から遠く離す
    g.input.fire = false;
    teleport(g, { x: 700, y: 25.5, z: 400 });
    let clearedAt = -1;
    for (let i = 0; i < 6 * 120; i++) {
      g.input.fire = false;
      g.step();
      g.drainEvents();
      if (clearedAt < 0 && s.enemyBullets.length === 0 && s.bullets.length === 0 && s.missiles.length === 0) clearedAt = (i + 1) / 120;
    }
    expect(clearedAt, '全弾体が消えるまでの秒数').toBeGreaterThan(0);
    expect(clearedAt).toBeLessThanOrEqual(4 + 1 / 60); // ミサイル寿命4秒が最長
    for (const e of s.enemies) expect(e.hitFlash).toBe(0);
    expect(s.enemyBullets.length + s.bullets.length + s.missiles.length).toBe(0);
  });
});

// =====================================================================================================================
// §10 評価用の読み取り専用インターフェース: window.AK2_BENCH.getSnapshot() (実体は bench.ts の buildSnapshot)
// =====================================================================================================================
/** SPEC §10 の型を1つずつ写した検査器。実装の型や他のテスト補助 (tools/snapshotShape.ts) からは写していない。 */
type Check = (v: unknown, path: string, errs: string[]) => void;
const shNum: Check = (v, p, e) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) e.push(`${p}: 有限の数ではない (${String(v)})`);
};
const shInt: Check = (v, p, e) => {
  if (typeof v !== 'number' || !Number.isInteger(v)) e.push(`${p}: 整数ではない (${String(v)})`);
};
const shStr: Check = (v, p, e) => {
  if (typeof v !== 'string') e.push(`${p}: 文字列ではない (${String(v)})`);
};
const shBool: Check = (v, p, e) => {
  if (typeof v !== 'boolean') e.push(`${p}: 真偽値ではない (${String(v)})`);
};
const shLit = (x: string | number): Check => (v, p, e) => {
  if (v !== x) e.push(`${p}: ${String(x)} でなければならない (${String(v)})`);
};
const shOneOf = (...xs: string[]): Check => (v, p, e) => {
  if (typeof v !== 'string' || !xs.includes(v)) e.push(`${p}: ${xs.join('|')} のどれかでなければならない (${String(v)})`);
};
const shNull = (c: Check): Check => (v, p, e) => {
  if (v !== null) c(v, p, e);
};
const shTuple = (...cs: Check[]): Check => (v, p, e) => {
  if (!Array.isArray(v) || v.length !== cs.length) {
    e.push(`${p}: 長さ${cs.length}の配列ではない`);
    return;
  }
  cs.forEach((c, i) => c(v[i], `${p}[${i}]`, e));
};
const shArr = (c: Check, max = Infinity): Check => (v, p, e) => {
  if (!Array.isArray(v)) {
    e.push(`${p}: 配列ではない`);
    return;
  }
  if (v.length > max) e.push(`${p}: 長さが${max}を超える (${v.length})`);
  v.forEach((x, i) => c(x, `${p}[${i}]`, e));
};
const shObj = (shape: Record<string, Check>): Check => (v, p, e) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    e.push(`${p}: オブジェクトではない`);
    return;
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(shape)) {
    if (!(k in o)) e.push(`${p}.${k}: 欠落`);
    else shape[k](o[k], `${p}.${k}`, e);
  }
  for (const k of Object.keys(o)) if (!(k in shape)) e.push(`${p}.${k}: SPEC §10 に無いキー`);
};
const shVec3 = shTuple(shNum, shNum, shNum);
const shWeapon = shOneOf('machinegun', 'beam', 'missile');
const shSolution = shOneOf('inactive', 'solved', 'no_solution');
const SNAPSHOT_SPEC: Check = shObj({
  version: shLit('AK2-1.2-candidate'),
  seed: shInt,
  state: shOneOf('garage', 'playing', 'paused', 'cleared', 'failed'),
  elapsedSeconds: shNum,
  loadout: shObj({ fcs: shOneOf('wide', 'medium', 'narrow'), generator: shOneOf('capacity', 'balanced', 'recovery'), legs: shOneOf('biped', 'quadruped') }),
  player: shObj({
    position: shVec3,
    velocity: shVec3,
    grounded: shBool,
    hp: shNum,
    en: shNum,
    weapon: shWeapon,
    ammo: shObj({ machinegun: shInt, missile: shInt }),
    movement: shObj({
      horizontalMode: shOneOf('walk', 'glide', 'quickboost'),
      verticalMode: shOneOf('grounded', 'rising', 'flying', 'falling'),
      glideEnabled: shBool,
      desiredHorizontalDirection: shTuple(shNum, shNum),
      qbSuccessfulCount: shInt,
      qbLastStartedAtSeconds: shNull(shNum),
      qbImpulseRemainingSeconds: shNum,
      qbCooldownRemainingSeconds: shNum,
      lastEnSpentAtSeconds: shNull(shNum),
    }),
  }),
  effectiveStats: shObj({ maxEn: shNum, regenPerSecond: shNum, lockSeconds: shNum, horizontalSpeedMultiplier: shNum }),
  lock: shObj({ state: shOneOf('none', 'acquiring', 'locked'), targetId: shNull(shStr), progress: shNum, radiusCssPx: shNum }),
  fireControl: shObj({
    status: shSolution,
    weapon: shWeapon,
    targetId: shNull(shStr),
    evaluatedAtSeconds: shNull(shNum),
    muzzlePosition: shNull(shVec3),
    targetPosition: shNull(shVec3),
    targetVelocity: shNull(shVec3),
    launchDirection: shNull(shVec3),
    predictedFlightSeconds: shNull(shNum),
    predictedInterceptPosition: shNull(shVec3),
    aimPoint: shNull(shVec3),
    residualMeters: shNull(shNum),
  }),
  recentPlayerShots: shArr(
    shObj({
      id: shInt,
      firedAtSeconds: shNum,
      weapon: shWeapon,
      targetId: shNull(shStr),
      solutionStatus: shSolution,
      muzzlePosition: shVec3,
      targetPositionAtFire: shNull(shVec3),
      targetVelocityAtFire: shNull(shVec3),
      launchDirection: shVec3,
      initialVelocity: shNull(shVec3),
      accelerationAtFire: shVec3,
      predictedFlightSeconds: shNull(shNum),
      predictedInterceptPosition: shNull(shVec3),
    }),
    32,
  ),
  enemies: shArr(
    shObj({
      id: shStr,
      kind: shOneOf('guard', 'turret'),
      isGateControl: shBool,
      sectorId: shStr,
      position: shVec3,
      velocity: shVec3,
      hp: shNum,
      alive: shBool,
      alert: shBool,
      hasLineOfSight: shBool,
      shotsFired: shInt,
      lastShotAtSeconds: shNull(shNum),
    }),
  ),
  objective: shObj({ controlsDestroyed: shInt, controlsRequired: shLit(6), openBarrierIds: shArr(shStr), gateOpen: shBool }),
  stage: shObj({ sectorCount: shInt, currentSectorId: shNull(shStr), visitedSectorIds: shArr(shStr), totalEnemies: shLit(45) }),
});
function shapeErrors(snap: unknown): string[] {
  const errs: string[] = [];
  SNAPSHOT_SPEC(snap, '$', errs);
  return errs;
}
/** 非有限数 (NaN/Infinity) と undefined の位置を列挙する */
function nonFinitePaths(v: unknown, path = '$', out: string[] = [], skip: ReadonlySet<string> = SKIP_KEYS): string[] {
  if (out.length > 20) return out;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) out.push(`${path}=${String(v)}`);
  } else if (v === undefined) {
    out.push(`${path}=undefined`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => nonFinitePaths(x, `${path}[${i}]`, out, skip));
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!skip.has(k)) nonFinitePaths(x, `${path}.${k}`, out, skip);
  }
  return out;
}
const SKIP_INTERNAL = new Set(['world', 'stage', 'rng', 'internal']);
/** 静止した(または既知の速度で動く)試験標的を置いた合成アリーナ。標的は m + r に置く */
function targetArena(o: { r?: V3; v?: V3; loadout?: Loadout; weapon?: 'machinegun' | 'beam' | 'missile'; seed?: number } = {}): Game {
  const g = arena({ enemies: [], player: { x: 0, z: 0 }, loadout: o.loadout, seed: o.seed });
  const r = o.r ?? { x: 0, y: 0, z: -60 };
  g.state.enemies.push(makeScriptedTarget('TGT', { x: r.x, y: PH + r.y, z: r.z }, o.v ?? { x: 0, y: 0, z: 0 }));
  if (o.weapon) g.state.player.weapon = o.weapon;
  return g;
}
const snapOf = (g: Game): Snapshot => buildSnapshot(g.state);
const v3a = (v: V3): [number, number, number] => [v.x, v.y, v.z];
const toV3 = (a: readonly number[]): V3 => ({ x: a[0], y: a[1], z: a[2] });
function stepUntil(g: Game, cond: () => boolean, maxTicks: number): boolean {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return true;
    g.step();
    g.drainEvents();
  }
  return cond();
}

describe('§10 getSnapshot: SPEC の型どおりの形・列挙値・有限数 (全状態で)', () => {
  it('garage / playing / paused / failed / cleared の全ての状態で、キー集合・型・列挙値・配列長が SPEC §10 と完全に一致する (余分なキーも不可)', () => {
    // garage: 出撃前
    const g0 = new Game({ stage: REAL });
    expect(shapeErrors(snapOf(g0)), 'garage').toEqual([]);
    expect(snapOf(g0).state).toBe('garage');
    // playing
    const g = realGame();
    for (let i = 0; i < 30; i++) g.step();
    expect(shapeErrors(snapOf(g)), 'playing').toEqual([]);
    expect(snapOf(g).state).toBe('playing');
    // paused
    g.pause();
    expect(shapeErrors(snapOf(g)), 'paused').toEqual([]);
    expect(snapOf(g).state).toBe('paused');
    g.resume();
    expect(snapOf(g).state).toBe('playing');
    // failed
    const gf = realGame();
    gf.state.player.hp = 0;
    gf.step();
    expect(shapeErrors(snapOf(gf)), 'failed').toEqual([]);
    expect(snapOf(gf).state).toBe('failed');
    // cleared
    const gc = realGame();
    destroyAllControls(gc);
    const z = REAL.escapeZone;
    teleport(gc, { x: (z.min.x + z.max.x) / 2, y: (z.min.y + z.max.y) / 2, z: (z.min.z + z.max.z) / 2 });
    gc.step();
    expect(shapeErrors(snapOf(gc)), 'cleared').toEqual([]);
    expect(snapOf(gc).state).toBe('cleared');
    // garage へ戻る
    gc.toGarage();
    expect(snapOf(gc).state).toBe('garage');
    expect(shapeErrors(snapOf(gc))).toEqual([]);
  });

  it('全18構成の出撃直後・戦闘後(ロック/射撃/被弾/QB)でも形が一致し、返却値のどこにも NaN/Infinity/undefined が無い。JSON往復で不変 (NaNがnullに化けていない)', () => {
    for (const lo of ALL_LOADOUTS) {
      const g = arena({ enemies: [spawn('guard', 'G01', 0, -40), spawn('turret', 'T01', 30, -60)], player: { x: 0, z: 0 }, loadout: lo, hp: 1e9 });
      g.state.enemies.push(makeScriptedTarget('TGT', { x: 5, y: PH, z: -30 }, { x: 0, y: 0, z: 0 }));
      for (let t = 0; t < 300; t++) {
        g.input.fire = t % 5 !== 4;
        g.input.qb = t === 100 || t === 101;
        g.input.forward = t >= 100 && t < 102;
        if (t === 150) g.input.weaponSelect = 'beam';
        if (t === 200) g.input.weaponSelect = 'missile';
        g.step();
        g.drainEvents();
        if (t % 50 === 49) {
          const snap = snapOf(g);
          expect(shapeErrors(snap), `${JSON.stringify(lo)} t=${t}`).toEqual([]);
          expect(nonFinitePaths(snap), `${JSON.stringify(lo)} t=${t}`).toEqual([]);
          expect(diffPaths(snap, JSON.parse(JSON.stringify(snap)))).toEqual([]);
        }
      }
    }
  });

  it('実ステージの60秒の戦闘 (全機能のスクリプト入力): 20tickごとのスナップショットの形が一致し、GameState本体にも NaN/Infinity/undefined が入らない (internalのAI記憶は除く)', () => {
    const g = combatGame({ seed: 31337, hp: 1e9 });
    const s = g.state;
    let checked = 0;
    let sawLocked = false;
    for (let tick = 0; tick < 60 * 120; tick++) {
      chaosScript(g, tick % 600);
      if (tick % 300 === 299) g.input.weaponSelect = (['machinegun', 'beam', 'missile'] as const)[Math.floor(tick / 300) % 3];
      g.step();
      if (tick % 20 === 0) {
        const snap = snapOf(g);
        expect(shapeErrors(snap), `tick ${tick}`).toEqual([]);
        expect(nonFinitePaths(snap), `snapshot tick ${tick}`).toEqual([]);
        expect(nonFinitePaths(plain(s), '$state', [], SKIP_INTERNAL), `GameState tick ${tick}`).toEqual([]);
        sawLocked ||= snap.lock.state === 'locked';
        checked++;
      }
    }
    expect(checked).toBe(360);
    expect(sawLocked).toBe(true);
    // 敵AIの内部記憶 (internal) には NaN が入らない (-Infinity/Infinity は「未設定」を表す番兵)
    for (const e of s.enemies) {
      const found: string[] = [];
      const walk = (v: unknown, p: string): void => {
        if (typeof v === 'number' && Number.isNaN(v)) found.push(p);
        else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
      };
      walk(e.internal, `${e.id}.internal`);
      expect(found).toEqual([]);
    }
  });

  it('feed の異常値: advance(NaN/Infinity/負数/巨大) でも状態が凍結・破壊されない (NaNが時間に入らない)', () => {
    const g = arena({ enemies: [spawn('turret', 'T01', 0, -60)], player: { x: 0, z: 0 } });
    expect(g.advance(NaN)).toBe(0);
    expect(g.advance(-5)).toBe(0);
    expect(g.advance(1 / 120)).toBe(1);
    expect(g.advance(Infinity)).toBeGreaterThan(0);
    expect(g.advance(1e9)).toBeGreaterThan(0);
    expect(g.advance(NaN)).toBe(0);
    expect(g.advance(1 / 120)).toBe(1);
    const snap = snapOf(g);
    expect(nonFinitePaths(snap)).toEqual([]);
    expect(Number.isFinite(g.state.time) && g.state.time > 0).toBe(true);
    expect(g.state.tick * (1 / 120)).toBeCloseTo(g.state.time, 9);
  });
});

describe('§10 getSnapshot: 基本フィールドの意味 (version/seed/state/elapsedSeconds/loadout/effectiveStats)', () => {
  it('version は "AK2-1.2-candidate"、seed は出撃のシード、elapsedSeconds は丸め前の tick/120 (HUDの丸め前)、loadout は選択した構成', () => {
    const g = arena({ enemies: [], player: { x: 0, z: 0 }, seed: 424242, loadout: { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' } });
    for (let i = 0; i < 7; i++) g.step();
    const snap = snapOf(g);
    expect(snap.version).toBe('AK2-1.2-candidate');
    expect(snap.seed).toBe(424242);
    expect(snap.state).toBe('playing');
    expect(snap.elapsedSeconds).toBeCloseTo(7 / 120, 12);
    expect(snap.elapsedSeconds, '丸めていない').not.toBe(Math.round(snap.elapsedSeconds * 100) / 100);
    expect(snap.elapsedSeconds).toBe(g.state.time);
    expect(snap.loadout).toEqual({ fcs: 'narrow', generator: 'recovery', legs: 'quadruped' });
    // 一時停止中は進まない
    g.pause();
    g.advance(5);
    expect(snapOf(g).elapsedSeconds).toBe(snap.elapsedSeconds);
    g.resume();
    g.step();
    expect(snapOf(g).elapsedSeconds).toBeCloseTo(8 / 120, 12);
  });

  it('effectiveStats: 全18構成で 最大EN(180/120/90)・回復率(基本x脚部倍率)・ロック所要時間(基本÷ロック速度倍率)・水平速度倍率 が SPEC の数値どおり (中範囲・均衡・4脚は 120 / 11.25 / 0.533..)', () => {
    const genMax = { capacity: 180, balanced: 120, recovery: 90 } as const;
    const genRegen = { capacity: 10, balanced: 15, recovery: 20 } as const;
    const lockBase = { wide: 1.2, medium: 0.8, narrow: 0.4 } as const;
    const legs = { biped: { speed: 1, regen: 1, lock: 1 }, quadruped: { speed: 0.8, regen: 0.75, lock: 1.5 } } as const;
    for (const lo of ALL_LOADOUTS) {
      const g = arena({ enemies: [], player: { x: 0, z: 0 }, loadout: lo });
      const snap = snapOf(g);
      const L = legs[lo.legs];
      expect(snap.effectiveStats.maxEn, JSON.stringify(lo)).toBe(genMax[lo.generator]);
      expect(snap.effectiveStats.regenPerSecond, JSON.stringify(lo)).toBeCloseTo(genRegen[lo.generator] * L.regen, 12);
      expect(snap.effectiveStats.lockSeconds, JSON.stringify(lo)).toBeCloseTo(lockBase[lo.fcs] / L.lock, 12);
      expect(snap.effectiveStats.horizontalSpeedMultiplier, JSON.stringify(lo)).toBe(L.speed);
      expect(snap.player.en, '出撃直後のENは構成の最大値').toBe(genMax[lo.generator]);
      expect(snap.player.hp).toBe(1e9); // arena() の設定 (HP上限は1000: 別に確認)
    }
    const g = realGame({ loadout: { fcs: 'medium', generator: 'balanced', legs: 'quadruped' } });
    const st = snapOf(g).effectiveStats;
    expect(st.maxEn).toBe(120);
    expect(st.regenPerSecond).toBeCloseTo(11.25, 12);
    expect(st.lockSeconds).toBeCloseTo(0.5333333333333333, 12);
    expect(snapOf(g).player.hp, 'SPEC §3: 最大HP1000').toBe(1000);
  });

  it('lock.radiusCssPx は 広範囲0.30D / 中範囲0.20D / 狭範囲0.10D (D=表示領域の幅と高さの小さい方) で、リサイズ後も一致する', () => {
    for (const [fcs, ratio] of [['wide', 0.3], ['medium', 0.2], ['narrow', 0.1]] as const) {
      const g = arena({ enemies: [], player: { x: 0, z: 0 }, loadout: { fcs, generator: 'balanced', legs: 'biped' } });
      expect(snapOf(g).lock.radiusCssPx, `${fcs} 1280x720`).toBeCloseTo(ratio * 720, 9);
      g.setViewport(1920, 1080);
      expect(snapOf(g).lock.radiusCssPx, `${fcs} 1920x1080`).toBeCloseTo(ratio * 1080, 9);
      g.setViewport(1000, 1600); // 縦長: D = 幅
      expect(snapOf(g).lock.radiusCssPx, `${fcs} 1000x1600`).toBeCloseTo(ratio * 1000, 9);
      g.step();
      expect(snapOf(g).lock.radiusCssPx, `${fcs} 1tick後も`).toBeCloseTo(ratio * 1000, 9);
    }
  });
});

describe('§10 getSnapshot: player.movement の意味 (QB・グライド・ブレーキ・垂直状態・目標方向・EN)', () => {
  it('QB: 発動tickの時刻が qbLastStartedAtSeconds (0秒でもnullでない)・lastEnSpentAtSeconds・qbSuccessfulCount=1・EN-36。噴射0.15秒中は quickboost、噴射後の慣性減速中は glide + glideEnabled、残り時間と再使用待ちは実時間で減る', () => {
    const g = arena({ enemies: [], player: { x: 0, z: 0 } });
    let snap = snapOf(g);
    expect(snap.player.movement.qbLastStartedAtSeconds).toBeNull();
    expect(snap.player.movement.lastEnSpentAtSeconds).toBeNull();
    expect(snap.player.movement.qbSuccessfulCount).toBe(0);
    expect(snap.player.movement.qbImpulseRemainingSeconds).toBe(0);
    expect(snap.player.movement.qbCooldownRemainingSeconds).toBe(0);
    expect(snap.player.movement.horizontalMode).toBe('walk');
    expect(snap.player.movement.glideEnabled).toBe(false);
    expect(snap.player.movement.verticalMode).toBe('grounded');
    expect(snap.player.grounded).toBe(true);
    g.input.qb = true;
    g.input.forward = true;
    g.step(); // tick 0 の開始時刻 T=0 で発動
    g.input.qb = false;
    g.input.forward = false;
    snap = snapOf(g);
    const mv = snap.player.movement;
    expect(mv.qbSuccessfulCount).toBe(1);
    expect(mv.qbLastStartedAtSeconds, '発動時刻 (0秒。null/未定義ではない)').toBe(0);
    expect(mv.lastEnSpentAtSeconds, 'QBの消費時刻 = 発動時').toBe(0);
    expect(snap.player.en, 'QBの36 ENを発動時に一括消費 (均衡ジェネレーター120)').toBeCloseTo(120 - 36, 9);
    expect(mv.horizontalMode).toBe('quickboost');
    expect(mv.qbImpulseRemainingSeconds).toBeGreaterThan(0.13);
    expect(mv.qbImpulseRemainingSeconds).toBeLessThanOrEqual(0.15 + 1e-9);
    expect(mv.qbCooldownRemainingSeconds).toBeGreaterThan(0.98);
    expect(mv.qbCooldownRemainingSeconds).toBeLessThanOrEqual(1 + 1e-9);
    // 直前のtickの入力 (W) の方向。カメラのyaw=0なので [0,-1]
    expect(mv.desiredHorizontalDirection[0]).toBeCloseTo(0, 9);
    expect(mv.desiredHorizontalDirection[1]).toBeCloseTo(-1, 9);
    expect(hspeed(toV3(snap.player.velocity))).toBeGreaterThan(70);
    g.step(); // キーを離したtick
    // desiredHorizontalDirection の解釈変更 (audit-movement F2 / SPEC §10, sim-fix): 「水平移動系が現在向かおうとしている方向」。
    // 入力がなくても QB の噴射・慣性・自動グライドは QB 方向へ続く (§7.2) ので、[0,0] ではなく保持している QB 方向 (W=カメラ前方 [0,-1])
    const held = snapOf(g).player.movement.desiredHorizontalDirection;
    expect(held[0], '入力なしでも QB 方向を保持 (x)').toBeCloseTo(0, 9);
    expect(held[1], '入力なしでも QB 方向を保持 (z)').toBeCloseTo(-1, 9);
    expect(snapOf(g).player.movement.horizontalMode).toBe('quickboost');
    // 噴射終了後
    for (let i = 0; i < 20; i++) g.step(); // 0.1667秒後
    snap = snapOf(g);
    expect(snap.player.movement.qbImpulseRemainingSeconds).toBe(0);
    expect(snap.player.movement.horizontalMode, 'QBの慣性減速中は glide').toBe('glide');
    expect(snap.player.movement.glideEnabled).toBe(true);
    expect(snap.player.movement.qbCooldownRemainingSeconds).toBeGreaterThan(0.8);
    expect(snap.player.movement.qbCooldownRemainingSeconds).toBeLessThan(0.85);
    expect(snap.player.movement.qbSuccessfulCount).toBe(1);
    // 1.0秒後には再使用可能
    for (let i = 0; i < 100; i++) g.step();
    expect(snapOf(g).player.movement.qbCooldownRemainingSeconds).toBe(0);
    expect(snapOf(g).player.movement.qbLastStartedAtSeconds).toBe(0);
    // EN不足のQBは成功回数も時刻も動かさない
    g.state.player.en = 35;
    const before = snapOf(g).player.movement;
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    g.step();
    const after = snapOf(g).player.movement;
    expect(after.qbSuccessfulCount).toBe(before.qbSuccessfulCount);
    expect(after.qbLastStartedAtSeconds).toBe(before.qbLastStartedAtSeconds);
    expect(after.lastEnSpentAtSeconds).toBe(before.lastEnSpentAtSeconds);
  });

  it('ブレーキ中は horizontalMode=walk で速度は直ちに0にならない。グライドON/OFFは glideEnabled に反映', () => {
    const g = arena({ enemies: [], player: { x: 0, z: 0 } });
    g.input.shift = true;
    g.input.forward = true;
    for (let i = 0; i < 3; i++) g.step();
    g.input.shift = false;
    g.input.forward = false;
    for (let i = 0; i < 60; i++) g.step();
    let snap = snapOf(g);
    expect(snap.player.movement.horizontalMode).toBe('glide');
    expect(snap.player.movement.glideEnabled).toBe(true);
    const v0 = hspeed(toV3(snap.player.velocity));
    expect(v0).toBeGreaterThan(15);
    g.input.ctrl = true;
    g.step();
    g.step();
    snap = snapOf(g);
    expect(snap.player.movement.horizontalMode, 'ブレーキ中').toBe('walk');
    expect(snap.player.movement.glideEnabled).toBe(false);
    const v1 = hspeed(toV3(snap.player.velocity));
    expect(v1, '直ちには0にならない').toBeGreaterThan(0.5);
    expect(v1).toBeLessThan(v0);
    for (let i = 0; i < 120; i++) g.step();
    expect(hspeed(toV3(snapOf(g).player.velocity))).toBeLessThan(1e-6);
  });

  it('desiredHorizontalDirection は [x, z] の単位方向 (yaw=0でWは[0,-1], Dは[1,0], 斜めは正規化)、入力なしは [0,0]。verticalMode: grounded → rising → falling → grounded / 長押しで flying', () => {
    const g = arena({ enemies: [], player: { x: 0, z: 0 } });
    g.step();
    expect(snapOf(g).player.movement.desiredHorizontalDirection).toEqual([0, 0]);
    g.input.forward = true;
    g.step();
    const w = snapOf(g).player.movement.desiredHorizontalDirection;
    expect(w[0]).toBeCloseTo(0, 9);
    expect(w[1]).toBeCloseTo(-1, 9);
    g.input.right = true;
    g.step();
    const wd = snapOf(g).player.movement.desiredHorizontalDirection;
    expect(Math.hypot(wd[0], wd[1]), '斜めで速度が増えない (単位ベクトル)').toBeCloseTo(1, 9);
    expect(wd[0]).toBeGreaterThan(0.6);
    expect(wd[1]).toBeLessThan(-0.6);
    g.input.forward = false;
    g.input.right = false;
    g.input.jump = true;
    g.step();
    g.input.jump = false;
    let snap = snapOf(g);
    expect(snap.player.movement.verticalMode).toBe('rising');
    expect(snap.player.grounded).toBe(false);
    const modes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      g.step();
      modes.add(snapOf(g).player.movement.verticalMode);
    }
    expect(modes.has('falling')).toBe(true);
    snap = snapOf(g);
    expect(snap.player.movement.verticalMode).toBe('grounded');
    expect(snap.player.grounded).toBe(true);
    // 長押しで飛行
    g.input.jump = true;
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      g.step();
      seen.add(snapOf(g).player.movement.verticalMode);
    }
    expect(seen.has('flying')).toBe(true);
    // 飛行中はENが減る。位置・速度・EN は state と一致
    const cur = snapOf(g);
    expect(cur.player.en).toBeLessThan(120);
    expect(cur.player.position).toEqual(v3a(g.state.player.pos));
    expect(cur.player.velocity).toEqual(v3a(g.state.player.vel));
    expect(cur.player.hp).toBe(g.state.player.hp);
    expect(cur.player.weapon).toBe(g.state.player.weapon);
    expect(cur.player.ammo).toEqual({ machinegun: g.state.player.ammo.machinegun, missile: g.state.player.ammo.missile });
    expect(Object.keys(cur.player.ammo).sort(), '弾数欄はマシンガンとミサイルだけ (ビームは無制限)').toEqual(['machinegun', 'missile']);
  });
});

describe('§10 getSnapshot: lock と fireControl の意味', () => {
  it('lock: 対象なし=none/null/0、取得中=acquiring/対象ID/0〜1で単調増加、完了=locked/1。対象が失効すると即座に none/null/0 に戻り、次の対象は0から', () => {
    const g = targetArena({});
    let snap = snapOf(g);
    expect(snap.lock).toEqual({ state: 'none', targetId: null, progress: 0, radiusCssPx: 144 });
    const seenProgress: number[] = [];
    let acquiringSeen = false;
    let lockedAt = -1;
    for (let i = 0; i < 200; i++) {
      g.step();
      g.drainEvents();
      snap = snapOf(g);
      expect(snap.lock.progress).toBeGreaterThanOrEqual(0);
      expect(snap.lock.progress).toBeLessThanOrEqual(1);
      if (snap.lock.state === 'acquiring') {
        acquiringSeen = true;
        expect(snap.lock.targetId).toBe('TGT');
        expect(snap.lock.progress).toBeLessThan(1);
        seenProgress.push(snap.lock.progress);
      }
      if (snap.lock.state === 'locked') {
        lockedAt = snap.elapsedSeconds;
        expect(snap.lock.progress).toBe(1);
        expect(snap.lock.targetId).toBe('TGT');
        break;
      }
    }
    expect(acquiringSeen).toBe(true);
    for (let i = 1; i < seenProgress.length; i++) expect(seenProgress[i]).toBeGreaterThanOrEqual(seenProgress[i - 1]);
    expect(lockedAt, '中範囲FCS・2脚は0.80秒').toBeGreaterThanOrEqual(0.8 - 1e-9);
    expect(lockedAt).toBeLessThanOrEqual(0.8 + 3 / 120);
    // 対象が範囲外へ出たら即座に破棄
    const t = g.state.enemies.find((e) => e.id === 'TGT')!;
    t.pos = { x: 0, y: PH, z: 200 }; // 背後・射程外
    g.step();
    expect(snapOf(g).lock).toEqual({ state: 'none', targetId: null, progress: 0, radiusCssPx: 144 });
    expect(snapOf(g).fireControl.status).toBe('inactive');
    // 戻すと0から (進捗を引き継がない)
    t.pos = { x: 0, y: PH, z: -60 };
    g.step();
    expect(snapOf(g).lock.state).toBe('acquiring');
    expect(snapOf(g).lock.progress).toBeLessThan(0.1);
  });

  it('fireControl: ロック完了前は status=inactive で status と weapon 以外が全て null (武器を切り替えると weapon が追従)', () => {
    const g = targetArena({});
    for (let i = 0; i < 30; i++) g.step();
    let snap = snapOf(g);
    expect(snap.lock.state).toBe('acquiring');
    const inactive = { status: 'inactive', weapon: 'machinegun', targetId: null, evaluatedAtSeconds: null, muzzlePosition: null, targetPosition: null, targetVelocity: null, launchDirection: null, predictedFlightSeconds: null, predictedInterceptPosition: null, aimPoint: null, residualMeters: null };
    expect(snap.fireControl).toEqual(inactive);
    g.input.weaponSelect = 'beam';
    g.step();
    snap = snapOf(g);
    expect(snap.fireControl).toEqual({ ...inactive, weapon: 'beam' });
    expect(snap.lock.state, '武器切り替えだけではロックをリセットしない').toBe('acquiring');
    expect(snap.lock.progress).toBeGreaterThan(30 / 120 / 0.8 - 1e-9);
    // 対象なし
    const g2 = arena({ enemies: [], player: { x: 0, z: 0 } });
    g2.step();
    expect(snapOf(g2).fireControl).toEqual(inactive);
  });

  it('fireControl (マシンガン・ロック完了・移動標的): solved。銃口・対象位置・実速度・評価時刻(=現在時刻)・偏差重力補正の式 aim=p+vt-0.5gt^2 / d=normalize(aim-m) / 残差<=0.01 が成り立つ', () => {
    const v = { x: 6, y: 0, z: 0 };
    const g = targetArena({ r: { x: 0, y: 0, z: -80 }, v });
    expect(stepUntil(g, () => g.state.lock.state === 'locked', 300)).toBe(true);
    g.step();
    const snap = snapOf(g);
    const fc = snap.fireControl;
    expect(snap.lock.state).toBe('locked');
    expect(fc.status).toBe('solved');
    expect(fc.weapon).toBe('machinegun');
    expect(fc.targetId).toBe('TGT');
    expect(fc.evaluatedAtSeconds, '現在時刻の値').toBe(snap.elapsedSeconds);
    const t = g.state.enemies.find((e) => e.id === 'TGT')!;
    expect(fc.targetPosition).toEqual(v3a(t.pos));
    expect(fc.targetVelocity, '実際の速度').toEqual([6, 0, 0]);
    // 銃口は実際の発射位置 (camera.ts の playerMuzzlePosition と同じ固定オフセット): 自由射撃の mgFire の origin と一致する
    const g2 = targetArena({ r: { x: 0, y: 0, z: -80 }, v });
    expect(stepUntil(g2, () => g2.state.lock.state === 'locked', 300)).toBe(true);
    g2.step();
    const fc2 = snapOf(g2).fireControl;
    g2.input.fire = true;
    g2.step();
    const ev = g2.drainEvents().find((e) => e.type === 'mgFire');
    expect(ev).toBeDefined();
    if (ev && ev.type === 'mgFire') {
      // 発射時刻Tは fc の評価時刻と同じ (評価は前tickの末尾=T)
      expect(fc2.evaluatedAtSeconds).toBeCloseTo(ev.time, 12);
      expect(v3a(ev.origin)).toEqual(fc2.muzzlePosition);
      expect(v3a(ev.dir)).toEqual(fc2.launchDirection);
    }
    const m = toV3(fc.muzzlePosition!);
    const p = toV3(fc.targetPosition!);
    const T = fc.predictedFlightSeconds!;
    expect(T).toBeGreaterThan(0.7);
    expect(T).toBeLessThan(1.0);
    const intercept = toV3(fc.predictedInterceptPosition!);
    expect(dist(intercept, addS(p, v, T))).toBeLessThan(1e-9);
    const aim = toV3(fc.aimPoint!);
    // 補正照準点 = 予測命中点 - 0.5 g t^2 (g = (0,-18,0)): 予測命中点より 0.5*18*t^2 だけ上
    expect(aim.y - intercept.y).toBeCloseTo(0.5 * 18 * T * T, 9);
    expect(aim.x).toBeCloseTo(intercept.x, 9);
    expect(aim.z).toBeCloseTo(intercept.z, 9);
    const d = toV3(fc.launchDirection!);
    expect(len(d)).toBeCloseTo(1, 12);
    expect(angleDeg(d, unit(sub(aim, m)))).toBeLessThan(1e-9);
    // 弾道の残差: m + 100 d t + 0.5 g t^2 と p + v t の距離
    const bullet = { x: m.x + 100 * d.x * T, y: m.y + 100 * d.y * T - 0.5 * 18 * T * T, z: m.z + 100 * d.z * T };
    expect(dist(bullet, intercept)).toBeLessThan(0.01);
    expect(fc.residualMeters!).toBeGreaterThanOrEqual(0);
    expect(fc.residualMeters!).toBeLessThanOrEqual(0.01);
    expect(Math.abs(fc.residualMeters! - dist(bullet, intercept))).toBeLessThan(1e-6);
  });

  it('fireControl (ビーム): 現在位置へ即時: predictedFlightSeconds=0・residualMeters=0・予測命中点=補正照準点=対象位置・方向=normalize(p-m) (移動標的でも未来位置を使わない)', () => {
    const g = targetArena({ r: { x: 0, y: 0, z: -80 }, v: { x: 6, y: 2, z: 0 }, weapon: 'beam' });
    expect(stepUntil(g, () => g.state.lock.state === 'locked', 300)).toBe(true);
    g.step();
    const fc = snapOf(g).fireControl;
    expect(fc.status).toBe('solved');
    expect(fc.weapon).toBe('beam');
    expect(fc.predictedFlightSeconds).toBe(0);
    expect(fc.residualMeters).toBe(0);
    expect(fc.predictedInterceptPosition).toEqual(fc.targetPosition);
    expect(fc.aimPoint).toEqual(fc.targetPosition);
    const m = toV3(fc.muzzlePosition!);
    const p = toV3(fc.targetPosition!);
    expect(angleDeg(toV3(fc.launchDirection!), unit(sub(p, m)))).toBeLessThan(1e-9);
    expect(fc.targetVelocity).toEqual([6, 2, 0]);
  });

  it('fireControl (ミサイル): 重力補正なしの偏差解 (v.v-45^2)t^2+2(r.v)t+r.r=0 の最小の正の解・normalize(r+vt)・予測命中点=補正照準点', () => {
    const v = { x: 8, y: 0, z: 0 };
    const g = targetArena({ r: { x: 0, y: 0, z: -70 }, v, weapon: 'missile' });
    expect(stepUntil(g, () => g.state.lock.state === 'locked', 300)).toBe(true);
    g.step();
    const fc = snapOf(g).fireControl;
    expect(fc.status).toBe('solved');
    expect(fc.weapon).toBe('missile');
    const m = toV3(fc.muzzlePosition!);
    const p = toV3(fc.targetPosition!);
    const orc = interceptOracle(m, p, toV3(fc.targetVelocity!), 45, 4)!;
    expect(orc).not.toBeNull();
    expect(fc.predictedFlightSeconds!).toBeCloseTo(orc.t, 9);
    expect(angleDeg(toV3(fc.launchDirection!), orc.dir)).toBeLessThan(1e-5);
    expect(fc.predictedInterceptPosition).toEqual(fc.aimPoint);
    expect(dist(toV3(fc.predictedInterceptPosition!), addS(p, toV3(fc.targetVelocity!), fc.predictedFlightSeconds!))).toBeLessThan(1e-9);
    expect(fc.residualMeters!).toBeGreaterThanOrEqual(0);
    expect(fc.residualMeters!).toBeLessThan(0.01);
  });

  it('fireControl (解なし): ロックは保持したまま status=no_solution。対象・銃口・評価時刻・直接照準の方向・aimPoint(=現在位置)は返し、到達時刻・予測命中点・残差は null。対象が失効したら古い値を残さない', () => {
    // 狭範囲FCS(0.40秒): 40m先を 95m/s で遠ざかる標的 → ロック完了時は約78m, 弾速100m/sでは2秒以内に追いつけない
    const g = targetArena({ r: { x: 0, y: 0, z: -40 }, v: { x: 0, y: 0, z: -95 }, loadout: { fcs: 'narrow', generator: 'balanced', legs: 'biped' } });
    expect(stepUntil(g, () => g.state.lock.state === 'locked', 200)).toBe(true);
    const snap = snapOf(g);
    expect(snap.lock.state).toBe('locked');
    const fc = snap.fireControl;
    expect(fc.status).toBe('no_solution');
    expect(fc.weapon).toBe('machinegun');
    expect(fc.targetId).toBe('TGT');
    expect(fc.evaluatedAtSeconds).toBe(snap.elapsedSeconds);
    expect(fc.muzzlePosition).not.toBeNull();
    expect(fc.targetPosition).not.toBeNull();
    expect(fc.launchDirection).not.toBeNull();
    expect(fc.aimPoint).toEqual(fc.targetPosition);
    expect(angleDeg(toV3(fc.launchDirection!), unit(sub(toV3(fc.targetPosition!), toV3(fc.muzzlePosition!))))).toBeLessThan(1e-9);
    expect(fc.predictedFlightSeconds).toBeNull();
    expect(fc.predictedInterceptPosition).toBeNull();
    expect(fc.residualMeters).toBeNull();
    // 解なしでも射撃は可能 (直接照準・1発消費・記録は no_solution)
    const before = g.state.player.ammo.machinegun;
    g.input.fire = true;
    g.step();
    g.input.fire = false;
    expect(g.state.player.ammo.machinegun).toBe(before - 1);
    const rec = snapOf(g).recentPlayerShots.at(-1)!;
    expect(rec.solutionStatus).toBe('no_solution');
    expect(rec.targetId).toBe('TGT');
    expect(rec.predictedFlightSeconds).toBeNull();
    expect(rec.predictedInterceptPosition).toBeNull();
    // 標的が射程外へ出る → 失効: 古い値を残さない
    expect(stepUntil(g, () => g.state.lock.state === 'none', 120)).toBe(true);
    expect(snapOf(g).fireControl).toEqual({ status: 'inactive', weapon: 'machinegun', targetId: null, evaluatedAtSeconds: null, muzzlePosition: null, targetPosition: null, targetVelocity: null, launchDirection: null, predictedFlightSeconds: null, predictedInterceptPosition: null, aimPoint: null, residualMeters: null });
  });
});

describe('§10 getSnapshot: recentPlayerShots の意味', () => {
  it('マシンガン(ロック完了): 発射瞬間のコピー。時刻・武器・対象・solved・銃口(=mgFireのorigin)・方向(=mgFireのdir)・initialVelocity(=実弾のv0)・accelerationAtFire=(0,-18,0)・予測時間/命中点はHUDの補正解と同一', () => {
    const g = targetArena({ r: { x: 0, y: 0, z: -80 }, v: { x: 6, y: 0, z: 0 } });
    expect(stepUntil(g, () => g.state.lock.state === 'locked', 300)).toBe(true);
    g.step();
    const fcBefore = snapOf(g).fireControl;
    const T0 = g.state.time;
    g.input.fire = true;
    g.step();
    g.input.fire = false;
    const evs = g.drainEvents();
    const snap = snapOf(g);
    expect(snap.recentPlayerShots.length).toBe(1);
    const r = snap.recentPlayerShots[0];
    expect(r.id).toBe(1);
    expect(r.firedAtSeconds, '発射tickの開始時刻').toBe(T0);
    expect(r.weapon).toBe('machinegun');
    expect(r.targetId).toBe('TGT');
    expect(r.solutionStatus).toBe('solved');
    const ev = evs.find((e) => e.type === 'mgFire');
    expect(ev && ev.type === 'mgFire').toBe(true);
    if (ev && ev.type === 'mgFire') {
      expect(r.muzzlePosition).toEqual(v3a(ev.origin));
      expect(r.launchDirection).toEqual(v3a(ev.dir));
    }
    const bullet = g.state.bullets[g.state.bullets.length - 1];
    expect(r.initialVelocity, '弾体へ本当に設定した値').toEqual(v3a(bullet.v0));
    expect(len(toV3(r.initialVelocity!))).toBeCloseTo(100, 6);
    expect(angleDeg(toV3(r.initialVelocity!), toV3(r.launchDirection))).toBeLessThan(1e-9);
    expect(r.accelerationAtFire).toEqual([0, -18, 0]);
    expect(r.targetPositionAtFire).toEqual(fcBefore.targetPosition);
    expect(r.targetVelocityAtFire).toEqual([6, 0, 0]);
    expect(r.predictedFlightSeconds).toBe(fcBefore.predictedFlightSeconds);
    expect(r.predictedInterceptPosition).toEqual(fcBefore.predictedInterceptPosition);
    expect(r.launchDirection).toEqual(fcBefore.launchDirection);
    expect(r.muzzlePosition).toEqual(fcBefore.muzzlePosition);
    expect(shapeErrors(snap)).toEqual([]);
  });

  it('自由射撃(未ロック): solutionStatus=inactive・targetId=null・対象/予測値=null・initialVelocityは方向x100で非null・accelerationAtFire=(0,-18,0)。ビームは initialVelocity=null・加速度(0,0,0)、ミサイルは (0,0,0) と方向x45', () => {
    const g = arena({ enemies: [], player: { x: 0, z: 0 } });
    g.input.fire = true;
    g.step(); // MG 自由射撃
    g.input.weaponSelect = 'beam';
    for (let i = 0; i < 40; i++) g.step();
    g.input.fire = false;
    const snap = snapOf(g);
    const mg = snap.recentPlayerShots.find((r) => r.weapon === 'machinegun')!;
    expect(mg.solutionStatus).toBe('inactive');
    expect(mg.targetId).toBeNull();
    expect(mg.targetPositionAtFire).toBeNull();
    expect(mg.targetVelocityAtFire).toBeNull();
    expect(mg.predictedFlightSeconds).toBeNull();
    expect(mg.predictedInterceptPosition).toBeNull();
    expect(mg.initialVelocity).not.toBeNull();
    expect(len(toV3(mg.initialVelocity!))).toBeCloseTo(100, 6);
    expect(mg.accelerationAtFire).toEqual([0, -18, 0]);
    const beam = snap.recentPlayerShots.find((r) => r.weapon === 'beam')!;
    expect(beam.solutionStatus).toBe('inactive');
    expect(beam.initialVelocity, 'ビームでは null').toBeNull();
    expect(beam.accelerationAtFire).toEqual([0, 0, 0]);
    expect(beam.targetId).toBeNull();
    expect(len(toV3(beam.launchDirection))).toBeCloseTo(1, 9);
    // ミサイル(ロック完了)
    const g2 = targetArena({ r: { x: 0, y: 0, z: -70 }, v: { x: 8, y: 0, z: 0 }, weapon: 'missile' });
    expect(stepUntil(g2, () => g2.state.lock.state === 'locked', 300)).toBe(true);
    g2.step();
    const fc = snapOf(g2).fireControl;
    g2.input.fire = true;
    g2.step();
    g2.input.fire = false;
    const ms = snapOf(g2).recentPlayerShots.at(-1)!;
    expect(ms.weapon).toBe('missile');
    expect(ms.solutionStatus).toBe('solved');
    expect(ms.targetId).toBe('TGT');
    expect(ms.accelerationAtFire).toEqual([0, 0, 0]);
    expect(len(toV3(ms.initialVelocity!))).toBeCloseTo(45, 9);
    expect(ms.initialVelocity).toEqual(v3a(g2.state.missiles[0].vel));
    expect(ms.predictedFlightSeconds, 'ミサイルの予測時刻は旋回時間を含まない初期方向の等速解').toBe(fc.predictedFlightSeconds);
    expect(ms.predictedInterceptPosition).toEqual(fc.predictedInterceptPosition);
  });

  it('ビーム(ロック完了): 記録は solved・対象ID・predictedFlightSeconds=0・initialVelocity=null・加速度(0,0,0)・予測命中点=対象の発射時の位置、方向は normalize(p-m) で移動標的の未来位置を使わない', () => {
    const g = targetArena({ r: { x: 0, y: 0, z: -70 }, v: { x: 6, y: 1, z: 0 }, weapon: 'beam' });
    expect(stepUntil(g, () => g.state.lock.state === 'locked', 300)).toBe(true);
    g.step();
    const fc = snapOf(g).fireControl;
    g.input.fire = true;
    g.step();
    g.input.fire = false;
    const r = snapOf(g).recentPlayerShots.at(-1)!;
    expect(r.weapon).toBe('beam');
    expect(r.solutionStatus).toBe('solved');
    expect(r.targetId).toBe('TGT');
    expect(r.predictedFlightSeconds).toBe(0);
    expect(r.initialVelocity).toBeNull();
    expect(r.accelerationAtFire).toEqual([0, 0, 0]);
    expect(r.targetPositionAtFire).toEqual(fc.targetPosition);
    expect(r.targetVelocityAtFire).toEqual([6, 1, 0]);
    expect(r.predictedInterceptPosition).toEqual(r.targetPositionAtFire);
    expect(angleDeg(toV3(r.launchDirection), unit(sub(toV3(r.targetPositionAtFire!), toV3(r.muzzlePosition))))).toBeLessThan(1e-9);
  });

  it('拒否された操作では記録が増えない (未ロックのミサイル・EN不足のビーム・弾切れのマシンガン)。弾数・ENも変わらない', () => {
    const g = arena({ enemies: [], player: { x: 0, z: 0 } });
    // 未ロックのミサイル
    g.input.weaponSelect = 'missile';
    g.input.fire = true;
    for (let i = 0; i < 30; i++) g.step();
    expect(snapOf(g).recentPlayerShots.length).toBe(0);
    expect(snapOf(g).player.ammo.missile).toBe(12);
    // EN不足のビーム
    g.input.weaponSelect = 'beam';
    g.state.player.en = 0;
    for (let i = 0; i < 30; i++) g.step(); // 回復は毎秒15 -> 0.25秒で3.75 < 8
    expect(snapOf(g).recentPlayerShots.length).toBe(0);
    expect(snapOf(g).player.en).toBeLessThan(8);
    // 弾切れのマシンガン
    g.input.weaponSelect = 'machinegun';
    g.state.player.ammo.machinegun = 0;
    for (let i = 0; i < 30; i++) g.step();
    expect(snapOf(g).recentPlayerShots.length).toBe(0);
    expect(snapOf(g).player.ammo.machinegun).toBe(0);
    // 弾が入ると撃てる
    g.state.player.ammo.machinegun = 2;
    for (let i = 0; i < 30; i++) g.step();
    expect(snapOf(g).recentPlayerShots.length).toBe(2);
    expect(snapOf(g).player.ammo.machinegun).toBe(0);
  });

  it('直近32件・古い順・連番: 50発撃つと32件で、idは1増えつつ最後が実際の総射撃数、時刻は非減少。過去の記録は後続の対象移動・武器切り替え・時間経過で変わらない (コピー)。再出撃で配列と連番が初期化される', () => {
    const g = targetArena({ r: { x: 0, y: 0, z: -80 }, v: { x: 6, y: 0, z: 0 } });
    expect(stepUntil(g, () => g.state.lock.state === 'locked', 300)).toBe(true);
    g.input.fire = true;
    let shots = 0;
    let keep: ReturnType<typeof snapOf>['recentPlayerShots'][number] | null = null;
    for (let i = 0; i < 6 * 120 && shots < 50; i++) {
      g.step();
      for (const ev of g.drainEvents()) if (ev.type === 'mgFire') shots++;
      if (keep === null && shots >= 1) keep = JSON.parse(JSON.stringify(snapOf(g).recentPlayerShots[0]));
    }
    g.input.fire = false;
    expect(shots).toBe(50);
    const snap = snapOf(g);
    expect(snap.recentPlayerShots.length).toBe(32);
    const ids = snap.recentPlayerShots.map((r) => r.id);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBe(ids[i - 1] + 1);
    expect(ids[ids.length - 1]).toBe(50);
    expect(ids[0]).toBe(19);
    const times = snap.recentPlayerShots.map((r) => r.firedAtSeconds);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1] + 0.1 - 1e-9); // 最短射撃間隔0.10秒
    expect(shapeErrors(snap)).toEqual([]);
    // 追いつめる: 記録は発射瞬間のコピー
    const frozen = JSON.parse(JSON.stringify(snap.recentPlayerShots));
    const t = g.state.enemies.find((e) => e.id === 'TGT')!;
    t.vel = { x: -30, y: 5, z: 10 };
    g.input.weaponSelect = 'beam';
    for (let i = 0; i < 60; i++) g.step();
    const later = snapOf(g).recentPlayerShots;
    for (const r of frozen) {
      const now = later.find((x) => x.id === r.id);
      if (now) expect(now).toEqual(r);
    }
    expect(keep).not.toBeNull();
    // 再出撃で初期化
    g.retry();
    expect(snapOf(g).recentPlayerShots).toEqual([]);
    g.state.enemies.push(makeScriptedTarget('TGT', { x: 0, y: PH, z: -80 }, { x: 0, y: 0, z: 0 }));
    g.input.fire = true;
    g.step();
    g.input.fire = false;
    expect(snapOf(g).recentPlayerShots.map((r) => r.id)).toEqual([1]);
  });
});

describe('§10 getSnapshot: enemies / objective / stage の意味', () => {
  it('enemies: 45体 (G01..G30, T01..T15)、IDは出撃内・再出撃・格納庫往復で不変で並びも同じ。velocityは実際の当たり判定中心の速度 ((pos-prevPos)/dt)、固定砲台は0', () => {
    const g = realGame();
    const ids0 = snapOf(g).enemies.map((e) => e.id);
    expect(ids0.length).toBe(45);
    expect(ids0.filter((i) => /^G\d\d$/.test(i)).length).toBe(30);
    expect(ids0.filter((i) => /^T\d\d$/.test(i)).length).toBe(15);
    expect(new Set(ids0).size).toBe(45);
    const meta0 = snapOf(g).enemies.map((e) => [e.id, e.kind, e.isGateControl, e.sectorId]);
    for (const e of snapOf(g).enemies) expect(REAL.sectors.some((s) => s.id === e.sectorId), `${e.id} の sectorId`).toBe(true);
    // 進行させて動かす
    teleport(g, sectorCenter('S02'));
    g.state.player.hp = 1e9;
    let maxSpeed = 0;
    let movedGuards = 0;
    for (let i = 0; i < 6 * 120; i++) {
      g.step();
      g.drainEvents();
      if (i % 30 === 0) {
        const snap = snapOf(g);
        expect(snap.enemies.map((e) => e.id)).toEqual(ids0);
        for (const e of g.state.enemies) {
          const se = snap.enemies.find((x) => x.id === e.id)!;
          expect(se.velocity, `${e.id} の速度は当たり判定中心の実速度`).toEqual(v3a(e.vel));
          const disp = { x: (e.pos.x - e.prevPos.x) * 120, y: (e.pos.y - e.prevPos.y) * 120, z: (e.pos.z - e.prevPos.z) * 120 };
          expect(dist(disp, e.vel), `${e.id} の速度と実際の変位`).toBeLessThan(1e-6);
          if (e.kind === 'turret') expect(se.velocity).toEqual([0, 0, 0]);
          else maxSpeed = Math.max(maxSpeed, hspeed(toV3(se.velocity)));
          expect(se.position).toEqual(v3a(e.pos));
          expect(se.hp).toBe(e.hp);
          expect(se.alert).toBe(e.alert);
          expect(se.hasLineOfSight).toBe(e.hasLineOfSight);
          expect(se.shotsFired).toBe(e.shotsFired);
          expect(se.lastShotAtSeconds).toBe(e.lastShotAt);
        }
      }
    }
    for (const e of g.state.enemies) if (e.kind === 'guard' && Math.hypot(e.pos.x - REAL.enemies.find((s) => s.id === e.id)!.pos.x, e.pos.z - REAL.enemies.find((s) => s.id === e.id)!.pos.z) > 1) movedGuards++;
    expect(maxSpeed).toBeGreaterThan(5);
    expect(movedGuards).toBeGreaterThan(0);
    g.retry();
    expect(snapOf(g).enemies.map((e) => e.id)).toEqual(ids0);
    expect(snapOf(g).enemies.map((e) => [e.id, e.kind, e.isGateControl, e.sectorId])).toEqual(meta0);
    g.toGarage();
    g.sortie();
    expect(snapOf(g).enemies.map((e) => e.id)).toEqual(ids0);
  });

  it('破壊された敵も enemies に残り alive=false・hp=0・velocity=[0,0,0]・alert=false・hasLineOfSight=false。撃った数と最後の発射時刻は保持され、順序・件数(45)も不変。撃破後は撃たず動かず、増えない', () => {
    const g = arena({ enemies: [spawn('guard', 'G01', 0, -40), spawn('turret', 'T01', 30, -60)], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    rec.run(3);
    const before = snapOf(g);
    const gBefore = before.enemies.find((e) => e.id === 'G01')!;
    expect(gBefore.shotsFired).toBeGreaterThan(0);
    expect(gBefore.lastShotAtSeconds).not.toBeNull();
    damageEnemy(g.state, enemyOf(g, 'G01'), 1e9, 'machinegun');
    rec.run(0.5);
    const snap = snapOf(g);
    expect(snap.enemies.map((e) => e.id)).toEqual(['G01', 'T01']);
    const dead = snap.enemies[0];
    expect(dead.alive).toBe(false);
    expect(dead.hp).toBe(0);
    expect(dead.velocity).toEqual([0, 0, 0]);
    expect(dead.alert).toBe(false);
    expect(dead.hasLineOfSight).toBe(false);
    const firedBeforeDeath = rec.of('G01').length;
    expect(dead.shotsFired, '撃った数は実際に生成した敵弾の数').toBe(firedBeforeDeath);
    expect(dead.lastShotAtSeconds).toBe(rec.of('G01').at(-1)!.time);
    // さらに10秒: 撃たず、動かず、復活しない
    const pos = dead.position;
    rec.run(10);
    expect(rec.of('G01').length).toBe(firedBeforeDeath);
    const later = snapOf(g);
    expect(later.enemies.length).toBe(2);
    expect(later.enemies[0].alive).toBe(false);
    expect(later.enemies[0].hp).toBe(0);
    expect(later.enemies[0].position).toEqual(pos);
    expect(later.enemies[1].alive, '他の敵は生存').toBe(true);
  });

  it('本編の45体: 制御砲台を全部壊しても敵は増えず、時間が経っても撃破済みの敵は再出現しない (無限に再出現する敵で数を満たさない)', () => {
    const g = realGame();
    destroyAllControls(g);
    const dead = new Set(g.state.enemies.filter((e) => !e.alive).map((e) => e.id));
    expect(dead.size).toBe(6);
    for (let i = 0; i < 60 * 120; i++) {
      g.step();
      g.drainEvents();
    }
    expect(g.state.enemies.length).toBe(45);
    for (const e of g.state.enemies) if (dead.has(e.id)) expect(e.alive, `${e.id} は再出現しない`).toBe(false);
    expect(g.state.enemies.filter((e) => e.alive).length).toBe(39);
    const snap = snapOf(g);
    expect(snap.enemies.length).toBe(45);
    expect(snap.enemies.filter((e) => e.alive).length).toBe(39);
    expect(snap.stage.totalEnemies).toBe(45);
  });

  it('objective / stage: 制御砲台の破壊数・開いた隔壁ID・ゲート・区画数(15以上=実際の区画定義)・現在区画・通過した区画(重複なし・通過順)。controlsRequired=6, totalEnemies=45', () => {
    const g = realGame();
    let snap = snapOf(g);
    expect(snap.objective).toEqual({ controlsDestroyed: 0, controlsRequired: 6, openBarrierIds: [], gateOpen: false });
    expect(snap.stage.sectorCount).toBe(REAL.sectors.length);
    expect(snap.stage.sectorCount).toBeGreaterThanOrEqual(15);
    expect(snap.stage.totalEnemies).toBe(45);
    expect(snap.stage.currentSectorId).toBe('S01');
    expect(snap.stage.visitedSectorIds).toEqual(['S01']);
    const order = ['S05', 'S02', 'S05', 'S01', 'S09'];
    for (const id of order) {
      teleport(g, sectorCenter(id));
      g.state.player.hp = 1e9;
      g.step();
      snap = snapOf(g);
      expect(snap.stage.currentSectorId, `${id} に居る`).toBe(id);
    }
    expect(snap.stage.visitedSectorIds, '通過順・重複なし').toEqual(['S01', 'S05', 'S02', 'S09']);
    // 破壊: 各制御砲台
    const ctl = controlsOf(g);
    damageEnemy(g.state, ctl[2], 1e9, 'machinegun');
    g.step();
    snap = snapOf(g);
    expect(snap.objective.controlsDestroyed).toBe(1);
    expect(snap.objective.openBarrierIds).toEqual([ctl[2].barrierId]);
    expect(snap.objective.gateOpen).toBe(false);
    for (const c of ctl) if (c !== ctl[2]) damageEnemy(g.state, c, 1e9, 'machinegun');
    g.step();
    snap = snapOf(g);
    expect(snap.objective.controlsDestroyed).toBe(6);
    expect([...snap.objective.openBarrierIds].sort()).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
    expect(snap.objective.gateOpen).toBe(true);
    expect(snap.objective.controlsRequired).toBe(6);
  });
});

describe('§10 getSnapshot: 返却値はコピー・呼び出しで状態が変わらない', () => {
  it('返却値を深く書き換えても (数値・文字列・配列のpush・要素の削除) ゲーム状態と次のスナップショットに影響しない。2回の呼び出しは互いに参照を共有しない', () => {
    const g = combatGame({ seed: 5, hp: 1e9 });
    const s = g.state;
    for (let t = 0; t < 400; t++) {
      chaosScript(g, t);
      g.step();
    }
    expect(s.shots.length).toBeGreaterThan(0);
    const dumpBefore = dumpGame(g);
    const eventsBefore = s.events.length;
    const a = snapOf(g);
    const golden = JSON.parse(JSON.stringify(a));
    // 参照共有の検出
    const b = snapOf(g);
    const seen = new Set<object>();
    const collect = (v: unknown, into: Set<object>): void => {
      if (v && typeof v === 'object') {
        into.add(v);
        for (const x of Object.values(v)) collect(x, into);
      }
    };
    collect(a, seen);
    const shared: string[] = [];
    const scan = (v: unknown, path: string): void => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) shared.push(path);
        for (const [k, x] of Object.entries(v)) scan(x, `${path}.${k}`);
      }
    };
    scan(b, '$');
    expect(shared, '2つのスナップショットが同じオブジェクトを共有').toEqual([]);
    // GameStateとの参照共有 (state内の配列/オブジェクトをそのまま返していない): 主要な配列・ベクトルの参照を直接比較する
    const stateRefs: unknown[] = [s.player.pos, s.player.vel, s.shots, s.enemies, s.objective.openBarrierIds, s.progress.visitedSectorIds, s.fc.muzzlePosition, s.fc.launchDirection, s.lock, s.player.ammo, s.loadout, s.stats];
    for (const e of s.enemies) stateRefs.push(e.pos, e.vel);
    for (const sh of s.shots) stateRefs.push(sh.muzzlePosition, sh.launchDirection, sh.initialVelocity);
    const aObjs = new Set<object>();
    collect(a, aObjs);
    for (const r of stateRefs) if (r && typeof r === 'object') expect(aObjs.has(r as object), 'GameStateの内部オブジェクトをそのまま返している').toBe(false);
    // 深く書き換える
    const mutate = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (typeof v[i] === 'number') v[i] = (v[i] as number) + 12345;
          else if (typeof v[i] === 'string') v[i] = 'MUTATED';
          else mutate(v[i]);
        }
        v.push('X');
        v.length = Math.max(0, v.length - 2);
      } else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        for (const k of Object.keys(o)) {
          if (typeof o[k] === 'number') o[k] = (o[k] as number) + 12345;
          else if (typeof o[k] === 'string') o[k] = 'MUTATED';
          else if (typeof o[k] === 'boolean') o[k] = !o[k];
          else mutate(o[k]);
        }
        o.extra = 1;
      }
    };
    mutate(a);
    expect(diffPaths(dumpBefore, dumpGame(g)), '書き換えでゲーム状態が変わった').toEqual([]);
    expect(s.events.length).toBe(eventsBefore);
    expect(snapOf(g)).toEqual(golden);
    // 本編を続行しても影響なし・再現可能
    for (let t = 400; t < 500; t++) {
      chaosScript(g, t);
      g.step();
    }
    expect(shapeErrors(snapOf(g))).toEqual([]);
  });

  it('getSnapshot() 自体は状態を変えない: 何度呼んでも GameState 全体・乱数状態・イベントキューが不変で、呼んだ場合と呼ばなかった場合で以降の進行が完全に同一 (一時停止中/クリア後/格納庫でも)', () => {
    const run = (calls: boolean): unknown => {
      const g = combatGame({ seed: 99, hp: 1e9 });
      for (let t = 0; t < 500; t++) {
        chaosScript(g, t);
        g.step();
        if (calls) {
          snapOf(g);
          snapOf(g);
          buildSnapshot(g.state);
        }
      }
      g.pause();
      if (calls) for (let i = 0; i < 5; i++) snapOf(g);
      g.resume();
      for (let t = 500; t < 600; t++) {
        chaosScript(g, t);
        g.step();
        if (calls) snapOf(g);
      }
      return dumpGame(g);
    };
    expect(diffPaths(run(false), run(true))).toEqual([]);
    // 格納庫・失敗後も
    const g0 = new Game({ stage: REAL });
    const d0 = dumpGame(g0);
    snapOf(g0);
    snapOf(g0);
    expect(diffPaths(d0, dumpGame(g0))).toEqual([]);
    const gf = realGame();
    gf.state.player.hp = 0;
    gf.step();
    const df = dumpGame(gf);
    snapOf(gf);
    expect(diffPaths(df, dumpGame(gf))).toEqual([]);
  });

  it('公開されるのは AK2_BENCH.getSnapshot だけ: main.ts は window.AK2_BENCH に getSnapshot 以外のメソッドを足さず、書き換えできないようにしている (静的確認)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    const m = /window\.AK2_BENCH\s*=\s*([\s\S]*?);\s*\n/.exec(src);
    expect(m, 'window.AK2_BENCH への代入').not.toBeNull();
    const rhs = (m as RegExpExecArray)[1];
    const keys = [...rhs.matchAll(/(\w+)\s*:/g)].map((x) => x[1]);
    expect(keys).toEqual(['getSnapshot']);
    expect(src.match(/AK2_BENCH\s*=/g)?.length).toBe(1);
    expect(src).not.toMatch(/window\.\w+\s*=/g.source.replace('\\w+', '(?!AK2_BENCH)\\w+'));
    // getSnapshot は呼ぶたびに「現在の state」から作る (再出撃で state が置き換わっても追従する)
    expect(rhs).toMatch(/app\.game\.state/);
  });
});

// =====================================================================================================================
// 補足: 通し確認・弾の生成tick・被弾方向・共有の経路長・不規則フレーム・nav状態依存・UIの重複登録
// =====================================================================================================================
describe('§2.1 正規経路の通し確認 (実ステージ・全敵が生きて撃つ中を、検証済み主経路に沿って歩く)', () => {
  it('主経路(validateStage)を 22m/s で辿る (ハーネス: プレイヤー位置を経路上に置く。敵・武器・隔壁・ゲート・進行判定は全て本物): 制御砲台を順に壊して6隔壁が開き、12区画以上を通過し、ゲート開放後の脱出領域でクリアする。隔壁が開いていない場所には入らない', () => {
    const rep = validateStage(REAL, { runClimbBot: false, relaxedRoute: false, altRouteGrid: false });
    expect(rep.route.found).toBe(true);
    const pts = rep.route.points;
    const cum: number[] = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i], pts[i - 1]));
    const total = cum[cum.length - 1];
    const at = (m: number): V3 => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < m) i++;
      const t = Math.min(1, Math.max(0, (m - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1])));
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
    };
    const g = realGame();
    const s = g.state;
    s.player.hp = 1e9;
    const H = { x: 0.8, y: 1.5, z: 0.8 };
    const zone = REAL.escapeZone;
    const opened: string[] = [];
    const sectorsSeen: string[] = [];
    let gateOpenAt = -1;
    let hits = 0;
    let overlaps = 0;
    let guardClips = 0;
    let m = 0;
    let ticks = 0;
    const done = new Set<string>();
    while (s.mode === 'playing' && ticks < 25000) {
      // 各隔壁の手前30mで、その制御砲台を破壊する (実際の damageEnemy)
      for (const c of rep.route.barrierCrossings) {
        if (c.barrierId === 'GATE' || done.has(c.barrierId) || m < c.atMeters - 30) continue;
        damageEnemy(s, s.enemies.find((e) => e.barrierId === c.barrierId)!, 1e9, 'machinegun');
        done.add(c.barrierId);
      }
      const p = at(Math.min(m, total));
      s.player.prevPos = { ...s.player.pos };
      s.player.pos = p;
      s.player.vel = { x: 0, y: 0, z: 0 };
      g.step();
      for (const ev of g.drainEvents()) {
        if (ev.type === 'barrierOpen') opened.push(ev.barrierId);
        else if (ev.type === 'gateOpen') gateOpenAt = ev.time;
        else if (ev.type === 'sector') sectorsSeen.push(ev.sectorId);
        else if (ev.type === 'playerHit') hits++;
      }
      if (s.mode === 'playing' && g.world.overlapAABB(s.player.pos, H, 0.05)) overlaps++;
      if (ticks % 6 === 0) {
        for (const e of s.enemies) {
          if (e.alive && e.kind === 'guard' && g.world.overlapAABB(e.pos, { x: e.hitRadius, y: e.hitRadius, z: e.hitRadius }, 0.1)) guardClips++;
        }
      }
      m += 22 / 120;
      ticks++;
    }
    console.info(`[route walk] mode ${s.mode}, ${ticks} ticks (${s.time.toFixed(1)} s), route ${total.toFixed(0)} m, sectors ${s.progress.visitedSectorIds.length}, hits ${hits}, damage ${s.damageTaken}`);
    expect(s.mode).toBe('cleared');
    expect(s.endReason).toBe('escaped');
    expect(opened).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
    expect(s.objective).toEqual({ controlsDestroyed: 6, openBarrierIds: ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'], gateOpen: true });
    expect(gateOpenAt).toBeGreaterThan(0);
    expect(gateOpenAt).toBeLessThan(s.time);
    expect(sectorsSeen.length).toBe(new Set(sectorsSeen).size);
    expect(s.progress.visitedSectorIds, '通過順 (sector イベントの順) と一致').toEqual(sectorsSeen);
    expect(s.progress.visitedSectorIds.length, 'SPEC §2.2: 少なくとも12の異なる区画を物理的に通過').toBeGreaterThanOrEqual(12);
    expect(rep.route.sectors.every((id) => s.progress.visitedSectorIds.includes(id))).toBe(true);
    expect(overlaps, '経路上で壁・閉じた隔壁にめり込んでいない').toBe(0);
    expect(guardClips, '警備ロボットが壁・設備にめり込んで動いていない (設備を無視した直進をしない)').toBe(0);
    expect(hits, '敵は実際に撃って当てている').toBeGreaterThan(0);
    expect(s.damageTaken).toBeGreaterThan(0);
    const p = s.player.pos;
    expect(p.x >= zone.min.x && p.x <= zone.max.x && p.y >= zone.min.y && p.y <= zone.max.y && p.z >= zone.min.z && p.z <= zone.max.z, 'クリア時は脱出領域の中').toBe(true);
    expect(buildSnapshot(s).state).toBe('cleared');
    expect(buildSnapshot(s).stage.visitedSectorIds.length).toBeGreaterThanOrEqual(12);
  });

  it('killY はどの区画の床よりも十分下: 通常のプレイ空間の最深部の床に立っても落下失敗にならない (復帰不能なステージ外への落下だけが失敗)', () => {
    const lowestFloor = Math.min(...REAL.sectors.map((x) => x.floorY));
    expect(REAL.killY).toBeLessThan(lowestFloor - 10);
    const g = realGame();
    const deepest = REAL.sectors.reduce((a, b) => (a.floorY <= b.floorY ? a : b));
    teleport(g, sectorCenter(deepest.id));
    for (let i = 0; i < 360; i++) g.step();
    expect(g.state.mode).toBe('playing');
    expect(g.state.player.pos.y).toBeGreaterThan(REAL.killY);
  });

  it('開始地点の保護: 全45体の初期位置から、開始位置のプレイヤーへは 射程外か遮蔽 (幾何) であり、開始から120秒 (入力なし) の間、警戒・射線・敵弾・被弾が一切生じない。最初のtickから', () => {
    const g = realGame();
    const s = g.state;
    const start = s.player.pos;
    for (const e of s.enemies) {
      const range = e.kind === 'guard' ? 90 : 120;
      const m = enemyMuzzlePosition(e);
      const blocked = g.world.segmentBlocked(m, start);
      expect(dist(m, start) > range || blocked, `${e.id} は開始地点を撃てる位置にいる (距離 ${dist(m, start).toFixed(1)}m, 遮蔽 ${blocked})`).toBe(true);
    }
    g.step();
    expect(s.enemies.some((e) => e.hasLineOfSight)).toBe(false);
    expect(s.player.hp).toBe(1000);
    for (let i = 0; i < 120 * 120; i++) {
      g.step();
      g.drainEvents();
      if (s.enemies.some((e) => e.hasLineOfSight || e.alert) || s.enemyBullets.length > 0 || s.player.hp < 1000) {
        throw new Error(`開始地点で 敵の警戒/射線/弾/被弾 が tick ${s.tick} に発生`);
      }
    }
    expect(s.mode).toBe('playing');
  });
});

describe('§2.3 補足: 生成tickの弾・被弾方向・共有の経路長', () => {
  it('敵弾は生成したtickで残りの区間 (1 dt) だけ進む: age=1/120・位置=銃口+方向x弾速x(1/120)・prevPos=銃口 (1フレーム分余分に前進させない)。3秒間の全発で成立', () => {
    for (const kind of ['guard', 'turret'] as const) {
      const S = SPEC[kind];
      const g = arena({ enemies: [spawn(kind, idOf(kind), 0, kind === 'guard' ? -50 : -80)], player: { x: 0, z: 0 } });
      const s = g.state;
      let n = 0;
      for (let i = 0; i < 4 * 120; i++) {
        const before = new Set(s.enemyBullets.map((b) => b.id));
        g.step();
        const fires = g.drainEvents().filter((e) => e.type === 'enemyFire');
        const fresh = s.enemyBullets.filter((b) => !before.has(b.id));
        expect(fresh.length, `tick ${i}: 新規の弾数 = 発射イベント数`).toBe(fires.length);
        for (const f of fires) {
          if (f.type !== 'enemyFire') continue;
          const b = fresh.find((x) => x.ownerId === f.id)!;
          expect(b.age).toBeCloseTo(DT, 12);
          expect(dist(b.prevPos, f.origin)).toBeLessThan(1e-9);
          expect(dist(b.pos, addS(f.origin, f.dir, S.speed * DT))).toBeLessThan(1e-9);
          n++;
        }
      }
      expect(n).toBeGreaterThan(3);
    }
  });

  it('被弾方向 (HUD): 被弾ごとに damageIndicators と playerHit イベントが記録され、dirToSource は プレイヤーから射手の銃口(弾を撃った位置)へ向く単位ベクトル。背後・上方・側方の射手でも一致', () => {
    const g = arena({
      enemies: [spawn('turret', 'T01', 0, -50), spawn('turret', 'T02', 55, 0), spawn('turret', 'T03', -30, 40, 20), spawn('guard', 'G01', 0, 45)],
      player: { x: 0, z: 0 },
      hp: 1e9,
    });
    const s = g.state;
    // 警備は動くので、射手の銃口は発射イベント (敵が弾を撃った位置) から集める
    const origins: { id: string; origin: V3 }[] = [];
    const seen = new Set<string>();
    let hits = 0;
    for (let i = 0; i < 8 * 120 && s.mode === 'playing'; i++) {
      const before = s.damageIndicators.length;
      const hpBefore = s.player.hp;
      g.step();
      const evs = g.drainEvents();
      for (const ev of evs) if (ev.type === 'enemyFire') origins.push({ id: ev.id, origin: ev.origin });
      for (const ev of evs) {
        if (ev.type !== 'playerHit') continue;
        hits++;
        const owner = origins.find((o) => dist(o.origin, ev.fromPos) < 1e-6);
        expect(owner, `被弾元 (${ev.fromPos.x.toFixed(2)},${ev.fromPos.y.toFixed(2)},${ev.fromPos.z.toFixed(2)}) はどれかの敵が弾を撃った位置`).toBeDefined();
        seen.add(owner!.id);
        expect(len(ev.dirToSource)).toBeCloseTo(1, 9);
        const toShooter = unit(sub(ev.fromPos, s.player.pos));
        expect(angleDeg(ev.dirToSource, toShooter), '射手の方向').toBeLessThan(0.5);
        expect(hpBefore - s.player.hp).toBeGreaterThanOrEqual(ev.damage);
      }
      expect(s.damageIndicators.length).toBeGreaterThanOrEqual(Math.min(before, 16));
    }
    expect(hits).toBeGreaterThan(8);
    expect([...seen].sort(), '全ての方向の射手から被弾方向が記録される').toEqual(['G01', 'T01', 'T02', 'T03']);
    expect(s.damageIndicators.length).toBeLessThanOrEqual(16);
    const last = s.damageIndicators[s.damageIndicators.length - 1];
    expect(len(last.dirToSource)).toBeCloseTo(1, 9);
    expect([18, 40]).toContain(last.damage);
  });

  it('共有の「通路でつながる60m以内」: 射線のある警備Aから、直線では近い(45m/55m)が歩行経路が 55m 前後 / 65m 前後 の壁裏の警備Bへ。経路55mなら受け取り、65mなら受け取らない (解釈: 通路=歩行経路の長さが60m以内)', () => {
    const outcomes: { pathLen: number; straight: number; alert: boolean }[] = [];
    for (const W of [35.9, 46.2]) {
      const wall = box(-W, 0, -22, W, 14, -20);
      const g = arena({ enemies: [spawn('guard', 'GA', W + 3, -5), spawn('guard', 'GB', 0, -30)], boxes: [wall], player: { x: 0, z: 0 } });
      const nav = getNav(g.world, REAL);
      const a = enemyOf(g, 'GA');
      const b = enemyOf(g, 'GB');
      const pathLen = nav.pathLength({ x: a.pos.x, y: 0, z: a.pos.z }, { x: b.pos.x, y: 0, z: b.pos.z });
      g.step();
      expect(a.hasLineOfSight, 'Aは射線あり').toBe(true);
      expect(b.hasLineOfSight, 'Bは壁の裏').toBe(false);
      outcomes.push({ pathLen: pathLen as number, straight: dist(a.pos, b.pos), alert: b.alert });
    }
    console.info(`[share radius] ${JSON.stringify(outcomes)}`);
    expect(outcomes[0].pathLen).toBeGreaterThan(50);
    expect(outcomes[0].pathLen).toBeLessThan(59);
    expect(outcomes[1].pathLen).toBeGreaterThan(62);
    expect(outcomes[0].straight).toBeLessThan(60);
    expect(outcomes[1].straight).toBeLessThan(60);
    expect(outcomes[0].alert, `経路 ${outcomes[0].pathLen.toFixed(1)}m <= 60m: 共有を受け取る`).toBe(true);
    expect(outcomes[1].alert, `経路 ${outcomes[1].pathLen.toFixed(1)}m > 60m: 共有は届かない`).toBe(false);
  });
});

describe('§9 補足: 不規則なフレーム時間・nav状態への非依存・UIの重複登録', () => {
  it('フレーム時間が 1〜250ms の不規則な列でも、tick 300 の全状態は 120fps の場合と完全に同一 (シード付きの不規則列を3通り)', () => {
    const at300 = (frames: ((r: Rng) => number) | null, seed: number): unknown => {
      const g = combatGame({ seed: 4242 });
      const orig = g.step.bind(g);
      let snap: unknown = null;
      g.step = (): void => {
        chaosScript(g, g.state.tick);
        orig();
        if (g.state.tick === 300) snap = dumpGame(g);
      };
      const r = new Rng(seed);
      for (let guard = 0; guard < 100000 && g.state.tick < 300; guard++) g.advance(frames ? frames(r) : 1 / 120);
      expect(g.state.tick).toBeGreaterThanOrEqual(300);
      return snap;
    };
    const ref = at300(null, 0);
    expect(ref).not.toBeNull();
    for (const seed of [1, 2, 3]) {
      const irregular = at300((r) => 0.001 + r.next() * 0.249, seed);
      expect(diffPaths(ref, irregular), `seed ${seed}`).toEqual([]);
    }
  });

  it('敵AIの結果は nav の温まり具合(長い出撃の後の再出撃) に依存しない: 7区画を巡った後の retry() と新規出撃とで、S02/S05/S13 の10秒間の戦闘の全状態が同一', () => {
    const sectors = ['S02', 'S05', 'S08', 'S12', 'S13', 'S03', 'S06'];
    for (const sec of ['S02', 'S05', 'S13']) {
      const script = (g: Game): void => {
        const t = g.state.tick;
        g.input.right = Math.floor(t / 200) % 2 === 0;
        g.input.left = !g.input.right;
        g.input.fire = t % 7 < 3;
      };
      const A = realGame({ seed: 555 });
      teleport(A, sectorCenter(sec));
      A.state.player.hp = 1e9;
      for (let i = 0; i < 1200; i++) {
        script(A);
        A.step();
      }
      const B = realGame({ seed: 555 });
      B.state.player.hp = 1e9;
      for (const s of sectors) {
        teleport(B, sectorCenter(s));
        for (let i = 0; i < 6 * 120; i++) B.step();
      }
      B.retry();
      teleport(B, sectorCenter(sec));
      B.state.player.hp = 1e9;
      for (let i = 0; i < 1200; i++) {
        script(B);
        B.step();
      }
      expect(diffPaths(dumpGame(A), dumpGame(B)), sec).toEqual([]);
      expect(A.state.enemies.reduce((a, e) => a + e.shotsFired, 0)).toBeGreaterThan(0);
    }
  });

  it('再出撃でイベントリスナー・更新ループが重複しない (静的確認): app.ts の addEventListener は start() の中だけ・start() は二重起動しない・rAF は start() と frame() の自己再登録だけ・再出撃(retry)経路は start() を呼ばない', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'ui', 'app.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const startIdx = src.indexOf('start(): void {');
    expect(startIdx).toBeGreaterThan(0);
    // start() の本体 (次の dispose まで)
    const disposeIdx = src.indexOf('dispose(): void {');
    const startBody = src.slice(startIdx, disposeIdx);
    const outside = src.slice(0, startIdx) + src.slice(disposeIdx);
    expect(startBody).toMatch(/if \(this\.ac \|\| this\.failed\) return;/);
    expect((startBody.match(/addEventListener\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(outside.match(/addEventListener\(/g)?.length ?? 0, 'start() 以外でのリスナー登録').toBe(0);
    expect((startBody.match(/requestAnimationFrame\(/g) ?? []).length).toBe(1);
    expect((outside.match(/requestAnimationFrame\(/g) ?? []).length, 'frame() の自己再登録だけ').toBe(1);
    expect(outside.match(/this\.start\(\)/g)?.length ?? 0, 'start() を再出撃などから呼ばない').toBe(0);
    const beginPlay = src.slice(src.indexOf('private beginPlay'), src.indexOf('private beginPlay') + 1200);
    expect(beginPlay).toMatch(/this\.game\.retry\(\)/);
    expect(beginPlay).not.toMatch(/addEventListener|requestAnimationFrame|setInterval/);
  });
});
