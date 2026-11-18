/**
 * 区画ビルダー用キット。区画モジュール (src/stage/sectors/Sxx.ts) は `build(kit)` の中で kit だけを使って内部を作る。
 *
 * 規約 (SPEC §2.2 / docs/ARCH.md §5):
 *  - 殻(床スラブ・壁・天井スラブ・portal開口・隔壁の箱)は StageBuilder が build(kit) の前に自動で作る。モジュールは殻を変えない。
 *  - 描画メッシュ = 衝突箱。通行可能空間に入る構造物は必ず kit.box 系(=衝突箱)で作る。衝突のない飾りは kit.decor だけ。
 *  - 箱は自区画の bounds の中に置く。portal前の6m四方(開口の前面)・ARENA_CLEAR(戦闘区画の空けておく床矩形)・RESERVED(出撃位置/分岐経路の点/
 *    昇降の離陸柱と飛行コリドー)には置けない(例外を投げる)。
 *  - ID は "<区画>-<name>-<n>" を自動採番、敵は G01.. / T01.. を区画順(S01→S20)に自動採番する。
 *  - 敵の pos は当たり判定中心: 警備 = 床+1.5, 砲台 = 台座上面+1.6。
 */
import { ENEMIES } from '../config';
import type { BarrierDef, BoxDef, EnemySpawn, MaterialKey, PortalDef, SectorDef, StageDef, V3 } from '../sim/types';
import {
  ARENA_CLEAR, BARRIER_INFO, BRANCHES, CLIMBS, CLIMB_SPECS, ESCAPE_ZONE, KILL_Y, LOOPS, MAIN_ROUTE, PLAYER_START, PORTALS, PORTAL_AXIS,
  RESERVED, SECTORS, STAGE_NAME, WALL, barrierSkeleton,
} from './blueprint';

export interface BoxExtra { shape?: BoxDef['shape']; emissive?: number }
export interface Rect { x0: number; z0: number; x1: number; z1: number }

const EPS = 1e-6;
const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

/** 区画の種別ごとの殻の材質 */
const SHELL_MATS: Record<string, { floor: MaterialKey; wall: MaterialKey }> = {
  dock: { floor: 'concreteDark', wall: 'concrete' },
  yard: { floor: 'concrete', wall: 'concrete' },
  factory: { floor: 'floorTile', wall: 'concreteDark' },
  shaft: { floor: 'metalDark', wall: 'metal' },
  corridor: { floor: 'concreteDark', wall: 'metalDark' },
  pipe: { floor: 'grating', wall: 'metalDark' },
  multilevel: { floor: 'floorTile', wall: 'concrete' },
  warehouse: { floor: 'concrete', wall: 'rust' },
  gate: { floor: 'floorTile', wall: 'metal' },
};

interface Opening { lo: number; hi: number; y0: number; y1: number }

/** 区画に接する portal の(壁面, 開口)を求める */
function portalFaces(sector: SectorDef): { portal: PortalDef; face: 'n' | 's' | 'w' | 'e'; lo: number; hi: number; y0: number; y1: number }[] {
  const b = sector.bounds;
  const out: { portal: PortalDef; face: 'n' | 's' | 'w' | 'e'; lo: number; hi: number; y0: number; y1: number }[] = [];
  for (const p of PORTALS) {
    if (p.a !== sector.id && p.b !== sector.id) continue;
    const axis = PORTAL_AXIS[p.id];
    const plane = axis === 'x' ? p.center.x : p.center.z;
    const lat = axis === 'x' ? p.center.z : p.center.x;
    let face: 'n' | 's' | 'w' | 'e';
    if (axis === 'x') face = Math.abs(plane - b.min.x) < EPS ? 'w' : Math.abs(plane - b.max.x) < EPS ? 'e' : 'w';
    else face = Math.abs(plane - b.min.z) < EPS ? 'n' : Math.abs(plane - b.max.z) < EPS ? 's' : 'n';
    const onFace =
      (axis === 'x' && (Math.abs(plane - b.min.x) < EPS || Math.abs(plane - b.max.x) < EPS)) ||
      (axis === 'z' && (Math.abs(plane - b.min.z) < EPS || Math.abs(plane - b.max.z) < EPS));
    if (!onFace) throw new Error(`portal ${p.id} is not on a face of ${sector.id}`);
    out.push({ portal: p, face, lo: lat - p.width / 2, hi: lat + p.width / 2, y0: p.center.y - p.height / 2, y1: p.center.y + p.height / 2 });
  }
  return out;
}

