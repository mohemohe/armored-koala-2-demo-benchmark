// 警備ロボット用の格子ナビゲーショングラフ（多層対応）とA*探索。
import type { V3 } from '../math';
import type { CollisionWorld } from './world';
import type { AABB, SectorDef } from '../stage/types';

export interface NavNode {
  x: number;
  y: number;
  z: number;
  nbr: number[];
  cost: number[];
  /** この地点を塞ぐ隔壁ID（閉鎖中は通行不可） */
  barrier: string | null;
  comp: number;
}

interface HeapItem {
  f: number;
  n: number;
}

class MinHeap {
  a: HeapItem[] = [];
  push(it: HeapItem) {
    const a = this.a;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): HeapItem | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1,
          r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

export class NavGraph {
  nodes: NavNode[] = [];
  private cols = new Map<number, number[]>();
  private spacing: number;
  private ox = 0;
  private oz = 0;

  constructor(spacing: number) {
    this.spacing = spacing;
  }

  private key(i: number, k: number) {
    return i * 100000 + k;
  }

  /**
   * world: 隔壁を「開放」状態にした衝突ワールド。barriers: 閉鎖時の隔壁箱。
   */
  build(
    world: CollisionWorld,
    bounds: AABB,
    sectors: SectorDef[],
    portals: AABB[],
    barriers: { id: string; box: AABB }[],
    hw: number,
    h: number,
    maxStep: number,
  ) {
    const sp = this.spacing;
    this.ox = Math.floor(bounds.min[0] / sp) * sp + sp / 2;
    this.oz = Math.floor(bounds.min[2] / sp) * sp + sp / 2;
    const ni = Math.ceil((bounds.max[0] - this.ox) / sp) + 1;
    const nk = Math.ceil((bounds.max[2] - this.oz) / sp) + 1;
    const inPlayable = (x: number, y: number, z: number) => {
      for (const s of sectors) {
        if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1 && y >= s.floor - 0.01 && y <= s.ceil - h) return true;
      }
      for (const p of portals) {
        if (x >= p.min[0] && x <= p.max[0] && z >= p.min[2] && z <= p.max[2] && y >= p.min[1] - 0.01 && y <= p.max[1] - 1) return true;
      }
      return false;
    };
    for (let i = 0; i < ni; i++) {
      for (let k = 0; k < nk; k++) {
        const x = this.ox + i * sp;
        const z = this.oz + k * sp;
        const tops: number[] = [];
        world.queryAABB([x - 0.05, bounds.min[1] - 1, z - 0.05], [x + 0.05, bounds.max[1] + 1, z + 0.05], (b) => {
          tops.push(b.max[1]);
        });
        const list: number[] = [];
        for (const y of tops) {
          if (!inPlayable(x, y, z)) continue;
          if (world.overlapsAny([x - hw, y + 0.02, z - hw], [x + hw, y + h, z + hw])) continue;
          // 足元が十分に支持されているか（中心付近）
          if (!world.overlapsAny([x - 0.3, y - 0.05, z - 0.3], [x + 0.3, y - 0.001, z + 0.3])) continue;
          if (list.some((id) => Math.abs(this.nodes[id].y - y) < 0.05)) continue;
          let barrier: string | null = null;
          for (const bb of barriers) {
            const b = bb.box;
            if (x + hw > b.min[0] && x - hw < b.max[0] && z + hw > b.min[2] && z - hw < b.max[2] && y + h > b.min[1] && y < b.max[1] + 0.05) {
              barrier = bb.id;
            }
          }
          list.push(this.nodes.length);
          this.nodes.push({ x, y, z, nbr: [], cost: [], barrier, comp: -1 });
        }
        if (list.length) this.cols.set(this.key(i, k), list);
      }
    }
    // 辺
    const dirs = [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
    ];
    for (let i = 0; i < ni; i++) {
      for (let k = 0; k < nk; k++) {
        const a = this.cols.get(this.key(i, k));
        if (!a) continue;
        for (const [di, dk] of dirs) {
          const b = this.cols.get(this.key(i + di, k + dk));
          if (!b) continue;
          for (const ia of a) {
            for (const ib of b) {
              const na = this.nodes[ia],
                nb = this.nodes[ib];
              if (Math.abs(na.y - nb.y) > maxStep) continue;
              const y = Math.max(na.y, nb.y) + 0.02;
              const mx = (na.x + nb.x) / 2,
                mz = (na.z + nb.z) / 2;
              // 経路の掃引箱が空いているか
              let blocked = false;
              if (di === 0 || dk === 0) {
                blocked = world.overlapsAny(
                  [Math.min(na.x, nb.x) - hw, y, Math.min(na.z, nb.z) - hw],
                  [Math.max(na.x, nb.x) + hw, y + h - 0.02, Math.max(na.z, nb.z) + hw],
                );
              } else {
                blocked = world.overlapsAny([mx - hw, y, mz - hw], [mx + hw, y + h - 0.02, mz + hw]);
                if (!blocked) {
                  // 角の抜けを防ぐ
                  const q1 = world.overlapsAny([na.x - hw, y, nb.z - hw], [na.x + hw, y + h - 0.02, nb.z + hw]);
                  const q2 = world.overlapsAny([nb.x - hw, y, na.z - hw], [nb.x + hw, y + h - 0.02, na.z + hw]);
                  blocked = q1 || q2;
                }
              }
              if (blocked) continue;
              // 中間に床があるか
              const g = world.groundBelow(mx, Math.max(na.y, nb.y) + 0.3, mz, 0.3, 0.3 + maxStep);
              if (g === null) continue;
              const c = Math.hypot(na.x - nb.x, na.y - nb.y, na.z - nb.z);
              na.nbr.push(ib);
              na.cost.push(c);
              nb.nbr.push(ia);
              nb.cost.push(c);
            }
          }
        }
      }
    }
    // 連結成分
    let comp = 0;
    for (let s = 0; s < this.nodes.length; s++) {
      if (this.nodes[s].comp >= 0) continue;
      const stack = [s];
      this.nodes[s].comp = comp;
      while (stack.length) {
        const n = stack.pop()!;
        for (const m of this.nodes[n].nbr) {
          if (this.nodes[m].comp < 0) {
            this.nodes[m].comp = comp;
            stack.push(m);
          }
        }
      }
      comp++;
    }
  }

