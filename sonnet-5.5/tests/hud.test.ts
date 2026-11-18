/**
 * HUD の表示ロジック (DOMなしの純粋関数)。実際の Game / GameState / projectToScreen を使う。
 * 検証: 判定円=state.lock.radiusCssPx、マーカー位置=FCSと同一の投影、表示値=state、画面外矢印、被弾方向、結果画面。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAMERA, ENEMIES, PLAYER, WEAPONS } from '../src/config';
import { Game } from '../src/sim/game';
import { projectToScreen } from '../src/sim/project';
import { buildTestArenaStage } from '../src/sim/testArena';
import type { BarrierDef, EnemySpawn, GameState, StageDef, V3 } from '../src/sim/types';
import {
  HUD_CONST,
  HudMessages,
  bearingAngle,
  bearingOf,
  buildHudModel,
  buildResultModel,
  edgeInsetFor,
  fmtEn,
  fmtHp,
  formatTime,
  hudUnit,
  layoutControlMarkers,
  placeMarker,
} from '../src/ui/hudLogic';
import type { ControlView, MarkerPlacement } from '../src/ui/hudLogic';

const add = (a: V3, b: V3, s = 1): V3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });

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

/** 制御砲台6体 + 隔壁B1..B6 + 最終ゲートを持つ試験ステージ (実際の objective.ts が処理する) */
function campaignLikeStage(): StageDef {
  const stage = buildTestArenaStage();
  const barriers: BarrierDef[] = [];
  const enemies: EnemySpawn[] = [spawn('G01', { x: 0, y: 1.5, z: -60 })];
  for (let i = 0; i < 6; i++) {
    const id = `T${String(i + 1).padStart(2, '0')}`;
    enemies.push(spawn(id, { x: -50 + i * 20, y: 1.6, z: -100 - i * 10 }, { isGateControl: true, controlIndex: i, barrierId: `B${i + 1}` }));
    barriers.push({ id: `B${i + 1}`, boxIds: [], controlEnemyId: id, isFinal: false, label: `テスト隔壁${i + 1}`, pos: { x: 0, y: 0, z: 0 } });
  }
  barriers.push({ id: 'GATE', boxIds: [], controlEnemyId: null, isFinal: true, label: '最終ゲート', pos: { x: 0, y: 0, z: 0 } });
  return { ...stage, enemies, barriers, escapeZone: { min: { x: 100, y: -5, z: -5 }, max: { x: 110, y: 10, z: 5 } }, killY: -100 };
}

function newGame(w = 1280, h = 720): Game {
  const g = new Game({ stage: campaignLikeStage(), viewportW: w, viewportH: h });
  g.sortie();
  return g;
}

const enemy = (s: GameState, id: string) => s.enemies.find((e) => e.id === id)!;

describe('FCS 判定円 (SPEC §5: 表示円=判定円, リサイズ追従)', () => {
  it('半径は state.lock.radiusCssPx そのもの (FCS 3種 × 解像度)', () => {
    for (const [fcs, ratio] of [['wide', 0.3], ['medium', 0.2], ['narrow', 0.1]] as const) {
      const g = new Game({ stage: campaignLikeStage(), loadout: { fcs, generator: 'balanced', legs: 'biped' }, viewportW: 1280, viewportH: 720 });
      g.sortie();
      expect(buildHudModel(g.state).lock.radius).toBe(g.state.lock.radiusCssPx);
      expect(buildHudModel(g.state).lock.radius).toBeCloseTo(ratio * 720, 9);
      g.setViewport(1920, 1080);
      const m = buildHudModel(g.state);
      expect(m.lock.radius).toBe(g.state.lock.radiusCssPx);
      expect(m.lock.radius).toBeCloseTo(ratio * 1080, 9);
      expect(m.width).toBe(1920);
      expect(m.height).toBe(1080);
      g.setViewport(3840, 1600); // 小さい方が D
      expect(buildHudModel(g.state).lock.radius).toBeCloseTo(ratio * 1600, 9);
    }
  });

  it('ロック状態は文字・進捗で区別できる (none / acquiring / locked)', () => {
    const g = newGame();
    const s = g.state;
    expect(buildHudModel(s).lock.phase).toBe('none');
    expect(buildHudModel(s).lock.label).toBe('');
    const e = enemy(s, 'G01');
    s.lock = { ...s.lock, state: 'acquiring', targetId: 'G01', progress: 0.625, elapsed: 0.5 };
    let m = buildHudModel(s);
    expect(m.lock.phase).toBe('acquiring');
    expect(m.lock.label).toBe('LOCKING 62%');
    expect(m.lock.progress).toBe(0.625);
    s.lock = { ...s.lock, state: 'locked', progress: 1 };
    m = buildHudModel(s);
    expect(m.lock.phase).toBe('locked');
    expect(m.lock.label).toBe('LOCKED');
    expect(m.lock.targetId).toBe('G01');
    expect(m.lock.targetName).toBe(ENEMIES.guard.name);
    // 対象が破壊されていれば表示しない (古いIDを残さない)
    e.alive = false;
    m = buildHudModel(s);
    expect(m.lock.phase).toBe('none');
    expect(m.target).toBeNull();
  });
});

