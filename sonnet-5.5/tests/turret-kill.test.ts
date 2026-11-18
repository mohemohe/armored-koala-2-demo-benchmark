/**
 * 制御砲台6体 (T03 T07 T08 T11 T14 T15) の遠隔破壊: 実ステージの実敵に対して、実際の武器・FCS・弾体・衝突・敵AIで確認する (SPEC §2.1 / §4 / §5 / §2.3)。
 *
 * 全て本番の Game (Game.input / Game.look / Game.step) を動かす。行うのは 初期条件としての配置 (狙撃位置に置く・HPを 1e9 にする・視点を砲台へ向ける) だけで、
 * 以降は FCS のロック取得 → ロック完了 → 発射 → 弾体/ビームの掃引衝突 → damageEnemy → objective(隔壁) を経る。砲台のHPや隔壁は直接書き換えない。
 * 他の44体は生きたまま実AIで反撃する。HP 1e9 は「被弾しても実行が終わらない」ためで、被弾でHPが実際に減ることも確認する。
 * 狙撃位置の探索・ボット・3武器/掩蔽/生存時間の実測は tools/turret-kill.ts (docs/TURRET_KILL.md)。
 */
import { describe, expect, it } from 'vitest';
import { ENEMIES, FCS, PLAYER, SIM, WEAPONS } from '../src/config';
import type { WeaponId } from '../src/config';
import { buildStage } from '../src/stage';
import {
  IMMORTAL_HP,
  SNIPER_SPOTS,
  SNIPE_MAX,
  SNIPE_MIN,
  controlTurrets,
  makeProbe,
  runGate,
  runScenario,
  searchSniperSpots,
  verifySnipeSpot,
  weaponsClear,
} from '../tools/turret-kill';
import type { RunResult } from '../tools/turret-kill';

const stage = buildStage();
const probe = makeProbe(stage);
const turrets = controlTurrets(stage);
const ids = turrets.map((t) => t.id);

const stand = (turretId: string, weapon: WeaponId, seed?: number): RunResult => runScenario(stage, { turretId, weapon, bot: 'stand', fire: SNIPER_SPOTS[turretId].fire, seed, maxSeconds: 30 });

