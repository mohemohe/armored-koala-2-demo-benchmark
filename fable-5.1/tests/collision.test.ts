/**
 * 幾何プリミティブ（src/sim/geom.ts）と衝突ワールド（src/sim/collision.ts）の試験。
 * ブロードフェーズの正しさは、このファイル内の総当たり実装と比較して検証する。
 */
import { describe, expect, it } from 'vitest';
import { SIM } from '../src/params';
import { CELL_SIZE, CONTACT_MARGIN, createCollisionWorld } from '../src/sim/collision';
import {
  aabbOverlap,
  expandAABB,
  rayAABB,
  raySphere,
  segmentAABB,
  sweptSphereVsMovingBox,
  sweptSphereVsMovingSphere,
} from '../src/sim/geom';
import { Rng } from '../src/sim/rng';
import { addScaled, distance, length, normalize, sub } from '../src/sim/vec';
import type { AABB, CollisionWorld, MoveResult, RayHit, Vec3 } from '../src/types';

const box = (min: Vec3, max: Vec3): AABB => ({ min: [...min] as Vec3, max: [...max] as Vec3 });
const unit = box([-1, -1, -1], [1, 1, 1]);

// ---------------------------------------------------------------------------
// 総当たりの参照実装（グリッドを使わない）
// ---------------------------------------------------------------------------

function bruteRaycast(world: CollisionWorld, origin: Vec3, dir: Vec3, maxDist: number): RayHit | null {
  let best: RayHit | null = null;
  for (const e of world.colliders()) {
    const h = rayAABB(origin, dir, e.box, maxDist);
    if (h && (best === null || h.t < best.t)) {
      best = { t: h.t, point: addScaled(origin, dir, h.t), normal: h.normal, colliderId: e.id, tag: e.tag };
    }
  }
  return best;
}

function bruteSegmentBlocked(world: CollisionWorld, a: Vec3, b: Vec3): boolean {
  for (const e of world.colliders()) if (segmentAABB(a, b, e.box)) return true;
  return false;
}

/** 掃引球: 拡張 AABB に対して rayAABB（距離ベース）で解き、割合へ変換する（実装とは別経路） */
function bruteSweep(world: CollisionWorld, a: Vec3, b: Vec3, r: number): { t: number; colliderId: number } | null {
  const d = sub(b, a);
  const len = length(d);
  const dir = normalize(d);
  let best: { t: number; colliderId: number } | null = null;
  for (const e of world.colliders()) {
    const h = rayAABB(a, dir, expandAABB(e.box, r), len);
    if (!h) continue;
    const t = len > 0 ? h.t / len : 0;
    if (best === null || t < best.t) best = { t, colliderId: e.id };
  }
  return best;
}

function bruteMoveBox(world: CollisionWorld, center: Vec3, half: Vec3, delta: Vec3): MoveResult {
  const c: Vec3 = [...center] as Vec3;
  const res: MoveResult = { position: c, hitNegX: false, hitPosX: false, hitNegY: false, hitPosY: false, hitNegZ: false, hitPosZ: false };
  for (const axis of [1, 0, 2] as const) {
    const d = delta[axis];
    if (d === 0) continue;
    const others = [0, 1, 2].filter((k) => k !== axis);
    let move = d;
    let hit = false;
    for (const e of world.colliders()) {
      const ok = others.every((k) => c[k] - half[k] < e.box.max[k] && c[k] + half[k] > e.box.min[k]);
      if (!ok) continue;
      const lo = c[axis] - half[axis];
      const hi = c[axis] + half[axis];
      if (lo < e.box.max[axis] && hi > e.box.min[axis]) continue;
      if (d > 0 && e.box.min[axis] >= hi) {
        const allowed = Math.max(0, e.box.min[axis] - hi - CONTACT_MARGIN);
        if (e.box.min[axis] - hi - CONTACT_MARGIN < move) {
          move = allowed;
          hit = true;
        }
      } else if (d < 0 && e.box.max[axis] <= lo) {
        const allowed = Math.max(0, lo - e.box.max[axis] - CONTACT_MARGIN);
        if (lo - e.box.max[axis] - CONTACT_MARGIN < -move) {
          move = -allowed;
          hit = true;
        }
      }
    }
    c[axis] += move;
    if (hit) {
      if (axis === 0) d > 0 ? (res.hitPosX = true) : (res.hitNegX = true);
      else if (axis === 1) d > 0 ? (res.hitPosY = true) : (res.hitNegY = true);
      else d > 0 ? (res.hitPosZ = true) : (res.hitNegZ = true);
    }
  }
  return res;
}

function randomDir(rng: Rng): Vec3 {
  for (;;) {
    const v: Vec3 = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)];
    const l = length(v);
    if (l > 0.1 && l <= 1) return normalize(v);
  }
}

function randomWorld(rng: Rng, count: number, extent: number): CollisionWorld {
  const world = createCollisionWorld();
  for (let i = 0; i < count; i++) {
    const cx = rng.range(-extent, extent);
    const cz = rng.range(-extent, extent);
    const cy = rng.range(-10, 60);
    const sx = rng.range(0.25, 10);
    const sy = rng.range(0.25, 10);
    const sz = rng.range(0.25, 10);
    world.addCollider(box([cx - sx, cy - sy, cz - sz], [cx + sx, cy + sy, cz + sz]), i % 7 === 0 ? 'tagged' : undefined);
  }
  return world;
}

// ---------------------------------------------------------------------------
// geom.ts
// ---------------------------------------------------------------------------

describe('rayAABB', () => {
  it('hits the -X face from outside with the correct t and normal', () => {
    const h = rayAABB([-5, 0, 0], [1, 0, 0], unit, 100);
    expect(h).not.toBeNull();
    expect(h!.t).toBeCloseTo(4, 12);
    expect(h!.normal).toEqual([-1, 0, 0]);
  });

  it('hits the +Y face when coming from above', () => {
    const h = rayAABB([0.2, 10, -0.3], [0, -1, 0], unit, 100);
    expect(h!.t).toBeCloseTo(9, 12);
    expect(h!.normal).toEqual([0, 1, 0]);
  });

  it('hits the +Z face when coming from +Z diagonally', () => {
    const dir = normalize([-0.2, 0.1, -1]);
    const h = rayAABB([0.5, 0.2, 6], dir, unit, 100);
    expect(h).not.toBeNull();
    const p = addScaled([0.5, 0.2, 6], dir, h!.t);
    expect(p[2]).toBeCloseTo(1, 12);
    expect(h!.normal).toEqual([0, 0, 1]);
  });

  it('misses when the ray passes beside the box', () => {
    expect(rayAABB([-5, 2, 0], [1, 0, 0], unit, 100)).toBeNull();
    expect(rayAABB([-5, 0, 1.5], [1, 0, 0], unit, 100)).toBeNull();
  });

  it('misses when the box is behind the origin', () => {
    expect(rayAABB([5, 0, 0], [1, 0, 0], unit, 100)).toBeNull();
  });

  it('misses when the box is beyond maxDist', () => {
    expect(rayAABB([-5, 0, 0], [1, 0, 0], unit, 3.9)).toBeNull();
    expect(rayAABB([-5, 0, 0], [1, 0, 0], unit, 4.0)).not.toBeNull();
  });

  it('returns t=0 with a normal opposing the dominant direction axis when the origin is inside', () => {
    const h = rayAABB([0.1, 0.2, 0.3], normalize([0.2, 0.9, -0.1]), unit, 100);
    expect(h!.t).toBe(0);
    expect(h!.normal).toEqual([0, -1, 0]);
    const h2 = rayAABB([0, 0, 0], [0, 0, -1], unit, 100);
    expect(h2!.t).toBe(0);
    expect(h2!.normal).toEqual([0, 0, 1]);
  });

  it('returns t=0 with the face normal when the origin is on a face and entering', () => {
    const h = rayAABB([-1, 0, 0], [1, 0, 0], unit, 100);
    expect(h!.t).toBe(0);
    expect(h!.normal).toEqual([-1, 0, 0]);
  });

  it('returns null when the origin is on a face and leaving', () => {
    expect(rayAABB([1, 0, 0], [1, 0, 0], unit, 100)).toBeNull();
  });

  it('handles rays parallel to an axis outside the slab', () => {
    expect(rayAABB([-5, 1.0001, 0], [1, 0, 0], unit, 100)).toBeNull();
    expect(rayAABB([-5, 1, 0], [1, 0, 0], unit, 100)).not.toBeNull(); // 境界は接触扱い
  });
});

describe('raySphere', () => {
  it('returns the distance to the first intersection', () => {
    expect(raySphere([-10, 0, 0], [1, 0, 0], [0, 0, 0], 2, 100)).toBeCloseTo(8, 12);
  });
  it('returns 0 when the origin is inside', () => {
    expect(raySphere([0.5, 0, 0], [1, 0, 0], [0, 0, 0], 2, 100)).toBe(0);
  });
  it('returns null when missing, behind, or beyond maxDist', () => {
    expect(raySphere([-10, 2.5, 0], [1, 0, 0], [0, 0, 0], 2, 100)).toBeNull();
    expect(raySphere([10, 0, 0], [1, 0, 0], [0, 0, 0], 2, 100)).toBeNull();
    expect(raySphere([-10, 0, 0], [1, 0, 0], [0, 0, 0], 2, 7.9)).toBeNull();
  });
  it('tangent ray touches the sphere', () => {
    const d = raySphere([-10, 2, 0], [1, 0, 0], [0, 0, 0], 2, 100);
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo(10, 6);
  });
});