describe('マーカー位置 = projectToScreen (FCSと同一の投影)', () => {
  it('カメラ正面の点は画面中心、右へずれた点は焦点距離の式どおり', () => {
    const g = newGame(1600, 900);
    const cam = g.state.camera;
    const p = add(cam.pos, cam.forward, 40);
    const c = placeMarker(cam, p);
    expect(c.onScreen).toBe(true);
    expect(c.x).toBeCloseTo(800, 6);
    expect(c.y).toBeCloseTo(450, 6);
    // 独立に式から: x = (right/depth) * (H/2)/tan(fov/2)
    const q = add(p, cam.right, 10);
    const r = placeMarker(cam, q);
    const scale = 450 / Math.tan((CAMERA.FOV_Y_DEG * Math.PI) / 360);
    expect(r.x).toBeCloseTo(800 + (10 / 40) * scale, 6);
    expect(r.y).toBeCloseTo(450, 6);
    // 上へ
    const u = placeMarker(cam, add(p, cam.up, 5));
    expect(u.y).toBeCloseTo(450 - (5 / 40) * scale, 6);
  });

  it('ロック対象マーカーは enemy.pos の投影に一致 (リサイズ後も)', () => {
    const g = newGame();
    const s = g.state;
    const e = enemy(s, 'G01');
    e.pos = add(s.camera.pos, s.camera.forward, 60);
    e.pos = add(e.pos, s.camera.right, 7);
    e.pos = add(e.pos, s.camera.up, -3);
    s.lock = { ...s.lock, state: 'acquiring', targetId: 'G01', progress: 0.3 };
    for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440]] as const) {
      g.setViewport(w, h);
      const m = buildHudModel(s);
      const sp = projectToScreen(s.camera, e.pos);
      expect(m.target).not.toBeNull();
      expect(m.target!.placement.onScreen).toBe(true);
      expect(m.target!.placement.x - w / 2).toBeCloseTo(sp.x, 9);
      expect(m.target!.placement.y - h / 2).toBeCloseTo(sp.y, 9);
    }
  });

  it('補正照準マーカーは fc.aimPoint の投影で、ロック完了前は出さない', () => {
    const g = newGame();
    const s = g.state;
    const e = enemy(s, 'G01');
    e.pos = add(s.camera.pos, s.camera.forward, 80);
    const aimPoint = add(e.pos, { x: 0, y: 1, z: 0 }, 4.5); // 現在位置より上 (重力補正)
    s.fc = {
      ...s.fc,
      status: 'solved',
      weapon: 'machinegun',
      targetId: 'G01',
      evaluatedAtSeconds: s.time,
      aimPoint,
      targetPosition: { ...e.pos },
    };
    // ロック取得中は補正が有効だと誤表示しない
    s.lock = { ...s.lock, state: 'acquiring', targetId: 'G01', progress: 0.5 };
    let m = buildHudModel(s);
    expect(m.aim).toBeNull();
    expect(m.aimStatusText).not.toContain('補正中');
    // ロック完了 + 解あり
    s.lock = { ...s.lock, state: 'locked', progress: 1 };
    m = buildHudModel(s);
    expect(m.aim).not.toBeNull();
    expect(m.aim!.status).toBe('solved');
    expect(m.aim!.label).toContain('補正中');
    const sp = projectToScreen(s.camera, aimPoint);
    expect(m.aim!.placement.x - 640).toBeCloseTo(sp.x, 9);
    expect(m.aim!.placement.y - 360).toBeCloseTo(sp.y, 9);
    // 対象マーカー(現在位置)と補正照準(上)は別位置
    expect(m.aim!.placement.y).toBeLessThan(m.target!.placement.y);
    // 補正解なし
    s.fc = { ...s.fc, status: 'no_solution', aimPoint: { ...e.pos } };
    m = buildHudModel(s);
    expect(m.aim!.status).toBe('no_solution');
    expect(m.aim!.label).toBe('補正解なし');
    expect(m.aimStatusText).toBe('補正解なし');
    // fc が inactive (計算前) なら補正中を出さない
    s.fc = { ...s.fc, status: 'inactive', aimPoint: null };
    m = buildHudModel(s);
    expect(m.aim).toBeNull();
    expect(m.aimStatusText).not.toContain('補正中');
    // 別対象の補正解は使わない
    s.fc = { ...s.fc, status: 'solved', targetId: 'T01', aimPoint };
    expect(buildHudModel(s).aim).toBeNull();
  });

  it('画面外(横・背後)は端の方向矢印。位置は余白内、方向は対象側', () => {
    const g = newGame(1280, 720);
    const cam = g.state.camera;
    const inset = HUD_CONST.EDGE_INSET;
    const right = placeMarker(cam, add(add(cam.pos, cam.forward, 10), cam.right, 200));
    expect(right.onScreen).toBe(false);
    expect(right.x).toBeGreaterThan(640);
    expect(right.x).toBeLessThanOrEqual(1280 - inset.x + 1e-6);
    expect(right.angle).toBeGreaterThan(0.9 * (Math.PI / 2) - 0.2);
    const left = placeMarker(cam, add(add(cam.pos, cam.forward, 10), cam.right, -200));
    expect(left.x).toBeLessThan(640);
    expect(left.angle).toBeLessThan(0);
    // 背後(左寄り)
    const behind = placeMarker(cam, add(add(cam.pos, cam.forward, -30), cam.right, -5));
    expect(behind.onScreen).toBe(false);
    expect(behind.inFront).toBe(false);
    expect(behind.x).toBeGreaterThanOrEqual(inset.x - 1e-6);
    expect(behind.x).toBeLessThanOrEqual(1280 - inset.x + 1e-6);
    expect(behind.y).toBeGreaterThanOrEqual(inset.y - 1e-6);
    expect(behind.y).toBeLessThanOrEqual(720 - inset.y + 1e-6);
    expect(behind.x).toBeLessThan(640);
    // 真後ろ・真上でも有限
    const dead = placeMarker(cam, add(cam.pos, cam.forward, -30));
    expect(Number.isFinite(dead.x) && Number.isFinite(dead.y) && Number.isFinite(dead.angle)).toBe(true);
    // 画面外でもロックは解除されない (モデルは state を書き換えない)
    const s = g.state;
    const e = enemy(s, 'G01');
    e.pos = add(add(cam.pos, cam.forward, -30), cam.right, -5);
    s.lock = { ...s.lock, state: 'locked', targetId: 'G01', progress: 1 };
    const m = buildHudModel(s);
    expect(m.target!.placement.onScreen).toBe(false);
    expect(m.lock.phase).toBe('locked');
    expect(s.lock.state).toBe('locked');
  });
});

