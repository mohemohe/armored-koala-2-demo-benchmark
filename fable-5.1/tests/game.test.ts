/**
 * Game 統括の統合試験: 出撃・再出撃の初期化、一時停止、隔壁/ゲート/クリア/失敗、スナップショット。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT, OBJECTIVE, PLAYER, WEAPONS } from '../src/params';
import { Game } from '../src/sim/game';
import type { EnemyDef, InputFrame, SolidDef, StageData, Vec3 } from '../src/types';
import { emptyInput } from '../src/types';
import { box, makeFlatStage } from './helpers/testStage';

const VIEW = { width: 1280, height: 720 };

function frameInput(partial: Partial<InputFrame> = {}): InputFrame {
  return { ...emptyInput(), ...partial };
}

/** 6 つの制御砲台と隔壁、最終ゲート、脱出領域を持つ平地ステージ */
function makeObjectiveStage(): StageData {
  const turrets: EnemyDef[] = [];
  const barriers: StageData['barriers'] = [];
  const solids: SolidDef[] = [];
  for (let i = 0; i < 6; i++) {
    const id = `t0${i + 1}`;
    const z = -30 - i * 12;
    turrets.push({ id, kind: 'turret', position: [12, 0, z], yaw: 0, sectorId: 'flat', isGateControl: true, controlsBarrierId: `B${i + 1}` });
    barriers.push({ id: `B${i + 1}`, box: box([40 + i * 3, 0, -5], [41 + i * 3, 6, 5]), controlTurretId: id, fromSectorId: 'flat', toSectorId: 'flat', label: `隔壁${i + 1}` });
  }
  // 非制御の敵も数体（合計は 45 でなくてよい: 統括の判定は制御砲台数のみに依存）
  const stage = makeFlatStage({ enemies: turrets, extraSolids: solids, start: [0, 0, 0], yaw: 0 });
  stage.barriers = barriers;
  stage.gate = { id: 'G', box: box([-5, 0, 60], [5, 6, 61]) };
  stage.exitZone = box([-5, -1, 62], [5, 10, 70]);
  return stage;
}

function newGame(stage: StageData, loadout = DEFAULT_LOADOUT): Game {
  const g = new Game({ stage, loadout, seed: 1234, viewport: VIEW, buildNav: false });
  g.launch();
  return g;
}

/**
 * 指定の敵をロックし、マシンガンで撃破するまで進める（最大 maxSeconds）。
 * 砲台は撃ち返してくるので、試験の目的（目標進行の検証）のため毎フレーム HP を満タンに戻す（試験専用の内部操作）。
 */
function destroyWithMachinegun(game: Game, enemyId: string, maxSeconds = 20): number {
  const dt = 1 / 60;
  let t = 0;
  while (t < maxSeconds) {
    game.player.hp = PLAYER.maxHp;
    const info = game.targetInfo(enemyId);
    if (!info || !info.alive) return t;
    // TPS カメラは注視方向で位置が変わるため、対象が画面中央に来るまで注視と追従を収束させる
    for (let k = 0; k < 4; k++) {
      game.camera.lookAt(info.center);
      game.camera.follow(game.player.pos, game.stage.world);
    }
    const snap = game.getSnapshot();
    const fire = snap.lock.state === 'locked' && snap.lock.targetId === enemyId;
    game.setInput(frameInput({ fireDown: fire }));
    game.advance(dt);
    game.drainEvents();
    t += dt;
  }
  return t;
}