describe('segmentAABB', () => {
  it('detects crossing, containment and misses', () => {
    expect(segmentAABB([-5, 0, 0], [5, 0, 0], unit)).toBe(true);
    expect(segmentAABB([-5, 0, 0], [-2, 0, 0], unit)).toBe(false);
    expect(segmentAABB([0, 0, 0], [0.5, 0.5, 0.5], unit)).toBe(true);
    expect(segmentAABB([-5, 3, 0], [5, 3, 0], unit)).toBe(false);
    expect(segmentAABB([-5, -5, 0], [5, 5, 0], unit)).toBe(true);
  });
});

describe('sweptSphereVsMovingSphere', () => {
  it('head-on: static target', () => {
    // 弾 r=0.1 が x=-10 → x=10、対象 R=0.5 が原点で静止。接触は |x| = 0.6 → x=-0.6 → t = 9.4/20
    const t = sweptSphereVsMovingSphere([-10, 0, 0], [10, 0, 0], 0.1, [0, 0, 0], [0, 0, 0], 0.5);
    expect(t).toBeCloseTo(9.4 / 20, 12);
  });

  it('head-on: target moving toward the bullet', () => {
    // 対象が x=5 → x=3（-2 の変位）。相対では弾が 22 進む: 接触点は相対距離 15-0.6 = 14.4 → t = 14.4/22
    const t = sweptSphereVsMovingSphere([-10, 0, 0], [10, 0, 0], 0.1, [5, 0, 0], [3, 0, 0], 0.5);
    expect(t).toBeCloseTo(14.4 / 22, 12);
    // 実際の位置で検証: 弾 x(t) = -10 + 20t, 対象 x(t) = 5 - 2t, 距離 = 0.6
    const bx = -10 + 20 * t!;
    const tx = 5 - 2 * t!;
    expect(Math.abs(bx - tx)).toBeCloseTo(0.6, 10);
  });

  it('crossing: target moves perpendicular and is hit at the intersection', () => {
    // 弾は z 軸方向に 0→20 (t で 20t)。対象は x: -10 → +10 (x = -10+20t) を z=10 で横切る。t=0.5 で両者 (0,0,10)
    const t = sweptSphereVsMovingSphere([0, 0, 0], [0, 0, 20], 0.1, [-10, 0, 10], [10, 0, 10], 0.5);
    expect(t).not.toBeNull();
    // 接触時刻は 0.5 より少し前、相対速度 (−20, 0, 20)·長さ 28.28 で距離 0.6 手前
    const b: Vec3 = [0, 0, 20 * t!];
    const c: Vec3 = [-10 + 20 * t!, 0, 10];
    expect(distance(b, c)).toBeCloseTo(0.6, 10);
    expect(t!).toBeLessThan(0.5);
    expect(t!).toBeGreaterThan(0.45);
  });

  it('moving away → null', () => {
    expect(sweptSphereVsMovingSphere([2, 0, 0], [10, 0, 0], 0.1, [0, 0, 0], [0, 0, 0], 0.5)).toBeNull();
    // 同じ速度で並走（相対運動なし）
    expect(sweptSphereVsMovingSphere([2, 0, 0], [10, 0, 0], 0.1, [0, 0, 0], [8, 0, 0], 0.5)).toBeNull();
  });

  it('miss when passing beside the target', () => {
    expect(sweptSphereVsMovingSphere([-10, 0.7, 0], [10, 0.7, 0], 0.1, [0, 0, 0], [0, 0, 0], 0.5)).toBeNull();
    expect(sweptSphereVsMovingSphere([-10, 0.59, 0], [10, 0.59, 0], 0.1, [0, 0, 0], [0, 0, 0], 0.5)).not.toBeNull();
  });

  it('already overlapping → 0', () => {
    expect(sweptSphereVsMovingSphere([0.2, 0, 0], [10, 0, 0], 0.1, [0, 0, 0], [0, 0, 0], 0.5)).toBe(0);
  });

  it('starts touching → 0', () => {
    expect(sweptSphereVsMovingSphere([0.6, 0, 0], [-10, 0, 0], 0.1, [0, 0, 0], [0, 0, 0], 0.5)).toBe(0);
  });

  it('contact beyond the segment end → null', () => {
    expect(sweptSphereVsMovingSphere([-10, 0, 0], [-2, 0, 0], 0.1, [0, 0, 0], [0, 0, 0], 0.5)).toBeNull();
  });

  it('fast bullet vs fast target in one 1/120 step is still detected', () => {
    const h = SIM.maxStep;
    // 弾 100 m/s (+z)、対象 30 m/s (−z)、区間の途中で交差
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 100 * h];
    const prev: Vec3 = [0, 0, 0.5];
    const cur: Vec3 = [0, 0, 0.5 - 30 * h];
    const t = sweptSphereVsMovingSphere(a, b, 0.08, prev, cur, 0.5);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(0);
    expect(t!).toBeLessThanOrEqual(1);
  });
});

describe('sweptSphereVsMovingBox', () => {
  it('static box head-on: t and normal', () => {
    // 球 r=0.2、箱 half 1 at origin。接触面 x = -1.2 → t = (10-1.2)/20
    const h = sweptSphereVsMovingBox([-10, 0, 0], [10, 0, 0], 0.2, [0, 0, 0], [0, 0, 0], [1, 1, 1]);
    expect(h).not.toBeNull();
    expect(h!.t).toBeCloseTo(8.8 / 20, 12);
    expect(h!.normal).toEqual([-1, 0, 0]);
  });

  it('moving box: relative motion', () => {
    // 箱が x=5 → x=3 へ動く（弾に向かう）。相対で弾は 22 進む: 接触 (5-1.2) - (-10) = 13.8 → t = 13.8/22
    const h = sweptSphereVsMovingBox([-10, 0, 0], [10, 0, 0], 0.2, [5, 0, 0], [3, 0, 0], [1, 1, 1]);
    expect(h!.t).toBeCloseTo(13.8 / 22, 12);
    expect(h!.normal).toEqual([-1, 0, 0]);
  });

  it('box moving out of the way → null', () => {
    // 弾は z 方向へ、箱は x 方向へ十分速く逃げる
    expect(sweptSphereVsMovingBox([0, 0, -10], [0, 0, 10], 0.2, [0, 0, 0], [30, 0, 0], [1, 1, 1])).toBeNull();
  });

  it('box moving into the path (crossing) → hit', () => {
    // 弾は z 方向 −10 → 10（t=0.5 で原点）。箱は x=-6 → x=6 に横切る（t=0.5 で原点）
    const h = sweptSphereVsMovingBox([0, 0, -10], [0, 0, 10], 0.2, [-6, 0, 0], [6, 0, 0], [1, 1, 1]);
    expect(h).not.toBeNull();
    expect(h!.t).toBeGreaterThan(0.3);
    expect(h!.t).toBeLessThan(0.5);
  });

  it('already overlapping → t=0', () => {
    const h = sweptSphereVsMovingBox([0.5, 0, 0], [10, 0, 0], 0.2, [0, 0, 0], [0, 0, 0], [1, 1, 1]);
    expect(h!.t).toBe(0);
  });
});