export class Kit {
  readonly sector: SectorDef;
  readonly id: string;
  readonly floorY: number;
  readonly ceilingY: number;
  /** 壁の内側(通行可能な水平範囲) */
  readonly inner: Rect;
  private readonly faces: ReturnType<typeof portalFaces>;
  private internal = false;

  constructor(private readonly sb: StageBuilder, sector: SectorDef) {
    this.sector = sector;
    this.id = sector.id;
    this.floorY = sector.floorY;
    this.ceilingY = sector.ceilingY;
    const b = sector.bounds;
    this.inner = { x0: b.min.x + WALL, z0: b.min.z + WALL, x1: b.max.x - WALL, z1: b.max.z - WALL };
    this.faces = portalFaces(sector);
  }

  // ------------------------------------------------------------------ primitives (collision boxes)
  /** 軸平行の衝突箱。id は自動採番 "<区画>-<name>-<n>" */
  box(name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: MaterialKey = 'concrete', extra: BoxExtra & { barrierId?: string } = {}): BoxDef {
    if (!(x1 > x0 && y1 > y0 && z1 > z0)) throw new Error(`${this.id}-${name}: empty box (${x0},${y0},${z0})-(${x1},${y1},${z1})`);
    const b = this.sector.bounds;
    if (x0 < b.min.x - EPS || x1 > b.max.x + EPS || y0 < b.min.y - EPS || y1 > b.max.y + EPS || z0 < b.min.z - EPS || z1 > b.max.z + EPS) {
      throw new Error(`${this.id}-${name}: box (${x0},${y0},${z0})-(${x1},${y1},${z1}) leaves the sector bounds`);
    }
    if (!this.internal) this.checkReserved(name, x0, y0, z0, x1, y1, z1);
    const id = this.sb.nextBoxId(this.id, name);
    const def: BoxDef = { id, mat, sectorId: this.id, min: v(x0, y0, z0), max: v(x1, y1, z1) };
    if (extra.shape) def.shape = extra.shape;
    if (extra.emissive !== undefined) def.emissive = extra.emissive;
    if (extra.barrierId) def.barrierId = extra.barrierId;
    this.sb.boxes.push(def);
    return def;
  }

  /** 中心+寸法の箱 */
  boxC(name: string, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, mat: MaterialKey = 'concrete', extra: BoxExtra = {}): BoxDef {
    return this.box(name, cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2, mat, extra);
  }

  /** 床(y0, 既定=区画の床)から高さ h の箱 */
  fbox(name: string, x0: number, z0: number, x1: number, z1: number, h: number, mat: MaterialKey = 'concrete', y0: number = this.floorY, extra: BoxExtra = {}): BoxDef {
    return this.box(name, x0, y0, z0, x1, y0 + h, z1, mat, extra);
  }

  /** 木箱/コンテナ: 中心(cx,cz) 幅w(x) 奥行d(z) 高さh */
  crate(name: string, cx: number, cz: number, w: number, d: number, h: number, mat: MaterialKey = 'crate', y0: number = this.floorY): BoxDef {
    return this.box(name, cx - w / 2, y0, cz - d / 2, cx + w / 2, y0 + h, cz + d / 2, mat);
  }

  /** 柱。y0..y1 の既定は 床〜天井 */
  pillar(name: string, cx: number, cz: number, size: number, y0: number = this.floorY, y1: number = this.ceilingY, mat: MaterialKey = 'metalDark'): BoxDef {
    return this.box(name, cx - size / 2, y0, cz - size / 2, cx + size / 2, y1, cz + size / 2, mat);
  }

