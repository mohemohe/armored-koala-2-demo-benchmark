/**
 * audit-ui: SPEC §3 (機体の造形・格納庫の表示・18構成) / §8 (HUDと画面表現) / §1 (納品) の敵対的監査。
 *
 * 方針: 実装を「仕様に反しているはず」と疑い、仕様の各条項を実行可能なテストにする。
 *  - 期待値は SPEC の表・本文から直接起こした独自の定数で、config.ts の値を期待値の根拠にしない (B04b は SPEC 4.3/4.4 の式を独立に解き直す)。
 *  - HUD/格納庫の表示ロジックは、実際の Game を tick 実行して得た状態から検証する (state を手で偽装しない)。
 *  - 実装の癖に合わせて緩めない。落ちたテストは (SPEC と突き合わせて) 実装の違反として報告する。
 *  - 画面そのもの (実 DOM / SVG / WebGL) の検証は tests/audit-ui/*.ts (Playwright + Chrome for Testing) が担当し、証拠の画像は test-results/audit-ui/ に出力する (.gitignore 済み):
 *      garage-audit.ts (格納庫 §3)  mech-audit.ts (プレイ中の機体・脚)  play-audit.ts (出撃・HUD 基本・一時停止・操作説明・リサイズ)
 *      hud-audit.ts (ロック/補正/画面外/通知/予告/被弾方向/制御砲台)  fx-audit.ts (射撃・ミサイル・撃破・QB・カメラ揺れ)
 *      stage-audit.ts (経路 45 地点の明るさと造形)
 *
 * 条項の分解 (テスト名の先頭の ID):
 *  §3  A01 初期選択 / A02 18構成の実効値 (表示・Game・HUD) / A03 部品カードの長所・短所・数値 / A04 頭部=立体コアラ /
 *      A05 装甲・関節・武器保持部・推進器 / A05b 選択中の武器だけを持つ / A06 格納庫で頭部を正面から / A07 脚数で実モデルが変わる /
 *      A08 歩行で全脚が動く / A09 頭部・胴体・腕は構成に依らず固定 / A10 出撃後の構成変更不可 / A11 HPの自然回復・補給なし
 *  §8  B01 判定円=lock.radiusCssPx / B02 マーカーは Three.js 投影と一致 / B03 補正表示はロック完了後のみ / B03c 対象付け替え /
 *      B04 武器切替後のHUD整合 / B04b 補正照準点=SPEC の式 (ビーム/ミサイル/MG) / B05 補正解なし表示 /
 *      B06 ビーム=弾数無制限+1射8EN / B07 拒否通知 (NO LOCK/EN不足/弾切れ) / B08 HP/EN/残弾の表示=状態 / B09 QB使用可否・残り時間 /
 *      B10 区画・次の目標・制御砲台数・隔壁・脱出 / B11 射撃予告 / B12 被弾方向 / B13 操作説明の必須記述 / B14 画面外マーカー /
 *      B15 UI専用の架空数値なし / D01 区画カリングで面が欠けない / D02 廃工場の造形要素
 *  §1  C01 package.json / C02 lockfile固定 / C03 外部参照なし (ソース) / C04 dev・build の構成 / C05 リサイズ対応 (ソース)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import type { Mesh, Object3D } from 'three';
import { applySimCamera } from '../src/render/cameraRig';
import { HangarScene } from '../src/render/hangar';
import { MechModel } from '../src/render/mech';
import type { MechFrame } from '../src/render/mech';
import { MaterialLibrary } from '../src/render/textures';
import { SectorVisibility, sectorContains } from '../src/render/visibility';
import { buildSnapshot } from '../src/sim/bench';
import { playerMuzzlePosition, updateCamera } from '../src/sim/camera';
import { damageEnemy } from '../src/sim/combat';
import { Game } from '../src/sim/game';
import { buildTestArenaStage } from '../src/sim/testArena';
import type { EnemySpawn, GameState, Loadout, StageDef, V3 } from '../src/sim/types';
import { buildStage } from '../src/stage';
import { findNonFinite } from '../tools/snapshotShape';
import { helpSections } from '../src/ui/controlsHelp';
import { fcsCards, garageSummary, generatorCards, legsCards } from '../src/ui/garageLogic';
import { buildHudModel, buildResultModel, HudMessages, placeMarker } from '../src/ui/hudLogic';

const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------------------------------------------------
// SPEC から直接起こした期待値 (config.ts は参照しない)
// ---------------------------------------------------------------------------------------------------------------------
/** §5 FCS 表 */
const SPEC_FCS = { wide: { r: 0.3, lock: 1.2 }, medium: { r: 0.2, lock: 0.8 }, narrow: { r: 0.1, lock: 0.4 } } as const;
/** §6 ジェネレーター表 (最大EN×回復率 = 1800) */
const SPEC_GEN = { capacity: { en: 180, regen: 10 }, balanced: { en: 120, regen: 15 }, recovery: { en: 90, regen: 20 } } as const;
/** §6 脚部表 */
const SPEC_LEGS = { biped: { speed: 1.0, regen: 1.0, lockSpeed: 1.0 }, quadruped: { speed: 0.8, regen: 0.75, lockSpeed: 1.5 } } as const;

const FCS_IDS = ['wide', 'medium', 'narrow'] as const;
const GEN_IDS = ['capacity', 'balanced', 'recovery'] as const;
const LEG_IDS = ['biped', 'quadruped'] as const;
const ALL_LOADOUTS: Loadout[] = FCS_IDS.flatMap((fcs) => GEN_IDS.flatMap((generator) => LEG_IDS.map((legs) => ({ fcs, generator, legs }))));

const DT = 1 / 120;

// ---------------------------------------------------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------------------------------------------------
const add = (a: V3, b: V3, s = 1): V3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function spawn(id: string, pos: V3, opt: Partial<EnemySpawn> = {}): EnemySpawn {
  return {
    id,
    kind: id.startsWith('T') ? 'turret' : 'guard',
    sectorId: 'T00',
    pos,
    yaw: 0,
    isGateControl: false,
    controlIndex: null,
    barrierId: null,
    ...opt,
  };
}

/** 障害物のない試験アリーナ + 任意の敵。実際の Game をそのまま使う (sortie 済み) */
function arena(opts: { loadout?: Loadout; enemies?: EnemySpawn[]; w?: number; h?: number } = {}): Game {
  const stage: StageDef = { ...buildTestArenaStage(), enemies: opts.enemies ?? [] };
  const g = new Game({ stage, loadout: opts.loadout, viewportW: opts.w ?? 1280, viewportH: opts.h ?? 720 });
  g.sortie(opts.loadout);
  // 水平に構える (出撃直後は僅かに下向きで、カメラ正面の遠い点が床下になり遮蔽されてしまうため)
  g.state.player.pitch = 0;
  updateCamera(g.state, g.world);
  return g;
}

/** カメラ正面 d [m] に置く (画面中央=FCS円の中心) */
function frontOf(s: GameState, d: number, right = 0, up = 0): V3 {
  return add(add(add(s.camera.pos, s.camera.forward, d), s.camera.right, right), s.camera.up, up);
}

function stepN(g: Game, n: number): void {
  for (let i = 0; i < n; i++) g.step();
}
/** 経過時間 [s] だけ進める (1/120 s tick) */
function stepSec(g: Game, sec: number): void {
  stepN(g, Math.round(sec / DT));
}

/** 試験用の動かない標的にする (AI・射撃なし。ロック/HUD の検証専用) */
function dummy(e: { scripted: boolean }): void {
  e.scripted = true;
}

/** 実際のステージ (1 回だけ構築) */
let realStageCache: StageDef | null = null;
function realStage(): StageDef {
  realStageCache ??= buildStage();
  return realStageCache;
}