describe('expandAABB / aabbOverlap', () => {
  it('expands and tests strict overlap', () => {
    const e = expandAABB(unit, 0.5);
    expect(e.min).toEqual([-1.5, -1.5, -1.5]);
    expect(e.max).toEqual([1.5, 1.5, 1.5]);
    expect(aabbOverlap(unit, box([0.5, 0.5, 0.5], [3, 3, 3]))).toBe(true);
    expect(aabbOverlap(unit, box([1, -1, -1], [3, 1, 1]))).toBe(false); // 接触は重なりではない
    expect(aabbOverlap(unit, box([1.1, -1, -1], [3, 1, 1]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collision.ts
// ---------------------------------------------------------------------------

describe('CollisionWorld basics', () => {
  it('add/remove/has/colliders/bounds', () => {
    const w = createCollisionWorld();
    expect(w.bounds()).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
    expect(w.colliders()).toHaveLength(0);
    const a = w.addCollider(box([-10, -1, -10], [10, 0, 10]), 'floor');
    const b = w.addCollider(box([20, 0, 20], [21, 5, 30]));
    expect(a).not.toBe(b);
    expect(w.hasCollider(a)).toBe(true);
    expect(w.colliders()).toHaveLength(2);
    expect(w.colliders().find((e) => e.id === a)?.tag).toBe('floor');
    expect(w.bounds()).toEqual({ min: [-10, -1, -10], max: [21, 5, 30] });
    w.removeCollider(a);
    expect(w.hasCollider(a)).toBe(false);
    expect(w.colliders()).toHaveLength(1);
    expect(w.bounds()).toEqual({ min: [20, 0, 20], max: [21, 5, 30] });
    w.removeCollider(a); // 二重削除は無害
    expect(w.colliders()).toHaveLength(1);
  });

  it('does not keep a reference to the caller AABB', () => {
    const w = createCollisionWorld();
    const b = box([0, 0, 0], [1, 1, 1]);
    w.addCollider(b);
    b.max[0] = 100;
    expect(w.raycast([50, 0.5, 0.5], [-1, 0, 0], 100)!.t).toBeCloseTo(49, 12);
  });

  it('raycast returns the nearest hit with point, normal, id and tag', () => {
    const w = createCollisionWorld();
    const near = w.addCollider(box([5, -1, -1], [6, 1, 1]), 'near');
    w.addCollider(box([8, -1, -1], [9, 1, 1]), 'far');
    const h = w.raycast([0, 0, 0], [1, 0, 0], 100);
    expect(h).not.toBeNull();
    expect(h!.t).toBeCloseTo(5, 12);
    expect(h!.colliderId).toBe(near);
    expect(h!.tag).toBe('near');
    expect(h!.normal).toEqual([-1, 0, 0]);
    expect(h!.point[0]).toBeCloseTo(5, 12);
    expect(w.raycast([0, 0, 0], [1, 0, 0], 4)).toBeNull();
    expect(w.raycast([0, 0, 0], [-1, 0, 0], 100)).toBeNull();
  });

  it('raycast across many cells (long ray) hits the far wall', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-500, -1, -500], [500, 0, 500]), 'floor');
    const wall = w.addCollider(box([400, 0, -50], [401, 20, 50]), 'wall');
    const h = w.raycast([-450, 5, 3], [1, 0, 0], 1000);
    expect(h!.colliderId).toBe(wall);
    expect(h!.t).toBeCloseTo(850, 9);
    // 空へ向かうレイは何にも当たらない
    expect(w.raycast([0, 5, 0], normalize([0, 1, 0.001]), 1000)).toBeNull();
    // 遠くから床に落ちるレイ
    const h2 = w.raycast([-700, 50, 0], normalize([1, -0.1, 0]), 2000);
    expect(h2!.colliderId).not.toBe(wall);
    expect(h2!.normal).toEqual([0, 1, 0]);
  });

  it('segmentBlocked and sweepSphere basic', () => {
    const w = createCollisionWorld();
    const id = w.addCollider(box([-1, -1, 5], [1, 1, 6]), 'plate');
    expect(w.segmentBlocked([0, 0, 0], [0, 0, 10])).toBe(true);
    expect(w.segmentBlocked([0, 0, 0], [0, 0, 4])).toBe(false);
    expect(w.segmentBlocked([3, 0, 0], [3, 0, 10])).toBe(false);
    const s = w.sweepSphere([0, 0, 0], [0, 0, 10], 0.5);
    expect(s).not.toBeNull();
    expect(s!.t).toBeCloseTo(4.5 / 10, 12);
    expect(s!.normal).toEqual([0, 0, -1]);
    expect(s!.colliderId).toBe(id);
    expect(s!.tag).toBe('plate');
    expect(s!.point[2]).toBeCloseTo(4.5, 12);
    // 半径分だけ横にずれても当たる（拡張 AABB）
    expect(w.sweepSphere([1.4, 0, 0], [1.4, 0, 10], 0.5)).not.toBeNull();
    expect(w.sweepSphere([1.6, 0, 0], [1.6, 0, 10], 0.5)).toBeNull();
    // 開始点が拡張ボックス内なら t=0
    expect(w.sweepSphere([0, 0, 4.7], [0, 0, 10], 0.5)!.t).toBe(0);
  });

  it('removed colliders (barriers) disappear from every query', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-50, -1, -50], [50, 0, 50]), 'floor');
    const barrier = w.addCollider(box([9, 0, -5], [10, 6, 5]), 'barrier');
    const from: Vec3 = [0, 2, 0];
    const to: Vec3 = [20, 2, 0];
    expect(w.segmentBlocked(from, to)).toBe(true);
    expect(w.raycast(from, [1, 0, 0], 100)!.colliderId).toBe(barrier);
    expect(w.sweepSphere(from, to, 0.2)!.colliderId).toBe(barrier);
    expect(w.boxOverlaps([9.5, 3, 0], [1, 1, 1])).toBe(true);
    const mv = w.moveBox([5, 1.5, 0], [0.8, 1.5, 0.8], [10, 0, 0]);
    expect(mv.hitPosX).toBe(true);
    expect(mv.position[0]).toBeCloseTo(9 - 0.8 - CONTACT_MARGIN, 9);

    w.removeCollider(barrier);
    expect(w.segmentBlocked(from, to)).toBe(false);
    expect(w.raycast(from, [1, 0, 0], 100)).toBeNull();
    expect(w.sweepSphere(from, to, 0.2)).toBeNull();
    expect(w.boxOverlaps([9.5, 3, 0], [1, 1, 1])).toBe(false);
    const mv2 = w.moveBox([5, 1.5, 0], [0.8, 1.5, 0.8], [10, 0, 0]);
    expect(mv2.hitPosX).toBe(false);
    expect(mv2.position[0]).toBeCloseTo(15, 12);

    // 再追加で復活
    const again = w.addCollider(box([9, 0, -5], [10, 6, 5]), 'barrier');
    expect(w.raycast(from, [1, 0, 0], 100)!.colliderId).toBe(again);
  });

  it('boxOverlaps is strict (touching is not overlap)', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-10, -1, -10], [10, 0, 10]));
    expect(w.boxOverlaps([0, 1.5, 0], [0.8, 1.5, 0.8])).toBe(false); // 床上面に接触
    expect(w.boxOverlaps([0, 1.49, 0], [0.8, 1.5, 0.8])).toBe(true);
    expect(w.boxOverlaps([0, 5, 0], [0.8, 1.5, 0.8])).toBe(false);
    expect(w.boxOverlaps([10.8, 0, 0], [0.8, 1.5, 0.8])).toBe(false); // 側面接触
    expect(w.boxOverlaps([10.7, 0, 0], [0.8, 1.5, 0.8])).toBe(true);
  });

  it('very large colliders (beyond the grid registration limit) are still queried', () => {
    const w = createCollisionWorld();
    const cellsAcross = Math.ceil(Math.sqrt(4096 + 1)) + 2;
    const half = (cellsAcross * CELL_SIZE) / 2;
    const floor = w.addCollider(box([-half, -1, -half], [half, 0, half]), 'hugeFloor');
    const wall = w.addCollider(box([100, 0, -10], [101, 10, 10]), 'wall');
    expect(w.raycast([0, 5, 0], [0, -1, 0], 100)!.colliderId).toBe(floor);
    expect(w.raycast([0, 5, 0], [1, 0, 0], 1000)!.colliderId).toBe(wall);
    expect(w.segmentBlocked([0, 5, 0], [0, -5, 0])).toBe(true);
    expect(w.sweepSphere([0, 5, 0], [0, -5, 0], 0.1)!.colliderId).toBe(floor);
    const mv = w.moveBox([0, 10, 0], [0.8, 1.5, 0.8], [0, -50, 0]);
    expect(mv.hitNegY).toBe(true);
    expect(mv.position[1]).toBeCloseTo(1.5 + CONTACT_MARGIN, 9);
    expect(w.boxOverlaps([0, 0, 0], [1, 1, 1])).toBe(true);
    w.removeCollider(floor);
    expect(w.raycast([0, 5, 0], [0, -1, 0], 100)).toBeNull();
  });
});