describe('表示値 = state (HUD専用の架空値なし)', () => {
  it('HP / EN / 武器 / 残弾', () => {
    const g = newGame();
    const s = g.state;
    s.player.hp = 734.2;
    s.player.en = 35.99;
    s.player.ammo.machinegun = 245;
    s.player.ammo.missile = 9;
    let m = buildHudModel(s);
    expect(m.hp.value).toBe(735); // 切り上げ (0表示は本当に0のときだけ)
    expect(m.hp.max).toBe(PLAYER.MAX_HP);
    expect(m.hp.ratio).toBeCloseTo(734.2 / PLAYER.MAX_HP, 12);
    expect(m.en.value).toBe(35); // 切り捨て (36表示=QB可能)
    expect(m.en.max).toBe(s.stats.maxEn);
    expect(m.en.low).toBe(true);
    expect(m.weapons.map((w) => w.selected)).toEqual([true, false, false]);
    expect(m.weapons[0].ammoText).toBe(`245/${WEAPONS.machinegun.totalAmmo}`);
    expect(m.weapons[2].ammoText).toBe(`9/${WEAPONS.missile.totalAmmo}`);
    expect(m.weapons[1].ammoText).toBe('弾数無制限');
    expect(m.weapons[1].subText).toBe(`1射 ${WEAPONS.beam.enCost} EN`);
    s.player.weapon = 'beam';
    s.player.ammo.machinegun = 0;
    s.player.en = 36;
    m = buildHudModel(s);
    expect(m.weapons.map((w) => w.selected)).toEqual([false, true, false]);
    expect(m.weapons[0].empty).toBe(true);
    expect(m.weapons[0].subText).toBe('弾切れ');
    expect(m.en.low).toBe(false);
    expect(m.en.value).toBe(36);
    expect(fmtEn(0)).toBe(0);
    expect(fmtHp(0)).toBe(0);
    expect(fmtHp(0.2)).toBe(1);
  });

  it('移動モードとQB表示 (READY / COOLDOWN / EN不足)', () => {
    const g = newGame();
    const s = g.state;
    const mv = s.player.mv;
    let m = buildHudModel(s).movement;
    expect(m).toMatchObject({ mode: 'WALK', qb: 'READY', qbText: 'READY', qbCooldown: 0, vertical: '接地' });
    mv.horizontalMode = 'glide';
    mv.verticalMode = 'falling';
    mv.qbCooldownRemaining = 0.42;
    m = buildHudModel(s).movement;
    expect(m.mode).toBe('GLIDE');
    expect(m.vertical).toBe('落下');
    expect(m.qb).toBe('COOLDOWN');
    expect(m.qbText).toBe('COOLDOWN 0.4s');
    expect(m.qbCooldown).toBe(0.42);
    mv.horizontalMode = 'quickboost';
    mv.qbCooldownRemaining = 0;
    s.player.en = 20;
    m = buildHudModel(s).movement;
    expect(m.mode).toBe('QB');
    expect(m.qb).toBe('EN不足');
    s.player.en = 36;
    expect(buildHudModel(s).movement.qb).toBe('READY');
  });

  it('左Ctrl(ブレーキ)を押している間は新しいQBが不成立 (SPEC §7.3) なので READY と出さない。実際の Q 押下の結果と一致する', () => {
    const tryQb = (g: Game): boolean => {
      const n = g.state.player.mv.qbSuccessCount;
      g.input.qb = true;
      g.step();
      g.input.qb = false;
      g.step();
      return g.state.player.mv.qbSuccessCount > n;
    };
    // Ctrl 押下中: 表示は BRAKE。実際にも QB は成立せず、ENも消費しない
    const g = newGame();
    g.input.ctrl = true;
    g.step();
    let m = buildHudModel(g.state).movement;
    expect(m.qb).toBe('BRAKE');
    expect(m.qbText).toBe('BRAKE Ctrl解除');
    expect(m.qbCooldown).toBe(0);
    const en = g.state.player.en;
    expect(tryQb(g)).toBe(false);
    expect(g.state.player.en).toBeGreaterThanOrEqual(en);
    expect(g.state.player.mv.qbLastStartedAt).toBeNull(); // 待ち時間も更新しない
    // 離せば READY に戻り、実際に成立する
    g.input.ctrl = false;
    g.step();
    m = buildHudModel(g.state).movement;
    expect(m).toMatchObject({ qb: 'READY', qbText: 'READY' });
    expect(tryQb(g)).toBe(true);
    // 表示 READY と実際の成否が、Ctrl/EN/待ち時間の全組み合わせで一致する
    for (const ctrl of [false, true])
      for (const en2 of [0, 35.9, 36, 120])
        for (const cooling of [false, true]) {
          const h = newGame();
          h.state.player.en = en2;
          if (cooling) {
            h.state.player.mv.qbLastStartedAt = h.state.time - 0.2;
            h.state.player.mv.qbCooldownRemaining = 0.8;
          }
          h.input.ctrl = ctrl;
          h.step();
          const label = buildHudModel(h.state).movement.qb;
          const ok = tryQb(h);
          expect(label === 'READY', `ctrl=${ctrl} en=${en2} cooling=${cooling} label=${label}`).toBe(ok);
          if (label !== 'READY') expect(['COOLDOWN', 'EN不足', 'BRAKE']).toContain(label);
        }
    // 待ち時間・EN不足が理由のときは、その理由が優先して表示される (Ctrl 併用でも)
    const h2 = newGame();
    h2.input.ctrl = true;
    h2.state.player.en = 10;
    h2.step();
    expect(buildHudModel(h2.state).movement.qb).toBe('EN不足');
  });

  it('制御砲台の破壊数 pip の数は STAGE.CONTROLS_REQUIRED から作る (直書きの 6 を持たない)', () => {
    const src = readFileSync(new URL('../src/ui/hud.ts', import.meta.url), 'utf8');
    expect(src).toContain('STAGE.CONTROLS_REQUIRED');
    expect(src).not.toMatch(/i < 6;/);
  });

  it('通知: 未ロックでミサイル(NO LOCK) / EN不足 / 弾切れ / 補正解なし は一定時間だけ', () => {
    const g = newGame();
    const s = g.state;
    s.time = 10;
    s.notices.noLockAt = 9.5;
    s.notices.noEnAt = 9.9;
    s.notices.noAmmoAt = 5;
    s.notices.noSolutionAt = 10;
    const m = buildHudModel(s);
    expect(m.notices.map((n) => n.kind)).toEqual(['noSolution', 'noEn', 'noLock']);
    expect(m.notices.find((n) => n.kind === 'noLock')!.text).toContain('NO LOCK');
    expect(m.notices.some((n) => n.kind === 'noAmmo')).toBe(false);
    s.time = 10 + HUD_CONST.NOTICE_SECONDS + 0.01;
    expect(buildHudModel(s).notices).toHaveLength(0);
  });

  it('射撃予告: telegraph>0 の生存敵だけ', () => {
    const g = newGame();
    const s = g.state;
    const e = enemy(s, 'G01');
    e.pos = add(s.camera.pos, s.camera.forward, 50);
    e.telegraph = 0.4;
    let m = buildHudModel(s);
    expect(m.telegraphs).toHaveLength(1);
    expect(m.telegraphs[0].id).toBe('G01');
    expect(m.telegraphs[0].progress).toBe(0.4);
    expect(m.telegraphs[0].placement.onScreen).toBe(true);
    e.alive = false;
    m = buildHudModel(s);
    expect(m.telegraphs).toHaveLength(0);
  });
});