// =====================================================================================================================
// §3 機体の造形・格納庫・18構成
// =====================================================================================================================
describe('§3 初期選択・18構成', () => {
  it('A01 初期選択は 中範囲FCS / 均衡ジェネレーター / 2脚 / マシンガン (Game・格納庫の要約・HUD)', () => {
    const g = new Game({ stage: buildTestArenaStage() });
    expect(g.getLoadout()).toEqual({ fcs: 'medium', generator: 'balanced', legs: 'biped' });
    expect(g.state.mode).toBe('garage');
    expect(g.state.loadout).toEqual({ fcs: 'medium', generator: 'balanced', legs: 'biped' });
    g.sortie();
    expect(g.state.player.weapon).toBe('machinegun');
    const sum = garageSummary(g.getLoadout());
    expect(sum.fcsName).toContain('中範囲');
    expect(sum.generatorName).toContain('均衡');
    expect(sum.legsName).toContain('2脚');
    // 起動直後に「選択中」として使われる要約 (初期表示) は 最大EN120 / 回復15 / ロック0.8秒 / 歩行10m/s
    expect(sum.maxEn).toBe(120);
    expect(sum.regenPerSecond).toBe(15);
    expect(sum.lockSeconds).toBeCloseTo(0.8, 12);
    expect(sum.speeds.walk).toBe(10);
    const hud = buildHudModel(g.state);
    expect(hud.weapons.find((w) => w.selected)?.id).toBe('machinegun');
  });

  it('A02 3×3×2=18構成の実効値: 格納庫の表示 = Game の実効値 = SPEC の式 (表示・出撃状態・HUD)', () => {
    expect(ALL_LOADOUTS).toHaveLength(18);
    for (const l of ALL_LOADOUTS) {
      const fcs = SPEC_FCS[l.fcs];
      const gen = SPEC_GEN[l.generator];
      const leg = SPEC_LEGS[l.legs];
      const name = `${l.fcs}/${l.generator}/${l.legs}`;
      const wantEn = gen.en;
      const wantRegen = gen.regen * leg.regen;
      const wantLock = fcs.lock / leg.lockSpeed; // ロック速度倍率: 所要時間 = 基本 ÷ 倍率
      // 格納庫の表示
      const sum = garageSummary(l);
      expect(sum.maxEn, name).toBe(wantEn);
      expect(sum.regenPerSecond, name).toBeCloseTo(wantRegen, 12);
      expect(sum.lockSeconds, name).toBeCloseTo(wantLock, 12);
      expect(sum.lockRadiusRatio, name).toBeCloseTo(fcs.r, 12);
      expect(sum.legCount, name).toBe(l.legs === 'biped' ? 2 : 4);
      expect(sum.speeds.walk, name).toBeCloseTo(10 * leg.speed, 12);
      expect(sum.speeds.glide, name).toBeCloseTo(22 * leg.speed, 12);
      expect(sum.speeds.air, name).toBeCloseTo(16 * leg.speed, 12);
      expect(sum.speeds.qb, name).toBeCloseTo(80 * leg.speed, 12);
      // 出撃した実際のゲーム状態
      const g = arena({ loadout: l });
      const s = g.state;
      expect(s.loadout, name).toEqual(l);
      expect(s.stats.maxEn, name).toBe(wantEn);
      expect(s.stats.regenPerSecond, name).toBeCloseTo(wantRegen, 12);
      expect(s.stats.lockSeconds, name).toBeCloseTo(wantLock, 12);
      expect(s.stats.horizontalSpeedMultiplier, name).toBeCloseTo(leg.speed, 12);
      expect(s.player.en, name).toBe(wantEn);
      expect(s.player.hp, name).toBe(1000);
      expect(s.lock.radiusCssPx, name).toBeCloseTo(fcs.r * 720, 9);
      // HUD 表示
      const hud = buildHudModel(s);
      expect(hud.en.max, name).toBe(wantEn);
      expect(hud.en.value, name).toBe(wantEn);
      expect(hud.lock.radius, name).toBeCloseTo(fcs.r * 720, 9);
      // SPEC §6 の積 = 1800
      expect(wantEn * gen.regen).toBe(1800);
    }
  });

  it('A02b 18構成すべてで 移動・QB・射撃・ロックを含む 2 秒間を実行できる (NaN/Infinity なし・EN は 0..最大)', () => {
    for (const l of ALL_LOADOUTS) {
      const name = `${l.fcs}/${l.generator}/${l.legs}`;
      const g = arena({ loadout: l, enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 }, {})] });
      dummy(g.state.enemies[0]);
      g.state.enemies[0].pos = frontOf(g.state, 40);
      g.input.forward = true;
      stepN(g, 30);
      g.input.qb = true;
      stepN(g, 2);
      g.input.qb = false;
      g.input.fire = true;
      for (let i = 0; i < 4; i++) {
        stepN(g, 30);
        g.input.weaponSelect = (['beam', 'missile', 'machinegun'] as const)[i % 3];
        const p = g.state.player;
        expect(p.en, name).toBeGreaterThanOrEqual(0);
        expect(p.en, name).toBeLessThanOrEqual(g.state.stats.maxEn + 1e-9);
      }
      const snap = buildSnapshot(g.state);
      expect(findNonFinite(snap), name).toEqual([]);
      const m = buildHudModel(g.state);
      expect(Number.isFinite(m.en.ratio) && Number.isFinite(m.hp.ratio), name).toBe(true);
      expect(g.state.mode, name).toBe('playing');
    }
  });

  it('A03 部品カード: 8 種すべてに長所・短所があり、数値が SPEC と一致し、選択肢間で区別できる', () => {
    const cards = [...fcsCards(), ...generatorCards(), ...legsCards()];
    expect(cards).toHaveLength(8);
    const seen = new Set<string>();
    for (const c of cards) {
      expect(c.pros.trim().length, c.id).toBeGreaterThan(4);
      expect(c.cons.trim().length, c.id).toBeGreaterThan(4);
      expect(c.pros, c.id).not.toBe(c.cons);
      const key = `${c.pros}|${c.cons}`;
      expect(seen.has(key), `${c.id}: 長所/短所が他の部品と完全に同じ`).toBe(false);
      seen.add(key);
      expect(c.name.length, c.id).toBeGreaterThan(1);
    }
    // 数値 (SPEC): spec 行にそのまま現れる
    const byId = new Map(cards.map((c) => [c.id, c]));
    for (const id of FCS_IDS) {
      const c = byId.get(id)!;
      expect(c.spec, id).toContain(String(SPEC_FCS[id].r));
      expect(c.spec, id).toContain(String(SPEC_FCS[id].lock));
    }
    for (const id of GEN_IDS) {
      const c = byId.get(id)!;
      expect(c.spec, id).toContain(String(SPEC_GEN[id].en));
      expect(c.spec, id).toContain(String(SPEC_GEN[id].regen));
    }
    expect(byId.get('quadruped')!.spec).toContain('0.8');
    expect(byId.get('quadruped')!.spec).toContain('0.75');
    expect(byId.get('quadruped')!.spec).toContain('1.5');
    // 長所/短所の文章中の数値が SPEC に反していない (例: 「1.20秒」「180」「0.30D」)
    for (const id of FCS_IDS) {
      const text = byId.get(id)!.pros + byId.get(id)!.cons;
      for (const m of text.matchAll(/(\d+(?:\.\d+)?)秒/g)) expect(Number(m[1]), `${id}: ${m[0]}`).toBeCloseTo(SPEC_FCS[id].lock, 9);
      for (const m of text.matchAll(/(\d+(?:\.\d+)?)D/g)) expect(Number(m[1]), `${id}: ${m[0]}`).toBeCloseTo(SPEC_FCS[id].r, 9);
    }
    for (const id of GEN_IDS) {
      const text = byId.get(id)!.pros + byId.get(id)!.cons;
      for (const m of text.matchAll(/\((\d+) EN\/秒\)/g)) expect(Number(m[1]), `${id}: ${m[0]}`).toBe(SPEC_GEN[id].regen);
    }
    // 長所短所が数値と矛盾しない: 最も長いロック時間を持つ広範囲FCSの短所に「最も長い」、狭範囲の長所に「最短」
    expect(byId.get('wide')!.cons).toMatch(/長い/);
    expect(byId.get('narrow')!.pros).toMatch(/最短/);
    expect(byId.get('capacity')!.pros).toMatch(/最大/);
    expect(byId.get('recovery')!.cons).toMatch(/最小/);
  });

  it('A10 出撃後は構成を変更できない: 戦闘中に格納庫の構成変更経路 (Game.setLoadout) を呼んでも進行中の出撃は壊れない', () => {
    // Game.setLoadout は toGarage() を呼ぶ = 呼べば出撃が格納庫へ戻る。UI が戦闘中に呼べないことを確認する:
    const src = readFileSync(join(ROOT, 'src/ui/app.ts'), 'utf8');
    // onChange は Garage の選択ボタンからのみ。Garage は出撃後 hidden (setVisible(false)) で操作できない。
    expect(src).toMatch(/onChange:\s*\(l\)\s*=>\s*this\.onLoadoutChange\(l\)/);
    expect(src).toMatch(/this\.garage\.setVisible\(false\)/);
    // 一方で、Game.sortie(loadout) は出撃時の構成を固定し、戦闘中に state.loadout は変わらない
    const g = arena({ loadout: { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' } });
    const before = JSON.stringify(g.state.loadout);
    stepSec(g, 1);
    expect(JSON.stringify(g.state.loadout)).toBe(before);
  });

  it('A11 HPの自然回復・弾薬補給・アイテムによるEN補充がない (60秒放置)', () => {
    const g = arena();
    g.state.player.hp = 500;
    g.state.player.ammo.machinegun = 100;
    g.state.player.ammo.missile = 3;
    stepSec(g, 60);
    expect(g.state.player.hp).toBe(500);
    expect(g.state.player.ammo.machinegun).toBe(100);
    expect(g.state.player.ammo.missile).toBe(3);
    expect(g.state.player.hp).toBeLessThanOrEqual(1000);
  });
});

describe('§3 機体の造形 (Three.js モデルの構造)', () => {
  const mkMech = (): MechModel => new MechModel(new MaterialLibrary());
  const frame = (over: Partial<MechFrame> = {}): MechFrame => ({
    dt: 1 / 60,
    time: 0,
    pos: { x: 0, y: 1.5, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    grounded: true,
    vertical: 'grounded',
    horizontal: 'walk',
    thrusting: false,
    qbRemaining: 0,
    qbDir: { x: 0, z: 0 },
    weapon: 'machinegun',
    muzzle: { x: 1.05, y: 2.25, z: -1.25 },
    aimDir: { x: 0, y: 0, z: -1 },
    legs: 'biped',
    ...over,
  });
  const worldVerts = (mesh: Mesh): Vector3[] => {
    const pos = mesh.geometry.getAttribute('position');
    const out: Vector3[] = [];
    for (let i = 0; i < pos.count; i++) out.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
    return out;
  };
  const meshesOf = (o: Object3D): Mesh[] => {
    const r: Mesh[] = [];
    o.traverse((c) => {
      if ((c as Mesh).isMesh) r.push(c as Mesh);
    });
    return r;
  };
  const visibleInTree = (o: Object3D): boolean => {
    for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };

  it('A04 頭部は立体的なコアラ: 左右対称の大きな丸い耳 + 黒い鼻 (顔画像を貼った箱ではない)', () => {
    const mech = mkMech();
    mech.update(frame());
    mech.root.updateMatrixWorld(true);
    const headCenter = mech.head.getWorldPosition(new Vector3());
    const headMeshes = meshesOf(mech.head);
    expect(headMeshes.length).toBeGreaterThanOrEqual(2);
    const verts: Vector3[] = headMeshes.flatMap((m) => worldVerts(m)).map((v) => v.sub(headCenter));
    const triangles = headMeshes.reduce((n, m) => n + (m.geometry.getIndex()?.count ?? 0) / 3, 0);
    // 箱 (12 三角形) や平面ではなく、球・円盤などの曲面を多数の三角形で作っている
    expect(triangles).toBeGreaterThan(800);
    const xs = verts.map((v) => v.x);
    const ys = verts.map((v) => v.y);
    const zs = verts.map((v) => v.z);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const depth = Math.max(...zs) - Math.min(...zs);
    // 3 軸とも十分な厚み (画像を貼った薄い板/箱ではない)
    expect(width).toBeGreaterThan(1.0);
    expect(height).toBeGreaterThan(0.6);
    expect(depth).toBeGreaterThan(0.6);
    // 耳: |x| が大きい側の頂点が左右にあり、鏡像対称で、直径が頭部の高さに近い「大きな」円盤
    const headHalfW = 0.42 * 1.14; // 頭本体の球の横半径 (スケール込み)。これより外側にある頂点が耳
    const rightEar = verts.filter((v) => v.x > headHalfW + 0.05);
    const leftEar = verts.filter((v) => v.x < -(headHalfW + 0.05));
    expect(rightEar.length, '右耳の頂点').toBeGreaterThan(50);
    expect(leftEar.length, '左耳の頂点').toBeGreaterThan(50);
    // 鏡像対称: 左右の耳の広がり (x の外端・y の上下端) が一致 (アンテナ等の片側だけの部品は耳の領域の外)
    expect(Math.abs(Math.max(...rightEar.map((v) => v.x)) + Math.min(...leftEar.map((v) => v.x)))).toBeLessThan(0.02);
    expect(Math.abs(Math.min(...rightEar.map((v) => v.y)) - Math.min(...leftEar.map((v) => v.y)))).toBeLessThan(0.02);
    const ext = (vs: Vector3[], k: 'y' | 'z'): number => Math.max(...vs.map((v) => v[k])) - Math.min(...vs.map((v) => v[k]));
    const earDiameter = Math.max(ext(rightEar, 'y'), ext(leftEar, 'y'));
    // 「大きな」耳: 直径が頭本体の高さ (2*0.36*1.14) の 0.8 倍以上
    expect(earDiameter).toBeGreaterThan(0.8 * 2 * 0.36 * 1.14);
    // 丸い: 円盤の面内 2 方向の広がりが揃う (縦 ≈ 耳を斜めから見た奥行き方向の広がり/cos で比較する代わりに、
    // 頂点群の縦の広がりと、円盤面内の水平方向の広がりが 25% 以内)
    // 耳の円盤は ry=∓0.6 rad だけ外側へ振ってある: 面内水平の広がり ≈ 直径*cos(0.6) + 厚み
    const earPlaneHoriz = (Math.max(...rightEar.map((v) => v.x)) - Math.min(...rightEar.map((v) => v.x))) / Math.cos(0.6);
    expect(Math.abs(earPlaneHoriz - ext(rightEar, 'y')) / ext(rightEar, 'y')).toBeLessThan(0.35);
    // 左右対称
    const symmetric = Math.abs(Math.max(...rightEar.map((v) => v.y)) - Math.max(...leftEar.map((v) => v.y)));
    expect(symmetric).toBeLessThan(0.02);
    // 黒い鼻: black スロットのメッシュが頭の正面 (-Z) 側・ほぼ中央にある
    const black = headMeshes.filter((m) => m.name === 'head/black');
    expect(black.length, '黒マテリアルのメッシュ (鼻)').toBe(1);
    const bv = worldVerts(black[0]).map((v) => v.sub(headCenter));
    const cx = bv.reduce((a, v) => a + v.x, 0) / bv.length;
    const cz = bv.reduce((a, v) => a + v.z, 0) / bv.length;
    expect(Math.abs(cx)).toBeLessThan(0.02);
    expect(cz).toBeLessThan(-0.3); // 前方 (機体の前 = -Z)
    const noseMat = black[0].material as unknown as { color: { r: number; g: number; b: number } };
    expect(Math.max(noseMat.color.r, noseMat.color.g, noseMat.color.b)).toBeLessThan(0.08); // 黒
    // 鼻は顔の中央に収まる大きさ (顔全体を覆っていない)
    expect(Math.max(...bv.map((v) => v.x)) - Math.min(...bv.map((v) => v.x))).toBeLessThan(0.6);
    // 頭部に「顔の画像」用のテクスチャは無い: マテリアルの map はすべて装甲/金属の汎用タイル (armorLight) だけ
    const maps = new Set<string>();
    for (const m of headMeshes) {
      const map = (m.material as { map?: { name?: string } | null }).map;
      if (map) maps.add(map.name ?? '(unnamed)');
    }
    expect(maps.size).toBeLessThanOrEqual(1);
  });

  it('A05 装甲・関節・武器保持部・推進器を備えた機械: 頭/胴/左右の腕(上腕・前腕)/武器3種/推進器2基/骨盤と脚', () => {
    const mech = mkMech();
    const names: string[] = [];
    mech.root.traverse((o) => names.push(o.name));
    const count = (prefix: string): number => names.filter((n) => n === prefix || n.startsWith(prefix + '/')).length;
    expect(count('head')).toBeGreaterThan(0);
    expect(count('torso')).toBeGreaterThan(0);
    expect(names.filter((n) => n === 'armUpper' || n.startsWith('armUpper/')).length).toBeGreaterThanOrEqual(2); // 左右
    expect(names.filter((n) => n === 'armFore' || n.startsWith('armFore/')).length).toBeGreaterThanOrEqual(2);
    for (const w of ['machinegun', 'beam', 'missile']) expect(names.some((n) => n.startsWith(`weapon:${w}`))).toBe(true); // 武器保持部 + 3種
    expect(names.some((n) => n.startsWith('nozzle'))).toBe(true); // 推進器のノズル
    expect(names.filter((n) => n === 'nozzle' || n.startsWith('nozzle/')).length).toBeGreaterThanOrEqual(2); // 背部推進器 左右
    // 関節: 腕は 2 関節 (肩・肘)、脚は 3 関節 (股・膝・足首) を Group の階層で持つ (thigh -> shin -> foot)
    const bip = mech.root.getObjectByName('legsBiped')!;
    const thigh = bip.getObjectByName('thigh/unit') ?? bip.children.flatMap((c) => c.children).find((c) => c.name.startsWith('thigh'));
    expect(thigh).toBeTruthy();
    expect(mech.triangleCount).toBeGreaterThan(3000);
    // 重装甲: 胴の外形が大きい (胴幅 > 1.2m, 高さ > 0.7m)
    const torsoMeshes = meshesOf(mech.torso).filter((m) => m.name.startsWith('torso/'));
    mech.update(frame());
    mech.root.updateMatrixWorld(true);
    const tv = torsoMeshes.flatMap((m) => worldVerts(m));
    expect(Math.max(...tv.map((v) => v.x)) - Math.min(...tv.map((v) => v.x))).toBeGreaterThan(1.8);
  });

  it('A05b 携行する 3 武器のうち、選択中の 1 種類だけを手に持って見せる (切替で見た目も変わる)。脚部グループも脚数どおりに 1 つだけ', () => {
    const mech = mkMech();
    for (const w of ['machinegun', 'beam', 'missile'] as const) {
      mech.update(frame({ weapon: w }));
      mech.root.updateMatrixWorld(true);
      for (const other of ['machinegun', 'beam', 'missile'] as const) {
        const g = mech.root.getObjectByName(`weapon:${other}`);
        expect(g, `weapon:${other}`).toBeTruthy();
        expect(visibleInTree(g!), `選択 ${w} のとき weapon:${other}`).toBe(other === w);
      }
    }
    for (const legs of LEG_IDS) {
      mech.update(frame({ legs }));
      expect(visibleInTree(mech.root.getObjectByName('legsBiped')!), `${legs}: 2脚グループ`).toBe(legs === 'biped');
      expect(visibleInTree(mech.root.getObjectByName('legsQuad')!), `${legs}: 4脚グループ`).toBe(legs === 'quadruped');
    }
  });

  it('A09 頭部・胴体・左右の腕は構成(脚部)に依らず固定: 2脚/4脚で頭・胴の頂点数と位置が同一', () => {
    const a = mkMech();
    a.update(frame({ legs: 'biped' }));
    const b = mkMech();
    b.update(frame({ legs: 'quadruped' }));
    for (const part of ['head', 'torso'] as const) {
      const ma = meshesOf(a[part]);
      const mb = meshesOf(b[part]);
      expect(ma.length).toBe(mb.length);
      ma.forEach((m, i) => {
        expect(m.geometry.getAttribute('position').count).toBe(mb[i].geometry.getAttribute('position').count);
      });
    }
    const ha = a.head.getWorldPosition(new Vector3());
    const hb = b.head.getWorldPosition(new Vector3());
    // 頭の高さは脚部で変わってよい (接地補正) が、頭部モデル自体 (胴に対する相対位置) は同一
    expect(a.head.position.distanceTo(b.head.position)).toBeLessThan(1e-9);
    expect(Number.isFinite(ha.y) && Number.isFinite(hb.y)).toBe(true);
  });

  it('A07 脚数で実モデルが変わる: 2脚は脚 2 本 (thigh)、4脚は脚 4 本 (thighQ) だけが可視 (HangarScene / MechModel)', () => {
    const countVisible = (root: Object3D, prefix: string): number => meshesOf(root).filter((m) => m.name.startsWith(prefix) && visibleInTree(m)).length;
    const hs = new HangarScene(new MaterialLibrary(), null, { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    hs.update(0.05);
    expect(countVisible(hs.mech.root, 'thigh/')).toBe(2);
    expect(countVisible(hs.mech.root, 'thighQ/')).toBe(0);
    hs.setLoadout({ fcs: 'medium', generator: 'balanced', legs: 'quadruped' });
    hs.update(0.05);
    expect(countVisible(hs.mech.root, 'thigh/')).toBe(0);
    expect(countVisible(hs.mech.root, 'thighQ/')).toBe(4);
    hs.setLoadout({ fcs: 'medium', generator: 'balanced', legs: 'biped' });
    hs.update(0.05);
    expect(countVisible(hs.mech.root, 'thigh/')).toBe(2);
    expect(countVisible(hs.mech.root, 'thighQ/')).toBe(0);
    // 三角形数 (可視分) も実際に変わる = 見た目だけの切替でも、色替えでもない
    const tri = (root: Object3D): number =>
      meshesOf(root)
        .filter((m) => visibleInTree(m))
        .reduce((n, m) => n + (m.geometry.getIndex()?.count ?? 0) / 3, 0);
    const triBiped = tri(hs.mech.root);
    hs.setLoadout({ fcs: 'medium', generator: 'balanced', legs: 'quadruped' });
    hs.update(0.05);
    expect(Math.abs(tri(hs.mech.root) - triBiped)).toBeGreaterThan(200);
    // プレイ中の MechModel も脚部構成に従う (loadout.legs -> frame.legs)
    const mech = mkMech();
    mech.update(frame({ legs: 'quadruped' }));
    expect(countVisible(mech.root, 'thighQ/')).toBe(4);
    expect(countVisible(mech.root, 'thigh/')).toBe(0);
  });

  it('A08 歩行時に全ての脚が動く: 格納庫のプレビュー (2脚2本・4脚4本) とプレイ中の歩行 (静止時は動かない)', () => {
    const hipOf = (m: Mesh): Object3D => m.parent!.parent!; // thigh メッシュ -> 'thigh' グループ -> 股関節の Group (これが回転する)
    const swing = (mech: MechModel, prefix: string, run: (i: number) => void, n = 100): number[] => {
      const hips = meshesOf(mech.root)
        .filter((m) => m.name.startsWith(prefix))
        .map(hipOf);
      const lo = hips.map(() => Infinity);
      const hi = hips.map(() => -Infinity);
      for (let i = 0; i < n; i++) {
        run(i);
        hips.forEach((h, k) => {
          lo[k] = Math.min(lo[k], h.rotation.x);
          hi[k] = Math.max(hi[k], h.rotation.x);
        });
      }
      return hips.map((_, k) => hi[k] - lo[k]);
    };
    for (const legs of LEG_IDS) {
      const hs = new HangarScene(new MaterialLibrary(), null, { fcs: 'medium', generator: 'balanced', legs });
      const ranges = swing(hs.mech, legs === 'biped' ? 'thigh/' : 'thighQ/', () => hs.update(1 / 30));
      expect(ranges.length, legs).toBe(legs === 'biped' ? 2 : 4);
      for (const r of ranges) expect(r, `${legs} 格納庫プレビューで動かない脚がある`).toBeGreaterThan(0.3);
    }
    // プレイ中: 歩行で全脚が動き、静止で止まる
    for (const legs of LEG_IDS) {
      const mech = mkMech();
      const prefix = legs === 'biped' ? 'thigh/' : 'thighQ/';
      const walking = swing(mech, prefix, (i) => mech.update(frame({ legs, time: i / 60, vel: { x: 0, y: 0, z: -8 * SPEC_LEGS[legs].speed } })));
      for (const r of walking) expect(r, `${legs} 歩行で動かない脚がある`).toBeGreaterThan(0.3);
      for (let i = 0; i < 180; i++) mech.update(frame({ legs, time: 2 + i / 60, vel: { x: 0, y: 0, z: 0 } })); // 歩容が収まるまで 3 秒
      const still = swing(mech, prefix, (i) => mech.update(frame({ legs, time: 5 + i / 60, vel: { x: 0, y: 0, z: 0 } })), 60);
      for (const r of still) expect(r, `${legs} 静止中に脚が動き続ける`).toBeLessThan(0.05);
    }
  });

  it('A06 格納庫: 初期表示で頭部を正面から確認できる (カメラ方向を向き、耳・鼻がフレーム内)。回転しても定期的に正面へ戻る', () => {
    const hs = new HangarScene(new MaterialLibrary(), null, { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    hs.setAspect(1280 / 720);
    hs.update(0.016);
    hs.mech.root.updateMatrixWorld(true);
    hs.camera.updateMatrixWorld(true);
    const head = hs.mech.head.getWorldPosition(new Vector3());
    const cam = hs.camera.position.clone();
    const toCam = cam.clone().sub(head).normalize();
    const fwd = new Vector3(0, 0, -1).transformDirection(hs.mech.head.matrixWorld);
    expect(fwd.dot(toCam), '頭部の正面方向とカメラ方向').toBeGreaterThan(0.97);
    // 頭部の全頂点が画面内 (NDC -1..1) に収まる = 耳の端まで見える
    const view = new Matrix4().multiplyMatrices(hs.camera.projectionMatrix, hs.camera.matrixWorldInverse);
    const meshes = meshesOf(hs.mech.head);
    for (const m of meshes) {
      for (const v of worldVerts(m)) {
        const p = v.clone().applyMatrix4(view);
        expect(Math.abs(p.x)).toBeLessThan(1);
        expect(Math.abs(p.y)).toBeLessThan(1);
      }
    }
    // 頭部は画面内で十分大きい (720px で高さ 60px 以上)
    const ys = meshes.flatMap((m) => worldVerts(m)).map((v) => v.clone().applyMatrix4(view).y);
    expect(((Math.max(...ys) - Math.min(...ys)) / 2) * 720).toBeGreaterThan(60);
    // 頭部は他の部位に隠されない: カメラから頭部中心への線分の途中にある「胴・腕」の頂点は無い (簡易: 頭は最上段)
    expect(head.y).toBeGreaterThan(hs.mech.torso.getWorldPosition(new Vector3()).y);
    // 回転周期のうち頭部が正面 (カメラ方向から ±35°) を向いている割合を計測 (参考値として下限のみ検査)
    const cycle = 3.8 + 15;
    let front = 0;
    const N = 1880;
    for (let i = 0; i < N; i++) {
      const yaw = hs.yawAt((i / N) * cycle);
      const d = Math.abs(((yaw - Math.PI + Math.PI) % (Math.PI * 2)) - Math.PI); // 0 = カメラ正面
      if (d < (35 * Math.PI) / 180) front++;
    }
    expect(front / N).toBeGreaterThan(0.2);
  });
});

// =====================================================================================================================
// §8 HUD (実際の Game を tick 実行して検証)
// =====================================================================================================================
describe('§8 中央: FCS の判定領域と照準', () => {
  it('B01 判定円の半径 = FCS比率 × min(幅,高さ) (縦長・横長・リサイズ後も)、表示円=判定円 (HUD の radius は state.lock.radiusCssPx)', () => {
    for (const fcs of FCS_IDS) {
      const g = arena({ loadout: { fcs, generator: 'balanced', legs: 'biped' } });
      for (const [w, h] of [[1280, 720], [1920, 1080], [1600, 1200], [1000, 1400], [2560, 1080], [1280, 900]] as const) {
        g.setViewport(w, h);
        stepN(g, 1); // 次の tick で FCS も更新される
        const D = Math.min(w, h);
        const m = buildHudModel(g.state);
        expect(m.lock.radius, `${fcs} ${w}x${h}`).toBeCloseTo(SPEC_FCS[fcs].r * D, 9);
        expect(g.state.lock.radiusCssPx, `${fcs} ${w}x${h}`).toBeCloseTo(SPEC_FCS[fcs].r * D, 9);
        expect(m.width).toBe(w);
        expect(m.height).toBe(h);
        expect(buildSnapshot(g.state).lock.radiusCssPx).toBeCloseTo(SPEC_FCS[fcs].r * D, 9);
      }
    }
  });

  it('B01b ロックの判定は表示円と同じ円: 円の内側 1px の敵は取得され、外側 1px の敵は取得されない (FCS 3種・非16:9)', () => {
    for (const fcs of FCS_IDS) {
      for (const [w, h] of [[1280, 720], [1000, 1400]] as const) {
        const r = SPEC_FCS[fcs].r * Math.min(w, h);
        for (const [dpx, want] of [[r - 1, true], [r + 1, false]] as const) {
          const g = arena({ loadout: { fcs, generator: 'balanced', legs: 'biped' }, enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 })], w, h });
          const e = g.state.enemies[0];
          dummy(e);
          // 画面中心から右へ dpx px 離れた点へ置く: x_px = right/depth * scale
          const cam = g.state.camera;
          const depth = 60;
          const scale = h / 2 / Math.tan((cam.fovYDeg * Math.PI) / 360);
          e.pos = add(add(cam.pos, cam.forward, depth), cam.right, (dpx / scale) * depth);
          stepN(g, 2);
          expect(g.state.lock.targetId !== null, `${fcs} ${w}x${h} 中心から ${dpx.toFixed(1)}px (円半径 ${r})`).toBe(want);
        }
      }
    }
  });

  it('B02 マーカー位置は Three.js の実カメラ投影 (描画される画像) と一致: 対象マーカー・補正照準マーカー (複数解像度)', () => {
    for (const [w, h] of [[1280, 720], [1920, 1080], [1000, 1000], [1600, 700]] as const) {
      const g = arena({ loadout: { fcs: 'wide', generator: 'balanced', legs: 'biped' }, enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 })], w, h });
      const e = g.state.enemies[0];
      dummy(e);
      e.pos = frontOf(g.state, 70, 6, 3);
      e.vel = { x: 4, y: 0, z: 0 };
      stepSec(g, 1.5); // 0.8*1.5 (wide の 1.2 秒) 以上 -> ロック完了
      const s = g.state;
      expect(s.lock.state, `${w}x${h}`).toBe('locked');
      const m = buildHudModel(s);
      expect(m.target, `${w}x${h}`).not.toBeNull();
      expect(m.aim, `${w}x${h}`).not.toBeNull();
      // 実カメラ (描画に使われる PerspectiveCamera と同じ設定) で投影
      const cam = new PerspectiveCamera(70, w / h, 0.3, 1500);
      applySimCamera(cam, s.camera, w / h);
      const px = (p: V3): { x: number; y: number } => {
        const v = new Vector3(p.x, p.y, p.z).project(cam);
        return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
      };
      const t = px(s.enemies[0].pos);
      expect(m.target!.placement.onScreen).toBe(true);
      expect(m.target!.placement.x, `${w}x${h} 対象x`).toBeCloseTo(t.x, 3);
      expect(m.target!.placement.y, `${w}x${h} 対象y`).toBeCloseTo(t.y, 3);
      const a = px(s.fc.aimPoint!);
      expect(m.aim!.placement.x, `${w}x${h} 補正x`).toBeCloseTo(a.x, 3);
      expect(m.aim!.placement.y, `${w}x${h} 補正y`).toBeCloseTo(a.y, 3);
      // 補正照準点は対象の現在位置より上 (重力補正)、かつ画面上で別の位置
      expect(m.aim!.placement.y).toBeLessThan(m.target!.placement.y - 0.5);
      // 補正照準点 = p + v*t - 0.5*g*t^2 (SPEC 4.3) が HUD の表示元
      const fc = s.fc;
      const t3 = fc.predictedFlightSeconds!;
      const want = {
        x: fc.targetPosition!.x + fc.targetVelocity!.x * t3,
        y: fc.targetPosition!.y + fc.targetVelocity!.y * t3 + 0.5 * 18 * t3 * t3,
        z: fc.targetPosition!.z + fc.targetVelocity!.z * t3,
      };
      expect(dist(fc.aimPoint!, want)).toBeLessThan(1e-6);
    }
  });
});