describe('制御砲台と狙撃位置', () => {
  it('制御砲台は T03 T07 T08 T11 T14 T15 の6体で、別々の区画・隔壁 B1〜B6 に対応し、HPは240 (=マシンガン20発分)', () => {
    expect(ids).toEqual(['T03', 'T07', 'T08', 'T11', 'T14', 'T15']);
    expect(turrets.map((t) => t.barrierId)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
    expect(new Set(turrets.map((t) => t.sectorId)).size).toBe(6);
    expect(ENEMIES.turret.hp / WEAPONS.machinegun.damage).toBe(20);
    expect(Math.ceil(ENEMIES.turret.hp / WEAPONS.missile.damage)).toBe(2);
    expect(Math.ceil(ENEMIES.turret.hp / WEAPONS.beam.damage)).toBe(6);
    const game = probe.state.enemies;
    for (const t of turrets) expect(game.find((e) => e.id === t.id)?.hp).toBe(240);
  });

  it.each(ids)('%s: 狙撃位置の表が現在のステージで有効 (立てる・ロック可・60〜118m・3武器の弾道が通る・砲台が撃ち返す・掩蔽点は全ての敵から見えない)', (id) => {
    const v = verifySnipeSpot(probe, id);
    expect(v.problems, `再探索: npx tsx tools/turret-kill.ts --search --turret ${id}`).toEqual([]);
    expect(v.eval.distMuzzle).toBeGreaterThanOrEqual(SNIPE_MIN);
    expect(v.eval.distMuzzle).toBeLessThanOrEqual(SNIPE_MAX);
    expect(v.eval.distMuzzle).toBeLessThan(FCS.RANGE);
  });

  it.each(ids)('%s: 自動探索が実際の camera / muzzle / isLockCandidate / 弾道で条件を満たす候補を見つける', (id) => {
    const rep = searchSniperSpots(probe, id, { hideTop: 3 });
    expect(rep.nodes).toBeGreaterThan(1000);
    expect(rep.walkable).toBeGreaterThan(0);
    expect(rep.candidates.length).toBeGreaterThan(0);
    for (const c of rep.candidates.slice(0, 20)) {
      expect(c.lockable).toBe(true);
      expect(c.distMuzzle).toBeGreaterThanOrEqual(SNIPE_MIN);
      expect(c.distMuzzle).toBeLessThanOrEqual(SNIPE_MAX);
      expect(weaponsClear(c)).toBe(true);
      expect(c.turretSees).toBe(true);
      expect(c.lockCandidates).toEqual([id]);
      expect(c.access).not.toBe('none');
    }
  });
});

describe('マシンガンで破壊 (狙撃位置に立ち、FCSのロック完了後に撃つ。他の44体は生存し反撃する)', () => {
  it.each(ids)('%s: 20発命中で破壊され、対応する隔壁が開く', (id) => {
    const r = stand(id, 'machinegun');
    const t = turrets.find((x) => x.id === id) as (typeof turrets)[number];
    expect(r.killed, `${id} 未破壊`).toBe(true);
    // ---- FCS: ロック取得 → 0.80秒 (中範囲FCS・2脚) で完了。完了前に撃たない
    expect(r.lockedAt).not.toBeNull();
    expect((r.lockedAt as number) - (r.lockAcquireAt as number)).toBeCloseTo(0.8, 6);
    expect(r.firstShotAt as number).toBeGreaterThanOrEqual((r.lockedAt as number) - 1e-9);
    expect(r.lockedOther).toEqual([]);
    // ---- 射撃解: 全ての弾が solved の補正射撃 (残差 0.01m 以下)
    expect(r.shotStatus.no_solution).toBe(0);
    expect(r.shotStatus.inactive).toBe(0);
    expect(r.shotStatus.solved).toBe(r.mg.firedAtTarget);
    expect(r.fc?.status).toBe('solved');
    expect(r.fc?.residualMeters as number).toBeLessThanOrEqual(FCS.MAX_RESIDUAL_M);
    // ---- 240 / 12 = 20 発の命中で破壊。決着した弾は全て命中 (壁・台座に当たらない)
    expect(r.mg.hitsTarget).toBe(ENEMIES.turret.hp / WEAPONS.machinegun.damage);
    expect(r.mg.hitsWorld).toBe(0);
    expect(r.mg.hitsOtherEnemy).toBe(0);
    expect(r.mg.hitRate).toBe(1);
    expect(r.used.machinegun).toBe(r.fired.machinegun);
    expect(r.used.machinegun).toBeGreaterThanOrEqual(20);
    // 破壊の瞬間に飛翔中だった弾 (射撃間隔0.1s × 弾の飛翔時間) の分だけ余分に撃つ
    expect(r.used.machinegun).toBeLessThanOrEqual(20 + Math.ceil(2 / SIM.DT / 12));
    expect(r.killAt as number).toBeLessThan(6);
    // ---- 隔壁: 実際の objective / world
    expect(r.barrier.id).toBe(t.barrierId);
    expect(r.barrier.openIds).toEqual([t.barrierId]);
    expect(r.barrier.openedAt).toBe(r.killAt); // 破壊と同じ tick の終わりに barrierOpen
    expect(r.barrier.controlsDestroyed).toBe(1);
    expect(r.barrier.boxesDisabled).toBe(true);
    expect(r.barrier.portalPassableBefore).toBe(false);
    expect(r.barrier.portalPassableAfter).toBe(true);
    expect(r.barrier.gateOpen).toBe(false);
    expect(r.otherKills).toEqual([]);
    // ---- 敵が機能している: 被弾でHPが実際に減る (HPは 1e9 で開始)
    expect(r.hpStart).toBe(IMMORTAL_HP);
    expect(r.damageTaken).toBeGreaterThan(0);
    expect(r.hpEnd).toBe(IMMORTAL_HP - r.damageTaken);
    for (const h of r.hits) expect([ENEMIES.guard.damage, ENEMIES.turret.damage]).toContain(h.damage);
  });
});

describe('対照実験: 当たるのはFCSの補正射撃だけ', () => {
  it.each(ids)('%s: ロック完了前の自由射撃 (補正なし) は標的に1発も当たらず、完了後の補正射撃だけが命中する', (id) => {
    const r = runScenario(stage, { turretId: id, weapon: 'machinegun', bot: 'stand', fire: SNIPER_SPOTS[id].fire, fireBeforeLock: true, maxSeconds: 30 });
    expect(r.killed).toBe(true);
    expect(r.firstShotAt).toBe(0);
    // 0.00〜0.80秒 (ロック完了は 0.808秒) の 0.1秒間隔 9発は補正なしの自由射撃。距離 60〜118m の重力落下 (数m) で砲台に届かない
    expect(r.shotStatus.inactive).toBe(9);
    expect(r.mg.firedAtTarget).toBe(r.shotStatus.solved); // 標的を対象にした射撃は全て補正射撃
    expect(r.mg.hitsWorld).toBeGreaterThanOrEqual(r.shotStatus.inactive);
    // 標的への命中は補正射撃だけ: 決着した補正弾 (発射数 - 飛翔中) が全て命中し、ちょうど20発
    expect(r.mg.hitsTarget).toBe(20);
    expect(r.shotStatus.solved - r.mg.inFlightAtKill).toBe(r.mg.hitsTarget);
  });
});

describe('ビーム・ミサイルで破壊', () => {
  it.each(ids)('%s: ビームは6射 (40×6=240, EN 8×6=48) で破壊される', (id) => {
    const r = stand(id, 'beam');
    expect(r.killed).toBe(true);
    expect(r.lockedAt).not.toBeNull();
    expect(r.fired.beam).toBe(6);
    expect(r.beamHits).toBe(6);
    expect(r.used.beamEn).toBe(6 * WEAPONS.beam.enCost);
    expect(r.shotStatus.solved).toBe(6);
    expect(r.barrier.boxesDisabled).toBe(true);
    expect(r.barrier.portalPassableAfter).toBe(true);
    // 射撃間隔は最短の 0.25s: 6射目は初弾の 5×0.25 秒後に tick 開始で撃たれ、その tick の終わり (+1/120 s) に破壊が確定する
    expect((r.killAt as number) - (r.firstShotAt as number)).toBeCloseTo(5 * WEAPONS.beam.interval + SIM.DT, 6);
  });

  it.each(ids)('%s: ミサイルは2発命中 (180×2≥240) で破壊される (ロック完了後だけ発射できる)', (id) => {
    const r = stand(id, 'missile');
    expect(r.killed).toBe(true);
    expect(r.firstShotAt as number).toBeGreaterThanOrEqual((r.lockedAt as number) - 1e-9);
    expect(r.missileHits).toBe(2);
    expect(r.fired.missile).toBeGreaterThanOrEqual(2);
    expect(r.used.missile).toBe(r.fired.missile);
    expect(r.shotStatus.no_solution).toBe(0);
    expect(r.barrier.boxesDisabled).toBe(true);
    expect(r.barrier.portalPassableAfter).toBe(true);
    expect(r.killAt as number).toBeLessThan(8);
  });
});

describe('6体全ての破壊で最終ゲートが開く', () => {
  it('1つのGameで6体を順に (マシンガン) 破壊すると B1〜B6 が順に開き、6体目でGATEが開いてゲートの箱が無効化される', () => {
    const run = runGate(stage, SNIPER_SPOTS);
    expect(run.results.map((r) => r.killed)).toEqual([true, true, true, true, true, true]);
    run.results.forEach((r, i) => {
      expect(r.barrier.controlsDestroyed).toBe(i + 1);
      expect(r.barrier.openIds).toEqual(ids.slice(0, i + 1).map((_, k) => `B${k + 1}`));
      expect(r.barrier.gateOpen).toBe(i === 5); // 5体まで最終ゲートは閉じたまま
      expect(r.barrier.boxesDisabled).toBe(true);
    });
    expect(run.gateOpen).toBe(true);
    expect(run.controlsDestroyed).toBe(6);
    expect(run.gateBoxesDisabled).toBe(true);
    expect(run.gatePassableBefore).toBe(false);
    expect(run.gatePassableAfter).toBe(true);
  });
});

describe('敵の反撃と遠距離での被害 (実HP 1000)', () => {
  it.each(ids)('%s: 狙撃位置に立ったままだと砲台の弾が実際に当たり、HPが減る (即死しない)', (id) => {
    const r = runScenario(stage, { turretId: id, weapon: 'machinegun', bot: 'idle', fire: SNIPER_SPOTS[id].fire, hp: PLAYER.MAX_HP, maxSeconds: 8 });
    expect(r.firstHitAt).not.toBeNull();
    // 砲台の初回攻撃は射線を得てから0.70秒後。弾速60m/sで 60〜118m を飛ぶので、砲台の最初の命中は 0.70 + 1.0〜2.0 秒後 (警備の弾はもっと早く当たりうる)
    const fromTurret = r.hits.find((h) => h.from === id);
    expect(fromTurret, `${id} の弾が当たっていない`).toBeDefined();
    expect((fromTurret as { time: number }).time).toBeGreaterThanOrEqual(ENEMIES.turret.firstAttackDelay + SNIPE_MIN / ENEMIES.turret.bulletSpeed - 0.05);
    expect(r.failedAt).toBeNull(); // 8秒では撃破されない (最短の T11 でも約12秒。docs/TURRET_KILL.md)
    expect(r.hpEnd).toBe(PLAYER.MAX_HP - r.damageTaken);
    expect(r.hpEnd).toBeLessThan(PLAYER.MAX_HP);
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect([ENEMIES.guard.damage, ENEMIES.turret.damage]).toContain(h.damage);
    expect(r.enemyShots[id] ?? 0).toBeGreaterThan(0);
  });

  it.each(ids)('%s: 掩蔽点から身を出して撃つ→引っ込むボットで破壊でき、実HP1000で生き残れる被害に収まる', (id) => {
    const sp = SNIPER_SPOTS[id];
    const r = runScenario(stage, { turretId: id, weapon: 'machinegun', bot: 'cover', fire: sp.fire, hide: sp.hide, maxSeconds: 60 });
    expect(r.killed, `${id}: 60秒で未破壊`).toBe(true);
    expect(r.peeks).toBeGreaterThanOrEqual(1);
    expect(r.mg.hitsTarget).toBe(20);
    expect(r.damageTaken).toBeLessThan(PLAYER.MAX_HP);
    expect(r.barrier.boxesDisabled).toBe(true);
    expect(r.barrier.portalPassableAfter).toBe(true);
  });
});
