/**
 * ステージ骨格(stage0)の構造テスト。実際の buildStage() / World / Game を使う。
 * 厳密な検証(全18構成の飛行昇降・3D最短経路など)は src/stage/validate.ts。ここは骨格の不変条件を守るための回帰テスト。
 */
import { describe, expect, it } from 'vitest';
import type { Loadout } from '../src/sim/types';
import { ENEMIES, PLAYER, STAGE } from '../src/config';
import { Game } from '../src/sim/game';
import type { BoxDef, StageDef, V3 } from '../src/sim/types';
import { World } from '../src/sim/world';
import { buildStage } from '../src/stage';
import { ARENA_CLEAR, CLIMB_SPECS, CONTROL_SECTORS, ENEMY_BUDGET, PORTAL_AXIS, WALL, polyLength, sectorsAlong } from '../src/stage/blueprint';
import { StageBuilder } from '../src/stage/kit';
import { validateStage } from '../src/stage/validate';
import { barrierCuts, perimeterLeak, probeStage } from '../tools/route-probe';

const stage: StageDef = buildStage();
const HALF: V3 = { ...PLAYER.HALF };
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** 全隔壁を開けた / 閉じた World */
function makeWorld(open: boolean): World {
  const w = new World(stage.boxes);
  for (const b of stage.barriers) for (const id of b.boxIds) w.setBoxEnabled(w.indexOfBox(id), !open);
  return w;
}
const worldOpen = makeWorld(true);
const worldClosed = makeWorld(false);

/** 開始位置が埋まらず、移動区間で衝突しない(終点ちょうどで面に接するだけ=床に降り立つ場合は通行可) */
const sweepFree = (w: World, start: V3, delta: V3): boolean => {
  if (w.overlapAABB(start, HALF)) return false;
  const hit = w.sweepAABB(start, HALF, delta);
  return hit === null || hit.t >= 1 - 1e-6;
};
const enemyMuzzle = (p: V3): V3 => v3(p.x, p.y + 0.4, p.z); // enemies.ts の enemyMuzzlePosition と同じ

function distPointBox(p: V3, b: BoxDef): number {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  return Math.hypot(dx, dy, dz);
}