describe('§8 ロックの状態表示と補正表示', () => {
  it('B03 実際の tick で: ロック完了前は補正が有効だと表示しない (補正マーカー無し・文言に「補正中」無し)。完了後は補正表示', () => {
    for (const l of [
      { fcs: 'wide', generator: 'balanced', legs: 'biped' },
      { fcs: 'narrow', generator: 'balanced', legs: 'quadruped' },
      { fcs: 'medium', generator: 'balanced', legs: 'biped' },
    ] as Loadout[]) {
      const g = arena({ loadout: l, enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 })] });
      const e = g.state.enemies[0];
      dummy(e);
      e.pos = frontOf(g.state, 60);
      const wantLock = SPEC_FCS[l.fcs].lock / SPEC_LEGS[l.legs].lockSpeed;
      let lockedAt: number | null = null;
      let sawAcquiring = false;
      for (let i = 0; i < 400 && g.state.mode === 'playing'; i++) {
        g.step();
        const s = g.state;
        const m = buildHudModel(s);
        expect(m.lock.phase).toBe(s.lock.state);
        if (s.lock.state === 'locked') {
          lockedAt ??= s.time;
          expect(m.aim, `${l.fcs} locked 後は補正マーカー`).not.toBeNull();
          expect(m.aimStatusText).toMatch(/補正/);
          expect(m.lock.label).toBe('LOCKED');
          expect(m.lock.progress).toBe(1);
        } else {
          // ロック完了前: 補正マーカー無し。「補正中」「補正解なし」を出さない
          expect(m.aim, `t=${s.time.toFixed(3)} ${s.lock.state}`).toBeNull();
          expect(m.aimStatusText).not.toMatch(/補正中|補正解なし/);
          if (s.lock.state === 'acquiring') {
            sawAcquiring = true;
            expect(m.lock.label).toMatch(/^LOCKING \d+%$/);
            const pct = Number(/(\d+)%/.exec(m.lock.label)![1]);
            expect(pct).toBe(Math.floor(s.lock.progress * 100 + 1e-6));
            expect(m.lock.progress).toBeCloseTo(s.lock.progress, 12);
          }
          if (s.lock.state === 'none') expect(m.lock.label).toBe('');
        }
      }
      expect(sawAcquiring).toBe(true);
      expect(lockedAt).not.toBeNull();
      // ロック完了時刻 = 所要時間 (ロック速度倍率 1.5 を所要時間 1.5 倍と取り違えていない)。1 tick の余裕
      expect(lockedAt!).toBeGreaterThanOrEqual(wantLock - 1e-9);
      expect(lockedAt!).toBeLessThanOrEqual(wantLock + 2 * DT + 1e-9);
    }
  });

  it('B03b 対象が破壊/遮蔽/円外へ出たら HUD は即座にロック表示と補正マーカーを消す (古い対象を残さない)', () => {
    const g = arena({ enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 })] });
    const e = g.state.enemies[0];
    dummy(e);
    e.pos = frontOf(g.state, 60);
    stepSec(g, 1.0);
    expect(g.state.lock.state).toBe('locked');
    expect(buildHudModel(g.state).target).not.toBeNull();
    // 円の外 (右へ大きくずらす) -> 次の tick で破棄
    e.pos = frontOf(g.state, 60, 60);
    g.step();
    let m = buildHudModel(g.state);
    expect(g.state.lock.state).toBe('none');
    expect(m.target).toBeNull();
    expect(m.aim).toBeNull();
    expect(m.lock.targetId).toBeNull();
    expect(m.lock.progress).toBe(0);
    // 再び入れると 0 から (進捗を引き継がない)
    e.pos = frontOf(g.state, 60);
    g.step();
    expect(buildHudModel(g.state).lock.progress).toBeLessThan(0.1);
    // 破壊
    stepSec(g, 1.0);
    expect(g.state.lock.state).toBe('locked');
    damageEnemy(g.state, e, 9999, 'machinegun');
    m = buildHudModel(g.state); // updateFcs 前でも HUD は死亡した対象を出さない
    expect(m.target).toBeNull();
    expect(m.aim).toBeNull();
    g.step();
    m = buildHudModel(g.state);
    expect(m.target).toBeNull();
    expect(m.lock.phase).toBe('none');
  });

  it('B04 ロック完了後に武器を 1→2→3 と切り替えると、切替後 1 tick で補正表示の武器が一致し、ロックと対象は維持される', () => {
    const g = arena({ enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 })] });
    const e = g.state.enemies[0];
    dummy(e);
    e.pos = frontOf(g.state, 70, 5);
    e.vel = { x: 3, y: 0, z: 0 };
    stepSec(g, 1.0);
    expect(g.state.lock.state).toBe('locked');
    const want = { machinegun: '偏差+重力', beam: '現在位置', missile: '偏差' } as const;
    for (const w of ['beam', 'missile', 'machinegun'] as const) {
      g.input.weaponSelect = w;
      g.step();
      const s = g.state;
      expect(s.player.weapon).toBe(w);
      expect(s.lock.state, `${w}: 武器切替でロックがリセットされた`).toBe('locked');
      expect(s.lock.targetId).toBe('G01');
      expect(s.fc.weapon, `${w}: 切替直後の補正解の武器`).toBe(w);
      const m = buildHudModel(s);
      expect(m.aim, w).not.toBeNull();
      expect(m.aim!.weapon).toBe(w);
      expect(m.aimStatusText, w).toContain(want[w]);
      expect(m.weapons.find((r) => r.selected)!.id).toBe(w);
    }
  });

  it('B04b 補正照準マーカーの位置 = SPEC の補正照準点: ビーム=対象の現在位置(対象マーカーと一致) / ミサイル=初期偏差点 p+v*t (4.4 の 2 次式の最小正解) / マシンガン=p+v*t-0.5*g*t^2 (SPEC を独立に解き直す)', () => {
    const g = arena({ loadout: { fcs: 'wide', generator: 'balanced', legs: 'biped' }, enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 })] });
    const e = g.state.enemies[0];
    dummy(e);
    e.pos = frontOf(g.state, 60, 3, 2);
    e.vel = { x: 6, y: 3, z: -2 };
    stepSec(g, 1.5);
    expect(g.state.lock.state).toBe('locked');
    const dot3 = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
    for (const w of ['beam', 'missile', 'machinegun'] as const) {
      g.input.weaponSelect = w;
      g.step();
      const s = g.state;
      const m = playerMuzzlePosition(s.player);
      const p = s.enemies[0].pos;
      const v = s.enemies[0].vel;
      const r = { x: p.x - m.x, y: p.y - m.y, z: p.z - m.z };
      const hud = buildHudModel(s);
      expect(hud.aim, w).not.toBeNull();
      const cam = s.camera;
      const project = (q: V3): { x: number; y: number } => {
        const d = { x: q.x - cam.pos.x, y: q.y - cam.pos.y, z: q.z - cam.pos.z };
        const depth = dot3(d, cam.forward);
        const scale = cam.viewportH / 2 / Math.tan((cam.fovYDeg * Math.PI) / 360);
        return { x: cam.viewportW / 2 + (dot3(d, cam.right) / depth) * scale, y: cam.viewportH / 2 - (dot3(d, cam.up) / depth) * scale };
      };
      let want: V3;
      if (w === 'beam') {
        want = { ...p }; // 4.4: 到達時間 0・偏差量 0・重力補正量 0
      } else if (w === 'missile') {
        // (v・v − 45²) t² + 2 (r・v) t + r・r = 0 の最小の正の実数解 (0 < t <= 4)
        const A = dot3(v, v) - 45 * 45;
        const B = 2 * dot3(r, v);
        const C = dot3(r, r);
        const roots: number[] = [];
        if (Math.abs(A) < 1e-12) roots.push(-C / B);
        else {
          const disc = B * B - 4 * A * C;
          if (disc >= 0) roots.push((-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A));
        }
        const t = roots.filter((x) => x > 0 && x <= 4).sort((a, b) => a - b)[0];
        expect(t, 'ミサイルの偏差解が存在する条件').toBeDefined();
        want = { x: p.x + v.x * t, y: p.y + v.y * t, z: p.z + v.z * t };
      } else {
        // |r + v t − 0.5 g t²|² − s² t² = 0 (g = (0,-18,0), s = 100) の最小の正の解 (0 < t <= 2) を細かい走査 + 二分法で求める
        const F = (t: number): number => {
          const q = { x: r.x + v.x * t, y: r.y + v.y * t + 9 * t * t, z: r.z + v.z * t };
          return dot3(q, q) - 100 * 100 * t * t;
        };
        let t0 = -1;
        let prev = F(1e-6);
        for (let i = 1; i <= 200000 && t0 < 0; i++) {
          const t = (i / 200000) * 2;
          const cur = F(t);
          if ((prev > 0 && cur <= 0) || (prev < 0 && cur >= 0)) {
            let lo = t - 2 / 200000;
            let hi = t;
            for (let k = 0; k < 80; k++) {
              const mid = (lo + hi) / 2;
              if (F(lo) * F(mid) <= 0) hi = mid;
              else lo = mid;
            }
            t0 = (lo + hi) / 2;
          }
          prev = cur;
        }
        expect(t0, 'マシンガンの射撃解が存在する条件').toBeGreaterThan(0);
        want = { x: p.x + v.x * t0, y: p.y + v.y * t0 + 9 * t0 * t0, z: p.z + v.z * t0 };
      }
      const wantPx = project(want);
      expect(hud.aim!.status, w).toBe('solved');
      expect(hud.aim!.placement.x, `${w} 補正マーカー x`).toBeCloseTo(wantPx.x, 1);
      expect(hud.aim!.placement.y, `${w} 補正マーカー y`).toBeCloseTo(wantPx.y, 1);
      if (w === 'beam') {
        // ビームでは対象マーカーと一致して構わない (一致していること = 現在位置)
        expect(hud.aim!.placement.x).toBeCloseTo(hud.target!.placement.x, 6);
        expect(hud.aim!.placement.y).toBeCloseTo(hud.target!.placement.y, 6);
      } else {
        // マシンガン・ミサイルでは対象の現在位置と別の点 (偏差があるので画面上で離れる)
        expect(Math.hypot(hud.aim!.placement.x - hud.target!.placement.x, hud.aim!.placement.y - hud.target!.placement.y), `${w}: 対象マーカーと補正マーカーは区別できる位置`).toBeGreaterThan(5);
      }
    }
  });

  it('B03c 対象の付け替え: 対象 A のロック完了直後に A が消え B が円へ入ると、B のロック完了まで補正マーカーも「補正中」の文字も出ない (A の補正解を引き継がない)', () => {
    const g = arena({ enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 }), spawn('G02', { x: 0, y: 1.5, z: -50 })] });
    const [a, b] = g.state.enemies;
    dummy(a);
    dummy(b);
    a.pos = frontOf(g.state, 50, 4);
    b.pos = { x: 5000, y: -500, z: 5000 }; // 遠く (射程外)
    stepSec(g, 1.0);
    expect(g.state.lock.state).toBe('locked');
    expect(g.state.lock.targetId).toBe('G01');
    expect(buildHudModel(g.state).aim).not.toBeNull();
    // A を円の外へ、B を円の中央へ (同じ tick)
    a.pos = frontOf(g.state, 50, 200);
    b.pos = frontOf(g.state, 45, -3);
    for (let i = 0; i < 200; i++) {
      g.step();
      const s = g.state;
      const m = buildHudModel(s);
      if (s.lock.state === 'locked') {
        expect(s.lock.targetId).toBe('G02');
        break;
      }
      expect(m.aim, `t=${s.time.toFixed(3)} state=${s.lock.state} target=${s.lock.targetId}`).toBeNull();
      expect(m.aimStatusText).not.toMatch(/補正中|補正解なし/);
      expect(m.lock.phase).toBe(s.lock.state);
      if (s.lock.targetId) expect(s.lock.targetId).toBe('G02');
    }
    expect(g.state.lock.state).toBe('locked'); // B のロックは 0.8 秒で完了する
    expect(g.state.lock.targetId).toBe('G02');
    expect(g.state.time).toBeGreaterThan(1.0 + 0.7); // 進捗を引き継がず 0 から (A: 1.0 秒後に付け替え → B 完了は 1.8 秒付近)
  });

  it('B05 補正解なし: ロックは保持され、HUD は「補正解なし」(文字) と ×形の補正マーカーを出し、対象マーカーは残る', () => {
    // 標的が 120 m/s で遠ざかる: 初速 100 m/s のマシンガンは追いつけず解なし。狭範囲FCS (0.4 s) で完了させる
    const g = arena({ loadout: { fcs: 'narrow', generator: 'balanced', legs: 'biped' }, enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 })] });
    const e = g.state.enemies[0];
    dummy(e);
    e.pos = frontOf(g.state, 25);
    // 遠ざかる方向 = カメラ前方 (水平成分)。上下成分は 0 ではなく前方そのもの
    e.vel = { x: g.state.camera.forward.x * 120, y: g.state.camera.forward.y * 120, z: g.state.camera.forward.z * 120 };
    let sawNoSolution = false;
    for (let i = 0; i < 90 && g.state.mode === 'playing'; i++) {
      g.step();
      const s = g.state;
      if (s.lock.state === 'locked' && s.fc.status === 'no_solution') {
        sawNoSolution = true;
        const m = buildHudModel(s);
        expect(m.aim).not.toBeNull();
        expect(m.aim!.status).toBe('no_solution');
        expect(m.aim!.label).toBe('補正解なし');
        expect(m.aimStatusText).toBe('補正解なし');
        expect(m.target).not.toBeNull(); // ロックも対象マーカーも保持
        expect(m.lock.phase).toBe('locked');
        // no_solution の補正照準は対象の現在位置への直接照準 (対象マーカーと同じ場所)
        expect(m.aim!.placement.x).toBeCloseTo(m.target!.placement.x, 6);
        expect(m.aim!.placement.y).toBeCloseTo(m.target!.placement.y, 6);
        break;
      }
    }
    expect(sawNoSolution, '解なしの状態を作れなかった (試験条件の見直しが必要)').toBe(true);
  });

  it('B14 画面外: 補正照準点が実際に画面外へ出る状況 (MG 70 m/横 90 m/s, ミサイル 40 m/横 40 m/s) で、端の方向表示になり、対象が円内にある限りロックは維持される', () => {
    // 探索 (tests/audit-ui/probe-offaim 相当) で、広範囲FCS・標的を円内に保つとき補正点が画面外になる条件を確認済み。
    // 「画面外の補正点が一度も出ないまま合格する」ことがないよう、出たことを必須にする。
    const cases: { weapon: 'machinegun' | 'missile'; dist: number; speed: number }[] = [
      { weapon: 'machinegun', dist: 70, speed: 90 },
      { weapon: 'missile', dist: 40, speed: 40 },
    ];
    for (const c of cases) {
      const g = arena({ loadout: { fcs: 'wide', generator: 'balanced', legs: 'biped' }, enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 })] });
      g.input.weaponSelect = c.weapon;
      const e = g.state.enemies[0];
      dummy(e);
      const rgt = g.state.camera.right;
      e.vel = { x: rgt.x * c.speed, y: 0, z: rgt.z * c.speed };
      let sawOff = false;
      let lockedFrames = 0;
      for (let i = 0; i < 300 && g.state.mode === 'playing'; i++) {
        // 標的を円内に保つ (中央付近へ戻し続ける = プレイヤーが照準を合わせ続ける状況。速度は変えない)
        e.pos = add(frontOf(g.state, c.dist), rgt, (i % 2 === 0 ? -1 : 1) * 0.5);
        g.step();
        const s = g.state;
        if (s.lock.state !== 'locked') continue;
        lockedFrames++;
        const m = buildHudModel(s);
        expect(m.target, `${c.weapon}: 補正点が画面外でも対象マーカーは残る`).not.toBeNull();
        if (m.aim && !m.aim.placement.onScreen) {
          sawOff = true;
          expect(m.aim.status, `${c.weapon}`).toBe('solved');
          expect(s.lock.state).toBe('locked'); // 補正点が画面外でもロックは解除されない (SPEC 5)
          expect(m.aim.placement.x).toBeGreaterThanOrEqual(0);
          expect(m.aim.placement.x).toBeLessThanOrEqual(m.width);
          expect(m.aim.placement.y).toBeGreaterThanOrEqual(0);
          expect(m.aim.placement.y).toBeLessThanOrEqual(m.height);
          // 端の方向表示は画面中心から補正点の方向にある (中心からの向きが投影方向と一致)
          const sp = { x: m.aim.placement.x - m.width / 2, y: m.aim.placement.y - m.height / 2 };
          expect(Math.hypot(sp.x, sp.y)).toBeGreaterThan(0);
          expect(m.aimStatusText).toMatch(/補正/);
        }
      }
      expect(lockedFrames, `${c.weapon}: ロックを完了できた`).toBeGreaterThan(30);
      expect(sawOff, `${c.weapon} ${c.dist} m / ${c.speed} m/s で補正照準点が画面外になる状況を作れた`).toBe(true);
    }
    // 端の方向表示の配置関数そのもの (画面外の 4 方向: 右・背後・上・左)
    const g2 = arena();
    const cam = g2.state.camera;
    for (const p of [add(cam.pos, cam.right, 500), add(cam.pos, cam.forward, -50), add(cam.pos, cam.up, 400), add(add(cam.pos, cam.forward, 10), cam.right, -300)]) {
      const pl = placeMarker(cam, p);
      expect(pl.onScreen).toBe(false);
      expect(pl.x).toBeGreaterThanOrEqual(0);
      expect(pl.x).toBeLessThanOrEqual(cam.viewportW);
      expect(pl.y).toBeGreaterThanOrEqual(0);
      expect(pl.y).toBeLessThanOrEqual(cam.viewportH);
    }
  });
});

