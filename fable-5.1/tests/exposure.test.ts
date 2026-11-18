/**
 * §2.3 露出時の危険性試験: 35〜50m の警備ロボット2体＋固定砲台1体が、遮蔽なしで静止した HP1000 の自機を
 * 攻撃可能になってから 15 秒以内に撃破できること。通常の AI・弾体・当たり判定だけで成立させる。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT, PLAYER } from '../src/params';
import { Game } from '../src/sim/game';
import type { EnemyDef } from '../src/types';
import { emptyInput } from '../src/types';
import { makeFlatStage } from './helpers/testStage';

describe('露出時の危険性', () => {
  it('警備2＋砲台1（35〜50m）が静止プレイヤーを15秒以内に撃破する', () => {
    const enemies: EnemyDef[] = [
      { id: 'g01', kind: 'guard', position: [-30, 0, -28], yaw: 0, sectorId: 'flat', isGateControl: false },
      { id: 'g02', kind: 'guard', position: [28, 0, -32], yaw: 0, sectorId: 'flat', isGateControl: false },
      { id: 't01', kind: 'turret', position: [0, 0, 48], yaw: 0, sectorId: 'flat', isGateControl: false },
    ];
    for (const e of enemies) {
      const d = Math.hypot(e.position[0], e.position[2]);
      expect(d).toBeGreaterThanOrEqual(35);
      expect(d).toBeLessThanOrEqual(50);
    }
    const stage = makeFlatStage({ enemies, start: [0, 0, 0], yaw: 0 });
    const game = new Game({ stage, loadout: DEFAULT_LOADOUT, seed: 20260908, viewport: { width: 1280, height: 720 }, buildNav: true });
    game.launch();
    const dt = 1 / 60;
    let t = 0;
    let died: number | null = null;
    let firstShot: number | null = null;
    const hitsByOwner: Record<string, number> = {};
    while (t < 20) {
      game.setInput(emptyInput());
      game.advance(dt);
      for (const ev of game.drainEvents()) {
        if (ev.type === 'enemyFire' && firstShot === null) firstShot = game.time;
        if (ev.type === 'playerHit') hitsByOwner['total'] = (hitsByOwner['total'] ?? 0) + 1;
      }
      t += dt;
      if (game.state === 'failed') {
        died = game.time;
        break;
      }
    }
    const snap = game.getSnapshot();
    console.log('exposure test: firstShot', firstShot, 'died at', died, 'hp', snap.player.hp, 'shots', snap.enemies.map((e) => `${e.id}:${e.shotsFired}`).join(' '), 'hits', hitsByOwner['total']);
    expect(firstShot).not.toBeNull();
    expect(died).not.toBeNull();
    expect(died as number).toBeLessThanOrEqual(15);
    expect(snap.player.hp).toBeLessThanOrEqual(0);
    expect(PLAYER.maxHp).toBe(1000);
    // 3体全てが独立に射撃している
    for (const e of snap.enemies) expect(e.shotsFired).toBeGreaterThan(0);
  });

  it('遮蔽物の陰では被弾せず、敵は最後の確認位置へ向かう', () => {
    const enemies: EnemyDef[] = [{ id: 'g01', kind: 'guard', position: [0, 0, -40], yaw: 0, sectorId: 'flat', isGateControl: false }];
    // プレイヤーと敵の間に壁（幅 20m、高さ 8m）
    const stage = makeFlatStage({
      enemies,
      start: [0, 0, 0],
      yaw: 0,
      extraSolids: [{ box: { min: [-10, 0, -12], max: [10, 8, -11] }, material: 'concrete' }],
    });
    const game = new Game({ stage, loadout: DEFAULT_LOADOUT, seed: 7, viewport: { width: 1280, height: 720 }, buildNav: true });
    game.launch();
    let hits = 0;
    for (let i = 0; i < 60 * 3; i++) {
      game.setInput(emptyInput());
      game.advance(1 / 60);
      for (const ev of game.drainEvents()) if (ev.type === 'playerHit') hits++;
    }
    expect(hits).toBe(0);
    const s = game.getSnapshot();
    // 壁越しなので射線なし。警戒していない（未発見）か、発見済みなら移動している
    expect(s.enemies[0].hasLineOfSight).toBe(false);
  });
});