describe('被弾方向 (カメラ基準)', () => {
  it('dirToSource をカメラ前方基準の角度にする。視点を回すと角度が変わる', () => {
    const g = newGame();
    const s = g.state;
    s.time = 3;
    // yaw=0: forward=-Z, right=+X
    s.damageIndicators = [
      { time: 3, dirToSource: { x: 0, y: 0, z: -1 }, damage: 18 },
      { time: 3, dirToSource: { x: 1, y: 0, z: 0 }, damage: 18 },
      { time: 3, dirToSource: { x: -1, y: 0, z: 0 }, damage: 18 },
      { time: 3, dirToSource: { x: 0, y: 0, z: 1 }, damage: 18 },
    ];
    let m = buildHudModel(s);
    expect(m.wedges.map((w) => w.angle)).toHaveLength(4);
    expect(m.wedges[0].angle).toBeCloseTo(0, 9);
    expect(m.wedges[1].angle).toBeCloseTo(Math.PI / 2, 9);
    expect(m.wedges[2].angle).toBeCloseTo(-Math.PI / 2, 9);
    expect(Math.abs(m.wedges[3].angle)).toBeCloseTo(Math.PI, 9);
    // 左へ90度向く (yaw += π/2 → forward = -X)。-X にいる敵が正面になる
    g.look(-(Math.PI / 2) / CAMERA.SENSITIVITY, 0);
    m = buildHudModel(s);
    expect(m.wedges[2].angle).toBeCloseTo(0, 6);
    expect(m.wedges[0].angle).toBeCloseTo(Math.PI / 2, 6); // -Z は右手側
  });

  it('表示時間を過ぎた指標は消える。フラッシュは控えめ', () => {
    const g = newGame();
    const s = g.state;
    s.time = 5;
    s.damageIndicators = [
      { time: 5, dirToSource: { x: 0, y: 0, z: -1 }, damage: 40 },
      { time: 5 - HUD_CONST.DAMAGE_SHOW_SECONDS - 0.1, dirToSource: { x: 1, y: 0, z: 0 }, damage: 40 },
    ];
    const m = buildHudModel(s);
    expect(m.wedges).toHaveLength(1);
    expect(m.flashAlpha).toBeGreaterThan(0);
    expect(m.flashAlpha).toBeLessThanOrEqual(HUD_CONST.FLASH_MAX_ALPHA + 1e-12);
    s.time = 5 + HUD_CONST.FLASH_SECONDS + 0.01;
    expect(buildHudModel(s).flashAlpha).toBe(0);
    // 垂直方向のみの被弾は方位なし (ウェッジ無し、クラッシュしない)
    s.damageIndicators = [{ time: s.time, dirToSource: { x: 0, y: 1, z: 0 }, damage: 10 }];
    expect(buildHudModel(s).wedges).toHaveLength(0);
  });
});

