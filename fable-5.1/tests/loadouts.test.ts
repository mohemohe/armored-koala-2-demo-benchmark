/**
 * 18 通りの機体構成（FCS 3 × ジェネレーター 3 × 脚部 2）を実際の Game で出撃させ、
 * 実効値・QB 移動量・ロック所要時間・EN 回復が仕様の式どおりになることを確認する。
 */
import { describe, expect, it } from 'vitest';
import { FCS, GENERATORS, LEGS, PLAYER, computeEffectiveStats } from '../src/params';
import { Game } from '../src/sim/game';
import type { FcsKind, GeneratorKind, LegsKind, Loadout } from '../src/types';
import { emptyInput } from '../src/types';
import { makeFlatStage } from './helpers/testStage';

const FCS_KINDS: FcsKind[] = ['wide', 'medium', 'narrow'];
const GEN_KINDS: GeneratorKind[] = ['capacity', 'balanced', 'recovery'];
const LEG_KINDS: LegsKind[] = ['biped', 'quadruped'];

function allLoadouts(): Loadout[] {
  const out: Loadout[] = [];
  for (const fcs of FCS_KINDS) for (const generator of GEN_KINDS) for (const legs of LEG_KINDS) out.push({ fcs, generator, legs });
  return out;
}

describe('18 通りの機体構成', () => {
  it('実効値が仕様の式どおり（最大EN×基本回復率=1800、回復率×脚部倍率、ロック時間÷ロック速度倍率）', () => {
    for (const l of allLoadouts()) {
      const s = computeEffectiveStats(l);
      const gen = GENERATORS[l.generator];
      const legs = LEGS[l.legs];
      expect(gen.maxEn * gen.regen).toBe(1800);
      expect(s.maxEn).toBe(gen.maxEn);
      expect(s.regenPerSecond).toBeCloseTo(gen.regen * legs.regenMul, 9);
      expect(s.lockSeconds).toBeCloseTo(FCS.kinds[l.fcs].lockSeconds / legs.lockSpeedMul, 9);
      expect(s.horizontalSpeedMultiplier).toBe(legs.speedMul);
    }
    // 仕様の例: 中範囲・均衡・4脚 → 120 / 11.25 / 約0.533
    const ex = computeEffectiveStats({ fcs: 'medium', generator: 'balanced', legs: 'quadruped' });
    expect(ex.maxEn).toBe(120);
    expect(ex.regenPerSecond).toBeCloseTo(11.25, 9);
    expect(ex.lockSeconds).toBeCloseTo(0.8 / 1.5, 9);
  });

  it('全構成で出撃でき、QB 移動量・ロック所要時間・EN 回復が構成の実効値に従う', () => {
    const results: string[] = [];
    for (const l of allLoadouts()) {
      const stage = makeFlatStage({
        enemies: [{ id: 'tgt', kind: 'target', position: [0, 3, -60], yaw: 0, sectorId: 'flat', isGateControl: false, velocity: [0, 0, 0] }],
      });
      const game = new Game({ stage, loadout: l, seed: 1, viewport: { width: 1280, height: 720 }, buildNav: false });
      expect(game.launch()).toBe(true);
      const stats = computeEffectiveStats(l);
      const s0 = game.getSnapshot();
      expect(s0.loadout).toEqual(l);
      expect(s0.player.en).toBe(stats.maxEn);
      expect(s0.effectiveStats.lockSeconds).toBeCloseTo(stats.lockSeconds, 9);

      // ロック: 標的を画面中央に置いて所要時間で完了する
      const dt = 1 / 120;
      let t = 0;
      let lockedAt: number | null = null;
      while (t < 3) {
        const info = game.targetInfo('tgt')!;
        for (let k = 0; k < 3; k++) {
          game.camera.lookAt(info.center);
          game.camera.follow(game.player.pos, game.stage.world);
        }
        game.setInput(emptyInput());
        game.advance(dt);
        t += dt;
        if (game.getSnapshot().lock.state === 'locked') {
          lockedAt = t;
          break;
        }
      }
      expect(lockedAt).not.toBeNull();
      // 候補取得の最初のサブステップから所要時間で完了（±2 サブステップ）
      expect(Math.abs((lockedAt as number) - stats.lockSeconds)).toBeLessThanOrEqual(2 * dt + 1e-9);

      // QB: 0.75 秒で 42.6 × 倍率、EN は 36 消費、0.75 秒後から回復
      game.camera.yaw = 0;
      game.camera.pitch = 0;
      const p0 = game.player.pos.slice() as [number, number, number];
      const en0 = game.player.en;
      game.setInput({ ...emptyInput(), qbPressed: true, moveForward: 1 });
      game.advance(dt);
      expect(game.player.en).toBeCloseTo(en0 - PLAYER.qb.cost, 9);
      expect(game.getSnapshot().player.movement.horizontalMode).toBe('quickboost');
      for (let i = 1; i < 90; i++) {
        game.setInput(emptyInput());
        game.advance(dt);
      }
      const p1 = game.player.pos;
      const dist = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
      expect(dist).toBeCloseTo(42.6 * stats.horizontalSpeedMultiplier, 3);
      expect(game.player.en).toBeCloseTo(en0 - PLAYER.qb.cost, 9); // 0.75 秒ちょうどまでは回復しない
      const snap = game.getSnapshot();
      expect(snap.player.movement.horizontalMode).toBe('glide');
      expect(snap.player.movement.glideEnabled).toBe(true);
      expect(Math.hypot(snap.player.velocity[0], snap.player.velocity[2])).toBeCloseTo(PLAYER.glideGroundSpeed * stats.horizontalSpeedMultiplier, 6);
      // さらに 1 秒: 回復率 × 1 秒
      for (let i = 0; i < 120; i++) {
        game.setInput(emptyInput());
        game.advance(dt);
      }
      expect(game.player.en).toBeCloseTo(Math.min(stats.maxEn, en0 - PLAYER.qb.cost + stats.regenPerSecond * 1.0), 6);
      results.push(`${l.fcs}/${l.generator}/${l.legs}: lock=${(lockedAt as number).toFixed(4)}s (spec ${stats.lockSeconds.toFixed(4)}) qb0.75s=${dist.toFixed(3)}m en=${game.player.en.toFixed(2)}`);
    }
    console.log(results.join('\n'));
    expect(results.length).toBe(18);
  });
});