describe('区画 (SPEC §2.2)', () => {
  it('区画数15以上・ID一意・boundsが重ならない', () => {
    expect(stage.sectors.length).toBeGreaterThanOrEqual(STAGE.SECTOR_MIN);
    expect(new Set(stage.sectors.map((s) => s.id)).size).toBe(stage.sectors.length);
    for (const s of stage.sectors) expect(s.id).toMatch(/^S\d\d$/);
    for (let i = 0; i < stage.sectors.length; i++) {
      for (let j = i + 1; j < stage.sectors.length; j++) {
        const a = stage.sectors[i].bounds;
        const b = stage.sectors[j].bounds;
        const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
        const oy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
        const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
        expect(ox > 0 && oy > 0 && oz > 0, `${stage.sectors[i].id} overlaps ${stage.sectors[j].id}`).toBe(false);
      }
    }
  });

  it('空間種別が6種類以上・名前が全て異なる', () => {
    expect(new Set(stage.sectors.map((s) => s.kind)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(stage.sectors.map((s) => s.name)).size).toBe(stage.sectors.length);
  });

  it('全ての箱は自区画のboundsの中にあり、IDが一意で有限', () => {
    const ids = new Set<string>();
    for (const b of stage.boxes) {
      expect(ids.has(b.id), `duplicate ${b.id}`).toBe(false);
      ids.add(b.id);
      const s = stage.sectors.find((x) => x.id === b.sectorId);
      expect(s, `${b.id}: unknown sector`).toBeDefined();
      const sb = (s as (typeof stage.sectors)[number]).bounds;
      expect(b.id.startsWith(`${b.sectorId}-`)).toBe(true);
      for (const a of ['x', 'y', 'z'] as const) {
        expect(Number.isFinite(b.min[a]) && Number.isFinite(b.max[a])).toBe(true);
        expect(b.max[a]).toBeGreaterThan(b.min[a]);
        expect(b.min[a]).toBeGreaterThanOrEqual(sb.min[a] - 1e-9);
        expect(b.max[a]).toBeLessThanOrEqual(sb.max[a] + 1e-9);
      }
    }
  });

  it('各区画に床スラブ・屋根スラブ・4方の壁があり、屋根は区画全体を覆う (全高の壁と天井で閉じる)', () => {
    for (const s of stage.sectors) {
      const mine = stage.boxes.filter((b) => b.sectorId === s.id);
      const floor = mine.find((b) => b.id.startsWith(`${s.id}-floor-`));
      const roof = mine.find((b) => b.id.startsWith(`${s.id}-roof-`));
      expect(floor, `${s.id} floor`).toBeDefined();
      expect(roof, `${s.id} roof`).toBeDefined();
      const f = floor as BoxDef;
      const r = roof as BoxDef;
      expect(f.max.y).toBeCloseTo(s.floorY, 9);
      expect(f.max.y - f.min.y).toBeCloseTo(WALL, 9);
      expect(r.min.y).toBeCloseTo(s.ceilingY, 9);
      expect(r.max.y - r.min.y).toBeCloseTo(WALL, 9);
      expect(r.min.x).toBe(s.bounds.min.x);
      expect(r.max.x).toBe(s.bounds.max.x);
      expect(r.min.z).toBe(s.bounds.min.z);
      expect(r.max.z).toBe(s.bounds.max.z);
      for (const w of ['wall-n', 'wall-s', 'wall-w', 'wall-e']) expect(mine.some((b) => b.id.startsWith(`${s.id}-${w}-`)), `${s.id} ${w}`).toBe(true);
      // 壁は 床〜天井 の全高: 壁の中心面を4mおきに調べ、隔壁を閉じた状態で空いているのは portal の開口だけ(隔壁付きは b 側の壁厚の空洞)
      const t = WALL / 2;
      const faces: { name: string; at: (u: number, y: number) => V3; lo: number; hi: number; axis: 'x' | 'z'; plane: number }[] = [
        { name: 'n', at: (u, y) => v3(u, y, s.bounds.min.z + t), lo: s.bounds.min.x, hi: s.bounds.max.x, axis: 'z', plane: s.bounds.min.z },
        { name: 's', at: (u, y) => v3(u, y, s.bounds.max.z - t), lo: s.bounds.min.x, hi: s.bounds.max.x, axis: 'z', plane: s.bounds.max.z },
        { name: 'w', at: (u, y) => v3(s.bounds.min.x + t, y, u), lo: s.bounds.min.z, hi: s.bounds.max.z, axis: 'x', plane: s.bounds.min.x },
        { name: 'e', at: (u, y) => v3(s.bounds.max.x - t, y, u), lo: s.bounds.min.z, hi: s.bounds.max.z, axis: 'x', plane: s.bounds.max.x },
      ];
      for (const f of faces) {
        for (let u = f.lo + 1.37; u < f.hi; u += 4) { // 箱の境界線上(pointInSolidは厳密不等号)を避けて調べる
          for (const y of [s.floorY + 0.5, (s.floorY + s.ceilingY) / 2, s.ceilingY - 0.5]) {
            const p = f.at(u, y);
            if (worldClosed.pointInSolid(p)) continue;
            const inOpening = stage.portals.some((q) => {
              if ((q.a !== s.id && q.b !== s.id) || (q.barrierId !== null && q.a === s.id) || PORTAL_AXIS[q.id] !== f.axis) return false; // 隔壁の箱は a 側の壁の中にある
              const plane = f.axis === 'x' ? q.center.x : q.center.z;
              const lat = f.axis === 'x' ? q.center.z : q.center.x;
              return Math.abs(plane - f.plane) < 1e-9 && Math.abs(u - lat) <= q.width / 2 && Math.abs(y - q.center.y) <= q.height / 2;
            });
            expect(inOpening, `${s.id} wall ${f.name} has a hole at (${p.x},${p.y},${p.z})`).toBe(true);
          }
        }
      }
    }
  });

  it('戦闘区画: 60x50m以上の障害物なし床(ARENA_CLEAR)が5区画以上・そこに構造物がない', () => {
    const combat = stage.sectors.filter((s) => s.combat);
    expect(combat.length).toBeGreaterThanOrEqual(5);
    let wide = 0;
    for (const s of combat) {
      const a = ARENA_CLEAR[s.id];
      expect(a, `${s.id} has no ARENA_CLEAR`).toBeDefined();
      const w = a.x1 - a.x0;
      const d = a.z1 - a.z0;
      if ((w >= 60 && d >= 50) || (w >= 50 && d >= 60)) wide++;
      expect(a.x0).toBeGreaterThanOrEqual(s.bounds.min.x + WALL);
      expect(a.x1).toBeLessThanOrEqual(s.bounds.max.x - WALL);
      expect(a.z0).toBeGreaterThanOrEqual(s.bounds.min.z + WALL);
      expect(a.z1).toBeLessThanOrEqual(s.bounds.max.z - WALL);
      for (const b of stage.boxes) {
        if (b.sectorId !== s.id) continue;
        const obstructs = b.max.y > s.floorY + 0.02 && b.min.y < s.floorY + 3;
        const overlaps = b.max.x > a.x0 && b.min.x < a.x1 && b.max.z > a.z0 && b.min.z < a.z1;
        expect(obstructs && overlaps, `${b.id} intrudes into the ${s.id} arena`).toBe(false);
      }
    }
    expect(wide).toBeGreaterThanOrEqual(5);
  });

  it('階層: 床の高さが3層以上(-14 / 0 / +12 / +24)で、実際に立てる大きな床面がある', () => {
    const bands = new Map<number, number>();
    for (const b of stage.boxes) {
      const w = b.max.x - b.min.x;
      const d = b.max.z - b.min.z;
      if (w < 8 || d < 8 || w * d < 250) continue;
      const c = v3((b.min.x + b.max.x) / 2, b.max.y + HALF.y + 0.01, (b.min.z + b.max.z) / 2);
      if (worldOpen.overlapAABB(c, HALF)) continue; // 上に構造物がある(天井スラブなど)
      const key = Math.round(b.max.y);
      bands.set(key, (bands.get(key) ?? 0) + w * d);
    }
    const big = [...bands.entries()].filter(([, area]) => area >= 250).map(([y]) => y);
    for (const y of [-14, 0, 12, 24]) expect(big, `band y=${y}`).toContain(y);
  });

  it('装飾(decor)は衝突がなく、通行可能空間に入らない(壁・床・天井の面から0.15m以内)', () => {
    for (const d of stage.decor ?? []) {
      const s = stage.sectors.find((x) => x.id === d.sectorId);
      expect(s, `${d.id}: unknown sector`).toBeDefined();
      const pts: V3[] = [];
      for (const x of [d.min.x, (d.min.x + d.max.x) / 2, d.max.x]) for (const y of [d.min.y, (d.min.y + d.max.y) / 2, d.max.y]) for (const z of [d.min.z, (d.min.z + d.max.z) / 2, d.max.z]) pts.push(v3(x, y, z));
      for (const p of pts) {
        const near = stage.boxes.some((b) => distPointBox(p, b) <= 0.16);
        expect(near, `${d.id} at (${p.x},${p.y},${p.z}) floats in open space`).toBe(true);
      }
      expect(stage.boxes.some((b) => b.id === d.id)).toBe(false);
    }
  });
});

describe('敵45体 (SPEC §2.1)', () => {
  it('警備30・砲台15・制御6、IDは G01..G30 / T01..T15 で一意', () => {
    expect(stage.enemies.length).toBe(ENEMIES.TOTAL);
    const guards = stage.enemies.filter((e) => e.kind === 'guard');
    const turrets = stage.enemies.filter((e) => e.kind === 'turret');
    expect(guards.length).toBe(ENEMIES.guard.count);
    expect(turrets.length).toBe(ENEMIES.turret.count);
    expect(new Set(stage.enemies.map((e) => e.id)).size).toBe(45);
    expect(guards.map((e) => e.id).sort()).toEqual(Array.from({ length: 30 }, (_, i) => `G${String(i + 1).padStart(2, '0')}`));
    expect(turrets.map((e) => e.id).sort()).toEqual(Array.from({ length: 15 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`));
    expect(stage.enemies.filter((e) => e.isGateControl).length).toBe(STAGE.CONTROLS_REQUIRED);
    for (const e of stage.enemies.filter((x) => x.isGateControl)) expect(e.kind).toBe('turret');
  });

  it('区画ごとの敵数が予算(ENEMY_BUDGET)どおり', () => {
    for (const s of stage.sectors) {
      const budget = ENEMY_BUDGET[s.id] ?? { guard: 0, turret: 0 };
      const mine = stage.enemies.filter((e) => e.sectorId === s.id);
      expect(mine.filter((e) => e.kind === 'guard').length, `${s.id} guards`).toBe(budget.guard);
      expect(mine.filter((e) => e.kind === 'turret').length, `${s.id} turrets`).toBe(budget.turret);
    }
  });

  it('制御砲台6体は controlIndex 0..5 ↔ 隔壁 B1..B6 に1対1で対応し、6つの別区画に分散する', () => {
    const controls = stage.enemies.filter((e) => e.isGateControl).sort((a, b) => (a.controlIndex as number) - (b.controlIndex as number));
    expect(controls.map((c) => c.controlIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(controls.map((c) => c.barrierId)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
    expect(controls.map((c) => c.sectorId)).toEqual([...CONTROL_SECTORS]);
    expect(new Set(controls.map((c) => c.sectorId)).size).toBe(6);
    for (const c of controls) {
      const b = stage.barriers.find((x) => x.id === c.barrierId);
      expect(b?.controlEnemyId).toBe(c.id);
    }
    for (const e of stage.enemies.filter((x) => !x.isGateControl)) {
      expect(e.controlIndex).toBeNull();
      expect(e.barrierId).toBeNull();
    }
  });

  it('全敵が自区画の中の床(台座)の上にあり、箱に埋まらず、頭上に3m以上の空きがある', () => {
    for (const e of stage.enemies) {
      const cfg = ENEMIES[e.kind];
      const s = stage.sectors.find((x) => x.id === e.sectorId);
      expect(s, `${e.id}: sector`).toBeDefined();
      const sb = (s as (typeof stage.sectors)[number]).bounds;
      expect(e.pos.x > sb.min.x && e.pos.x < sb.max.x && e.pos.y > sb.min.y && e.pos.y < sb.max.y && e.pos.z > sb.min.z && e.pos.z < sb.max.z, `${e.id} inside ${e.sectorId}`).toBe(true);
      expect(worldClosed.pointInSolid(e.pos), `${e.id} center inside a box`).toBe(false);
      let clear = Infinity;
      for (const b of stage.boxes) clear = Math.min(clear, distPointBox(e.pos, b));
      expect(clear, `${e.id} hit sphere penetrates a box`).toBeGreaterThanOrEqual(cfg.hitRadius - 0.1);
      const down = worldClosed.raycast(e.pos, v3(0, -1, 0), 30);
      expect(down, `${e.id} floor`).not.toBeNull();
      expect((down as { t: number }).t, `${e.id} height above floor`).toBeCloseTo(cfg.centerHeight, 6);
      const up = worldClosed.raycast(e.pos, v3(0, 1, 0), 3);
      expect(up, `${e.id} headroom`).toBeNull();
      expect(Number.isFinite(e.yaw)).toBe(true);
    }
  });

  it('スタート位置は床の上・衝突なしで、どの敵の銃口からも射線が通らない(27点)', () => {
    const s = stage.playerStart.pos;
    expect(worldClosed.overlapAABB(s, HALF)).toBe(false);
    const down = worldClosed.raycast(s, v3(0, -1, 0), 5);
    expect((down as { t: number }).t - HALF.y).toBeCloseTo(0, 6);
    const targets: V3[] = [];
    for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) for (const sz of [-1, 0, 1]) targets.push(v3(s.x + sx * HALF.x, s.y + sy * HALF.y, s.z + sz * HALF.z));
    for (const e of stage.enemies) {
      const m = enemyMuzzle(e.pos);
      for (const t of targets) expect(worldClosed.segmentBlocked(m, t), `${e.id} sees the start ${JSON.stringify(t)}`).toBe(true);
    }
    // スタートは3方を壁で囲まれる: 西・北・東(アルコーブ東壁)へ 1m 以内に壁がある
    expect(worldClosed.raycast(s, v3(-1, 0, 0), 20)?.t).toBeLessThan(15);
    expect(worldClosed.raycast(s, v3(0, 0, -1), 20)?.t).toBeLessThan(15);
    expect(worldClosed.raycast(s, v3(1, 0, 0), 20)?.t).toBeLessThan(15);
    expect(stage.sectors.find((x) => x.id === 'S01')?.kind).toBe('dock');
  });

  it('5つ以上の戦闘区画で、床の1点を4体以上の敵(同区画・射程内)が射線に捉えられる', () => {
    let qualifying = 0;
    for (const s of stage.sectors) {
      const a = ARENA_CLEAR[s.id];
      const es = stage.enemies.filter((e) => e.sectorId === s.id);
      if (!a || es.length < 4) continue;
      let best = 0;
      for (let x = a.x0 + 2; x < a.x1; x += 6) {
        for (let z = a.z0 + 2; z < a.z1; z += 6) {
          const p = v3(x, s.floorY + HALF.y, z);
          let cnt = 0;
          for (const e of es) {
            const m = enemyMuzzle(e.pos);
            if (dist(m, p) <= ENEMIES[e.kind].sensorRange && !worldClosed.segmentBlocked(m, p)) cnt++;
          }
          best = Math.max(best, cnt);
        }
      }
      if (best >= 4) qualifying++;
    }
    expect(qualifying).toBeGreaterThanOrEqual(5);
  });
});

describe('接続(portal)と隔壁', () => {
  /** portal の開口を貫く経路(軸方向に前後6mずつ) */
  function lanes(p: (typeof stage.portals)[number]): { start: V3; delta: V3 }[] {
    const axis = PORTAL_AXIS[p.id];
    const out: { start: V3; delta: V3 }[] = [];
    const latHalf = p.width / 2 - (axis === 'x' ? HALF.z : HALF.x);
    const vHalf = p.height / 2 - HALF.y;
    for (const o of [-latHalf, 0, latHalf]) {
      for (const oy of [-vHalf, 0, vHalf]) {
        const c = axis === 'x' ? v3(p.center.x, p.center.y + oy, p.center.z + o) : v3(p.center.x + o, p.center.y + oy, p.center.z);
        out.push(axis === 'x' ? { start: v3(c.x - 6, c.y, c.z), delta: v3(12, 0, 0) } : { start: v3(c.x, c.y, c.z - 6), delta: v3(0, 0, 12) });
      }
    }
    return out;
  }

  it('portalは両区画の共有面にあり、寸法は幅>=8m・高さ>=7m(SPEC)で、開いた状態で全レーンが通れる', () => {
    expect(stage.portals.length).toBeGreaterThanOrEqual(15);
    for (const p of stage.portals) {
      const a = stage.sectors.find((s) => s.id === p.a);
      const b = stage.sectors.find((s) => s.id === p.b);
      expect(a && b, `${p.id}: sectors`).toBeTruthy();
      const A = (a as (typeof stage.sectors)[number]).bounds;
      const B = (b as (typeof stage.sectors)[number]).bounds;
      const axis = PORTAL_AXIS[p.id];
      const plane = axis === 'x' ? p.center.x : p.center.z;
      const key = axis === 'x' ? 'x' : 'z';
      const shared = (Math.abs(A.max[key] - plane) < 1e-9 && Math.abs(B.min[key] - plane) < 1e-9) || (Math.abs(A.min[key] - plane) < 1e-9 && Math.abs(B.max[key] - plane) < 1e-9);
      expect(shared, `${p.id} plane ${plane}`).toBe(true);
      expect(p.width).toBeGreaterThanOrEqual(8);
      expect(p.height).toBeGreaterThanOrEqual(7);
      for (const l of lanes(p)) expect(sweepFree(worldOpen, l.start, l.delta), `${p.id} lane ${JSON.stringify(l.start)}`).toBe(true);
    }
    // 宣言されたportal以外に区画間の開口がない: 各区画の壁のうち通れる所は宣言portalの開口だけ(壁の全高テストで確認済み)
    const declared = new Set(stage.portals.map((p) => p.id));
    expect(declared.size).toBe(stage.portals.length);
  });

  it('隔壁(B1..B6, GATE): 箱で開口を完全に塞ぎ、開くと通れる。見た目=衝突(箱そのもの)', () => {
    expect(stage.barriers.map((b) => b.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'GATE']);
    expect(stage.barriers.filter((b) => b.isFinal).map((b) => b.id)).toEqual(['GATE']);
    for (const br of stage.barriers) {
      const portals = stage.portals.filter((p) => p.barrierId === br.id);
      expect(portals.length, `${br.id} portals`).toBeGreaterThanOrEqual(1);
      const tagged = stage.boxes.filter((b) => b.barrierId === br.id).map((b) => b.id).sort();
      expect(br.boxIds.slice().sort()).toEqual(tagged);
      expect(tagged.length).toBeGreaterThan(0);
      for (const id of br.boxIds) expect(['barrier', 'gate']).toContain(stage.boxes.find((b) => b.id === id)?.mat);
      for (const p of portals) {
        const closedOnly = new World(br.boxIds.map((id) => stage.boxes.find((b) => b.id === id) as BoxDef));
        for (const l of lanes(p)) {
          expect(sweepFree(closedOnly, l.start, l.delta), `${br.id} leaks at ${JSON.stringify(l.start)}`).toBe(false);
          expect(sweepFree(worldClosed, l.start, l.delta), `${br.id} closed world lane`).toBe(false);
        }
        // 隔壁は次の進行方向(p.a→p.b)の開口を塞ぐ: 箱は開口の外形と同じ幅・高さ
        const box = stage.boxes.find((b) => b.id === br.boxIds[0]) as BoxDef;
        const axis = PORTAL_AXIS[p.id];
        const lat = axis === 'x' ? [box.min.z, box.max.z] : [box.min.x, box.max.x];
        const c = axis === 'x' ? p.center.z : p.center.x;
        expect(lat[0]).toBeCloseTo(c - p.width / 2, 9);
        expect(lat[1]).toBeCloseTo(c + p.width / 2, 9);
        expect(box.min.y).toBeCloseTo(p.center.y - p.height / 2, 9);
        expect(box.max.y).toBeCloseTo(p.center.y + p.height / 2, 9);
      }
      expect(br.isFinal ? br.controlEnemyId : 'ctl').toBe(br.isFinal ? null : 'ctl');
      if (!br.isFinal) expect(stage.enemies.find((e) => e.id === br.controlEnemyId)?.barrierId).toBe(br.id);
    }
  });

  it('制御砲台は自分の隔壁を射線に捉えられる位置にある(隔壁の手前の攻略区間内)', () => {
    for (const br of stage.barriers.filter((b) => !b.isFinal)) {
      const e = stage.enemies.find((x) => x.id === br.controlEnemyId) as (typeof stage.enemies)[number];
      const portal = stage.portals.find((p) => p.barrierId === br.id) as (typeof stage.portals)[number];
      expect(portal.a, `${br.id}: turret is not in the sector before the barrier`).toBe(e.sectorId);
      const m = enemyMuzzle(e.pos);
      const box = stage.boxes.find((b) => b.id === br.boxIds[0]) as BoxDef;
      // 隔壁の手前側の面(a区画側)の中心を狙う
      const axis = PORTAL_AXIS[portal.id];
      const sec = stage.sectors.find((x) => x.id === portal.a) as (typeof stage.sectors)[number];
      const inset = 0.02;
      const cy = (box.min.y + box.max.y) / 2;
      const target =
        axis === 'x'
          ? v3(Math.abs(sec.bounds.max.x - portal.center.x) < 1e-9 ? box.min.x - inset : box.max.x + inset, cy, (box.min.z + box.max.z) / 2)
          : v3((box.min.x + box.max.x) / 2, cy, Math.abs(sec.bounds.max.z - portal.center.z) < 1e-9 ? box.min.z - inset : box.max.z + inset);
      const d = dist(m, target);
      const dir = v3((target.x - m.x) / d, (target.y - m.y) / d, (target.z - m.z) / d);
      const hit = worldClosed.raycast(m, dir, d + 1);
      expect(hit, `${br.id}: no hit`).not.toBeNull();
      expect(stage.boxes[(hit as { boxIndex: number }).boxIndex].barrierId, `${br.id}: the turret ${e.id} cannot see its barrier (blocked by ${stage.boxes[(hit as { boxIndex: number }).boxIndex].id})`).toBe(br.id);
    }
  });
});

describe('昇降 (飛行が必要な高低差)', () => {
  it('必須の昇降が6か所以上・高低差6〜16m・別々の場所', () => {
    expect(stage.climbs.length).toBeGreaterThanOrEqual(6);
    expect(stage.climbs.length).toBe(CLIMB_SPECS.length);
    const jump = (PLAYER.JUMP_SPEED * PLAYER.JUMP_SPEED) / (2 * 18);
    for (const c of stage.climbs) {
      expect(c.heightMeters).toBeGreaterThanOrEqual(6);
      expect(c.heightMeters).toBeLessThanOrEqual(16);
      expect(c.heightMeters).toBeGreaterThan(jump);
      expect(c.to.y - c.from.y).toBeCloseTo(c.heightMeters, 9);
    }
    for (let i = 0; i < stage.climbs.length; i++) {
      for (let j = i + 1; j < stage.climbs.length; j++) {
        const a = stage.climbs[i];
        const b = stage.climbs[j];
        expect(Math.hypot(a.to.x - b.to.x, a.to.z - b.to.z), `${a.id} vs ${b.id}`).toBeGreaterThan(15);
      }
    }
    expect(new Set(stage.climbs.map((c) => c.sectorId)).size).toBeGreaterThanOrEqual(6);
  });

  it('着地足場(to)は8m四方以上で立てる。離陸側(from)も接地して立てる足場', () => {
    for (const c of stage.climbs) {
      for (const [name, p] of [['to', c.to], ['from', c.from]] as [string, V3][]) {
        const pad = stage.boxes.find((b) => Math.abs(b.max.y - p.y) < 1e-6 && p.x - 4 >= b.min.x && p.x + 4 <= b.max.x && p.z - 4 >= b.min.z && p.z + 4 <= b.max.z);
        expect(pad, `${c.id}.${name} ${JSON.stringify(p)}: no >=8x8 platform top here`).toBeDefined();
        expect(worldOpen.overlapAABB(v3(p.x, p.y + HALF.y + 0.01, p.z), HALF), `${c.id}.${name}: no room to stand`).toBe(false);
      }
      // 着地足場の広さ(上面を持つ最大の箱)
      const top = stage.boxes.filter((b) => Math.abs(b.max.y - c.to.y) < 1e-6 && c.to.x >= b.min.x && c.to.x <= b.max.x && c.to.z >= b.min.z && c.to.z <= b.max.z);
      const area = Math.max(...top.map((b) => (b.max.x - b.min.x) * (b.max.z - b.min.z)));
      expect(area, `${c.id} landing area`).toBeGreaterThanOrEqual(64);
    }
  });

  it('通常ジャンプ(最大2.78m)の踏み台を重ねても from から to の高さへ届かない(近傍の上面を高さ順に積み上げて確認)', () => {
    const jump = (PLAYER.JUMP_SPEED * PLAYER.JUMP_SPEED) / (2 * 18);
    for (const c of stage.climbs) {
      // 立てる上面: 2x2m以上の箱の上面(壁・屋根・隔壁は除く)。fromから水平40m以内にあるものだけを踏み台候補にする(寛容な仮定)
      const surfaces = stage.boxes.filter((b) => {
        if (b.id.includes('-wall-') || b.id.includes('-roof-') || b.barrierId) return false;
        if (b.max.x - b.min.x < 2 || b.max.z - b.min.z < 2) return false;
        const cx = Math.max(b.min.x, Math.min(c.from.x, b.max.x));
        const cz = Math.max(b.min.z, Math.min(c.from.z, b.max.z));
        return Math.hypot(cx - c.from.x, cz - c.from.z) <= 40;
      });
      let reach = c.from.y;
      for (let changed = true; changed; ) {
        changed = false;
        for (const b of surfaces) {
          if (b.max.y > reach + 1e-6 && b.max.y <= reach + jump) {
            reach = b.max.y;
            changed = true;
          }
        }
      }
      expect(c.to.y - reach, `${c.id}: stepping surfaces reach y=${reach}`).toBeGreaterThan(jump);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 経路 (tools/route-probe.ts: 3Dボクセル + sweepAABB検証つきA*)
// ---------------------------------------------------------------------------------------------------------------------
let probeMemo: ReturnType<typeof probeStage> | null = null;
const probe = (): ReturnType<typeof probeStage> => (probeMemo ??= probeStage(stage, { step: 2 }));

/** 折れ線が(全隔壁開放の)実際の衝突で通行可能か */
function polylineFree(pts: V3[]): number {
  for (let i = 1; i < pts.length; i++) {
    if (!sweepFree(worldOpen, pts[i - 1], v3(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z))) return i;
  }
  return -1;
}

describe('経路 (SPEC §2.2)', () => {
  it('スタートから脱出領域までの最短の実行可能経路が1500m以上(目標1800m以上)・12区画以上を通過', () => {
    const r = probe();
    expect(r.length).toBeGreaterThanOrEqual(STAGE.ROUTE_MIN_METERS);
    expect(r.length).toBeGreaterThanOrEqual(1800);
    // 格子の最短の長さ(=上界)を26近傍の最大誤差(約8%)で割っても1500mを超える
    expect(r.gridLength / 1.09).toBeGreaterThan(STAGE.ROUTE_MIN_METERS);
    expect(r.sectors.length).toBeGreaterThanOrEqual(12);
    expect(r.sectors[0]).toBe('S01');
    expect(r.sectors[r.sectors.length - 1]).toBe('S16');
    // 区画の中心間距離や蛇行ではなく、扉から扉への実距離で稼ぐ: 直線距離よりずっと長い
    expect(r.length).toBeGreaterThan(r.straight * 2);
  });

  it('全ての昇降が最短経路の上にある(経路から12m以内)', () => {
    for (const c of probe().climbs) expect(c.pathDistance, `${c.id}`).toBeLessThanOrEqual(12);
  });

  it('分岐が3か所以上: 2経路は別の区画を通り、宣言長さ=折れ線長、実際に通行でき、迂回のほうが長い', () => {
    expect(stage.branches.length).toBeGreaterThanOrEqual(3);
    for (const b of stage.branches) {
      expect(b.routes.length).toBeGreaterThanOrEqual(2);
      const [direct, alt] = b.routes;
      for (const r of b.routes) {
        expect(r.lengthMeters).toBeCloseTo(polyLength(r.points), 1);
        expect(r.lengthMeters, `${r.id} length`).toBeGreaterThanOrEqual(40);
        expect(polylineFree(r.points), `${r.id}: blocked segment`).toBe(-1);
        const secs = sectorsAlong(r.points);
        expect(secs[0]).toBe(b.splitSectorId);
        expect(secs[secs.length - 1]).toBe(b.mergeSectorId);
        expect(secs.filter((x) => x !== b.splitSectorId && x !== b.mergeSectorId).sort()).toEqual([...r.sectorIds].sort());
      }
      // 2経路は同じ始点・終点を共有し、間は別の場所
      expect(dist(direct.points[0], alt.points[0])).toBeLessThan(0.01);
      expect(dist(direct.points[direct.points.length - 1], alt.points[alt.points.length - 1])).toBeLessThan(0.01);
      expect(alt.sectorIds.length).toBeGreaterThanOrEqual(1);
      expect(alt.lengthMeters).toBeGreaterThan(direct.lengthMeters + 20);
    }
    // 宣言の長さは probe が今のジオメトリで求めた長さと一致する(区画内部を変えたら tools/route-probe.ts --emit で更新する)
    for (const pb of probe().branches) {
      const decl = stage.branches.find((x) => x.id === pb.id) as (typeof stage.branches)[number];
      for (const r of pb.routes) {
        const d = decl.routes.find((x) => x.id === r.id) as (typeof decl.routes)[number];
        expect(Math.abs(r.length - d.lengthMeters), `${r.id}: probe ${r.length.toFixed(1)} vs declared ${d.lengthMeters}`).toBeLessThan(1);
      }
    }
  });

  it('環状経路が2か所以上: 始点に戻り、単純な往復ではない', () => {
    expect(stage.loops.length).toBeGreaterThanOrEqual(2);
    for (const l of stage.loops) {
      expect(dist(l.points[0], l.points[l.points.length - 1])).toBeLessThan(3);
      expect(polylineFree(l.points), `${l.id}`).toBe(-1);
      expect(polyLength(l.points)).toBeGreaterThanOrEqual(80);
      // 前半の点が後半の折れ線から6m以上離れている割合(往復なら0)
      const half = Math.floor(l.points.length / 2);
      const first = l.points.slice(0, half + 1);
      const second = l.points.slice(half);
      let apart = 0;
      let n = 0;
      for (const p of first) {
        n++;
        let best = Infinity;
        for (let i = 1; i < second.length; i++) {
          const a = second[i - 1];
          const b = second[i];
          const ab = v3(b.x - a.x, b.y - a.y, b.z - a.z);
          const l2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z || 1;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / l2));
          best = Math.min(best, dist(p, v3(a.x + ab.x * t, a.y + ab.y * t, a.z + ab.z * t)));
        }
        if (best > 6) apart++;
      }
      expect(apart / n, `${l.id} retraces itself`).toBeGreaterThan(0.3);
    }
  });

  it('mainRoute の折れ線: スタートから脱出領域まで、全隔壁を開けた実際の衝突で通行でき、1500m以上', () => {
    const mr = stage.mainRoute;
    expect(dist(mr.points[0], stage.playerStart.pos)).toBeLessThan(0.01);
    const last = mr.points[mr.points.length - 1];
    const z = stage.escapeZone;
    expect(last.x >= z.min.x && last.x <= z.max.x && last.y >= z.min.y && last.y <= z.max.y && last.z >= z.min.z && last.z <= z.max.z).toBe(true);
    expect(polylineFree(mr.points), 'main route is blocked').toBe(-1);
    expect(polyLength(mr.points)).toBeGreaterThanOrEqual(1800);
    expect(mr.sectorIds.length).toBeGreaterThanOrEqual(12);
  });

  it('隔壁を1つだけ閉じると脱出領域に着けない(全て必須)・全隔壁を開けても外周から出られない', () => {
    for (const r of barrierCuts(stage, 2)) expect(r.goalReachable, `${r.id} can be bypassed`).toBe(false);
    const leak = perimeterLeak(stage, 2);
    expect(leak.reachable).toBeGreaterThan(100000);
    expect(leak.outside).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('kit の規約', () => {
  it('自区画のbounds外・portal前面・戦闘区画のARENA_CLEARには置けない。IDは自動採番', () => {
    const sb = new StageBuilder();
    const k4 = sb.kit('S04');
    expect(() => k4.box('x', 0, 0, 0, 10, 10, 10)).toThrow(/leaves the sector bounds/);
    const k1 = sb.kit('S01');
    k1.buildShell();
    expect(() => k1.fbox('block', 60, 115, 68, 125, 3)).toThrow(/blocks the approach to portal P01/);
    const k2 = sb.kit('S02');
    expect(() => k2.crate('c', 100, 60, 4, 4, 3)).toThrow(/arena/);
    const a = k1.crate('crate', 40, 90, 3, 3, 2);
    const b = k1.crate('crate', 46, 90, 3, 3, 2);
    expect(a.id).toBe('S01-crate-1');
    expect(b.id).toBe('S01-crate-2');
    const g1 = k1.guard(30, 100);
    const g2 = k1.guard(31, 100);
    expect([g1.id, g2.id]).toEqual(['G01', 'G02']);
    const t = sb.kit('S02').turret(100, 6, 5, { control: 0 });
    expect(t.id).toBe('T01');
    expect(t.barrierId).toBe('B1');
    expect(() => sb.kit('S02').turret(190, 132, 5, { control: 0 })).toThrow(/defined twice/);
  });

  it('予約空間(RESERVED)・プリミティブ(catwalk/pipe/boxC/decor/climbPads)の挙動', () => {
    const sb = new StageBuilder();
    // 昇降C1の離陸位置の真上・分岐アンカー・出撃位置には置けない
    const k4 = sb.kit('S04');
    expect(() => k4.crate('c', 352, 100, 3, 3, 3)).toThrow(/reserved space "C1.column"/);
    expect(() => sb.kit('S02').crate('c', 80, 112, 3, 3, 3)).toThrow(/reserved space "BR1-direct.start"/);
    expect(() => sb.kit('S01').crate('c', 12, 14, 3, 3, 3)).toThrow(/reserved space "start"/);
    // catwalk: 足場 + 指定辺の手すり(高さ1.2m)
    const k12 = sb.kit('S12');
    const deck = k12.catwalk('cw', 20, 400, 60, 420, 12, ['n', 's']);
    expect(deck.max.y).toBe(12);
    const rails = sb.boxes.filter((b) => b.id.startsWith('S12-cw-rail-'));
    expect(rails.length).toBe(2);
    for (const r of rails) expect(r.max.y - r.min.y).toBeCloseTo(1.2, 9);
    // pipe: 断面3m以下だけ円柱ヒント(衝突は外接AABB)。太いものは箱(見た目=衝突)
    const p = k12.pipe('pp', 'x', 20, 5, 396, 60, 8, 399);
    expect(p.shape).toBe('cylX');
    expect(k12.pipe('fat', 'y', 20, 0, 424, 30, 10, 428).shape).toBeUndefined();
    // 描画メッシュは BoxDef と一致する: 円柱ヒントの箱は全て断面3m以下
    for (const b of stage.boxes) {
      if (!b.shape || b.shape === 'box') continue;
      const d = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
      const axisIdx = b.shape === 'cylX' ? 0 : b.shape === 'cylY' ? 1 : 2;
      expect(Math.max(...d.filter((_, i) => i !== axisIdx)), `${b.id} cylinder hint on a fat box`).toBeLessThanOrEqual(3 + 1e-9);
    }
    const c = k12.boxC('bc', 100, 6, 402, 4, 4, 4);
    expect(c.min.x).toBe(98);
    expect(c.max.y).toBe(8);
    expect(c.min.z).toBe(400);
    // decor は衝突箱に入らない
    const before = sb.boxes.length;
    const d = k12.decor('lamp', 2, 20, 350, 3, 22, 350.1, 'lightPanel', { emissive: 1 });
    expect(sb.boxes.length).toBe(before);
    expect(sb.decor).toContain(d);
    // 昇降の足場: to(上)を作る。solid は下を床まで詰める
    k12.climbPads('C5', [], false, true);
    const m = sb.boxes.find((b) => b.id === 'S12-pad-C5-to-1') as BoxDef;
    expect(m.min.y).toBe(0);
    expect(m.max.y).toBe(12);
    expect(() => sb.kit('S04').climbPads('C5')).toThrow(/does not belong/);
  });

  it('buildStage() は毎回同じ内容で、返した値を書き換えても次の呼び出しに影響しない', () => {
    const a = buildStage();
    const b = buildStage();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    a.sectors[0].name = 'changed';
    a.enemies[0].pos.x = 12345;
    a.mainRoute.points[0].x = 999;
    const c = buildStage();
    expect(c.sectors[0].name).not.toBe('changed');
    expect(c.enemies[0].pos.x).not.toBe(12345);
    expect(c.mainRoute.points[0].x).not.toBe(999);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 実際の Game (objective.ts) で 制御砲台 → 隔壁 → 最終ゲート → クリア を通す
// ---------------------------------------------------------------------------------------------------------------------
describe('進行 (実際のGame)', () => {
  it('出撃時はS01。制御砲台を1体ずつ倒すと対応する隔壁の箱が消えて通れるようになり、6体でGATEが開き、脱出領域に入るとクリア', () => {
    const game = new Game({ stage: buildStage() });
    game.sortie();
    game.step();
    const st = game.state;
    expect(st.mode).toBe('playing');
    expect(st.progress.currentSectorId).toBe('S01');
    expect(st.enemies.length).toBe(45);
    for (let i = 0; i < 6; i++) {
      const barrier = st.stage.barriers.find((b) => b.id === `B${i + 1}`) as (typeof stage.barriers)[number];
      const portal = st.stage.portals.find((p) => p.barrierId === barrier.id) as (typeof stage.portals)[number];
      const blockedBefore = lanes2(portal).every((l) => !sweepFree(game.world, l.start, l.delta));
      expect(blockedBefore, `${barrier.id} closed`).toBe(true);
      const turret = st.enemies.find((e) => e.controlIndex === i) as (typeof st.enemies)[number];
      turret.hp = 0;
      turret.alive = false;
      game.step();
      expect(st.objective.openBarrierIds).toContain(barrier.id);
      expect(st.objective.controlsDestroyed).toBe(i + 1);
      for (const id of barrier.boxIds) expect(game.world.isBoxEnabled(game.world.indexOfBox(id))).toBe(false);
      expect(lanes2(portal).some((l) => sweepFree(game.world, l.start, l.delta)), `${barrier.id} open`).toBe(true);
      // まだ最終ゲートは閉じている
      if (i < 5) expect(st.objective.gateOpen).toBe(false);
    }
    expect(st.objective.gateOpen).toBe(true);
    const gate = st.stage.barriers.find((b) => b.isFinal) as (typeof stage.barriers)[number];
    for (const id of gate.boxIds) expect(game.world.isBoxEnabled(game.world.indexOfBox(id))).toBe(false);
    // 脱出領域に入るとクリア
    const z = st.stage.escapeZone;
    st.player.pos = v3((z.min.x + z.max.x) / 2, z.min.y + HALF.y + 0.01, (z.min.z + z.max.z) / 2);
    st.player.prevPos = { ...st.player.pos };
    game.step();
    expect(st.mode).toBe('cleared');
    expect(st.endReason).toBe('escaped');
  });

  it('最終ゲートが閉じたまま脱出領域に入ってもクリアにならない', () => {
    const game = new Game({ stage: buildStage() });
    game.sortie();
    const st = game.state;
    const z = st.stage.escapeZone;
    st.player.pos = v3((z.min.x + z.max.x) / 2, z.min.y + HALF.y + 0.01, (z.min.z + z.max.z) / 2);
    st.player.prevPos = { ...st.player.pos };
    game.step();
    expect(st.mode).toBe('playing');
  });

  it('区画追跡: 主経路に沿って移動すると訪れた区画が S01→S16 の順に記録される', () => {
    const game = new Game({ stage: buildStage() });
    game.sortie();
    const st = game.state;
    const seen: string[] = [];
    for (const p of stage.mainRoute.points) {
      st.player.pos = { ...p };
      game.step();
      st.player.hp = 1000; // 敵AIの被弾でテストが終わらないようにする(区画追跡だけを見る)
      if (st.mode !== 'playing') break;
      const cur = st.progress.currentSectorId;
      if (cur && seen[seen.length - 1] !== cur) seen.push(cur);
    }
    for (const id of ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15']) expect(st.progress.visitedSectorIds).toContain(id);
  });
});

function lanes2(p: (typeof stage.portals)[number]): { start: V3; delta: V3 }[] {
  const axis = PORTAL_AXIS[p.id];
  const latHalf = p.width / 2 - (axis === 'x' ? HALF.z : HALF.x);
  const vHalf = p.height / 2 - HALF.y;
  const out: { start: V3; delta: V3 }[] = [];
  for (const o of [-latHalf, 0, latHalf]) {
    for (const oy of [-vHalf, 0, vHalf]) {
      const c = axis === 'x' ? v3(p.center.x, p.center.y + oy, p.center.z + o) : v3(p.center.x + o, p.center.y + oy, p.center.z);
      out.push(axis === 'x' ? { start: v3(c.x - 6, c.y, c.z), delta: v3(12, 0, 0) } : { start: v3(c.x, c.y, c.z - 6), delta: v3(0, 0, 12) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
describe('厳密検証器(stagecheck) との突き合わせ', () => {
  it('validateStage が全ての必須チェックに合格(飛行昇降は最悪構成: 4脚+高回復 と 2脚+大容量 のbotで確認)', () => {
    const loadouts: Loadout[] = [
      { fcs: 'medium', generator: 'recovery', legs: 'quadruped' },
      { fcs: 'wide', generator: 'capacity', legs: 'biped' },
    ];
    const report = validateStage(stage, { loadouts });
    const failed = report.checks.filter((c) => !c.pass && !c.advisory).map((c) => `${c.name}: ${c.details}`);
    expect(failed).toEqual([]);
    expect(report.route.length).toBeGreaterThanOrEqual(1800);
    for (const c of report.climbs) {
      expect(c.allConfigsOk, `${c.id}`).toBe(true);
      expect(c.maxEnUsed).toBeLessThan(c.minMaxEn);
    }
  });
});