describe('制御砲台・次の目標・隔壁・脱出 (実際の updateProgress と接続)', () => {
  it('次の目標は未破壊で最小の controlIndex。方向と距離は位置から', () => {
    const g = newGame();
    const s = g.state;
    let m = buildHudModel(s);
    expect(m.controls).toHaveLength(6);
    expect(m.controls.filter((c) => c.isNext).map((c) => c.id)).toEqual(['T01']);
    expect(m.next.kind).toBe('control');
    expect(m.next.id).toBe('T01');
    expect(m.next.text).toContain('T01');
    expect(m.next.text).toContain('テスト隔壁1');
    const t1 = enemy(s, 'T01');
    expect(m.next.distance).toBeCloseTo(Math.hypot(t1.pos.x - s.player.pos.x, t1.pos.y - s.player.pos.y, t1.pos.z - s.player.pos.z), 9);
    // T01 を破壊 → 次は T02、隔壁B1が開く
    t1.alive = false;
    t1.hp = 0;
    g.step();
    expect(s.objective.openBarrierIds).toEqual(['B1']);
    m = buildHudModel(s);
    expect(m.mission.controlsDestroyed).toBe(1);
    expect(m.mission.controlsRequired).toBe(6);
    expect(m.mission.barriers.find((b) => b.id === 'B1')!.open).toBe(true);
    expect(m.mission.barriers.find((b) => b.id === 'B2')!.open).toBe(false);
    expect(m.controls).toHaveLength(5);
    expect(m.next.id).toBe('T02');
    expect(m.mission.gateOpen).toBe(false);
    expect(m.escape).toBeNull();
  });

  it('方位ラベル: 8方位 (前方/右前/右/右後/後方/左後/左/左前)', () => {
    const g = newGame();
    const cam = g.state.camera;
    const from = g.state.player.pos;
    const at = (deg: number): string => {
      const a = (deg * Math.PI) / 180; // 0=前方, +で右
      const f = { x: cam.right.z, y: 0, z: -cam.right.x }; // 水平前方
      const d = { x: f.x * Math.cos(a) + cam.right.x * Math.sin(a), y: 0, z: f.z * Math.cos(a) + cam.right.z * Math.sin(a) };
      return bearingOf(cam, from, add(from, d, 50)).label;
    };
    expect([0, 45, 90, 135, 180, -135, -90, -45].map(at)).toEqual(['前方', '右前', '右', '右後', '後方', '左後', '左', '左前']);
    expect(bearingAngle(cam, { x: 0, y: 5, z: 0 })).toBeNull();
  });

  it('6体全て破壊 → 最終ゲート開放 → 脱出可能表示 → 脱出領域でクリア (結果画面の値も state 由来)', () => {
    const g = newGame();
    const s = g.state;
    const msgs = new HudMessages();
    expect(msgs.update(s)).toHaveLength(0);
    for (let i = 1; i <= 6; i++) {
      const e = enemy(s, `T0${i}`);
      e.alive = false;
      e.hp = 0;
      g.step();
      const m = buildHudModel(s);
      expect(m.mission.controlsDestroyed).toBe(i);
    }
    expect(s.objective.gateOpen).toBe(true);
    const m = buildHudModel(s);
    expect(m.mission.gateOpen).toBe(true);
    expect(m.mission.gateText).toContain('脱出可能');
    expect(m.escape).not.toBeNull();
    expect(m.next.kind).toBe('escape');
    expect(m.controls).toHaveLength(0);
    const shown = msgs.update(s);
    expect(shown.filter((x) => x.kind === 'barrier')).toHaveLength(6);
    expect(shown.some((x) => x.kind === 'gate')).toBe(true);
    // 4秒(ゲーム時間)後に消える。一時停止(time不変)では消えない
    s.time += HUD_CONST.MESSAGE_SECONDS + 0.01;
    expect(msgs.update(s)).toHaveLength(0);
    // 生きた被害統計
    s.player.pos = { x: 105, y: 1.5, z: 0 };
    s.killCount = 7;
    s.damageTaken = 123.4;
    g.step();
    expect(s.mode).toBe('cleared');
    const r = buildResultModel(s);
    expect(r.cleared).toBe(true);
    expect(r.title).toBe('MISSION CLEAR');
    expect(r.reason).toContain('脱出');
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x.value]));
    expect(byLabel['撃破数']).toBe(`7 / ${s.enemies.length}`);
    expect(byLabel['制御砲台']).toBe('6 / 6');
    expect(byLabel['被ダメージ']).toBe('123');
    expect(byLabel['通過区画数']).toBe(`${s.progress.visitedSectorIds.length} / ${s.stage.sectors.length}`);
    expect(byLabel['経過時間']).toBe(formatTime(s.time));
  });

  it('HudMessages は再出撃(state差し替え)で履歴を初期化する', () => {
    const g = newGame();
    const msgs = new HudMessages();
    msgs.update(g.state);
    enemy(g.state, 'T01').alive = false;
    g.step();
    expect(msgs.update(g.state).map((m) => m.kind)).toEqual(['barrier']);
    g.retry();
    expect(msgs.update(g.state)).toHaveLength(0);
    expect(g.state.objective.openBarrierIds).toHaveLength(0);
  });
});