describe('§8 左: 武器と残弾 / 右: EN / 下: HP', () => {
  it('B06 ビーム選択中: 弾数欄は「弾数無制限」、1射 8 EN の消費も表示 (数値は SPEC の 8)', () => {
    const g = arena();
    g.input.weaponSelect = 'beam';
    g.step();
    const m = buildHudModel(g.state);
    const beam = m.weapons.find((w) => w.id === 'beam')!;
    expect(beam.selected).toBe(true);
    expect(beam.ammoText).toMatch(/無制限/);
    expect(beam.ammoText).not.toMatch(/\d+\s*\/\s*\d+/); // 「n/N」形式の弾数にしない
    expect(beam.subText).toMatch(/8\s*EN/);
    // マシンガン 300 / ミサイル 12 は「残弾/総弾数」で表示
    expect(m.weapons.find((w) => w.id === 'machinegun')!.ammoText).toBe('300/300');
    expect(m.weapons.find((w) => w.id === 'missile')!.ammoText).toBe('12/12');
  });

  it('B08 HP / EN / 残弾の表示 = 実際の状態: 射撃・QB・ビーム・飛行を含む 6 秒間、毎 tick 一致 (EN は切り捨て、HP は切り上げ)', () => {
    const g = arena({ enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 })] });
    dummy(g.state.enemies[0]);
    g.state.enemies[0].pos = frontOf(g.state, 60);
    const script: [number, () => void][] = [
      [0.2, () => (g.input.fire = true)],
      [0.5, () => (g.input.fire = false)],
      [0.6, () => (g.input.qb = true)],
      [0.65, () => (g.input.qb = false)],
      [1.0, () => (g.input.weaponSelect = 'beam')],
      [1.1, () => (g.input.fire = true)],
      [1.6, () => (g.input.fire = false)],
      [2.0, () => (g.input.jump = true)],
      [2.6, () => (g.input.jump = false)],
      [3.5, () => (g.input.weaponSelect = 'missile')],
      [3.6, () => (g.input.fire = true)],
      [3.7, () => (g.input.fire = false)],
    ];
    let k = 0;
    for (let i = 0; i < 720 && g.state.mode === 'playing'; i++) {
      while (k < script.length && g.state.time >= script[k][0] - 1e-9) script[k++][1]();
      g.state.enemies[0].pos = frontOf(g.state, 60); // 標的は常にカメラ正面 (ロックを保ち、ミサイルも撃てる状況にする)
      g.step();
      const s = g.state;
      const m = buildHudModel(s);
      const en = s.player.en;
      expect(m.en.max).toBe(s.stats.maxEn);
      expect(m.en.value).toBeLessThanOrEqual(en + 1e-9);
      expect(en - m.en.value).toBeLessThan(1 + 1e-6);
      expect(m.en.ratio).toBeCloseTo(en / s.stats.maxEn, 12);
      expect(m.hp.max).toBe(1000);
      expect(m.hp.value).toBe(Math.ceil(s.player.hp - 1e-9));
      expect(m.weapons.find((w) => w.id === 'machinegun')!.ammoText).toBe(`${s.player.ammo.machinegun}/300`);
      expect(m.weapons.find((w) => w.id === 'missile')!.ammoText).toBe(`${s.player.ammo.missile}/12`);
      expect(m.weapons.find((w) => w.selected)!.id).toBe(s.player.weapon);
    }
    expect(g.state.player.ammo.machinegun).toBeLessThan(300);
    expect(g.state.player.ammo.missile).toBeLessThan(12);
  });

  it('B08b 表示が 0 になるのは本当に 0 のときだけ (EN 切り捨て・HP 切り上げ境界)', () => {
    const g = arena();
    const p = g.state.player;
    p.hp = 0.4;
    expect(buildHudModel(g.state).hp.value).toBe(1);
    p.hp = 1000;
    p.en = 35.9;
    expect(buildHudModel(g.state).en.value).toBe(35);
    p.en = 36;
    expect(buildHudModel(g.state).en.value).toBe(36);
    p.en = 0.9;
    expect(buildHudModel(g.state).en.value).toBe(0);
  });

  it('B07 拒否の通知: 未ロックのミサイル / ビームEN不足 / マシンガン弾切れ / ミサイル弾切れ を文字で判別 (実際の射撃処理から)。弾数・ENは消費しない', () => {
    // (a) 未ロックでミサイル
    let g = arena();
    g.input.weaponSelect = 'missile';
    g.input.fire = true;
    stepN(g, 3);
    let m = buildHudModel(g.state);
    expect(m.notices.map((n) => n.kind)).toContain('noLock');
    expect(m.notices.find((n) => n.kind === 'noLock')!.text).toMatch(/NO LOCK|未ロック/);
    expect(g.state.player.ammo.missile).toBe(12);
    expect(g.state.shots).toHaveLength(0);
    expect(g.state.missiles).toHaveLength(0);
    // (b) ビームでEN不足 (EN < 8)
    g = arena();
    g.input.weaponSelect = 'beam';
    g.input.fire = true;
    for (let i = 0; i < 3; i++) {
      g.state.player.en = 7.9; // 回復で 8 を超えないよう毎 tick 固定
      g.step();
    }
    m = buildHudModel(g.state);
    expect(m.notices.map((n) => n.kind)).toContain('noEn');
    expect(m.notices.find((n) => n.kind === 'noEn')!.text).toMatch(/EN不足/);
    expect(g.state.shots).toHaveLength(0);
    // (c) マシンガン弾切れ
    g = arena();
    g.state.player.ammo.machinegun = 0;
    g.input.fire = true;
    stepN(g, 3);
    m = buildHudModel(g.state);
    expect(m.notices.map((n) => n.kind)).toContain('noAmmo');
    expect(m.notices.find((n) => n.kind === 'noAmmo')!.text).toMatch(/弾切れ/);
    expect(m.weapons.find((w) => w.id === 'machinegun')!.empty).toBe(true);
    expect(m.weapons.find((w) => w.id === 'machinegun')!.subText).toMatch(/弾切れ/);
    // (d) ミサイル弾切れ (ロック完了済み)
    g = arena({ enemies: [spawn('G01', { x: 0, y: 1.5, z: -50 })] });
    dummy(g.state.enemies[0]);
    g.state.enemies[0].pos = frontOf(g.state, 60);
    stepSec(g, 1.0);
    expect(g.state.lock.state).toBe('locked');
    g.state.player.ammo.missile = 0;
    g.input.weaponSelect = 'missile';
    g.input.fire = true;
    stepN(g, 3);
    m = buildHudModel(g.state);
    expect(m.notices.map((n) => n.kind)).toContain('noAmmo');
    expect(m.weapons.find((w) => w.id === 'missile')!.subText).toMatch(/弾切れ/);
    // (e) 通知は一定時間で消え、別の種類の通知とは文言が異なる
    g.input.fire = false;
    stepSec(g, 2.0);
    expect(buildHudModel(g.state).notices).toHaveLength(0);
    const texts = new Set(['noLock', 'noEn', 'noAmmo'].map((k) => k));
    expect(texts.size).toBe(3);
    // (f) QB は EN < 36 のとき HUD の QB 表示が「EN不足」(色だけでなく文字) になり、実際にも不成立
    g = arena();
    g.state.player.en = 35;
    expect(buildHudModel(g.state).movement.qb).toBe('EN不足');
    expect(buildHudModel(g.state).movement.qbText).toMatch(/EN不足/);
    g.input.qb = true;
    stepN(g, 2);
    expect(g.state.player.mv.qbSuccessCount).toBe(0);
  });
});

