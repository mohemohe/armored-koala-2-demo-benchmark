/**
 * 出撃地点の直線距離 (S01 遮蔽レーン): 出撃直後 (初期向き = 南) に Q を1回押すと、SPEC §7.2 / §11 の QB 移動量
 * (2脚 0.75秒で 42.6m / 4脚 34.08m) が壁に阻まれずにそのまま測れること。実際の Game (実ステージ buildStage()) を tick 実行して確認する。
 *   - 幾何: 出撃位置から初期向きの真っ直ぐ前方に、当たり判定(1.6x3.0x1.6m)が通れる障害物なしの直線が 50m 以上
 *           (幅4m・頭上6m以上の余裕つき)
 *   - QB: 無入力 (= カメラ水平前方) と 前進入力 の両方 × 2脚/4脚。QB開始から0.75秒後の水平移動量 (許容 ±0.05m)
 *   - 安全: 出撃直後から60秒放置しても被弾しない・敵弾が飛んでこない (開始地点は遮蔽されている)
 * SPEC の数値はここに直書きする (config.ts を読まない)。
 */
import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/game';
import type { Loadout, StageDef, V3 } from '../src/sim/types';
import { buildStage } from '../src/stage';

const HALF = { x: 0.8, y: 1.5, z: 0.8 }; // ARCH §5: 1.6 x 3.0 x 1.6 m
const QB_STEPS = 90; // 0.75 s at 120 Hz (QB 開始 tick を含む)
const BIPED: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
const QUAD: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'quadruped' };

const stage: StageDef = buildStage();

function sortie(l: Loadout): Game {
  const g = new Game({ stage, loadout: l });
  g.sortie(l);
  return g;
}

describe('S01 start lane: geometry (straight line from the sortie point along the initial heading)', () => {
  const start = stage.playerStart.pos;
  const yaw = stage.playerStart.yaw;
  // 初期向き: yaw=π → 南 (+z)。yaw規約は math.ts (yaw=0 は -Z)。前方 = (-sin(yaw), -cos(yaw))
  const dir: V3 = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };

  it('initial heading is south (+z)', () => {
    expect(dir.x).toBeCloseTo(0, 9);
    expect(dir.z).toBeCloseTo(1, 9);
  });

  it('player box (1.6 x 3.0 x 1.6) travels >= 50 m (target 52 m) straight ahead without touching anything', () => {
    const g = sortie(BIPED);
    const LEN = 70;
    const hit = g.world.sweepAABB(start, HALF, { x: dir.x * LEN, y: 0, z: dir.z * LEN });
    expect(hit, 'lane must end in a wall within 70 m').not.toBeNull();
    const free = (hit?.t ?? Infinity) * LEN; // sweepAABB の t は delta に対する割合 (0..1)
    expect(free).toBeGreaterThanOrEqual(52);
  });

  it('the lane is >= 4 m wide with >= 6 m headroom and a flat floor over the 50 m', () => {
    const g = sortie(BIPED);
    // 幅 4m x 高さ 6m の箱 (床の上 0.02m から 6.02m)。中心は出撃位置の真南
    const c: V3 = { x: start.x, y: 0.02 + 3, z: start.z };
    const wide = g.world.sweepAABB(c, { x: 2, y: 3, z: 0.8 }, { x: 0, y: 0, z: 50 });
    expect(wide, `blocked at ${wide?.t}`).toBeNull();
    // 床は同じ高さ: 足元の箱 (床+0.02 .. 床+0.3) を通す (段差・凹みがない)
    const low = g.world.sweepAABB({ x: start.x, y: 0.02 + 0.14, z: start.z }, { x: 0.8, y: 0.14, z: 0.8 }, { x: 0, y: 0, z: 50 });
    expect(low, `low obstacle at ${low?.t}`).toBeNull();
    // 床までの距離が全区間で同じ (下向きレイ)
    for (let z = start.z; z <= start.z + 52; z += 2) {
      const r = g.world.raycast({ x: start.x, y: start.y, z }, { x: 0, y: -1, z: 0 }, 5);
      expect(r?.t, `floor at z=${z}`).toBeCloseTo(start.y, 6);
    }
  });
});

describe('S01 start lane: QB right after the sortie (SPEC §7.2: 2脚 42.6 m / 4脚 34.08 m in 0.75 s)', () => {
  const cases: { name: string; l: Loadout; dist: number }[] = [
    { name: 'biped', l: BIPED, dist: 42.6 },
    { name: 'quadruped', l: QUAD, dist: 34.08 },
  ];
  for (const c of cases) {
    for (const withForward of [false, true]) {
      it(`${c.name}, ${withForward ? 'forward input' : 'no input (camera forward)'}: horizontal travel in 0.75 s = ${c.dist} m (+-0.05), straight south, no wall contact`, () => {
        const g = sortie(c.l);
        const p = g.state.player;
        const x0 = p.pos.x;
        const z0 = p.pos.z;
        expect(g.state.mode).toBe('playing');
        if (withForward) g.input.forward = true;
        g.input.qb = true;
        g.step();
        g.input.qb = false;
        expect(p.mv.qbSuccessCount, 'QB must be accepted right after the sortie').toBe(1);
        for (let i = 1; i < QB_STEPS; i++) g.step();
        expect(g.state.time).toBeCloseTo(0.75, 9);
        const dx = p.pos.x - x0;
        const dz = p.pos.z - z0;
        expect(Math.hypot(dx, dz)).toBeGreaterThan(c.dist - 0.05);
        expect(Math.hypot(dx, dz)).toBeLessThan(c.dist + 0.05);
        expect(dz).toBeGreaterThan(c.dist - 0.05); // 真南へ
        expect(Math.abs(dx)).toBeLessThan(0.01);
        // 壁に触れて速度が削られていない: QB 終了後 (0.75 s) の速度は 22 m/s x 脚倍率 の直前 (減速完了 = 0.15+0.60 s)
        const m = c.l.legs === 'biped' ? 1 : 0.8;
        expect(Math.hypot(p.vel.x, p.vel.z)).toBeCloseTo(22 * m, 6);
        expect(p.hp).toBe(1000);
        expect(g.state.enemyBullets.length).toBe(0);
      });
    }
  }
});

describe('S01 start lane: the sortie point is sheltered (nobody shoots the player who has not touched the controls)', () => {
  for (const [name, l] of [['biped', BIPED], ['quadruped', QUAD]] as const) {
    it(`${name}: idle for 60 s -> no damage, no enemy bullet ever exists, still playing`, () => {
      const g = sortie(l);
      let bullets = 0;
      for (let t = 0; t < 60 * 120; t++) {
        g.step();
        bullets += g.state.enemyBullets.length;
        g.drainEvents();
      }
      expect(g.state.time).toBeCloseTo(60, 6);
      expect(bullets).toBe(0);
      expect(g.state.player.hp).toBe(1000);
      expect(g.state.damageTaken).toBe(0);
      expect(g.state.mode).toBe('playing');
    });
  }

  it('QB to the end of the lane and then idling for 30 s is also harmless (the lane is closed except for the exit gap)', () => {
    const g = sortie(BIPED);
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    let bullets = 0;
    for (let t = 0; t < 30 * 120; t++) {
      g.step();
      bullets += g.state.enemyBullets.length;
      g.drainEvents();
    }
    expect(bullets).toBe(0);
    expect(g.state.player.hp).toBe(1000);
    expect(g.state.player.pos.z).toBeLessThan(67 - HALF.z + 1e-3); // 突き当たりの壁の手前で止まる
  });
});