  /**
   * 配管/タンク/ダクト。axis は円柱の軸方向。衝突は常に外接AABBなので、見た目=衝突を守るため円柱ヒント(shape)は断面が3m以下のときだけ付ける
   * (太いものは箱として描画される: 円柱の四隅に見えない壁が残るのを避ける)。
   */
  pipe(name: string, axis: 'x' | 'y' | 'z', x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: MaterialKey = 'pipe'): BoxDef {
    const cross = axis === 'x' ? [y1 - y0, z1 - z0] : axis === 'y' ? [x1 - x0, z1 - z0] : [x1 - x0, y1 - y0];
    const thin = Math.max(cross[0], cross[1]) <= 3 + EPS;
    return this.box(name, x0, y0, z0, x1, y1, z1, mat, thin ? { shape: axis === 'x' ? 'cylX' : axis === 'y' ? 'cylY' : 'cylZ' } : {});
  }

  /** 張り出し足場/デッキ: 上面 topY、厚さ thick(既定2m) */
  platform(name: string, x0: number, z0: number, x1: number, z1: number, topY: number, thick = 2, mat: MaterialKey = 'grating'): BoxDef {
    return this.box(name, x0, topY - thick, z0, x1, topY, z1, mat);
  }

  /** キャットウォーク: 足場 + 指定した辺(n=z小,s=z大,w=x小,e=x大)の手すり(高さ1.2mの衝突箱) */
  catwalk(name: string, x0: number, z0: number, x1: number, z1: number, topY: number, rails: ('n' | 's' | 'w' | 'e')[] = [], mat: MaterialKey = 'grating'): BoxDef {
    const deck = this.platform(name, x0, z0, x1, z1, topY, 1, mat);
    const t = 0.3;
    for (const r of rails) {
      if (r === 'n') this.box(`${name}-rail`, x0, topY, z0, x1, topY + 1.2, z0 + t, 'metal');
      if (r === 's') this.box(`${name}-rail`, x0, topY, z1 - t, x1, topY + 1.2, z1, 'metal');
      if (r === 'w') this.box(`${name}-rail`, x0, topY, z0, x0 + t, topY + 1.2, z1, 'metal');
      if (r === 'e') this.box(`${name}-rail`, x1 - t, topY, z0, x1, topY + 1.2, z1, 'metal');
    }
    return deck;
  }

  /** 台座(砲台・狙撃位置用)。上面 topY */
  pedestal(name: string, cx: number, cz: number, size: number, topY: number, baseY: number = this.floorY, mat: MaterialKey = 'machine'): BoxDef {
    return this.box(name, cx - size / 2, baseY, cz - size / 2, cx + size / 2, topY, cz + size / 2, mat);
  }

  /** 仕切り壁(床 y0 から高さ h の箱)。厚さは (x0..x1, z0..z1) の短い方で指定する。全高にするなら h = 天井 - 床 */
  partition(name: string, x0: number, z0: number, x1: number, z1: number, h: number, mat: MaterialKey = 'concreteDark', y0: number = this.floorY): BoxDef {
    return this.box(name, x0, y0, z0, x1, y0 + h, z1, mat);
  }

  /** 衝突のない装飾(配管の細部・ケーブル・看板・警告灯)。通行可能空間に入れない(壁面から0.15m以内など) */
  decor(name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: MaterialKey = 'pipe', extra: BoxExtra = {}): BoxDef {
    const id = this.sb.nextBoxId(this.id, `d-${name}`);
    const def: BoxDef = { id, mat, sectorId: this.id, min: v(x0, y0, z0), max: v(x1, y1, z1) };
    if (extra.shape) def.shape = extra.shape;
    if (extra.emissive !== undefined) def.emissive = extra.emissive;
    this.sb.decor.push(def);
    return def;
  }

  // ------------------------------------------------------------------ blueprint structures
  /**
   * 昇降(CLIMB_SPECS)の足場を作る。to側(上)と、fromPad があれば from側の足場(skipFrom=true で省略: 既に別の昇降で作った足場のとき)。
   * columns は上の足場の支柱位置[x,z](足場の下を床から支える柱)。solid=true は足場の下を床まで詰めた基礎にする。
   */
  climbPads(climbId: string, columns: [number, number][] = [], skipFrom = false, solid = false): void {
    const spec = CLIMB_SPECS.find((c) => c.id === climbId);
    if (!spec || spec.sectorId !== this.id) throw new Error(`climb ${climbId} does not belong to ${this.id}`);
    const mk = (tag: string, r: { x0: number; z0: number; x1: number; z1: number; y: number }): void => {
      // solid=true: 下が詰まった土台(機械基礎)。下をくぐって上の足場に回り込めなくする
      if (solid && tag === 'to') this.box(`pad-${climbId}-${tag}`, r.x0, this.floorY, r.z0, r.x1, r.y, r.z1, 'machine');
      else this.platform(`pad-${climbId}-${tag}`, r.x0, r.z0, r.x1, r.z1, r.y, 2, 'metal');
    };
    if (spec.fromPad && !skipFrom) mk('from', spec.fromPad);
    mk('to', spec.toPad);
    for (const [cx, cz] of columns) this.pillar(`pad-${climbId}-col`, cx, cz, 2, this.floorY, spec.toPad.y - 2, 'metalDark');
  }