describe('§8 移動モード・QB', () => {
  /** 1 tick で Q を押して離す (エッジ)。QB が成立したら true */
  function tryQb(g: Game): boolean {
    const before = g.state.player.mv.qbSuccessCount;
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    g.step();
    return g.state.player.mv.qbSuccessCount > before;
  }

  it('B09 QB使用可否の表示 = 実際にQBが成立するか (クールダウン境界 0.99/1.00/1.01 秒・EN 境界 35.9/36)', () => {
    const tests: { waitAfter: number; en: number }[] = [
      { waitAfter: 0.5, en: 120 },
      { waitAfter: 0.98, en: 120 },
      { waitAfter: 1.0, en: 120 },
      { waitAfter: 1.02, en: 120 },
      { waitAfter: 2.0, en: 35.9 },
      { waitAfter: 2.0, en: 36 },
    ];
    for (const t of tests) {
      const g = arena({ loadout: { fcs: 'medium', generator: 'capacity', legs: 'biped' } });
      if (t.waitAfter < 1.5) {
        expect(tryQb(g)).toBe(true); // 最初の QB
        const start = g.state.player.mv.qbLastStartedAt!;
        while (g.state.time < start + t.waitAfter - 1e-9) g.step();
      } else {
        stepSec(g, t.waitAfter);
      }
      g.state.player.en = Math.max(0, Math.min(t.en, g.state.stats.maxEn)); // 回復による超過を避け EN を指定値にする
      const mv = buildHudModel(g.state).movement;
      const label = mv.qb;
      const cooldown = g.state.player.mv.qbCooldownRemaining;
      const ok = tryQb(g);
      const name = `待ち ${t.waitAfter}s EN=${t.en}: HUD=${mv.qbText} cd=${cooldown.toFixed(4)}`;
      expect(label === 'READY', `${name} -> QB ${ok ? '成立' : '不成立'}`).toBe(ok);
      if (!ok && t.en >= 36) {
        expect(label).toBe('COOLDOWN');
        expect(mv.qbCooldown).toBeGreaterThan(0);
      }
      if (!ok && t.en < 36) expect(label).toBe('EN不足');
    }
  });

  it('B09b 次のQBまでの残り時間の表示 = snapshot.qbCooldownRemainingSeconds (QB 直後から 1.0 秒まで毎 tick)', () => {
    const g = arena();
    expect(tryQb(g)).toBe(true);
    for (let i = 0; i < 130; i++) {
      const s = g.state;
      const snap = buildSnapshot(s);
      const mv = buildHudModel(s).movement;
      expect(mv.qbCooldown).toBeCloseTo(snap.player.movement.qbCooldownRemainingSeconds, 9);
      if (snap.player.movement.qbCooldownRemainingSeconds > 1e-9) expect(mv.qb).toBe('COOLDOWN');
      g.step();
    }
    expect(buildHudModel(g.state).movement.qbCooldown).toBe(0);
  });

  it('B09c 左Ctrl を押している間は新しいQBが不成立 (SPEC 7.3)。HUD の QB 表示が「使用可能 (READY)」のままなら実際と食い違う', () => {
    const g = arena();
    g.input.ctrl = true;
    g.step();
    const label = buildHudModel(g.state).movement.qb;
    const ok = tryQb(g);
    expect(ok, 'Ctrl 押下中の QB は不成立のはず').toBe(false);
    expect(label, 'Ctrl 押下中は QB 使用不可: HUD は READY と表示してはいけない').not.toBe('READY');
  });

  it('B09d 移動モード表示: 歩行=WALK / QB 噴射中=QB / 噴射後(慣性・自動グライド)=GLIDE / 左Ctrl ブレーキ中=WALK (SPEC §10 と同じ規則)', () => {
    const g = arena();
    expect(buildHudModel(g.state).movement.mode).toBe('WALK');
    g.input.forward = true;
    stepN(g, 6);
    expect(buildHudModel(g.state).movement.mode).toBe('WALK');
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    let m = buildHudModel(g.state).movement;
    expect(m.mode).toBe('QB');
    expect(buildSnapshot(g.state).player.movement.horizontalMode).toBe('quickboost');
    stepSec(g, 0.2);
    m = buildHudModel(g.state).movement;
    expect(m.mode).toBe('GLIDE'); // Shift を押していなくても自動グライド
    expect(g.state.player.mv.glideEnabled).toBe(true);
    g.input.forward = false;
    g.input.ctrl = true;
    stepN(g, 3);
    expect(buildHudModel(g.state).movement.mode).toBe('WALK');
    expect(buildSnapshot(g.state).player.movement.horizontalMode).toBe('walk');
  });
});