  /** 位置に最も近いノード（上方優先しない。y差は重み付き） */
  nearest(p: V3, maxR = 9, maxAbove = 1.5): number {
    const sp = this.spacing;
    const ci = Math.round((p[0] - this.ox) / sp);
    const ck = Math.round((p[2] - this.oz) / sp);
    const r = Math.ceil(maxR / sp);
    let best = -1;
    let bestD = Infinity;
    for (let i = ci - r; i <= ci + r; i++)
      for (let k = ck - r; k <= ck + r; k++) {
        const list = this.cols.get(this.key(i, k));
        if (!list) continue;
        for (const id of list) {
          const n = this.nodes[id];
          const dy = p[1] - n.y;
          if (dy < -maxAbove) continue; // ノードが上にありすぎる
          const d = Math.hypot(n.x - p[0], n.z - p[2]) + Math.abs(dy) * 0.6;
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
      }
    return best;
  }

  /** 真下優先で最も近いノード（プレイヤーが空中にいる場合用） */
  nearestBelow(p: V3, maxR = 12): number {
    const id = this.nearest(p, maxR, 1.5);
    if (id >= 0) return id;
    return this.nearest(p, maxR * 2, 60);
  }

  /**
   * A*。到達不能なら目標に最も近い到達可能ノードまでの経路を返す。
   */
  findPath(start: number, goal: number, closed: Set<string>, maxExpand = 6000): number[] | null {
    if (start < 0 || goal < 0) return null;
    const nodes = this.nodes;
    const g = new Map<number, number>();
    const came = new Map<number, number>();
    const heap = new MinHeap();
    const goalN = nodes[goal];
    const hfun = (n: number) => Math.hypot(nodes[n].x - goalN.x, nodes[n].y - goalN.y, nodes[n].z - goalN.z);
    g.set(start, 0);
    heap.push({ f: hfun(start), n: start });
    let bestNode = start;
    let bestH = hfun(start);
    let expanded = 0;
    const done = new Set<number>();
    while (heap.size > 0 && expanded < maxExpand) {
      const it = heap.pop()!;
      const n = it.n;
      if (done.has(n)) continue;
      done.add(n);
      expanded++;
      if (n === goal) {
        bestNode = n;
        break;
      }
      const hn = hfun(n);
      if (hn < bestH) {
        bestH = hn;
        bestNode = n;
      }
      const gn = g.get(n)!;
      const node = nodes[n];
      for (let j = 0; j < node.nbr.length; j++) {
        const m = node.nbr[j];
        const bm = nodes[m].barrier;
        if (bm && closed.has(bm)) continue;
        const ng = gn + node.cost[j];
        const og = g.get(m);
        if (og === undefined || ng < og) {
          g.set(m, ng);
          came.set(m, n);
          heap.push({ f: ng + hfun(m), n: m });
        }
      }
    }
    const path: number[] = [bestNode];
    let cur = bestNode;
    while (came.has(cur)) {
      cur = came.get(cur)!;
      path.push(cur);
    }
    path.reverse();
    return path;
  }

  /** 開始ノードから経路距離 maxDist 以内のノード集合 */
  withinPathDistance(start: number, maxDist: number, closed: Set<string>): Set<number> {
    const out = new Set<number>();
    if (start < 0) return out;
    const dist = new Map<number, number>();
    const heap = new MinHeap();
    dist.set(start, 0);
    heap.push({ f: 0, n: start });
    while (heap.size > 0) {
      const { f, n } = heap.pop()!;
      if (out.has(n)) continue;
      if (f > maxDist) break;
      out.add(n);
      const node = this.nodes[n];
      for (let j = 0; j < node.nbr.length; j++) {
        const m = node.nbr[j];
        const bm = this.nodes[m].barrier;
        if (bm && closed.has(bm)) continue;
        const nd = f + node.cost[j];
        if (nd <= maxDist && (dist.get(m) ?? Infinity) > nd) {
          dist.set(m, nd);
          heap.push({ f: nd, n: m });
        }
      }
    }
    return out;
  }

  /** 開始ノードから半径内のランダムな同一成分ノード（巡回用） */
  randomNear(center: V3, radius: number, comp: number, rnd: () => number): number {
    const sp = this.spacing;
    for (let tries = 0; tries < 12; tries++) {
      const ang = rnd() * Math.PI * 2;
      const r = rnd() * radius;
      const x = center[0] + Math.cos(ang) * r;
      const z = center[2] + Math.sin(ang) * r;
      const i = Math.round((x - this.ox) / sp);
      const k = Math.round((z - this.oz) / sp);
      const list = this.cols.get(this.key(i, k));
      if (!list) continue;
      for (const id of list) {
        const n = this.nodes[id];
        if (n.comp === comp && Math.abs(n.y - center[1]) < 3) return id;
      }
    }
    return -1;
  }
}