  // ------------------------------------------------------------------ enemies
  /** 警備ロボットの仮配置。floorTop = 立つ床の上面(既定=区画の床) */
  guard(x: number, z: number, opts: { floorTop?: number; yaw?: number; face?: [number, number]; patrol?: V3[] } = {}): EnemySpawn {
    const ft = opts.floorTop ?? this.floorY;
    const spawn: EnemySpawn = {
      id: this.sb.nextGuardId(), kind: 'guard', sectorId: this.id, pos: v(x, ft + ENEMIES.guard.centerHeight, z),
      yaw: this.yawOf(x, z, opts), isGateControl: false, controlIndex: null, barrierId: null,
    };
    if (opts.patrol) spawn.patrol = opts.patrol;
    this.sb.enemies.push(spawn);
    return spawn;
  }

  /**
   * 固定砲台。台座(5x5m)を自動で作り、上面 = baseY + height, 敵中心 = 上面 + 1.6。
   * control: 0..5 を渡すと制御砲台(隔壁 B(n+1))。
   */
  turret(x: number, z: number, height: number, opts: { baseY?: number; yaw?: number; face?: [number, number]; control?: number; pedestal?: number } = {}): EnemySpawn {
    const base = opts.baseY ?? this.floorY;
    const size = opts.pedestal ?? 5;
    const top = base + height;
    this.pedestal('ped', x, z, size, top, base);
    const c = opts.control;
    const spawn: EnemySpawn = {
      id: this.sb.nextTurretId(), kind: 'turret', sectorId: this.id, pos: v(x, top + ENEMIES.turret.centerHeight, z),
      yaw: this.yawOf(x, z, opts), isGateControl: c !== undefined, controlIndex: c ?? null, barrierId: c !== undefined ? `B${c + 1}` : null,
    };
    if (c !== undefined) this.sb.registerControl(c, spawn.id);
    this.sb.enemies.push(spawn);
    return spawn;
  }

  private yawOf(x: number, z: number, opts: { yaw?: number; face?: [number, number] }): number {
    if (opts.yaw !== undefined) return opts.yaw;
    if (opts.face) return Math.atan2(-(opts.face[0] - x), -(opts.face[1] - z));
    return Math.PI;
  }