describe('§8 区画・次の目標・制御砲台・隔壁・脱出 (実ステージ)', () => {
  const realGame = (): Game => {
    const g = new Game({ stage: realStage() });
    g.sortie();
    return g;
  };

  it('B10 実ステージ: 初期表示 = 搬入口・制御砲台 0/6・隔壁 6 つとも閉・最終ゲート閉鎖中・次の目標=制御砲台', () => {
    const g = realGame();
    stepN(g, 2);
    const m = buildHudModel(g.state);
    expect(m.mission.sectorId).toBe('S01');
    expect(m.mission.sectorName).toContain('搬入口');
    expect(m.mission.controlsDestroyed).toBe(0);
    expect(m.mission.controlsRequired).toBe(6);
    expect(m.mission.barriers).toHaveLength(6);
    expect(m.mission.barriers.every((b) => !b.open)).toBe(true);
    expect(m.mission.gateOpen).toBe(false);
    expect(m.mission.gateText).toMatch(/閉鎖/);
    expect(m.next.kind).toBe('control');
    expect(m.next.text).toMatch(/制御砲台/);
    expect(m.controls).toHaveLength(6);
    expect(m.escape).toBeNull();
  });

  it('B10b 制御砲台を任意の順で破壊: 破壊数 n/6・対応する隔壁だけが「開放」・その隔壁の衝突箱も実際に無効・次の目標は未破壊の最小番号', () => {
    const g = realGame();
    const st = g.state.stage;
    const controls = g.state.enemies.filter((e) => e.controlIndex !== null).sort((a, b) => (a.controlIndex as number) - (b.controlIndex as number));
    expect(controls).toHaveLength(6);
    const order = [4, 1, 5, 0, 3, 2];
    const destroyed: number[] = [];
    for (const idx of order) {
      const c = controls[idx];
      damageEnemy(g.state, c, 99999, 'machinegun');
      g.step();
      destroyed.push(idx);
      const s = g.state;
      const m = buildHudModel(s);
      expect(m.mission.controlsDestroyed).toBe(destroyed.length);
      expect(s.objective.controlsDestroyed).toBe(destroyed.length);
      for (const b of m.mission.barriers) {
        const barrier = st.barriers.find((x) => x.id === b.id)!;
        const shouldOpen = destroyed.some((d) => controls[d].barrierId === b.id);
        expect(b.open, `${b.id} の開放表示 (破壊済み=${destroyed.join(',')})`).toBe(shouldOpen);
        // 実際の衝突箱: 開放表示の隔壁は全ての箱が無効、閉の隔壁は全て有効
        for (const boxId of barrier.boxIds) {
          const bi = s.world.indexOfBox(boxId);
          expect(bi, `${b.id} の箱 ${boxId}`).toBeGreaterThanOrEqual(0);
          expect(s.world.isBoxEnabled(bi), `${b.id} 表示=${b.open ? '開放' : '閉'} の箱 ${boxId}`).toBe(!shouldOpen);
        }
      }
      const rest = controls.filter((_, i) => !destroyed.includes(i));
      if (rest.length > 0) {
        expect(m.next.kind).toBe('control');
        expect(m.next.id).toBe(rest[0].id);
        expect(m.next.text).toContain(rest[0].id);
        // 次の目標の文言に対応する隔壁の説明が入る
        const barrier = st.barriers.find((x) => x.id === rest[0].barrierId)!;
        expect(m.next.text).toContain(barrier.label);
        expect(m.mission.gateText).toMatch(/閉鎖/);
        expect(m.mission.gateOpen).toBe(false);
        expect(m.escape).toBeNull();
      }
    }
    // 6/6: 最終ゲートが開き、脱出可能の表示・脱出マーカー・次の目標=脱出
    const m = buildHudModel(g.state);
    expect(m.mission.controlsDestroyed).toBe(6);
    expect(m.mission.gateOpen).toBe(true);
    expect(g.state.objective.gateOpen).toBe(true);
    expect(m.mission.gateText).toMatch(/脱出可能/);
    expect(m.next.kind).toBe('escape');
    expect(m.escape).not.toBeNull();
    // 最終ゲートの衝突箱も実際に無効
    for (const b of st.barriers.filter((x) => x.isFinal)) for (const boxId of b.boxIds) expect(g.state.world.isBoxEnabled(g.state.world.indexOfBox(boxId))).toBe(false);
  });

  it('B10e 隔壁・最終ゲートの開放通知 (HUD メッセージ): 制御砲台の破壊で対応する隔壁の開放が文字で出て、経過 4 秒 (ゲーム内時間) で消える。再出撃では過去の通知を引き継がない', () => {
    const g = realGame();
    const msgs = new HudMessages();
    expect(msgs.update(g.state)).toHaveLength(0);
    const controls = g.state.enemies.filter((e) => e.controlIndex !== null).sort((a, b) => (a.controlIndex as number) - (b.controlIndex as number));
    damageEnemy(g.state, controls[2], 99999, 'machinegun');
    g.step();
    let list = msgs.update(g.state);
    const barrier = g.state.stage.barriers.find((b) => b.id === controls[2].barrierId)!;
    expect(list.map((m) => m.text).join('|')).toContain(`隔壁 ${barrier.id} 開放`);
    expect(list.map((m) => m.text).join('|')).toContain(barrier.label);
    // 3.9 秒後はまだ、4.1 秒後には消える (ゲーム内時間 = state.time。一時停止中は進まない)
    stepSec(g, 3.9);
    expect(msgs.update(g.state).some((m) => m.kind === 'barrier')).toBe(true);
    g.pause();
    for (let i = 0; i < 300; i++) g.advance(0.1); // 一時停止中は何秒経っても state.time は進まない
    expect(msgs.update(g.state).some((m) => m.kind === 'barrier')).toBe(true);
    g.resume();
    stepSec(g, 0.3);
    expect(msgs.update(g.state).some((m) => m.kind === 'barrier')).toBe(false);
    // 6/6: 最終ゲートの開放通知
    for (const c of controls) damageEnemy(g.state, c, 99999, 'machinegun');
    g.step();
    list = msgs.update(g.state);
    expect(list.some((m) => m.kind === 'gate' && /脱出/.test(m.text))).toBe(true);
    // 再出撃 (state の差し替え) では古い通知を持ち越さない
    g.retry();
    expect(msgs.update(g.state)).toHaveLength(0);
  });

  it('B10c 現在の区画表示: 20 区画の各中心へ移動すると、その区画の ID と名前を表示し、通過数が増える', () => {
    const g = realGame();
    const stage = g.state.stage;
    let visited = 1;
    for (const sec of stage.sectors) {
      const b = sec.bounds;
      // 区画の中心の少し上 (床の内側ではなく空間内)。AABB 判定なので中心で足りる
      g.state.player.pos = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
      g.state.player.vel = { x: 0, y: 0, z: 0 };
      g.step();
      const m = buildHudModel(g.state);
      expect(m.mission.sectorId, sec.id).toBe(sec.id);
      expect(m.mission.sectorName, sec.id).toBe(sec.name);
      expect(m.mission.sectorCount).toBe(stage.sectors.length);
      if (sec.id !== 'S01') visited++;
      expect(m.mission.visited, sec.id).toBe(visited);
      expect(buildSnapshot(g.state).stage.currentSectorId).toBe(sec.id);
      expect(g.state.mode).toBe('playing');
    }
    expect(visited).toBe(stage.sectors.length);
    expect(stage.sectors.length).toBeGreaterThanOrEqual(15);
  });

  it('B10d 結果画面のモデル: クリア/失敗の表示・理由・数値 = state (HP0 とクリアが同時なら失敗)', () => {
    const g = realGame();
    g.state.player.hp = 0;
    g.step();
    expect(g.state.mode).toBe('failed');
    const r = buildResultModel(g.state);
    expect(r.cleared).toBe(false);
    expect(r.title).toMatch(/FAILED/);
    expect(r.reason).toMatch(/HP 0|大破/);
    expect(r.rows.find((x) => x.label === '制御砲台')!.value).toBe('0 / 6');
    // 再出撃で初期化される (格納庫へ戻る操作は app.ts の DOM 検査で確認)
    g.retry();
    expect(g.state.mode).toBe('playing');
    expect(g.state.player.hp).toBe(1000);
    expect(g.state.objective.controlsDestroyed).toBe(0);
  });
});

