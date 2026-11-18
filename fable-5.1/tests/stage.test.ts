/**
 * ステージ規模要件の検証（仕様 §2.2）。verifyStage が実際に計算した値で判定する。
 */
import { describe, expect, it } from 'vitest';
import { FCS, OBJECTIVE, WEAPONS } from '../src/params';
import { overlaps } from '../src/stage/builders';
import { STAGE_DATA } from '../src/stage/stageData';
import { VERIFY_THRESHOLDS, verifyStage, type StageReport } from '../src/stage/verify';
import type { StageData } from '../src/types';

let cached: StageReport | null = null;
function report(): StageReport {
  if (!cached) {
    cached = verifyStage(STAGE_DATA);
    const m = cached.metrics;
    console.log(
      JSON.stringify(
        {
          ok: cached.ok,
          errors: cached.errors,
          warnings: cached.warnings,
          sectorCount: m.sectorCount,
          kinds: m.kinds,
          shortestPathMeters: Number(m.shortestPathMeters.toFixed(1)),
          legMeters: m.legMeters.map((x) => Number(x.toFixed(1))),
          gridPathMeters: Number(m.gridPathMeters.toFixed(1)),
          gridLegMeters: m.gridLegMeters.map((x) => Number(x.toFixed(1))),
          pulledPathPoints: m.pulledPath.length,
          firingRangeM: m.firingRangeM,
          routeSectors: m.routeSectors,
          pathSectorCount: m.pathSectorCount,
          branchCount: m.branchCount,
          loopCount: m.loopCount,
          flightPointCount: m.flightPointCount,
          flightPoints: m.flightPoints.map((f) => ({ id: f.id, ok: f.ok, h: f.heightDiff, gap: Number(f.horizontalGap.toFixed(2)), en: Number(f.enRequired.toFixed(1)), walk: f.walkOnlyReachable, dFrom: Number(f.fromDistToPath.toFixed(1)), dTo: Number(f.toDistToPath.toFixed(1)), errors: f.errors })),
          layerHeights: m.layerHeights,
          floorLevels: m.floorLevels,
          floorLevelCells: m.floorLevelCells,
          arenaSizes: m.arenaSizes,
          crossfire: m.crossfireDetails,
          crossfireSimultaneous: m.crossfireSimultaneous,
          enemies: m.enemies,
          decorInWalkableSpace: m.decorInWalkableSpace,
          walkOnlyExitReachable: m.walkOnlyExitReachable,
          walkOnlyReachableCells: m.walkOnlyReachableCells,
          walkOnlyReachesFirstControl: m.walkOnlyReachesFirstControl,
          startHasLos: m.startHasLos,
          nearestEnemyToStart: Number(m.nearestEnemyToStart.toFixed(1)),
          firingCellCounts: m.firingCellCounts,
          firingCellsOutsideSector: m.firingCellsOutsideSector,
          gridCells: m.gridCells,
          freeCells: m.freeCells,
          reachableCells: m.reachableCells,
          solidCount: m.solidCount,
          pathCellCount: m.pathCellCount,
          elapsedMs: m.elapsedMs,
        },
        null,
        1,
      ),
    );
  }
  return cached;
}

/** 設計記録（docs/STAGE.md）生成用: 環境変数 STAGE_DUMP=<path> で報告と経路を JSON 出力する（@types/node なしで動かす） */
function dumpPath(): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.STAGE_DUMP;
}

/** 検証器が欠陥を実際に検出することの確認用: データを浅くコピーして一部を変える */
function mutated(fn: (d: StageData) => void): StageData {
  const d: StageData = {
    ...STAGE_DATA,
    solids: [...STAGE_DATA.solids],
    decor: [...STAGE_DATA.decor],
    enemies: STAGE_DATA.enemies.map((e) => ({ ...e, position: [...e.position] as [number, number, number] })),
    barriers: [...STAGE_DATA.barriers],
    flightPoints: [...STAGE_DATA.flightPoints],
  };
  fn(d);
  return d;
}