  // ------------------------------------------------------------------ shell (StageBuilder が自動で呼ぶ)
  /** @internal */
  buildShell(): void {
    this.internal = true;
    const b = this.sector.bounds;
    const F = this.floorY;
    const C = this.ceilingY;
    const m = SHELL_MATS[this.sector.kind] ?? SHELL_MATS.yard;
    this.box('floor', b.min.x, b.min.y, b.min.z, b.max.x, F, b.max.z, m.floor);
    this.box('roof', b.min.x, C, b.min.z, b.max.x, b.max.y, b.max.z, 'roof');
    const ops = (face: 'n' | 's' | 'w' | 'e'): Opening[] =>
      this.faces.filter((f) => f.face === face).map((f) => ({ lo: f.lo, hi: f.hi, y0: f.y0, y1: f.y1 })).sort((p, q) => p.lo - q.lo);
    this.wallZ('wall-n', b.min.z, b.min.z + WALL, b.min.x, b.max.x, ops('n'), m.wall);
    this.wallZ('wall-s', b.max.z - WALL, b.max.z, b.min.x, b.max.x, ops('s'), m.wall);
    this.wallX('wall-w', b.min.x, b.min.x + WALL, b.min.z + WALL, b.max.z - WALL, ops('w'), m.wall);
    this.wallX('wall-e', b.max.x - WALL, b.max.x, b.min.z + WALL, b.max.z - WALL, ops('e'), m.wall);
    // 隔壁の箱: この区画が portal.a のとき、開口を壁厚の中で完全に塞ぐ
    for (const f of this.faces) {
      const bid = f.portal.barrierId;
      if (!bid || f.portal.a !== this.id) continue;
      const axis = PORTAL_AXIS[f.portal.id];
      const mat: MaterialKey = bid === 'GATE' ? 'gate' : 'barrier';
      let def: BoxDef;
      if (axis === 'x') {
        const x0 = f.face === 'e' ? b.max.x - WALL : b.min.x;
        def = this.box(`barrier-${bid}`, x0, f.y0, f.lo, x0 + WALL, f.y1, f.hi, mat, { barrierId: bid, emissive: 0.5 });
      } else {
        const z0 = f.face === 's' ? b.max.z - WALL : b.min.z;
        def = this.box(`barrier-${bid}`, f.lo, f.y0, z0, f.hi, f.y1, z0 + WALL, mat, { barrierId: bid, emissive: 0.5 });
      }
      this.sb.registerBarrierBox(bid, def.id);
    }
    this.internal = false;
  }

  private segs(spanLo: number, spanHi: number, ops: Opening[]): { lo: number; hi: number; y0: number; y1: number }[] {
    const F = this.floorY;
    const C = this.ceilingY;
    const out: { lo: number; hi: number; y0: number; y1: number }[] = [];
    let cur = spanLo;
    for (const o of ops) {
      if (o.lo < cur - EPS || o.hi > spanHi + EPS) throw new Error(`${this.id}: portal opening [${o.lo},${o.hi}] outside/overlapping the wall span [${cur},${spanHi}]`);
      if (o.y0 < F - EPS || o.y1 > C + EPS) throw new Error(`${this.id}: portal opening y[${o.y0},${o.y1}] outside floor..ceiling [${F},${C}]`);
      if (o.lo > cur + EPS) out.push({ lo: cur, hi: o.lo, y0: F, y1: C });
      if (o.y0 > F + EPS) out.push({ lo: o.lo, hi: o.hi, y0: F, y1: o.y0 });
      if (o.y1 < C - EPS) out.push({ lo: o.lo, hi: o.hi, y0: o.y1, y1: C });
      cur = o.hi;
    }
    if (cur < spanHi - EPS) out.push({ lo: cur, hi: spanHi, y0: F, y1: C });
    return out;
  }
  /** z一定の壁(北/南): x方向に伸びる */
  private wallZ(name: string, z0: number, z1: number, xLo: number, xHi: number, ops: Opening[], mat: MaterialKey): void {
    for (const s of this.segs(xLo, xHi, ops)) this.box(name, s.lo, s.y0, z0, s.hi, s.y1, z1, mat);
  }
  /** x一定の壁(西/東): z方向に伸びる */
  private wallX(name: string, x0: number, x1: number, zLo: number, zHi: number, ops: Opening[], mat: MaterialKey): void {
    for (const s of this.segs(zLo, zHi, ops)) this.box(name, x0, s.y0, s.lo, x1, s.y1, s.hi, mat);
  }