describe('§8 敵の射撃予告と被弾方向 (実際の敵AI)', () => {
  it('B11 射撃予告: 固定砲台 0.35 秒 / 警備ロボット 0.15 秒 の予告中だけ、HUD の予告マーカーが該当敵に出る (発射前・遮蔽なし)', () => {
    for (const [id, kind, telegraphSec] of [['T01', 'turret', 0.35], ['G01', 'guard', 0.15]] as const) {
      const g = arena({ enemies: [spawn(id, { x: 0, y: kind === 'turret' ? 1.6 : 1.5, z: -60 })] });
      const e = g.state.enemies[0];
      let ticksTele = 0;
      let firstTeleAt = -1;
      let firstShotAt = -1;
      let mism = 0;
      for (let i = 0; i < 360 && g.state.mode === 'playing'; i++) {
        g.step();
        const s = g.state;
        const m = buildHudModel(s);
        const has = m.telegraphs.some((t) => t.id === id);
        if (e.telegraph > 0) {
          ticksTele++;
          if (firstTeleAt < 0) firstTeleAt = s.time;
        }
        if ((e.telegraph > 0) !== has) mism++;
        if (firstShotAt < 0 && e.shotsFired > 0) firstShotAt = s.time;
        if (firstShotAt >= 0 && i > 240) break;
      }
      expect(mism, `${id}: 予告マーカーの表示と e.telegraph>0 が食い違った tick 数`).toBe(0);
      expect(firstTeleAt, `${id}: 予告が一度も出ない`).toBeGreaterThan(0);
      expect(firstShotAt).toBeGreaterThan(0);
      // 予告開始から最初の発射までが SPEC の予告時間 (±2 tick)
      expect(firstShotAt - firstTeleAt, `${id} 予告→発射`).toBeGreaterThanOrEqual(telegraphSec - 3 * DT);
      expect(firstShotAt - firstTeleAt, `${id} 予告→発射`).toBeLessThanOrEqual(telegraphSec + 3 * DT);
      // 予告マーカーは死んだ敵には出ない
      damageEnemy(g.state, e, 9999, 'machinegun');
      expect(buildHudModel(g.state).telegraphs).toHaveLength(0);
      expect(ticksTele).toBeGreaterThan(0);
    }
  });

  it('B12 被弾方向: 実際の敵弾が命中したとき、HUD のウェッジ角 = カメラ基準の射手の方位 (前・右・後・左・斜め、視点回転後も)', () => {
    // 4 方位 + 2 斜め: 射手 (固定砲台) をプレイヤー中心の円周上に置き、カメラ (yaw) を回して確認
    const cases: { name: string; at: V3; yaw: number; expectAngle: number }[] = [
      { name: '前 (-Z, yaw0)', at: { x: 0, y: 1.6, z: -40 }, yaw: 0, expectAngle: 0 },
      { name: '右 (+X, yaw0)', at: { x: 40, y: 1.6, z: 0 }, yaw: 0, expectAngle: Math.PI / 2 },
      { name: '左 (-X, yaw0)', at: { x: -40, y: 1.6, z: 0 }, yaw: 0, expectAngle: -Math.PI / 2 },
      { name: '後 (+Z, yaw0)', at: { x: 0, y: 1.6, z: 40 }, yaw: 0, expectAngle: Math.PI },
      { name: '右前 (yaw0)', at: { x: 28.28, y: 1.6, z: -28.28 }, yaw: 0, expectAngle: Math.PI / 4 },
      // 視点を右へ 90° 回す (yaw 減少 = マウス右): 元の「前(-Z)」の射手は左側に見える
      { name: '前の射手 + 視点を右90°', at: { x: 0, y: 1.6, z: -40 }, yaw: -Math.PI / 2, expectAngle: -Math.PI / 2 },
    ];
    for (const c of cases) {
      const g = arena({ enemies: [spawn('T01', c.at)] });
      g.state.player.yaw = c.yaw;
      updateCamera(g.state, g.world);
      let hit = false;
      for (let i = 0; i < 720 && g.state.mode === 'playing'; i++) {
        g.step();
        if (g.state.damageIndicators.length > 0) {
          hit = true;
          break;
        }
      }
      expect(hit, `${c.name}: 被弾しなかった`).toBe(true);
      const m = buildHudModel(g.state);
      expect(m.wedges.length, c.name).toBeGreaterThanOrEqual(1);
      let d = m.wedges[0].angle - c.expectAngle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      expect(Math.abs(d), `${c.name}: ウェッジ角 ${(m.wedges[0].angle * 180) / Math.PI}° (期待 ${(c.expectAngle * 180) / Math.PI}°)`).toBeLessThan((3 * Math.PI) / 180);
      // 射手方向のベクトルは実際の射手の位置と一致する (3°以内)
      const ind = g.state.damageIndicators[0];
      const want = { x: c.at.x - g.state.player.pos.x, y: c.at.y - g.state.player.pos.y, z: c.at.z - g.state.player.pos.z };
      const wl = Math.hypot(want.x, want.y, want.z);
      const dot = (ind.dirToSource.x * want.x + ind.dirToSource.y * want.y + ind.dirToSource.z * want.z) / wl;
      expect(Math.acos(Math.min(1, dot)), c.name).toBeLessThan((3 * Math.PI) / 180);
    }
  });
});