describe('Game: 初期化と再出撃', () => {
  it('出撃時の初期値と、再出撃での完全初期化', () => {
    const stage = makeObjectiveStage();
    const game = newGame(stage);
    const s0 = game.getSnapshot();
    expect(s0.state).toBe('playing');
    expect(s0.elapsedSeconds).toBe(0);
    expect(s0.player.hp).toBe(PLAYER.maxHp);
    expect(s0.player.en).toBe(s0.effectiveStats.maxEn);
    expect(s0.player.ammo).toEqual({ machinegun: WEAPONS.machinegun.ammo, missile: WEAPONS.missile.ammo });
    expect(s0.player.weapon).toBe('machinegun');
    expect(s0.loadout).toEqual(DEFAULT_LOADOUT);
    expect(s0.objective.controlsDestroyed).toBe(0);
    expect(s0.objective.gateOpen).toBe(false);
    expect(s0.recentPlayerShots).toEqual([]);
    expect(s0.version).toBe('AK2-1.2-candidate');

    // 何かしてから再出撃
    game.setInput(frameInput({ qbPressed: true, moveForward: 1 }));
    for (let i = 0; i < 30; i++) game.advance(1 / 60);
    for (let i = 0; i < 30; i++) {
      game.setInput(frameInput({ fireDown: true }));
      game.advance(1 / 60);
    }
    const s1 = game.getSnapshot();
    expect(s1.player.movement.qbSuccessfulCount).toBe(1);
    expect(s1.player.ammo.machinegun).toBeLessThan(WEAPONS.machinegun.ammo);
    expect(s1.elapsedSeconds).toBeGreaterThan(0.9);
    game.player.takeDamage(300);
    destroyWithMachinegun(game, 't01');
    expect(game.getSnapshot().objective.controlsDestroyed).toBe(1);
    expect(game.getSnapshot().objective.openBarrierIds).toEqual(['B1']);

    // 再出撃（クリア/失敗でなくても launch() で初期化されることを検証するため、一度失敗させる）
    game.player.takeDamage(10000);
    game.advance(1 / 120);
    expect(game.state).toBe('failed');
    expect(game.launch()).toBe(true);
    const s2 = game.getSnapshot();
    expect(s2.state).toBe('playing');
    expect(s2.elapsedSeconds).toBe(0);
    expect(s2.player.hp).toBe(PLAYER.maxHp);
    expect(s2.player.en).toBe(s2.effectiveStats.maxEn);
    expect(s2.player.ammo.machinegun).toBe(WEAPONS.machinegun.ammo);
    expect(s2.player.movement.qbSuccessfulCount).toBe(0);
    expect(s2.player.movement.qbLastStartedAtSeconds).toBeNull();
    expect(s2.player.movement.glideEnabled).toBe(false);
    expect(s2.player.movement.horizontalMode).toBe('walk');
    expect(s2.recentPlayerShots).toEqual([]);
    expect(s2.objective.controlsDestroyed).toBe(0);
    expect(s2.objective.openBarrierIds).toEqual([]);
    expect(s2.enemies.every((e) => e.alive && e.shotsFired === 0 && e.lastShotAtSeconds === null && !e.alert)).toBe(true);
    expect(s2.enemies.map((e) => e.id)).toEqual(s0.enemies.map((e) => e.id));
    expect(s2.player.position).toEqual(s0.player.position);
    expect(s2.lock.state).toBe('none');
    expect(s2.fireControl.status).toBe('inactive');
    // 隔壁のコライダーが復元されている（レイが遮られる）
    const b = stage.barriers[0].box;
    const hit = game.stage.world.raycast([b.min[0] - 1, 3, 0], [1, 0, 0], 1.5);
    expect(hit).not.toBeNull();
  });

  it('スナップショットはコピーであり、編集してもゲーム状態は変わらない', () => {
    const game = newGame(makeObjectiveStage());
    const s = game.getSnapshot();
    s.player.hp = 1;
    s.player.position[0] = 999;
    s.enemies[0].alive = false;
    s.objective.openBarrierIds.push('X');
    (s.recentPlayerShots as unknown[]).push({});
    const s2 = game.getSnapshot();
    expect(s2.player.hp).toBe(PLAYER.maxHp);
    expect(s2.player.position[0]).toBe(0);
    expect(s2.enemies[0].alive).toBe(true);
    expect(s2.objective.openBarrierIds).toEqual([]);
    expect(s2.recentPlayerShots).toEqual([]);
    // NaN/Infinity を含まない
    const json = JSON.stringify(s2);
    expect(json.includes('null') || true).toBe(true);
    const walk = (o: unknown): void => {
      if (typeof o === 'number') expect(Number.isFinite(o)).toBe(true);
      else if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') Object.values(o as Record<string, unknown>).forEach(walk);
    };
    walk(s2);
  });
});