describe('moveBox', () => {
  const half: Vec3 = [0.8, 1.5, 0.8];

  it('walking into a wall stops at the wall (hitPosX)', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-50, -1, -50], [50, 0, 50]), 'floor');
    w.addCollider(box([10, 0, -5], [12, 6, 5]), 'wall');
    const r = w.moveBox([0, 1.5 + CONTACT_MARGIN, 0], half, [15, 0, 0]);
    expect(r.hitPosX).toBe(true);
    expect(r.hitNegX).toBe(false);
    expect(r.hitNegY).toBe(false);
    expect(r.position[0]).toBeCloseTo(10 - 0.8 - CONTACT_MARGIN, 9);
    expect(r.position[1]).toBeCloseTo(1.5 + CONTACT_MARGIN, 12);
    expect(r.position[2]).toBe(0);
    // 反対側から
    const r2 = w.moveBox([20, 1.5 + CONTACT_MARGIN, 0], half, [-15, 0, 0]);
    expect(r2.hitNegX).toBe(true);
    expect(r2.position[0]).toBeCloseTo(12 + 0.8 + CONTACT_MARGIN, 9);
    // Z 方向
    const r3 = w.moveBox([11, 1.5 + CONTACT_MARGIN, -20], half, [0, 0, 30]);
    expect(r3.hitPosZ).toBe(true);
    expect(r3.position[2]).toBeCloseTo(-5 - 0.8 - CONTACT_MARGIN, 9);
    const r4 = w.moveBox([11, 1.5 + CONTACT_MARGIN, 20], half, [0, 0, -30]);
    expect(r4.hitNegZ).toBe(true);
    expect(r4.position[2]).toBeCloseTo(5 + 0.8 + CONTACT_MARGIN, 9);
  });

  it('sliding along a wall keeps the perpendicular motion', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-50, -1, -50], [50, 0, 50]), 'floor');
    w.addCollider(box([10, 0, -50], [12, 6, 50]), 'wall');
    const r = w.moveBox([5, 1.5 + CONTACT_MARGIN, 0], half, [10, 0, 7]);
    expect(r.hitPosX).toBe(true);
    expect(r.hitPosZ).toBe(false);
    expect(r.position[0]).toBeCloseTo(10 - 0.8 - CONTACT_MARGIN, 9);
    expect(r.position[2]).toBeCloseTo(7, 12);
  });

  it('falling onto a floor lands on top (hitNegY) with the contact margin', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-50, -3, -50], [50, 2, 50]), 'floor');
    const r = w.moveBox([1, 20, 2], half, [0, -100, 0]);
    expect(r.hitNegY).toBe(true);
    expect(r.hitPosY).toBe(false);
    const expected = 2 + 1.5 + CONTACT_MARGIN;
    expect(r.position[1]).toBeGreaterThanOrEqual(2 + 1.5);
    expect(Math.abs(r.position[1] - expected)).toBeLessThan(1e-9);
    expect(r.position[0]).toBe(1);
    expect(r.position[2]).toBe(2);
    // 着地済みの状態で更に下へ動かしても位置は変わらず hitNegY が立ち続ける
    const r2 = w.moveBox(r.position, half, [0, -0.15, 0]);
    expect(r2.hitNegY).toBe(true);
    expect(r2.position[1]).toBeCloseTo(expected, 9);
  });

  it('ceiling stops upward motion (hitPosY)', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-50, -1, -50], [50, 0, 50]), 'floor');
    w.addCollider(box([-50, 8, -50], [50, 9, 50]), 'ceiling');
    const r = w.moveBox([0, 1.5 + CONTACT_MARGIN, 0], half, [0, 30, 0]);
    expect(r.hitPosY).toBe(true);
    expect(r.hitNegY).toBe(false);
    expect(r.position[1]).toBeCloseTo(8 - 1.5 - CONTACT_MARGIN, 9);
  });

  it('lands on a small platform and does not fall through its edge region', () => {
    const w = createCollisionWorld();
    w.addCollider(box([3, 5, 3], [7, 6, 7]), 'platform');
    // 足場に部分的にかかる位置から落下
    const r = w.moveBox([3.2, 20, 3.2], half, [0, -30, 0]);
    expect(r.hitNegY).toBe(true);
    expect(r.position[1]).toBeCloseTo(6 + 1.5 + CONTACT_MARGIN, 9);
    // 足場から外れていれば落ちる
    const r2 = w.moveBox([9, 20, 3.2], half, [0, -30, 0]);
    expect(r2.hitNegY).toBe(false);
    expect(r2.position[1]).toBeCloseTo(-10, 12);
  });

  it('colliders already overlapping on the moving axis are ignored (no push-out)', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-1, 0, -1], [1, 3, 1]), 'pillar');
    // ボックスが柱に横から食い込んだ状態で X 方向へ動く: 柱では止まらない
    const r = w.moveBox([1.5, 1.5, 0], half, [-0.5, 0, 0]);
    expect(r.hitNegX).toBe(false);
    expect(r.position[0]).toBeCloseTo(1.0, 12);
    expect(w.boxOverlaps([1.5, 1.5, 0], half)).toBe(true);
  });

  it('zero delta does nothing and reports no hits', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-50, -1, -50], [50, 0, 50]));
    const r = w.moveBox([0, 1.5, 0], half, [0, 0, 0]);
    expect(r.position).toEqual([0, 1.5, 0]);
    expect(r.hitNegY).toBe(false);
  });

  it('NO TUNNELING: 80 m/s box in 1/120 s steps for 3 s stops at a 0.5 m wall', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-500, -1, -500], [500, 0, 500]), 'floor');
    const wallMinX = 100;
    w.addCollider(box([wallMinX, 0, -20], [wallMinX + 0.5, 10, 20]), 'thinWall');
    const h = SIM.maxStep;
    const steps = Math.round(3 / h);
    let pos: Vec3 = [0, 1.5 + CONTACT_MARGIN, 0];
    let hits = 0;
    let firstHitStep = -1;
    for (let i = 0; i < steps; i++) {
      const r = w.moveBox(pos, half, [80 * h, -18 * h, 0]);
      pos = r.position;
      if (r.hitPosX) {
        hits++;
        if (firstHitStep < 0) firstHitStep = i;
      }
      expect(r.hitNegY).toBe(true);
      // 一度も壁の向こうへ出ない
      expect(pos[0] + half[0]).toBeLessThanOrEqual(wallMinX);
    }
    expect(firstHitStep).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
    expect(pos[0]).toBeCloseTo(wallMinX - half[0] - CONTACT_MARGIN, 9);
    expect(pos[1]).toBeCloseTo(1.5 + CONTACT_MARGIN, 9);
  });

  it('NO TUNNELING: a single long-frame move of 240 m stops at the same wall', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-500, -1, -500], [500, 0, 500]), 'floor');
    w.addCollider(box([100, 0, -20], [100.5, 10, 20]), 'thinWall');
    const r = w.moveBox([0, 1.5 + CONTACT_MARGIN, 0], half, [240, 0, 0]);
    expect(r.hitPosX).toBe(true);
    expect(r.position[0]).toBeCloseTo(100 - 0.8 - CONTACT_MARGIN, 9);
  });

  it('NO TUNNELING: fast fall through a thin floor is stopped', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-50, 10, -50], [50, 10.2, 50]), 'thinFloor');
    const h = SIM.maxStep;
    let pos: Vec3 = [0, 60, 0];
    let vy = -120; // 1 ステップで 1 m 落下（床厚 0.2 m より大きい）
    let landed = false;
    for (let i = 0; i < 600 && !landed; i++) {
      const r = w.moveBox(pos, half, [0, vy * h, 0]);
      pos = r.position;
      if (r.hitNegY) landed = true;
      else vy -= 18 * h;
    }
    expect(landed).toBe(true);
    expect(pos[1]).toBeCloseTo(10.2 + 1.5 + CONTACT_MARGIN, 9);
  });
});

describe('sweepSphere no tunneling', () => {
  it('0.08 m sphere at 100 m/s per 1/120 s through a 0.2 m plate is detected', () => {
    const w = createCollisionWorld();
    const plateZ = 30;
    const plate = w.addCollider(box([-5, -5, plateZ], [5, 5, plateZ + 0.2]), 'plate');
    const h = SIM.maxStep;
    const speed = 100;
    let pos: Vec3 = [0.3, 0.2, 0];
    let detected: RayHit | null = null;
    let steps = 0;
    while (pos[2] < 60 && detected === null) {
      const next: Vec3 = [pos[0], pos[1], pos[2] + speed * h];
      detected = w.sweepSphere(pos, next, 0.08);
      if (detected === null) pos = next;
      steps++;
    }
    expect(detected).not.toBeNull();
    expect(detected!.colliderId).toBe(plate);
    expect(detected!.normal).toEqual([0, 0, -1]);
    expect(detected!.point[2]).toBeCloseTo(plateZ - 0.08, 9);
    // 接触点はその区間内
    expect(detected!.t).toBeGreaterThanOrEqual(0);
    expect(detected!.t).toBeLessThanOrEqual(1);
    // 区間長 (0.83 m) が板厚 (0.2 m) より大きいことを確認（すり抜けが起き得る条件）
    expect(speed * h).toBeGreaterThan(0.2);
    expect(steps).toBeGreaterThan(30);
  });

  it('a diagonal fast sweep across cell boundaries hits the plate', () => {
    const w = createCollisionWorld();
    w.addCollider(box([-2, -2, 40], [2, 2, 40.2]), 'plate');
    const a: Vec3 = [-30, 15, 0];
    const dir = normalize(sub([0, 0, 40.1], a));
    const b = addScaled(a, dir, 200);
    const s = w.sweepSphere(a, b, 0.08);
    expect(s).not.toBeNull();
    expect(s!.normal).toEqual([0, 0, -1]);
  });
});