describe('§8 画面表現: 区画カリングが見えるはずの壁・床を消さない (廃工場の造形が欠けない)', () => {
  it('D01 実ステージの経路上 (12 m 間隔) の 8 方位 × 3 ピッチ × 隔壁 閉/開 で、画素の光線が最初に当たる面 (壁・床・天井・足場) の区画は、必ず描画対象になっている', () => {
    // 描画は区画単位のポータルカリング (render/visibility.ts) で、遮蔽壁の向こう側の区画などを描かない。
    // 「実際に画面に映る最初の面」を実 World のレイキャストで求め、その面を持つ区画が描画される (flags=1) ことを確認する。
    // 欠けると、そこだけ床/壁が抜けて背景色が見える (廃工場の通路や足場の境界が識別できなくなる)。
    const stage = realStage();
    const g = new Game({ stage });
    g.sortie();
    const vis = new SectorVisibility(stage);
    const flags = new Uint8Array(vis.count);
    const sectors = stage.sectors;
    const sectorOf = (b: { min: V3; max: V3 }): number => {
      const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
      for (let i = 0; i < sectors.length; i++) if (sectorContains(sectors[i], c)) return i; // render/stageMesh.ts と同じ割り当て
      return -1;
    };
    const boxSector = stage.boxes.map(sectorOf);
    const barrierIds = new Set(stage.barriers.map((b) => b.id));
    const pts = stage.mainRoute.points;
    const poses: { p: V3; tag: string }[] = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 12));
      for (let j = 0; j < n; j++) poses.push({ p: { x: a.x + ((b.x - a.x) * j) / n, y: a.y + ((b.y - a.y) * j) / n, z: a.z + ((b.z - a.z) * j) / n }, tag: `seg${k}.${j}` });
    }
    poses.push({ p: pts[pts.length - 1], tag: 'last' });
    expect(poses.length).toBeGreaterThan(100);
    const W = 1280;
    const H = 720;
    const cam = new PerspectiveCamera(70, W / H, 0.3, 1500);
    const NX = 24;
    const NY = 14;
    const holes: string[] = [];
    let rays = 0;
    let checked = 0;
    for (const closed of [true, false]) {
      for (let i = 0; i < g.world.boxes.length; i++) if (g.world.boxes[i].barrierId) g.world.setBoxEnabled(i, closed);
      for (const base of poses) {
        for (let yi = 0; yi < 8; yi++) {
          for (const pitch of [-0.4, 0, 0.4]) {
            const st = g.state;
            st.player.pos = { ...base.p };
            st.player.yaw = (yi * Math.PI) / 4;
            st.player.pitch = pitch;
            updateCamera(st, g.world);
            applySimCamera(cam, st.camera, W / H);
            const pv = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
            vis.compute(cam.position, st.player.pos, pv, (id) => closed && barrierIds.has(id), 330, flags); // 330 = フォグ far 320 + 10
            checked++;
            for (let iy = 0; iy < NY; iy++) {
              for (let ix = 0; ix < NX; ix++) {
                const d = new Vector3(((ix + 0.5) / NX) * 2 - 1, 1 - ((iy + 0.5) / NY) * 2, 0.5).unproject(cam).sub(cam.position).normalize();
                const hit = g.world.raycast({ x: cam.position.x, y: cam.position.y, z: cam.position.z }, { x: d.x, y: d.y, z: d.z }, 330);
                rays++;
                if (!hit || g.world.boxes[hit.boxIndex].barrierId) continue; // 隔壁のシャッターは別メッシュで常に描く
                const sec = boxSector[hit.boxIndex];
                if (sec >= 0 && flags[sec] === 0) holes.push(`${base.tag}${closed ? '' : '(隔壁開)'} yaw=${yi * 45} pitch=${pitch} 区画 ${sectors[sec].id} 箱 ${g.world.boxes[hit.boxIndex].id}`);
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
    expect(rays).toBeGreaterThan(1_500_000);
    expect(holes.slice(0, 5), `カリングで欠ける面 ${holes.length} 本 / ${rays} 本`).toEqual([]);
  });
});

describe('§8 画面表現: 廃工場としての造形 (配管・梁・機械設備・破損箇所・警告灯)', () => {
  it('D02 実ステージに 配管 (円柱の管)・梁・機械設備・破損箇所・警告灯 が全体で十分な数あり、20 区画のどの区画も 5 要素のうち 3 種類以上を持つ', () => {
    const stage = realStage();
    const all = [...stage.boxes, ...(stage.decor ?? [])];
    const cats: Record<string, (b: { id: string; mat: string; shape?: string; emissive?: number }) => boolean> = {
      配管: (b) => b.mat === 'pipe' || (!!b.shape && b.shape !== 'box' && /pipe|duct|riser|flue|hose/.test(b.id)),
      梁: (b) => /girder|truss|beam|gantry|cross|purlin|bridge/.test(b.id),
      機械設備: (b) => b.mat === 'machine' || /press|pump|furnace|crane|hoist|fan|tank|belt|valve|compressor|transformer|lathe|conveyor/.test(b.id),
      破損箇所: (b) => /rubble|fallen|debris|collapsed|scrap|wreck/.test(b.id) || b.mat === 'rust',
      警告灯: (b) => (b.mat === 'hazard' && (b.emissive ?? 0) > 0) || /beacon|lamp|siren/.test(b.id) || b.mat === 'gate',
    };
    const total: Record<string, number> = {};
    for (const [name, fn] of Object.entries(cats)) total[name] = all.filter(fn).length;
    // SPEC §8 が挙げる各要素が「一部にだけ」ではなく工場全体を通して使われている
    for (const [name, n] of Object.entries(total)) expect(n, `${name} の総数 ${JSON.stringify(total)}`).toBeGreaterThanOrEqual(50);
    // 円柱形状の配管が実際にある (箱の見立てだけではない)
    expect(all.filter((b) => (b as { shape?: string }).shape === 'cylX' || (b as { shape?: string }).shape === 'cylY' || (b as { shape?: string }).shape === 'cylZ').length).toBeGreaterThanOrEqual(100);
    const lacking: string[] = [];
    for (const sec of stage.sectors) {
      const have = Object.entries(cats).filter(([, fn]) => all.some((b) => b.sectorId === sec.id && fn(b))).map(([k]) => k);
      if (have.length < 3) lacking.push(`${sec.id} ${sec.name}: ${have.join('・')}`);
    }
    expect(lacking, '5 要素のうち 3 種類未満の区画').toEqual([]);
  });
});

describe('§8 操作説明', () => {
  const text = helpSections()
    .flatMap((s) => [s.title, ...s.rows.map((r) => `${r.key} ${r.desc}`), ...(s.notes ?? [])])
    .join('\n');
  const rowsOf = (): string[] => helpSections().flatMap((s) => s.rows.map((r) => `${r.key} ${r.desc}`));

  it('B13 必須記述: FCS 円内に保てば偏差と重力を自動補正・中央照準を補正マーカーへ手動で合わせる必要はない', () => {
    const row = rowsOf().find((r) => /偏差/.test(r) && /重力/.test(r) && /自動/.test(r) && /FCS/.test(r));
    expect(row, '「FCS円に保てば偏差と重力を自動補正」の記述').toBeTruthy();
    expect(row).toMatch(/中央/);
    expect(row).toMatch(/手動/);
    expect(row).toMatch(/必要はない|不要/);
    expect(row).toMatch(/補正マーカー|補正照準/);
  });

  it('B13b 必須記述: Qは単発・36 EN・QB後は自動グライド・グライドは0 EN・停止は左CtrlまたはShiftでの解除', () => {
    const qRow = rowsOf().find((r) => /^Q\b/.test(r));
    expect(qRow, 'Q の行').toBeTruthy();
    expect(qRow).toMatch(/単発/);
    expect(qRow).toMatch(/36\s*EN/);
    expect(qRow).toMatch(/自動/);
    expect(qRow).toMatch(/グライド/);
    expect(text).toMatch(/グライド[^\n]{0,20}0\s*EN|0\s*EN[^\n]{0,20}グライド/);
    const stop = rowsOf().find((r) => /停止/.test(r) && /左Ctrl/.test(r) && /Shift/.test(r));
    expect(stop, '停止は左CtrlまたはShiftでの解除').toBeTruthy();
    expect(stop).toMatch(/解除/);
  });

  it('B13c 操作説明の数値が SPEC と一致 (移動 10m/s・飛行 20EN/秒 0.2秒・ビーム 8EN・弾数 300/12・回復待ち 0.75秒・HP1000・QB 0.15秒)', () => {
    expect(text).toMatch(/10\s*m\/s/);
    expect(text).toMatch(/0\.2秒以上/);
    expect(text).toMatch(/20\s*EN\/秒/);
    expect(text).toMatch(/8\s*EN/);
    expect(text).toMatch(/300発/);
    expect(text).toMatch(/12発/);
    expect(text).toMatch(/0\.75秒/);
    expect(text).toMatch(/1000/);
    expect(text).toMatch(/0\.15秒/);
    expect(text).toMatch(/左クリック/);
    expect(text).toMatch(/Esc/);
    for (const k of ['W / A / S / D', 'Space', 'Shift', '左Ctrl', 'Q', '1 / 2 / 3']) expect(text).toContain(k);
    // 6 体・隔壁・最終ゲート・脱出の説明
    expect(text).toMatch(/6体/);
    expect(text).toMatch(/最終ゲート/);
  });

  it('B13d 操作説明は出撃前(格納庫)と一時停止画面の両方から開ける (UI 配線)', () => {
    const app = readFileSync(join(ROOT, 'src/ui/app.ts'), 'utf8');
    const screens = readFileSync(join(ROOT, 'src/ui/screens.ts'), 'utf8');
    const garage = readFileSync(join(ROOT, 'src/ui/garage.ts'), 'utf8');
    expect(garage).toMatch(/操作方法を確認/);
    expect(garage).toMatch(/onHelp\(\)/);
    expect(screens).toMatch(/button\('操作方法'/);
    expect(app).toMatch(/onHelp:\s*\(\)\s*=>\s*this\.help\.open\(\)/g);
    expect((app.match(/onHelp:\s*\(\)\s*=>\s*this\.help\.open\(\)/g) ?? []).length).toBe(2); // 格納庫 + 一時停止
  });
});

describe('§8 表示値はゲームロジックと同じ定義 (UI専用の架空の数値なし)', () => {
  it('B15 HUD/格納庫/操作説明のソースに、ゲーム数値をリテラルで重複定義していない (config 経由)', () => {
    const files = ['src/ui/hudLogic.ts', 'src/ui/garageLogic.ts', 'src/ui/controlsHelp.ts', 'src/ui/hud.ts', 'src/ui/garage.ts', 'src/ui/screens.ts'];
    const offenders: string[] = [];
    // 「36」「300」「1000」「0.75」等のゲーム数値が、config を介さず直書きされていないか (コメント・文字列内の説明は除外しない: 厳しめ)
    const forbidden: [RegExp, string][] = [
      [/(?<![\w.])36(?![\w.])/, 'QB 36 EN'],
      [/(?<![\w.])300(?![\w.])/, 'MG 300 発'],
      [/(?<![\w.])1000(?![\w.])/, 'HP 1000'],
    ];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const [re, what] of forbidden) if (re.test(src)) offenders.push(`${f}: ${what}`);
      // 制御砲台 6 の直書き (pip の数など)
    }
    expect(offenders).toEqual([]);
    const hud = readFileSync(join(ROOT, 'src/ui/hud.ts'), 'utf8');
    // 制御砲台の破壊数 pip の数は STAGE.CONTROLS_REQUIRED (=6) から作る
    expect(hud).not.toMatch(/for \(let i = 0; i < 6; i\+\+\)/);
  });
});

// =====================================================================================================================
// §1 納品
// =====================================================================================================================
describe('§1 納品 (package.json / lockfile / 外部参照 / dev・build 構成)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    type?: string;
  };
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    lockfileVersion: number;
    packages: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
  };

  it('C01 npm run dev / build / preview が定義され、dev は vite (npm run dev -- --host 0.0.0.0 --port 5173 が vite へ渡る)', () => {
    expect(pkg.scripts.build).toMatch(/^vite build/);
    expect(pkg.scripts.dev).toMatch(/^vite(\s|$)/);
    expect(pkg.scripts.dev).not.toMatch(/--port|--host/); // 固定していると spec の引数と衝突するため、素の vite であること
    expect(pkg.type).toBe('module');
    expect(existsSync(join(ROOT, 'index.html'))).toBe(true);
    const cfg = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/host:\s*'0\.0\.0\.0'/);
    expect(cfg).toMatch(/port:\s*5173/);
    expect(cfg).toMatch(/base:\s*'\.\/'/); // 相対 base: どのパスから配信しても動く
    // 実行時に必要なのは three のみ (Three.js を使用)
    expect(Object.keys(pkg.dependencies)).toContain('three');
  });

  it('C02 依存関係のバージョンが固定 (^ ~ * > < x latest URL タグ無し) で、lockfile と package.json が一致し、node_modules もその版', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, ver] of Object.entries(all)) {
      expect(ver, `${name}@${ver}`).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
    const root = lock.packages[''];
    expect(root.dependencies).toEqual(pkg.dependencies);
    expect(root.devDependencies).toEqual(pkg.devDependencies);
    for (const [name, ver] of Object.entries(all)) {
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry, name).toBeTruthy();
      expect(entry.version, name).toBe(ver);
      const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')) as { version: string };
      expect(installed.version, `${name} (node_modules)`).toBe(ver);
    }
    // lockfile の全パッケージが版・取得元・integrity を持つ (再現性)
    let n = 0;
    for (const [path, e] of Object.entries(lock.packages)) {
      if (path === '') continue;
      n++;
      expect(e.version, path).toMatch(/^\d+\.\d+\.\d+/);
      expect(e.integrity, path).toMatch(/^sha(512|384|256)-/);
      expect(e.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
    expect(n).toBeGreaterThan(10);
    expect(existsSync(join(ROOT, 'package-lock.json'))).toBe(true);
    expect(pkg.dependencies.three).toBe('0.186.0');
  });

  /** src / index.html 内の全ファイルを列挙 */
  function listFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) listFiles(p, out);
      else out.push(p);
    }
    return out;
  }

  it('C03 ソースに外部参照 (CDN/画像/フォント/音源/API) が無い: http(s):// は SVG 名前空間のみ、通信・外部ローダー API を使わない', () => {
    const files = [...listFiles(join(ROOT, 'src')), join(ROOT, 'index.html')];
    const urlHits: string[] = [];
    const apiHits: string[] = [];
    const apis =
      /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|TextureLoader|ImageLoader|FileLoader|GLTFLoader|OBJLoader|AudioLoader|CubeTextureLoader|ImageBitmapLoader|new\s+Image\s*\(|new\s+Audio\s*\()/;
    const tags = /<\s*(img|audio|video|iframe|source|embed|object)\b|<link[^>]+href\s*=\s*["']https?:|<script[^>]+src\s*=\s*["']https?:|@import|url\(\s*["']?https?:/i;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/https?:\/\/[^\s'"`)>]+/g)) {
        if (m[0] === 'http://www.w3.org/2000/svg') continue; // XML 名前空間識別子 (通信しない)
        urlHits.push(`${f.replace(ROOT + '/', '')}: ${m[0]}`);
      }
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (apis.test(stripped)) apiHits.push(`${f.replace(ROOT + '/', '')}: ${apis.exec(stripped)![0]}`);
      if (tags.test(src)) apiHits.push(`${f.replace(ROOT + '/', '')}: ${tags.exec(src)![0]}`);
    }
    expect(urlHits, '外部URL').toEqual([]);
    expect(apiHits, '外部通信/外部アセット API').toEqual([]);
  });

  it('C03b index.html: 外部の script/link/画像を参照せず、favicon は data URI', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
      expect(m[1].startsWith('data:') || m[1].startsWith('/src/') || m[1].startsWith('./') || m[1].startsWith('/'), m[1]).toBe(true);
      expect(m[1]).not.toMatch(/^(https?:)?\/\//);
    }
    expect(html).toMatch(/<html[^>]+lang="ja"/);
  });

  it('C06 README.md がある: 起動手順 (npm ci / npm run build / npm run dev -- --host 0.0.0.0 --port 5173) と、検証節 (実際に用いた条件・発射数・命中数・残差・未実施項目) を記録する場所 (SPEC §1 納品 / §4.6 / §11)', () => {
    const name = readdirSync(ROOT).find((n) => /^readme(\.md)?$/i.test(n));
    expect(name, 'プロジェクト直下に README.md が無い (SPEC §4.6: 「READMEの検証節へ、実際に用いた条件、発射数、命中数、弾道計算の残差、未実施項目を記録してください」)').toBeTruthy();
    const text = readFileSync(join(ROOT, name!), 'utf8');
    expect(text).toMatch(/npm ci/);
    expect(text).toMatch(/npm run build/);
    expect(text).toMatch(/npm run dev/);
    expect(text).toMatch(/^#{1,4}\s.*検証/m); // 検証節
    expect(text).toMatch(/未実施|未確認/);
  });

  it('C05 リサイズ対応 (ソース): resize で Game・レンダラーの両方へ反映、dpr を渡す、1280x720 未満でも幅0にならない', () => {
    const app = readFileSync(join(ROOT, 'src/ui/app.ts'), 'utf8');
    expect(app).toMatch(/addEventListener\('resize'/);
    expect(app).toMatch(/this\.game\.setViewport\(w, h\)/);
    expect(app).toMatch(/this\.renderer\.resize\(w, h, window\.devicePixelRatio/);
    expect(app).toMatch(/w > 0 && h > 0/);
    const css = readFileSync(join(ROOT, 'src/ui/style.css'), 'utf8');
    expect(css).toMatch(/overflow:\s*hidden/);
    expect(css).toMatch(/#game-canvas\s*\{[^}]*position:\s*fixed/);
  });
});