describe('Game: 一時停止', () => {
  it('一時停止中は時間・位置・EN・QB噴射・ロック・敵タイマーが進まず、復帰後に一括加算されない', () => {
    const game = newGame(makeObjectiveStage());
    // QB を発動し噴射中に一時停止
    game.setInput(frameInput({ qbPressed: true, moveForward: 1 }));
    game.advance(0.05);
    const before = game.getSnapshot();
    expect(before.player.movement.horizontalMode).toBe('quickboost');
    expect(game.pause()).toBe(true);
    expect(game.state).toBe('paused');
    game.setInput(frameInput({ moveForward: 1, fireDown: true }));
    game.advance(3.0);
    game.advance(3.0);
    const during = game.getSnapshot();
    expect(during.elapsedSeconds).toBe(before.elapsedSeconds);
    expect(during.player.position).toEqual(before.player.position);
    expect(during.player.en).toBe(before.player.en);
    expect(during.player.movement.qbImpulseRemainingSeconds).toBe(before.player.movement.qbImpulseRemainingSeconds);
    expect(during.player.ammo.machinegun).toBe(before.player.ammo.machinegun);
    expect(during.enemies.every((e) => e.shotsFired === 0)).toBe(true);
    expect(game.resume()).toBe(true);
    // 復帰直後に Q が押されたままでも新しい押下として扱わない（入力層で解除される想定だが、ゲーム側も edge を要求する）
    game.setInput(frameInput({ qbPressed: false }));
    game.advance(1 / 60);
    const after = game.getSnapshot();
    expect(after.elapsedSeconds).toBeCloseTo(before.elapsedSeconds + 1 / 60, 6);
    expect(after.player.movement.qbSuccessfulCount).toBe(1);
    // 噴射の残り時間が一時停止の分だけ減っていない
    expect(after.player.movement.qbImpulseRemainingSeconds).toBeCloseTo(before.player.movement.qbImpulseRemainingSeconds - 1 / 60, 6);
  });
});