describe('broadphase equivalence vs brute force', () => {
  const rng = new Rng(20260908);
  const world = randomWorld(rng, 800, 300);

  it('raycast (300 random rays incl. long, inside-origin and outside-bounds)', () => {
    for (let i = 0; i < 300; i++) {
      const origin: Vec3 = [rng.range(-400, 400), rng.range(-20, 80), rng.range(-400, 400)];
      const dir = randomDir(rng);
      const maxDist = i % 5 === 0 ? rng.range(200, 1500) : rng.range(1, 150);
      const a = world.raycast(origin, dir, maxDist);
      const b = bruteRaycast(world, origin, dir, maxDist);
      if (b === null) {
        expect(a).toBeNull();
      } else {
        expect(a).not.toBeNull();
        expect(Math.abs(a!.t - b.t)).toBeLessThan(1e-9);
        if (a!.t !== 0 || b.t !== 0) {
          expect(a!.normal).toEqual(b.normal);
        }
      }
    }
    // 原点がコライダー内部にある場合
    let insideChecked = 0;
    for (const e of world.colliders()) {
      if (insideChecked >= 20) break;
      const origin: Vec3 = [(e.box.min[0] + e.box.max[0]) / 2, (e.box.min[1] + e.box.max[1]) / 2, (e.box.min[2] + e.box.max[2]) / 2];
      const a = world.raycast(origin, randomDir(rng), 50);
      expect(a).not.toBeNull();
      expect(a!.t).toBe(0);
      insideChecked++;
    }
  });

  it('segmentBlocked (300 random segments)', () => {
    let blockedCount = 0;
    for (let i = 0; i < 300; i++) {
      const a: Vec3 = [rng.range(-400, 400), rng.range(-20, 80), rng.range(-400, 400)];
      const len = i % 4 === 0 ? rng.range(100, 900) : rng.range(0.5, 120);
      const b = addScaled(a, randomDir(rng), len);
      const x = world.segmentBlocked(a, b);
      const y = bruteSegmentBlocked(world, a, b);
      expect(x).toBe(y);
      if (y) blockedCount++;
    }
    expect(blockedCount).toBeGreaterThan(20);
    expect(blockedCount).toBeLessThan(300);
  });

  it('sweepSphere (300 random sweeps)', () => {
    let hitCount = 0;
    for (let i = 0; i < 300; i++) {
      const a: Vec3 = [rng.range(-350, 350), rng.range(-20, 80), rng.range(-350, 350)];
      const len = i % 3 === 0 ? rng.range(5, 300) : rng.range(0.1, 2);
      const b = addScaled(a, randomDir(rng), len);
      const r = rng.range(0.05, 2);
      const x = world.sweepSphere(a, b, r);
      const y = bruteSweep(world, a, b, r);
      if (y === null) {
        expect(x).toBeNull();
      } else {
        expect(x).not.toBeNull();
        expect(Math.abs(x!.t - y.t)).toBeLessThan(1e-9);
        if (y.t > 0) expect(x!.colliderId).toBe(y.colliderId);
        hitCount++;
      }
    }
    expect(hitCount).toBeGreaterThan(10);
  });

  it('sweepSphere with larger radii and axis-aligned directions across several seeds', () => {
    // 近傍セルに複数の候補があるとき、最初に見つけた候補で打ち切らないこと（回帰試験）
    for (const seed of [1, 2, 3, 42, 987654]) {
      const r2 = new Rng(seed);
      const w = randomWorld(r2, 600, 150 + r2.range(0, 200));
      let hits = 0;
      for (let i = 0; i < 400; i++) {
        const a: Vec3 = [r2.range(-350, 350), r2.range(-30, 90), r2.range(-350, 350)];
        let dir = randomDir(r2);
        if (i % 4 === 0) dir = [0, -1, 0];
        if (i % 4 === 1) dir = [1, 0, 0];
        const b = addScaled(a, dir, r2.range(0.5, 250));
        const r = r2.range(0.05, 3);
        const x = w.sweepSphere(a, b, r);
        const y = bruteSweep(w, a, b, r);
        if (y === null) {
          expect(x).toBeNull();
        } else {
          expect(x).not.toBeNull();
          expect(Math.abs(x!.t - y.t)).toBeLessThan(1e-9);
          hits++;
        }
      }
      expect(hits).toBeGreaterThan(50);
    }
  });

  it('moveBox (300 random moves)', () => {
    let hitAny = 0;
    for (let i = 0; i < 300; i++) {
      const c: Vec3 = [rng.range(-320, 320), rng.range(-15, 70), rng.range(-320, 320)];
      const half: Vec3 = [rng.range(0.3, 2), rng.range(0.3, 2), rng.range(0.3, 2)];
      const scale = i % 3 === 0 ? 40 : 1;
      const d: Vec3 = [rng.range(-1, 1) * scale, rng.range(-1, 1) * scale, rng.range(-1, 1) * scale];
      const x = world.moveBox(c, half, d);
      const y = bruteMoveBox(world, c, half, d);
      expect(Math.abs(x.position[0] - y.position[0])).toBeLessThan(1e-9);
      expect(Math.abs(x.position[1] - y.position[1])).toBeLessThan(1e-9);
      expect(Math.abs(x.position[2] - y.position[2])).toBeLessThan(1e-9);
      expect([x.hitNegX, x.hitPosX, x.hitNegY, x.hitPosY, x.hitNegZ, x.hitPosZ]).toEqual([
        y.hitNegX,
        y.hitPosX,
        y.hitNegY,
        y.hitPosY,
        y.hitNegZ,
        y.hitPosZ,
      ]);
      if (x.hitNegX || x.hitPosX || x.hitNegY || x.hitPosY || x.hitNegZ || x.hitPosZ) hitAny++;
    }
    expect(hitAny).toBeGreaterThan(10);
  });

  it('boxOverlaps (300 random boxes)', () => {
    let overlaps = 0;
    for (let i = 0; i < 300; i++) {
      const c: Vec3 = [rng.range(-320, 320), rng.range(-15, 70), rng.range(-320, 320)];
      const half: Vec3 = [rng.range(0.3, 3), rng.range(0.3, 3), rng.range(0.3, 3)];
      const x = world.boxOverlaps(c, half);
      const y = world.colliders().some((e) => aabbOverlap({ min: sub(c, half), max: [c[0] + half[0], c[1] + half[1], c[2] + half[2]] }, e.box));
      expect(x).toBe(y);
      if (y) overlaps++;
    }
    expect(overlaps).toBeGreaterThan(5);
  });

  it('after removing half of the colliders, queries still match brute force', () => {
    const ids = world.colliders().map((e) => e.id);
    for (let i = 0; i < ids.length; i += 2) world.removeCollider(ids[i]);
    expect(world.colliders().length).toBe(ids.length - Math.ceil(ids.length / 2));
    for (let i = 0; i < 150; i++) {
      const a: Vec3 = [rng.range(-350, 350), rng.range(-20, 80), rng.range(-350, 350)];
      const b = addScaled(a, randomDir(rng), rng.range(1, 200));
      expect(world.segmentBlocked(a, b)).toBe(bruteSegmentBlocked(world, a, b));
      const dir = normalize(sub(b, a));
      const x = world.raycast(a, dir, 200);
      const y = bruteRaycast(world, a, dir, 200);
      expect(x === null).toBe(y === null);
      if (x && y) expect(Math.abs(x.t - y.t)).toBeLessThan(1e-9);
    }
  });
});