  // ------------------------------------------------------------------ reserved space checks
  private checkReserved(name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const F = this.floorY;
    // portal の前面(開口 x 奥行6m)を塞がない
    for (const f of this.faces) {
      const D = 6;
      let bx0: number, bx1: number, bz0: number, bz1: number;
      if (f.face === 'w') { bx0 = this.inner.x0; bx1 = this.inner.x0 + D; bz0 = f.lo; bz1 = f.hi; }
      else if (f.face === 'e') { bx0 = this.inner.x1 - D; bx1 = this.inner.x1; bz0 = f.lo; bz1 = f.hi; }
      else if (f.face === 'n') { bz0 = this.inner.z0; bz1 = this.inner.z0 + D; bx0 = f.lo; bx1 = f.hi; }
      else { bz0 = this.inner.z1 - D; bz1 = this.inner.z1; bx0 = f.lo; bx1 = f.hi; }
      if (x1 > bx0 && x0 < bx1 && z1 > bz0 && z0 < bz1 && y1 > f.y0 + 1e-3 && y0 < f.y1 - 1e-3) {
        throw new Error(`${this.id}-${name}: blocks the approach to portal ${f.portal.id}`);
      }
    }
    // 出撃位置・分岐経路の点・昇降の離陸柱/飛行コリドー(blueprint.RESERVED)
    for (const r of RESERVED) {
      if (x1 > r.min.x && x0 < r.max.x && y1 > r.min.y && y0 < r.max.y && z1 > r.min.z && z0 < r.max.z) {
        throw new Error(`${this.id}-${name}: intrudes into the reserved space "${r.id}"`);
      }
    }
    // 戦闘区画の空けておく床矩形(validator の arena 判定: 床+0.02 .. 床+3m を占める箱)
    const a = ARENA_CLEAR[this.id];
    if (a && y1 > F + 0.02 && y0 < F + 3 && x1 > a.x0 && x0 < a.x1 && z1 > a.z0 && z0 < a.z1) {
      throw new Error(`${this.id}-${name}: intrudes into the reserved obstacle-free arena rect`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
export class StageBuilder {
  readonly boxes: BoxDef[] = [];
  readonly decor: BoxDef[] = [];
  readonly enemies: EnemySpawn[] = [];
  private readonly ids = new Set<string>();
  private readonly seq = new Map<string, number>();
  private readonly barrierBoxes = new Map<string, string[]>();
  private readonly controls = new Map<number, string>();
  private guardN = 0;
  private turretN = 0;

  kit(sectorId: string): Kit {
    const s = SECTORS.find((x) => x.id === sectorId);
    if (!s) throw new Error(`unknown sector ${sectorId}`);
    return new Kit(this, s);
  }

  nextBoxId(sectorId: string, name: string): string {
    const key = `${sectorId}-${name}`;
    const n = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, n);
    const id = `${key}-${n}`;
    if (this.ids.has(id)) throw new Error(`duplicate box id ${id}`);
    this.ids.add(id);
    return id;
  }
  nextGuardId(): string {
    return `G${String(++this.guardN).padStart(2, '0')}`;
  }
  nextTurretId(): string {
    return `T${String(++this.turretN).padStart(2, '0')}`;
  }
  registerBarrierBox(barrierId: string, boxId: string): void {
    const a = this.barrierBoxes.get(barrierId) ?? [];
    a.push(boxId);
    this.barrierBoxes.set(barrierId, a);
  }
  registerControl(index: number, enemyId: string): void {
    if (this.controls.has(index)) throw new Error(`control turret ${index} defined twice`);
    this.controls.set(index, enemyId);
  }

  /** 区画の殻を作ってから build(kit) を呼ぶ */
  buildSector(sectorId: string, build: (kit: Kit) => void): void {
    const kit = this.kit(sectorId);
    kit.buildShell();
    build(kit);
  }

  finish(): StageDef {
    const barriers: BarrierDef[] = barrierSkeleton();
    for (const b of barriers) {
      b.boxIds = [...(this.barrierBoxes.get(b.id) ?? [])];
      const info = BARRIER_INFO.find((x) => x.id === b.id);
      if (info && !info.isFinal) {
        const idx = Number(b.id.slice(1)) - 1;
        b.controlEnemyId = this.controls.get(idx) ?? null;
      }
    }
    const enemies = [...this.enemies].sort((p, q) => (p.id < q.id ? -1 : 1));
    // blueprint の定数は共有せず、呼び出しごとに複製を返す(利用側が書き換えても他に影響しない)
    return {
      name: STAGE_NAME,
      boxes: this.boxes,
      sectors: structuredClone(SECTORS),
      portals: structuredClone(PORTALS),
      barriers,
      enemies,
      playerStart: { pos: { ...PLAYER_START.pos }, yaw: PLAYER_START.yaw },
      escapeZone: structuredClone(ESCAPE_ZONE),
      mainRoute: structuredClone(MAIN_ROUTE),
      branches: structuredClone(BRANCHES),
      loops: structuredClone(LOOPS),
      climbs: structuredClone(CLIMBS),
      killY: KILL_Y,
      decor: this.decor,
    };
  }
}