describe('Game: 目標進行、クリア、失敗', () => {
  it('制御砲台の破壊で対応する隔壁が開き、6体で最終ゲートが開き、脱出領域でクリア', () => {
    const stage = makeObjectiveStage();
    const game = newGame(stage);
    const ids = ['t01', 't02', 't03', 't04', 't05', 't06'];
    for (let i = 0; i < ids.length; i++) {
      const t = destroyWithMachinegun(game, ids[i], 30);
      expect(t).toBeLessThan(30);
      const s = game.getSnapshot();
      expect(s.objective.controlsDestroyed).toBe(i + 1);
      expect(s.objective.openBarrierIds).toContain(`B${i + 1}`);
      expect(s.objective.gateOpen).toBe(i === 5);
      // 開いた隔壁のコライダーが消えている
      const b = stage.barriers[i].box;
      expect(game.stage.world.raycast([b.min[0] - 1, 3, 0], [1, 0, 0], 1.5)).toBeNull();
      // 未開放の隔壁はまだ塞がっている
      if (i < 5) {
        const nb = stage.barriers[i + 1].box;
        expect(game.stage.world.raycast([nb.min[0] - 1, 3, 0], [1, 0, 0], 1.5)).not.toBeNull();
      }
    }
    // 未開放時のゲート接触ではクリアしない（既に開いているので、ここでは脱出領域に入ってクリア）
    expect(game.state).toBe('playing');
    game.player.pos = [0, 0, 65];
    game.setInput(frameInput());
    game.advance(1 / 120);
    expect(game.state).toBe('cleared');
    // クリア後は更新が止まる
    const t = game.time;
    game.advance(1);
    expect(game.time).toBe(t);
  });

  it('ゲート未開放では脱出領域に入ってもクリアしない', () => {
    const game = newGame(makeObjectiveStage());
    game.player.pos = [0, 0, 65];
    game.advance(0.1);
    expect(game.state).toBe('playing');
  });

  it('同じ更新でクリア条件と HP0 が成立したら失敗を優先', () => {
    const stage = makeObjectiveStage();
    const game = newGame(stage);
    for (const id of ['t01', 't02', 't03', 't04', 't05', 't06']) destroyWithMachinegun(game, id, 30);
    expect(game.getSnapshot().objective.gateOpen).toBe(true);
    game.player.pos = [0, 0, 65];
    game.player.takeDamage(PLAYER.maxHp);
    game.advance(1 / 120);
    expect(game.state).toBe('failed');
    expect(game.failReason).toBe('hp');
  });

  it('ステージ外への落下で失敗', () => {
    const game = newGame(makeObjectiveStage());
    game.player.pos = [0, game.stageData.killY - 1, 0];
    game.advance(1 / 120);
    expect(game.state).toBe('failed');
    expect(game.failReason).toBe('fall');
  });

  it('区画の通過を記録する', () => {
    const stage = makeFlatStage();
    stage.sectors = [
      { id: 'A', name: 'A', kind: 'yard', bounds: [box([-300, -10, -300], [0, 200, 300])] },
      { id: 'B', name: 'B', kind: 'corridor', bounds: [box([0, -10, -300], [300, 200, 300])] },
    ];
    stage.start.sectorId = 'A';
    stage.start.position = [-10, 0, 0];
    stage.objectiveHints = { A: 'a', B: 'b' };
    const game = newGame(stage);
    expect(game.getSnapshot().stage.currentSectorId).toBe('A');
    expect(game.getSnapshot().stage.sectorCount).toBe(2);
    game.camera.yaw = -Math.PI / 2; // 前方 +X
    for (let i = 0; i < 180; i++) {
      game.setInput(frameInput({ moveForward: 1 }));
      game.advance(1 / 60);
    }
    const s = game.getSnapshot();
    expect(s.stage.currentSectorId).toBe('B');
    expect(s.stage.visitedSectorIds).toEqual(['A', 'B']);
  });
});

describe('Game: 描画頻度非依存', () => {
  const script = (game: Game, dt: number): Vec3 => {
    // 0.0s: QB 前方、0.5s: Shift、1.0s: Space 押し続け（飛行）、2.0s: 離す、3.0s まで
    let t = 0;
    let qbDone = false;
    let shiftDone = false;
    while (t < 3.0 - 1e-9) {
      const f = frameInput();
      if (!qbDone) {
        f.qbPressed = true;
        qbDone = true;
      }
      if (t >= 0.5 - 1e-9 && !shiftDone) {
        f.shiftPressed = true;
        shiftDone = true;
      }
      if (t >= 1.0 - 1e-9 && t < 2.0 - 1e-9) {
        f.spaceDown = true;
        if (t < 1.0 + dt - 1e-9) f.spacePressed = true;
      }
      game.setInput(f);
      game.advance(dt);
      t += dt;
    }
    const s = game.getSnapshot();
    return [s.player.position[0], s.player.position[2], s.player.en];
  };
  it('30/60/120fps で同じ入力列なら位置と EN が一致する', () => {
    const r120 = script(newGame(makeFlatStage()), 1 / 120);
    const r60 = script(newGame(makeFlatStage()), 1 / 60);
    const r30 = script(newGame(makeFlatStage()), 1 / 30);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(r60[i] - r120[i])).toBeLessThan(1e-6);
      expect(Math.abs(r30[i] - r120[i])).toBeLessThan(1e-6);
    }
  });
});

describe('Game: 制御砲台の数', () => {
  it('OBJECTIVE の定義が仕様値', () => {
    expect(OBJECTIVE.controlsRequired).toBe(6);
    expect(OBJECTIVE.totalEnemies).toBe(45);
  });
});