describe('performance sanity', () => {
  it('1000 boxes, 20000 segmentBlocked calls complete quickly', () => {
    const rng = new Rng(12345);
    const world = randomWorld(rng, 1000, 250);
    const segs: [Vec3, Vec3][] = [];
    for (let i = 0; i < 20000; i++) {
      const a: Vec3 = [rng.range(-250, 250), rng.range(-10, 60), rng.range(-250, 250)];
      segs.push([a, addScaled(a, randomDir(rng), rng.range(5, 120))]);
    }
    // ウォームアップ
    for (let i = 0; i < 500; i++) world.segmentBlocked(segs[i][0], segs[i][1]);
    const t0 = performance.now();
    let blocked = 0;
    for (const [a, b] of segs) if (world.segmentBlocked(a, b)) blocked++;
    const elapsed = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`segmentBlocked x20000 with 1000 boxes: ${elapsed.toFixed(1)} ms (blocked ${blocked})`);
    expect(blocked).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(400);
  });

  it('1000 boxes, 5000 moveBox + 5000 sweepSphere + 5000 raycast complete quickly', () => {
    const rng = new Rng(777);
    const world = randomWorld(rng, 1000, 250);
    const t0 = performance.now();
    for (let i = 0; i < 5000; i++) {
      const c: Vec3 = [rng.range(-250, 250), rng.range(-10, 60), rng.range(-250, 250)];
      world.moveBox(c, [0.8, 1.5, 0.8], [rng.range(-0.7, 0.7), rng.range(-0.7, 0.7), rng.range(-0.7, 0.7)]);
      const a: Vec3 = [rng.range(-250, 250), rng.range(-10, 60), rng.range(-250, 250)];
      world.sweepSphere(a, addScaled(a, randomDir(rng), 0.9), 0.08);
      world.raycast(a, randomDir(rng), 1000);
    }
    const elapsed = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`5000x(moveBox+sweepSphere+raycast) with 1000 boxes: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(600);
  });
});

// ---------------------------------------------------------------------------
// 回帰試験（レビュー指摘）
// ---------------------------------------------------------------------------

describe('REGRESSION: moveBox gathers colliders whose face lies on a 16 m cell boundary', () => {
  const half: Vec3 = [0.8, 1.5, 0.8];

  it('a step ending inside the contact margin of a wall face on a cell boundary stops at the margin and reports the hit', () => {
    const faceX = 2 * CELL_SIZE; // 32
    const w = createCollisionWorld();
    w.addCollider(box([faceX, -1, -10], [faceX + 8, 10, 10]), 'wall');
    const start: Vec3 = [faceX - half[0] - 2 * CONTACT_MARGIN, 1.5, 0];
    const r = w.moveBox(start, half, [1.5 * CONTACT_MARGIN, 0, 0]);
    expect(r.hitPosX).toBe(true);
    expect(r.position[0] + half[0]).toBeCloseTo(faceX - CONTACT_MARGIN, 12);
    // 総当たりと一致
    const b = bruteMoveBox(w, start, half, [1.5 * CONTACT_MARGIN, 0, 0]);
    expect(r.position[0]).toBeCloseTo(b.position[0], 12);
    expect(r.hitPosX).toBe(b.hitPosX);
    // セル境界でない面（x=30）でも同じ相対結果
    const w2 = createCollisionWorld();
    w2.addCollider(box([30, -1, -10], [38, 10, 10]), 'wall');
    const r2 = w2.moveBox([30 - half[0] - 2 * CONTACT_MARGIN, 1.5, 0], half, [1.5 * CONTACT_MARGIN, 0, 0]);
    expect(r2.hitPosX).toBe(true);
    expect(r.position[0] - faceX).toBeCloseTo(r2.position[0] - 30, 12);
  });

  it('the same for -X, +Z and -Z faces on cell boundaries', () => {
    const f = 2 * CELL_SIZE;
    const w = createCollisionWorld();
    w.addCollider(box([-f - 8, -1, -10], [-f, 10, 10]), 'wallNegX');
    w.addCollider(box([-10, -1, f], [10, 10, f + 8]), 'wallPosZ');
    w.addCollider(box([-10, -1, -f - 8], [10, 10, -f]), 'wallNegZ');
    const step = 1.5 * CONTACT_MARGIN;
    const rx = w.moveBox([-f + half[0] + 2 * CONTACT_MARGIN, 1.5, 0], half, [-step, 0, 0]);
    expect(rx.hitNegX).toBe(true);
    expect(rx.position[0] - half[0]).toBeCloseTo(-f + CONTACT_MARGIN, 12);
    const rz = w.moveBox([0, 1.5, f - half[2] - 2 * CONTACT_MARGIN], half, [0, 0, step]);
    expect(rz.hitPosZ).toBe(true);
    expect(rz.position[2] + half[2]).toBeCloseTo(f - CONTACT_MARGIN, 12);
    const rnz = w.moveBox([0, 1.5, -f + half[2] + 2 * CONTACT_MARGIN], half, [0, 0, -step]);
    expect(rnz.hitNegZ).toBe(true);
    expect(rnz.position[2] - half[2]).toBeCloseTo(-f + CONTACT_MARGIN, 12);
  });

  it('randomised: cell-snapped colliders, steps ending within a few margins of a face, match brute force', () => {
    const rng = new Rng(4242);
    const w = createCollisionWorld();
    const entries: AABB[] = [];
    for (let i = 0; i < 120; i++) {
      const ix = Math.floor(rng.range(-6, 6));
      const iz = Math.floor(rng.range(-6, 6));
      const nx = 1 + Math.floor(rng.range(0, 2));
      const nz = 1 + Math.floor(rng.range(0, 2));
      const y0 = rng.range(-5, 5);
      const b = box([ix * CELL_SIZE, y0, iz * CELL_SIZE], [(ix + nx) * CELL_SIZE, y0 + rng.range(6, 20), (iz + nz) * CELL_SIZE]);
      w.addCollider(b);
      entries.push(b);
    }
    let hits = 0;
    for (let i = 0; i < 600; i++) {
      const e = entries[Math.floor(rng.range(0, entries.length))];
      const axis = i % 2 === 0 ? 0 : 2;
      const other = axis === 0 ? 2 : 0;
      const side = i % 4 < 2 ? 1 : -1; // +1: 箱は面の min 側（正方向へ進む）
      const gap = rng.range(0, 3 * CONTACT_MARGIN);
      const c: Vec3 = [0, 0, 0];
      c[1] = rng.range(e.min[1] + half[1], e.max[1] - half[1]);
      c[other] = rng.range(e.min[other] - half[other] * 0.5, e.max[other] + half[other] * 0.5);
      c[axis] = side > 0 ? e.min[axis] - half[axis] - gap : e.max[axis] + half[axis] + gap;
      const d: Vec3 = [0, 0, 0];
      d[axis] = side * rng.range(0, 5 * CONTACT_MARGIN);
      if (i % 3 === 0) d[1] = rng.range(-0.01, 0.01);
      if (i % 5 === 0) d[other] = rng.range(-0.01, 0.01);
      const x = w.moveBox(c, half, d);
      const y = bruteMoveBox(w, c, half, d);
      expect(Math.abs(x.position[0] - y.position[0])).toBeLessThan(1e-12);
      expect(Math.abs(x.position[1] - y.position[1])).toBeLessThan(1e-12);
      expect(Math.abs(x.position[2] - y.position[2])).toBeLessThan(1e-12);
      expect([x.hitNegX, x.hitPosX, x.hitNegY, x.hitPosY, x.hitNegZ, x.hitPosZ]).toEqual([
        y.hitNegX,
        y.hitPosX,
        y.hitNegY,
        y.hitPosY,
        y.hitNegZ,
        y.hitPosZ,
      ]);
      if (x.hitNegX || x.hitPosX || x.hitNegZ || x.hitPosZ) hits++;
    }
    expect(hits).toBeGreaterThan(100);
  });
});

describe('REGRESSION: maxDist = 0 with the origin inside', () => {
  it('rayAABB: inside or on a face and entering → t=0; on a face and leaving, outside, negative or NaN maxDist → null', () => {
    expect(rayAABB([0, 0, 0], [1, 0, 0], unit, 0)).toEqual({ t: 0, normal: [-1, 0, 0] });
    expect(rayAABB([0.3, -0.2, 0.9], normalize([0, 0, 1]), unit, 0)).toEqual({ t: 0, normal: [0, 0, -1] });
    expect(rayAABB([-1, 0, 0], [1, 0, 0], unit, 0)).toEqual({ t: 0, normal: [-1, 0, 0] });
    expect(rayAABB([1, 0, 0], [1, 0, 0], unit, 0)).toBeNull();
    expect(rayAABB([-5, 0, 0], [1, 0, 0], unit, 0)).toBeNull();
    expect(rayAABB([0, 0, 0], [1, 0, 0], unit, -1)).toBeNull();
    expect(rayAABB([0, 0, 0], [1, 0, 0], unit, NaN)).toBeNull();
    // 有限の maxDist はこれまで通り: 境界ちょうどは当たり、手前は外れ
    expect(rayAABB([-5, 0, 0], [1, 0, 0], unit, 4)).not.toBeNull();
    expect(rayAABB([-5, 0, 0], [1, 0, 0], unit, 3.999999)).toBeNull();
  });

  it('world.raycast with maxDist = 0 reports the containing collider (grid-registered and large alike)', () => {
    const w = createCollisionWorld();
    const floor = w.addCollider(box([-10, -1, -10], [10, 0, 10]), 'floor');
    const h = w.raycast([0.5, -0.5, 0.5], [0, -1, 0], 0);
    expect(h).not.toBeNull();
    expect(h!.t).toBe(0);
    expect(h!.colliderId).toBe(floor);
    expect(h!.point).toEqual([0.5, -0.5, 0.5]);
    expect(w.raycast([0, 5, 0], [0, -1, 0], 0)).toBeNull();
    expect(w.raycast([0, -0.5, 0], [0, -1, 0], -1)).toBeNull();
    expect(w.raycast([0, -0.5, 0], [0, -1, 0], NaN)).toBeNull();
    const big = createCollisionWorld();
    const slab = big.addCollider(box([-1e5, -1, -1e5], [1e5, 0, 1e5]), 'hugeFloor');
    expect(big.raycast([3, -0.5, 4], [1, 0, 0], 0)!.colliderId).toBe(slab);
    expect(big.raycast([3, 0.5, 4], [1, 0, 0], 0)).toBeNull();
  });
});

describe('REGRESSION: non-finite query inputs never produce NaN results', () => {
  const bad: Vec3[] = [
    [NaN, NaN, NaN],
    [NaN, 0, 0],
    [0, Infinity, 0],
    [0, 0, -Infinity],
  ];

  it('world queries give the same null/false whether the collider is grid-registered or large', () => {
    const grid = createCollisionWorld();
    grid.addCollider(box([-100, -1, -100], [100, 0, 100]), 'floor');
    const big = createCollisionWorld();
    big.addCollider(box([-1e5, -1, -1e5], [1e5, 0, 1e5]), 'hugeFloor');
    for (const w of [grid, big]) {
      // 有限入力では当たる
      expect(w.raycast([0, 5, 0], [0, -1, 0], 10)).not.toBeNull();
      expect(w.segmentBlocked([0, 5, 0], [0, -5, 0])).toBe(true);
      expect(w.sweepSphere([0, 5, 0], [0, -5, 0], 0.1)).not.toBeNull();
      for (const v of bad) {
        expect(w.raycast([0, 5, 0], v, 10)).toBeNull();
        expect(w.raycast(v, [0, -1, 0], 10)).toBeNull();
        expect(w.raycast([0, -0.5, 0], v, 10)).toBeNull(); // 原点が内部でも方向が NaN なら null
        expect(w.segmentBlocked([0, 5, 0], v)).toBe(false);
        expect(w.segmentBlocked(v, [0, -5, 0])).toBe(false);
        expect(w.sweepSphere([0, 5, 0], v, 0.1)).toBeNull();
        expect(w.sweepSphere(v, [0, -5, 0], 0.1)).toBeNull();
      }
    }
  });

  it('geom primitives return null / false (never NaN)', () => {
    for (const v of bad) {
      expect(rayAABB(v, [1, 0, 0], unit, 10)).toBeNull();
      expect(rayAABB([0, 0, 0], v, unit, 10)).toBeNull();
      expect(raySphere(v, [1, 0, 0], [0, 0, 0], 1, 10)).toBeNull();
      expect(raySphere([-5, 0, 0], v, [0, 0, 0], 1, 10)).toBeNull();
      expect(raySphere([0, 0, 0], v, [0, 0, 0], 1, 10)).toBeNull();
      expect(segmentAABB(v, [0, 0, 0], unit)).toBe(false);
      expect(segmentAABB([0, 0, 0], v, unit)).toBe(false);
      expect(sweptSphereVsMovingSphere(v, [1, 0, 0], 0.1, [0, 0, 0], [0, 0, 0], 0.5)).toBeNull();
      expect(sweptSphereVsMovingSphere([-5, 0, 0], [5, 0, 0], 0.1, v, [0, 0, 0], 0.5)).toBeNull();
      expect(sweptSphereVsMovingSphere([-5, 0, 0], [5, 0, 0], 0.1, [0, 0, 0], v, 0.5)).toBeNull();
      expect(sweptSphereVsMovingBox(v, [1, 0, 0], 0.1, [0, 0, 0], [0, 0, 0], [1, 1, 1])).toBeNull();
      expect(sweptSphereVsMovingBox([-5, 0, 0], [5, 0, 0], 0.1, [0, 0, 0], v, [1, 1, 1])).toBeNull();
      expect(sweptSphereVsMovingBox([-5, 0, 0], [5, 0, 0], 0.1, v, [0, 0, 0], [1, 1, 1])).toBeNull();
    }
  });
});

describe('closed-boundary semantics of segmentBlocked (documented; deliberately conservative)', () => {
  it('a segment sliding on a face, grazing an edge, or ending on a face is blocked; 1e-9 outside is not', () => {
    const w = createCollisionWorld();
    w.addCollider(box([0, 0, -10], [1, 10, 10]), 'wall');
    expect(w.segmentBlocked([0, 5, -5], [0, 5, 5])).toBe(true); // 面に沿って滑る
    expect(w.segmentBlocked([-1e-9, 5, -5], [-1e-9, 5, 5])).toBe(false);
    expect(w.segmentBlocked([-1, 10, -5], [1, 10, 5])).toBe(true); // 上面に沿って辺をかすめる
    expect(w.segmentBlocked([-1, 10 + 1e-9, -5], [1, 10 + 1e-9, 5])).toBe(false);
    expect(w.segmentBlocked([-5, 5, 0], [0, 5, 0])).toBe(true); // 終点が面に触れる
    expect(w.segmentBlocked([-5, 5, 0], [-1e-9, 5, 0])).toBe(false);
    // 面上から離れていく線分は遮蔽されない（rayAABB と同じ）
    expect(w.segmentBlocked([0, 5, 0], [-5, 5, 0])).toBe(false);
  });

  it('a segment lying in the seam plane between two adjacent boxes is blocked (no LOS through a solid wall along its seam)', () => {
    const w = createCollisionWorld();
    const seam = 2 * CELL_SIZE;
    w.addCollider(box([seam - 8, 0, -1], [seam, 10, 1]), 'wallA');
    w.addCollider(box([seam, 0, -1], [seam + 8, 10, 1]), 'wallB');
    expect(w.segmentBlocked([seam, 5, -10], [seam, 5, 10])).toBe(true);
    expect(w.segmentBlocked([seam - 3, 5, -10], [seam + 3, 5, 10])).toBe(true);
    expect(w.segmentBlocked([seam, 10.5, -10], [seam, 10.5, 10])).toBe(false);
  });
});

describe('REGRESSION: broadphase visits the cell beyond a query that ends exactly on a 16 m cell boundary', () => {
  it('segmentBlocked / raycast / sweepSphere ending exactly on a collider face that lies on a cell boundary (brute force says hit)', () => {
    for (const faceX of [0, 2 * CELL_SIZE, -3 * CELL_SIZE]) {
      const w = createCollisionWorld();
      const id = w.addCollider(box([faceX, 0, -10], [faceX + 8, 10, 10]), 'wall');
      const e = w.colliders()[0];
      const a: Vec3 = [faceX - 5, 5, 0];
      const end: Vec3 = [faceX, 5, 0];
      expect(segmentAABB(a, end, e.box)).toBe(true);
      expect(w.segmentBlocked(a, end)).toBe(true);
      const h = w.raycast(a, [1, 0, 0], 5);
      expect(h).not.toBeNull();
      expect(h!.t).toBe(5);
      expect(h!.colliderId).toBe(id);
      expect(w.sweepSphere(a, [faceX - 0.5, 5, 0], 0.5)!.t).toBe(1);
      // 反対側（面が max 側）: 終点が面に触れる
      const w2 = createCollisionWorld();
      w2.addCollider(box([faceX - 8, 0, -10], [faceX, 10, 10]), 'wall');
      expect(w2.segmentBlocked([faceX + 5, 5, 0], [faceX, 5, 0])).toBe(true);
      expect(w2.raycast([faceX + 5, 5, 0], [-1, 0, 0], 5)!.t).toBe(5);
      // Z 方向でも同じ
      const w3 = createCollisionWorld();
      w3.addCollider(box([-10, 0, faceX], [10, 10, faceX + 8]), 'wall');
      expect(w3.segmentBlocked([0, 5, faceX - 5], [0, 5, faceX])).toBe(true);
      expect(w3.raycast([0, 5, faceX - 5], [0, 0, 1], 5)!.t).toBe(5);
      // 面上から離れる線分は当たらない（rayAABB と同じ）
      expect(w.segmentBlocked([faceX, 5, 0], [faceX - 5, 5, 0])).toBe(false);
      expect(w.raycast([faceX, 5, 0], [-1, 0, 0], 5)).toBeNull();
    }
  });

  it('a 45° ray passing exactly through a cell corner still tests the collider touched only at that corner (DDA corner case)', () => {
    // 箱は角セル (-1,-6) を占め、その min 角 (-16, -96) をレイがちょうど通過する（辺かすめ = 閉境界の接触）。
    // 方向成分は ±SQRT1_2 で、両軸の進入割合が同じ浮動小数点値になるので狭域判定は必ず「接触」になる
    const w = createCollisionWorld();
    const id = w.addCollider(box([-CELL_SIZE, 0, -6 * CELL_SIZE], [0, 10, -5 * CELL_SIZE]), 'cornerBox');
    const origin: Vec3 = [0, 5, -7 * CELL_SIZE];
    const dir: Vec3 = [-Math.SQRT1_2, 0, Math.SQRT1_2];
    const brute = rayAABB(origin, dir, w.colliders()[0].box, 40);
    expect(brute).not.toBeNull();
    expect(brute!.t).toBeCloseTo(CELL_SIZE * Math.SQRT2, 9);
    const h = w.raycast(origin, dir, 40);
    expect(h).not.toBeNull();
    expect(h!.t).toBe(brute!.t);
    expect(h!.colliderId).toBe(id);
    const b = addScaled(origin, dir, 30);
    expect(segmentAABB(origin, b, w.colliders()[0].box)).toBe(true);
    expect(w.segmentBlocked(origin, b)).toBe(true);
    // 角の反対側（+X,-Z 方向へ進む）でも同じ
    const w2 = createCollisionWorld();
    w2.addCollider(box([0, 0, -8 * CELL_SIZE], [CELL_SIZE, 10, -7 * CELL_SIZE]), 'cornerBox2');
    const dir2: Vec3 = [Math.SQRT1_2, 0, -Math.SQRT1_2];
    const o2: Vec3 = [-CELL_SIZE, 5, -6 * CELL_SIZE];
    expect(rayAABB(o2, dir2, w2.colliders()[0].box, 40)).not.toBeNull();
    expect(w2.raycast(o2, dir2, 40)).not.toBeNull();
    expect(w2.segmentBlocked(o2, addScaled(o2, dir2, 30))).toBe(true);
  });

  it('randomised grid-aligned endpoints: segmentBlocked and raycast match brute force', () => {
    const rng = new Rng(31337);
    const w = createCollisionWorld();
    for (let i = 0; i < 150; i++) {
      const ix = Math.floor(rng.range(-6, 6));
      const iz = Math.floor(rng.range(-6, 6));
      const y0 = rng.range(-5, 5);
      w.addCollider(box([ix * CELL_SIZE, y0, iz * CELL_SIZE], [(ix + 1 + Math.floor(rng.range(0, 2))) * CELL_SIZE, y0 + rng.range(4, 20), (iz + 1 + Math.floor(rng.range(0, 2))) * CELL_SIZE]));
    }
    let blockedCount = 0;
    for (let i = 0; i < 1500; i++) {
      // 端点の X/Z をセル境界（16 m の倍数）にそろえ、方向は軸平行・45°・ランダムを混ぜる
      const snap = (v: number): number => Math.round(v / CELL_SIZE) * CELL_SIZE;
      const a: Vec3 = [snap(rng.range(-110, 110)), rng.range(-8, 30), snap(rng.range(-110, 110))];
      let d: Vec3;
      switch (i % 5) {
        case 0:
          d = [1, 0, 0];
          break;
        case 1:
          d = [0, 0, -1];
          break;
        case 2:
          d = normalize([1, 0, 1]);
          break;
        case 3:
          d = normalize([-1, 0.2, 1]);
          break;
        default:
          d = randomDir(rng);
      }
      const len = i % 3 === 0 ? CELL_SIZE * Math.floor(rng.range(1, 5)) : rng.range(0.5, 90);
      const b = addScaled(a, d, len);
      const x = w.segmentBlocked(a, b);
      const y = bruteSegmentBlocked(w, a, b);
      expect(x).toBe(y);
      if (y) blockedCount++;
      const rx = w.raycast(a, d, len);
      const ry = bruteRaycast(w, a, d, len);
      expect(rx === null).toBe(ry === null);
      if (rx && ry) expect(Math.abs(rx.t - ry.t)).toBeLessThan(1e-9);
    }
    expect(blockedCount).toBeGreaterThan(100);
    expect(blockedCount).toBeLessThan(1500);
  });
});

// ---------------------------------------------------------------------------
// 独立した参照（スラブ法を使わないサンプリング/閉形式）による検証
// ---------------------------------------------------------------------------

/** 点が閉じた AABB（tol だけ縮めた/広げた）に含まれるか */
function pointInAABB(p: Vec3, b: AABB, tol: number): boolean {
  return (
    p[0] >= b.min[0] - tol &&
    p[0] <= b.max[0] + tol &&
    p[1] >= b.min[1] - tol &&
    p[1] <= b.max[1] + tol &&
    p[2] >= b.min[2] - tol &&
    p[2] <= b.max[2] + tol
  );
}

/** 点から閉じた AABB までの距離 */
function pointAABBDistance(p: Vec3, b: AABB): number {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const d = p[k] < b.min[k] ? b.min[k] - p[k] : p[k] > b.max[k] ? p[k] - b.max[k] : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

/** 点が AABB の表面上にあるか（tol 以内） */
function pointOnAABBSurface(p: Vec3, b: AABB, tol: number): boolean {
  if (!pointInAABB(p, b, tol)) return false;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(p[k] - b.min[k]) <= tol || Math.abs(p[k] - b.max[k]) <= tol) return true;
  }
  return false;
}

describe('independent references (sampling / closed form, not slab-based)', () => {
  const N = 1000;

  it('sweepSphere: contact t agrees with point sampling against r-expanded AABBs and the contact point lies on the surface', () => {
    const rng = new Rng(99);
    const world = randomWorld(rng, 300, 120);
    let hits = 0;
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const a: Vec3 = [rng.range(-150, 150), rng.range(-20, 70), rng.range(-150, 150)];
      const b = addScaled(a, randomDir(rng), rng.range(0.5, 60));
      const r = rng.range(0.05, 1.5);
      // 独立した前処理: 線分の包含 AABB と拡張 AABB の重なりで候補を絞る
      const segBox: AABB = {
        min: [Math.min(a[0], b[0]) - 1e-6, Math.min(a[1], b[1]) - 1e-6, Math.min(a[2], b[2]) - 1e-6],
        max: [Math.max(a[0], b[0]) + 1e-6, Math.max(a[1], b[1]) + 1e-6, Math.max(a[2], b[2]) + 1e-6],
      };
      const cands = world
        .colliders()
        .map((e) => ({ id: e.id, box: expandAABB(e.box, r) }))
        .filter((c) => aabbOverlap(c.box, segBox));
      const hit = world.sweepSphere(a, b, r);
      if (cands.length === 0) {
        expect(hit).toBeNull();
        continue;
      }
      checked++;
      let firstInside = -1;
      for (let k = 0; k <= N && firstInside < 0; k++) {
        const p = addScaled(a, sub(b, a), k / N);
        if (cands.some((c) => pointInAABB(p, c.box, -1e-9))) firstInside = k; // 厳密な内部
      }
      if (hit === null) {
        expect(firstInside).toBe(-1); // 内部のサンプルがあるのに null は誤り
        continue;
      }
      hits++;
      const cbox = cands.find((c) => c.id === hit.colliderId)!.box;
      // 接触点は拡張 AABB の表面上（t=0 の開始時重なりは内部で良い）
      if (hit.t > 0) expect(pointOnAABBSurface(hit.point, cbox, 1e-9)).toBe(true);
      else expect(pointInAABB(hit.point, cbox, 1e-9)).toBe(true);
      // 接触より前のサンプルはどの拡張 AABB の厳密な内部にもない
      for (let k = 0; k / N < hit.t - 1e-9; k++) {
        const p = addScaled(a, sub(b, a), k / N);
        expect(cands.some((c) => pointInAABB(p, c.box, -1e-9))).toBe(false);
      }
      // 内部のサンプルがあるなら接触はその直前の区間内
      if (firstInside >= 0) {
        expect(hit.t).toBeLessThanOrEqual(firstInside / N + 1e-12);
        expect(hit.t).toBeGreaterThanOrEqual((firstInside - 1) / N - 1e-12);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(hits).toBeGreaterThan(20);
  });

  it('segmentBlocked: agrees with point sampling (inside sample ⇒ blocked; blocked ⇒ some sample within one step of a box)', () => {
    const rng = new Rng(1234);
    const world = randomWorld(rng, 300, 120);
    let blocked = 0;
    for (let i = 0; i < 400; i++) {
      const a: Vec3 = [rng.range(-150, 150), rng.range(-20, 70), rng.range(-150, 150)];
      const len = rng.range(0.5, 80);
      const b = addScaled(a, randomDir(rng), len);
      const x = world.segmentBlocked(a, b);
      let anyInside = false;
      let minDist = Infinity;
      for (let k = 0; k <= N; k++) {
        const p = addScaled(a, sub(b, a), k / N);
        for (const e of world.colliders()) {
          if (pointInAABB(p, e.box, -1e-9)) anyInside = true;
          const d = pointAABBDistance(p, e.box);
          if (d < minDist) minDist = d;
        }
        if (anyInside) break;
      }
      if (anyInside) expect(x).toBe(true);
      if (x) {
        blocked++;
        expect(minDist).toBeLessThanOrEqual(len / N + 1e-9);
      } else {
        expect(anyInside).toBe(false);
      }
    }
    expect(blocked).toBeGreaterThan(30);
  });

  it('sweptSphereVsMovingSphere: closed-form check (contact distance = r+R at t, no earlier approach, null ⇒ min distance ≥ r+R)', () => {
    const rng = new Rng(2026);
    let hits = 0;
    for (let i = 0; i < 2000; i++) {
      const a: Vec3 = [rng.range(-5, 5), rng.range(-5, 5), rng.range(-5, 5)];
      const prev: Vec3 = [rng.range(-5, 5), rng.range(-5, 5), rng.range(-5, 5)];
      const cur = addScaled(prev, randomDir(rng), rng.range(0, 6));
      // 半数は対象の中間位置へ向けて撃ち、命中例を十分に含める
      const aim = i % 2 === 0 ? randomDir(rng) : normalize(sub(addScaled(prev, sub(cur, prev), rng.range(0, 1)), a));
      const b = addScaled(a, aim, rng.range(0, 12));
      const r = rng.range(0.01, 0.5);
      const R = rng.range(0.1, 2);
      const t = sweptSphereVsMovingSphere(a, b, r, prev, cur, R);
      const dist = (s: number): number => distance(addScaled(a, sub(b, a), s), addScaled(prev, sub(cur, prev), s));
      // 相対運動 m + d s の最小距離（閉形式）
      const m = sub(a, prev);
      const d = sub(sub(b, a), sub(cur, prev));
      const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const sStar = dd > 0 ? Math.min(1, Math.max(0, -(m[0] * d[0] + m[1] * d[1] + m[2] * d[2]) / dd)) : 0;
      const dmin = dist(sStar);
      if (t === null) {
        expect(dmin).toBeGreaterThanOrEqual(r + R - 1e-9);
        continue;
      }
      hits++;
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
      if (t === 0) {
        expect(dist(0)).toBeLessThanOrEqual(r + R + 1e-9);
      } else {
        expect(Math.abs(dist(t) - (r + R))).toBeLessThan(1e-7);
        for (let k = 0; k < 200; k++) {
          const s = (t * k) / 200;
          expect(dist(s)).toBeGreaterThan(r + R - 1e-9);
        }
      }
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('sweptSphereVsMovingBox: sampling check against the moving r-expanded box', () => {
    const rng = new Rng(777);
    const M = 500;
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      const a: Vec3 = [rng.range(-6, 6), rng.range(-6, 6), rng.range(-6, 6)];
      const prev: Vec3 = [rng.range(-4, 4), rng.range(-4, 4), rng.range(-4, 4)];
      const cur = addScaled(prev, randomDir(rng), rng.range(0, 6));
      const aim = i % 2 === 0 ? randomDir(rng) : normalize(sub(addScaled(prev, sub(cur, prev), rng.range(0, 1)), a));
      const b = addScaled(a, aim, rng.range(0, 14));
      const r = rng.range(0.01, 0.5);
      const half: Vec3 = [rng.range(0.2, 2), rng.range(0.2, 2), rng.range(0.2, 2)];
      const h = sweptSphereVsMovingBox(a, b, r, prev, cur, half);
      const boxAt = (s: number): AABB => {
        const c = addScaled(prev, sub(cur, prev), s);
        return { min: [c[0] - half[0] - r, c[1] - half[1] - r, c[2] - half[2] - r], max: [c[0] + half[0] + r, c[1] + half[1] + r, c[2] + half[2] + r] };
      };
      const pAt = (s: number): Vec3 => addScaled(a, sub(b, a), s);
      if (h === null) {
        for (let k = 0; k <= M; k++) expect(pointInAABB(pAt(k / M), boxAt(k / M), -1e-9)).toBe(false);
        continue;
      }
      hits++;
      expect(h.t).toBeGreaterThanOrEqual(0);
      expect(h.t).toBeLessThanOrEqual(1);
      if (h.t > 0) {
        expect(pointOnAABBSurface(pAt(h.t), boxAt(h.t), 1e-9)).toBe(true);
        // 法線の軸の面に接している
        const axis = h.normal[0] !== 0 ? 0 : h.normal[1] !== 0 ? 1 : 2;
        const bx = boxAt(h.t);
        const face = h.normal[axis] > 0 ? bx.max[axis] : bx.min[axis];
        expect(Math.abs(pAt(h.t)[axis] - face)).toBeLessThan(1e-9);
      } else {
        expect(pointInAABB(pAt(0), boxAt(0), 1e-9)).toBe(true);
      }
      for (let k = 0; k / M < h.t - 1e-9; k++) expect(pointInAABB(pAt(k / M), boxAt(k / M), -1e-9)).toBe(false);
    }
    expect(hits).toBeGreaterThan(60);
  });
});