describe('stage: 廃工場の規模要件（verifyStage による実測）', () => {
  it('検証器が全項目を通過する', () => {
    const r = report();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('区画数 ≥ 15、区画種別 ≥ 6', () => {
    const m = report().metrics;
    expect(m.sectorCount).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.minSectors);
    expect(m.kindCount).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.minKinds);
  });

  it('自由飛行の最短経路（紐張り後）≥ 1500 m、格子経路以下、通過区画 ≥ 12', () => {
    const m = report().metrics;
    expect(Number.isFinite(m.shortestPathMeters)).toBe(true);
    expect(m.shortestPathMeters).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.minPathMeters);
    // 紐張りは折れ線を直線で置き換えるだけなので、格子経路より長くならない
    expect(m.shortestPathMeters).toBeLessThanOrEqual(m.gridPathMeters + 1e-6);
    expect(m.gridPathMeters).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.minPathMeters);
    expect(m.pathSectorCount).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.minPathSectors);
    expect(m.legMeters.length).toBe(OBJECTIVE.controlsRequired + 1);
    expect(m.gridLegMeters.length).toBe(OBJECTIVE.controlsRequired + 1);
    expect(Math.abs(m.legMeters.reduce((a, b) => a + b, 0) - m.shortestPathMeters)).toBeLessThan(1e-6);
    expect(m.pulledPath.length).toBeGreaterThan(2);
    expect(m.pulledPath.length).toBeLessThan(m.pathCellCount);
  });

  it('射撃可能セルの判定半径は MG 自由射撃の到達距離（100 m/s × 2 s ＋ 重力落下）以上', () => {
    const m = report().metrics;
    const mgReach = WEAPONS.machinegun.speed * WEAPONS.machinegun.lifetime;
    expect(m.firingRangeM).toBeGreaterThanOrEqual(mgReach);
    expect(m.firingRangeM).toBeGreaterThanOrEqual(FCS.range);
    expect(m.firingRangeM).toBeGreaterThanOrEqual(WEAPONS.missile.speed * WEAPONS.missile.lifetime);
    // この半径でも制御砲台は自区画の外から視認できない
    for (const v of Object.values(m.firingCellsOutsideSector)) expect(v).toBe(0);
  });

  it('分岐 ≥ 3、環状 ≥ 2', () => {
    const m = report().metrics;
    expect(m.branchCount).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.minBranches);
    expect(m.loopCount).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.minLoops);
  });

  it('飛行必須箇所 ≥ 6（各 6〜16 m、歩行不可、最弱構成で可、経路上）', () => {
    const m = report().metrics;
    expect(m.flightPointCount).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.minFlightPoints);
    for (const f of m.flightPoints) {
      expect(f.ok).toBe(true);
      expect(f.heightDiff).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.flightMinDiff);
      expect(f.heightDiff).toBeLessThanOrEqual(VERIFY_THRESHOLDS.flightMaxDiff);
      expect(f.walkOnlyReachable).toBe(false);
      expect(f.enRequired).toBeLessThanOrEqual(f.enBudget);
      expect(f.fromDistToPath).toBeLessThanOrEqual(VERIFY_THRESHOLDS.flightNearPathM);
      expect(f.toDistToPath).toBeLessThanOrEqual(VERIFY_THRESHOLDS.flightNearPathM);
    }
    expect(m.walkOnlyExitReachable).toBe(false);
  });

  it('高度帯 ≥ 3、アリーナ ≥ 5、交差射線区画 ≥ 5', () => {
    const m = report().metrics;
    expect(m.layerCount).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.minLayers);
    expect(m.arenaCount).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.minArenas);
    expect(m.crossfireCount).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.minCrossfire);
  });

  it('階層は床材質の上面から求める: 宣言したナビ床高さは全て経路が実際に立つ床であり、配管の上面は数えない', () => {
    const m = report().metrics;
    for (const lv of STAGE_DATA.navFloorLevels ?? []) expect(m.floorLevels).toContain(lv);
    // 動力棟の配管 S06:pipeS（上面 −10 m、pipeRust）は床ではない
    expect(m.floorLevels).not.toContain(-10);
    expect(m.layerHeights).not.toContain(-10);
    for (const h of m.layerHeights) expect(m.floorLevels).toContain(h);
  });

  it('アリーナの記録は条件を満たす最大面積の長方形（S03 は 60×50 ちょうどではない）', () => {
    const m = report().metrics;
    for (const id of STAGE_DATA.arenaSectorIds) {
      const [a, b] = m.arenaSizes[id];
      expect(Math.max(a, b)).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.arenaLongM);
      expect(Math.min(a, b)).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.arenaShortM);
    }
    const [a, b] = m.arenaSizes.S03;
    expect(a * b).toBeGreaterThanOrEqual(60 * 56);
  });

  it('交差射線区画では 1 つの位置へ 4 体が同時に射線を持つ', () => {
    const m = report().metrics;
    for (const cf of STAGE_DATA.crossfireSectors) {
      expect(m.crossfireDetails[cf.sectorId].length).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.crossfireEnemies);
      expect(m.crossfireSimultaneous[cf.sectorId]).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.crossfireEnemies);
    }
  });

  it('見た目と衝突の一致: ソリッド同士は重ならず、衝突なしの大型装飾は通行空間にない', () => {
    const solids = STAGE_DATA.solids;
    const pairs: string[] = [];
    for (let i = 0; i < solids.length; i++)
      for (let j = i + 1; j < solids.length; j++)
        if (overlaps(solids[i].box, solids[j].box)) pairs.push(`${solids[i].label ?? i} / ${solids[j].label ?? j}`);
    expect(pairs).toEqual([]);
    // 装飾はランプ・矢印・区画名だけ（太い配管はソリッド）
    for (const d of STAGE_DATA.decor) {
      if (d.kind === 'cylinder') expect(d.radius ?? 0).toBeLessThanOrEqual(VERIFY_THRESHOLDS.decorThinRadius);
      if (d.kind === 'box' && d.box) {
        const [dx, dy, dz] = [d.box.max[0] - d.box.min[0], d.box.max[1] - d.box.min[1], d.box.max[2] - d.box.min[2]];
        expect(Math.min(dx, dy, dz)).toBeLessThanOrEqual(VERIFY_THRESHOLDS.decorThinRadius * 2);
      }
    }
    expect(report().metrics.decorInWalkableSpace).toBe(0);
  });

  it('検証器は欠陥を検出する: 通行空間に太い装飾シリンダーを置くとエラー', () => {
    const d = mutated((x) => {
      // 冷却設備の空いた床の上に、衝突のない太い縦配管を置く（元の S07 の装飾配管と同じ大きさ）
      x.decor.push({ kind: 'cylinder', position: [230, -5, 170], radius: 1.2, height: 18, axis: 'y', material: 'pipe', sectorId: 'S07' });
    });
    const r = verifyStage(d);
    expect(r.ok).toBe(false);
    expect(r.metrics.decorInWalkableSpace).toBe(1);
    expect(r.errors.some((e) => e.includes('装飾') && e.includes('通行空間'))).toBe(true);
  });

  it('検証器は欠陥を検出する: 敵を閉じた隔壁の中に置くとエラー', () => {
    const b6 = STAGE_DATA.barriers.find((b) => b.id === 'B-06')!;
    const d = mutated((x) => {
      const t = x.enemies.find((e) => e.id === 't14')!;
      t.position = [(b6.box.min[0] + b6.box.max[0]) / 2, b6.box.min[1], (b6.box.min[2] + b6.box.max[2]) / 2];
    });
    const r = verifyStage(d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('t14') && (e.includes('重なっている') || e.includes('自由セルではない')))).toBe(true);
  });

  it('敵 45（警備 30 / 砲台 15 / 制御 6）、開始地点は遮蔽', () => {
    const m = report().metrics;
    expect(m.enemies).toEqual({ total: OBJECTIVE.totalEnemies, guards: OBJECTIVE.guards, turrets: OBJECTIVE.turrets, controls: OBJECTIVE.controlsRequired });
    expect(m.startHasLos).toBe(false);
    expect(m.nearestEnemyToStart).toBeGreaterThanOrEqual(VERIFY_THRESHOLDS.startMinEnemyDistance);
    for (const v of Object.values(m.firingCellsOutsideSector)) expect(v).toBe(0);
  });

  it('データの静的整合（隔壁 6、ID 形式、ヒント、ナビ床高さ、ソリッド数）', () => {
    expect(STAGE_DATA.barriers.length).toBe(OBJECTIVE.controlsRequired);
    const guardIds = STAGE_DATA.enemies.filter((e) => e.kind === 'guard').map((e) => e.id);
    const turretIds = STAGE_DATA.enemies.filter((e) => e.kind === 'turret').map((e) => e.id);
    expect(guardIds).toEqual(Array.from({ length: 30 }, (_, i) => `g${String(i + 1).padStart(2, '0')}`));
    expect(turretIds).toEqual(Array.from({ length: 15 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`));
    for (const s of STAGE_DATA.sectors) expect(typeof STAGE_DATA.objectiveHints[s.id]).toBe('string');
    expect(STAGE_DATA.navFloorLevels && STAGE_DATA.navFloorLevels.length).toBeGreaterThanOrEqual(3);
    expect(STAGE_DATA.solids.length).toBeLessThanOrEqual(1500);
    // ARCHITECTURE §3.10: 区画ごとの PointLight は最大 8 程度
    expect(STAGE_DATA.lights.length).toBeLessThanOrEqual(8);
  });

  it('検証器は欠陥を検出する: 開始地点へ射線を持つ敵を置くとエラー', () => {
    const d = mutated((x) => {
      x.enemies[0].position = [14, 0, 62]; // 搬入口の遮蔽壁の内側（開始地点と同じ側）
      x.enemies[0].sectorId = 'S01';
    });
    const r = verifyStage(d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('開始地点へ射線'))).toBe(true);
  });

  it('検証器は欠陥を検出する: 昇降ダクトの壁を外すと歩行のみで通過できる', () => {
    const d = mutated((x) => {
      // D1（圧延棟→搬送縦坑）のダクト壁と屋根を外し、代わりに階段状の足場を置く
      x.solids = x.solids.filter((s) => !(s.label ?? '').startsWith('D1:'));
      for (let n = 0; n < 4; n++) x.solids.push({ box: { min: [286 - n * 4, 0, 60], max: [290 - n * 4, 8 - n * 2, 80] }, material: 'crate' });
    });
    const r = verifyStage(d);
    expect(r.ok).toBe(false);
    expect(r.metrics.flightPoints.find((f) => f.id === 'F1')?.walkOnlyReachable).toBe(true);
  });

  it('検証器は欠陥を検出する: 敵を壁の中・到達不能な場所へ置くとエラー', () => {
    const d = mutated((x) => {
      x.enemies[0].position = [40.5, 0, 20]; // S01/S02 の壁の中
      x.enemies[1].position = [500, 0, 500]; // 施設の外
    });
    const r = verifyStage(d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('g01') && e.includes('重なっている'))).toBe(true);
    expect(r.errors.some((e) => e.includes('g02'))).toBe(true);
  });

  it('検証器は欠陥を検出する: 隔壁を 1 つ外すと制御砲台の対応が崩れる', () => {
    const d = mutated((x) => {
      x.barriers = x.barriers.slice(1);
    });
    const r = verifyStage(d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('B-01'))).toBe(true);
  });

  it('検証は 60 秒以内に完了する', () => {
    expect(report().metrics.elapsedMs).toBeLessThan(60_000);
  });

  it('STAGE_DUMP 指定時は報告とステージ定義を JSON 出力する', async () => {
    const path = dumpPath();
    if (!path) return;
    const fs = (await import('node:' + 'fs')) as { writeFileSync(p: string, d: string): void };
    fs.writeFileSync(path, JSON.stringify({ report: report(), stage: STAGE_DATA }, null, 1));
  });
});
