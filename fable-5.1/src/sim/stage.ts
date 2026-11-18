/**
 * ステージ実行時状態: 衝突ワールド、隔壁、最終ゲート、区画判定。
 */
import type { AABB, BarrierDef, CollisionWorld, StageData, Vec3 } from '../types';
import { createCollisionWorld } from './collision';

export function pointInAABB(p: Vec3, b: AABB): boolean {
  return p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2];
}

export class StageRuntime {
  readonly data: StageData;
  readonly world: CollisionWorld;
  private barrierColliderIds = new Map<string, number>();
  private gateColliderId: number | null = null;
  readonly openBarrierIds: string[] = [];
  gateOpen = false;
  private readonly barrierById = new Map<string, BarrierDef>();

  constructor(data: StageData) {
    this.data = data;
    this.world = createCollisionWorld();
    for (const s of data.solids) this.world.addCollider(s.box, s.material);
    for (const b of data.barriers) this.barrierById.set(b.id, b);
    this.reset();
  }

  /** 隔壁とゲートを全て閉じる */
  reset(): void {
    for (const id of this.barrierColliderIds.values()) this.world.removeCollider(id);
    this.barrierColliderIds.clear();
    if (this.gateColliderId !== null) this.world.removeCollider(this.gateColliderId);
    for (const b of this.data.barriers) this.barrierColliderIds.set(b.id, this.world.addCollider(b.box, 'barrier:' + b.id));
    this.gateColliderId = this.world.addCollider(this.data.gate.box, 'gate:' + this.data.gate.id);
    this.openBarrierIds.length = 0;
    this.gateOpen = false;
  }

  barrier(id: string): BarrierDef | undefined {
    return this.barrierById.get(id);
  }

  isBarrierOpen(id: string): boolean {
    return this.openBarrierIds.includes(id);
  }

  /** 隔壁を開く。開いたら true（既に開いていれば false） */
  openBarrier(id: string): boolean {
    const cid = this.barrierColliderIds.get(id);
    if (cid === undefined) return false;
    this.world.removeCollider(cid);
    this.barrierColliderIds.delete(id);
    if (!this.openBarrierIds.includes(id)) this.openBarrierIds.push(id);
    return true;
  }

  openGate(): boolean {
    if (this.gateOpen) return false;
    if (this.gateColliderId !== null) {
      this.world.removeCollider(this.gateColliderId);
      this.gateColliderId = null;
    }
    this.gateOpen = true;
    return true;
  }

  /** 点が属する区画 ID（複数に該当する場合は定義順で最初） */
  sectorAt(p: Vec3): string | null {
    for (const s of this.data.sectors) {
      for (const b of s.bounds) if (pointInAABB(p, b)) return s.id;
    }
    return null;
  }

  sectorName(id: string | null): string {
    if (id === null) return '---';
    const s = this.data.sectors.find((x) => x.id === id);
    return s ? s.name : id;
  }

  isInExitZone(p: Vec3): boolean {
    return pointInAABB(p, this.data.exitZone);
  }
}