describe('結果画面 (失敗理由)', () => {
  it('HP0 で失敗 (実際の updateProgress)', () => {
    const g = newGame();
    g.state.player.hp = 0;
    g.step();
    expect(g.state.mode).toBe('failed');
    const r = buildResultModel(g.state);
    expect(r.cleared).toBe(false);
    expect(r.title).toBe('MISSION FAILED');
    expect(r.reason).toContain('HP');
  });
  it('転落で失敗', () => {
    const g = newGame();
    g.state.player.pos = { x: 0, y: -1000, z: 0 };
    g.step();
    expect(g.state.mode).toBe('failed');
    expect(buildResultModel(g.state).reason).toContain('転落');
  });
  it('HP0 と脱出が同時なら失敗が優先 (結果は失敗)', () => {
    const g = newGame();
    const s = g.state;
    for (let i = 1; i <= 6; i++) enemy(s, `T0${i}`).alive = false;
    s.player.pos = { x: 105, y: 1.5, z: 0 };
    s.player.hp = 0;
    g.step();
    expect(s.mode).toBe('failed');
    expect(buildResultModel(s).cleared).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 制御砲台マーカーの整理 (画面端に矢印とラベルが密集して読めない問題の対策)
// ---------------------------------------------------------------------------
function ctl(id: string, distance: number, pl: Partial<MarkerPlacement>, isNext = false): ControlView {
  return {
    id,
    distance,
    isNext,
    bearing: { angle: 0, index: 0, label: '前方', arrow: '↑' },
    placement: { x: 56, y: 300, onScreen: false, inFront: true, angle: -Math.PI / 2, depth: 100, ...pl },
  };
}

describe('制御砲台マーカーの整理 (密集の回避)', () => {
  const W = 1280;
  const H = 720;
  /** 実機で出ていた状態: 6体の制御砲台が全て左の画面端に近い位置へ (y がほぼ同じ) */
  const crowded = (): ControlView[] => [
    ctl('T15', 568, { y: 296 }),
    ctl('T08', 484, { y: 306 }),
    ctl('T11', 227, { y: 312 }),
    ctl('T03', 310, { y: 318 }, true),
    ctl('T14', 521, { y: 300 }),
    ctl('T06', 400, { y: 309 }),
  ];

  it('次の目標を必ず含み (先頭)、残りは近い順で合計 CONTROL_MARKERS_MAX 個まで', () => {
    const out = layoutControlMarkers(crowded(), W, H);
    expect(HUD_CONST.CONTROL_MARKERS_MAX).toBe(3);
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe('T03');
    expect(out[0].isNext).toBe(true);
    expect(out.slice(1).map((m) => m.id)).toEqual(['T11', 'T06']); // 227m, 400m (次の目標を除く近い順)
    // 遠いものは描かない
    expect(out.some((m) => m.id === 'T15' || m.id === 'T14' || m.id === 'T08')).toBe(false);
  });

  it('画面外の矢印は縦にずらして重ならず、端の余白の範囲内に収まる', () => {
    const inset = edgeInsetFor(W, H);
    const out = layoutControlMarkers(crowded(), W, H);
    for (let i = 0; i < out.length; i++) {
      expect(out[i].placement.y).toBeGreaterThanOrEqual(inset.y - 1e-6);
      expect(out[i].placement.y).toBeLessThanOrEqual(H - inset.y + 1e-6);
      for (let j = i + 1; j < out.length; j++) {
        const close = Math.abs(out[i].placement.x - out[j].placement.x) < HUD_CONST.LABEL_BOX.w && Math.abs(out[i].placement.y - out[j].placement.y) < HUD_CONST.LABEL_BOX.h;
        expect(close).toBe(false);
      }
    }
    // 入力 (投影から得た位置) は書き換えない
    const src = crowded();
    layoutControlMarkers(src, W, H);
    expect(src[0].placement.y).toBe(296);
  });

  it('画面内でラベルが重なるときはラベルだけを下へずらす (投影位置はそのまま)', () => {
    const a = ctl('T01', 50, { onScreen: true, x: 640, y: 200, angle: 0 }, true);
    const b = ctl('T02', 80, { onScreen: true, x: 700, y: 210, angle: 0 });
    const c = ctl('T03', 90, { onScreen: true, x: 900, y: 500, angle: 0 });
    const out = layoutControlMarkers([b, c, a], W, H);
    const byId = Object.fromEntries(out.map((m) => [m.id, m]));
    expect(byId.T01.labelDy).toBe(0);
    expect(byId.T02.labelDy).toBeGreaterThan(0);
    expect(byId.T03.labelDy).toBe(0);
    expect(byId.T02.placement.x).toBe(700);
    expect(byId.T02.placement.y).toBe(210);
  });

  it('制御砲台が3体以下なら全て描く。0体でも壊れない。max を変えられる', () => {
    expect(layoutControlMarkers([], W, H)).toEqual([]);
    expect(layoutControlMarkers(crowded().slice(0, 2), W, H)).toHaveLength(2);
    expect(layoutControlMarkers(crowded(), W, H, 1).map((m) => m.id)).toEqual(['T03']);
    expect(layoutControlMarkers(crowded(), W, H, 0)).toEqual([]);
  });

  it('画面端の余白は解像度に比例して拡大し、1280x720 では HUD_CONST.EDGE_INSET に一致する', () => {
    expect(hudUnit(1280, 720)).toBeCloseTo(12.24, 9);
    expect(edgeInsetFor(1280, 720)).toEqual(HUD_CONST.EDGE_INSET);
    const big = edgeInsetFor(1920, 1080);
    expect(big.x).toBeCloseTo(HUD_CONST.EDGE_INSET.x * 1.5, 9);
    expect(big.y).toBeCloseTo(HUD_CONST.EDGE_INSET.y * 1.5, 9);
    // 下限・上限 (CSS の --u = clamp(12px, 1.7vmin, 32px))
    expect(hudUnit(400, 300)).toBe(12);
    expect(hudUnit(4000, 3000)).toBe(32);
    // placeMarker の既定の余白は解像度に合わせた値
    const g = newGame(1920, 1080);
    const cam = g.state.camera;
    const far = placeMarker(cam, add(add(cam.pos, cam.forward, 10), cam.right, 500));
    expect(far.onScreen).toBe(false);
    expect(far.x).toBeLessThanOrEqual(1920 - big.x + 1e-6);
  });

  it('実際の HudModel: 6体の制御砲台が生きていても controlMarkers は最大3個で、次の目標を含む (controls は全て)', () => {
    const g = newGame();
    const m = buildHudModel(g.state);
    expect(m.controls).toHaveLength(6);
    expect(m.controlMarkers.length).toBeLessThanOrEqual(HUD_CONST.CONTROL_MARKERS_MAX);
    expect(m.controlMarkers[0].id).toBe('T01');
    expect(m.controlMarkers[0].isNext).toBe(true);
    // 破壊済みの砲台は出ない。次の目標が変わる
    enemy(g.state, 'T01').alive = false;
    g.step();
    const m2 = buildHudModel(g.state);
    expect(m2.controlMarkers.some((x) => x.id === 'T01')).toBe(false);
    expect(m2.controlMarkers[0].id).toBe('T02');
  });
});

describe('整形', () => {
  it('経過時間 mm:ss.s', () => {
    expect(formatTime(0)).toBe('00:00.0');
    expect(formatTime(65.25)).toBe('01:05.3');
    expect(formatTime(Number.NaN)).toBe('00:00.0');
  });
});
