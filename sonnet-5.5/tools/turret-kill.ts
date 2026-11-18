/**
 * turret-kill: 制御砲台6体(T03 T07 T08 T11 T14 T15)を、実ステージの実敵に対して、実際の武器・FCS・弾体・衝突・敵AIで
 * 遠隔破壊できるかを確かめるツール兼ライブラリ (tests/turret-kill.test.ts からも使う)。
 *
 *   npx tsx tools/turret-kill.ts                    全項目 (狙撃位置の探索 / 3武器の破壊 / 6体で最終ゲート / 掩蔽ボット / 露出時の生存)
 *   npx tsx tools/turret-kill.ts --search           狙撃位置の探索だけ (--turret T03 で1体, --top 8 で表示数)
 *   npx tsx tools/turret-kill.ts --weapons          マシンガン・ビーム・ミサイルで各砲台を破壊 (露出したまま撃つ)
 *   npx tsx tools/turret-kill.ts --cover [--seeds 5]  遮蔽物の陰から身を出して撃つ→引っ込む簡易ボット
 *   npx tsx tools/turret-kill.ts --idle [--seeds 5]   狙撃位置で何もしないときの生存時間 (実HP1000)
 *   npx tsx tools/turret-kill.ts --control          対照実験: ロック完了前の自由射撃は当たらず、完了後の補正射撃だけが当たる
 *   npx tsx tools/turret-kill.ts --gate             1つのGameで6体を順に破壊 → 最終ゲート
 *   npx tsx tools/turret-kill.ts --oneway           砲台から見えないのに撃てる位置 (撃ち返されない位置)
 *   npx tsx tools/turret-kill.ts --pick             探索の上位候補を cover ボットで実走して狙撃位置を選ぶ (SNIPER_SPOTS の根拠。数分)
 *
 * 方針 (SPEC §2.1 / §4 / §5 / §2.3):
 *  - 撃つ側の処理は全て本番の Game.step() (FCSのロック → 射撃解 → 弾体/ビーム → 掃引衝突 → damageEnemy → objective) を通す。
 *    砲台のHPを直接減らす・隔壁を直接開ける等はしない。敵は他の44体も生きたまま、実AIで反撃する。
 *  - 「テスト初期条件」として行うのは、(1) プレイヤーを狙撃位置に置く (2) HPを 1e9 にする (kill / cover 実行のみ。生存時間の実測は実HP1000)
 *    (3) 出撃時の視点を砲台へ向ける、だけ。以降は Game.input / Game.look() / Game.step() だけで動かす。
 *  - 狙撃位置の探索は「立てる床」を実ステージの箱から自動列挙し、実際の camera / muzzle / isLockCandidate / solveMachinegun /
 *    World.raycast / sweepSphere で判定する (自前の見通し計算は持たない)。
 */
import { pathToFileURL } from 'node:url';
import { CAMERA, DEFAULT_SEED, ENEMIES, PLAYER, SIM, WEAPONS } from '../src/config';
import type { WeaponId } from '../src/config';
import { mgPositionAt, solveMachinegun } from '../src/sim/ballistics';
import { playerMuzzlePosition, updateCamera } from '../src/sim/camera';
import { enemyMuzzlePosition } from '../src/sim/enemies';
import { isLockCandidate } from '../src/sim/fcs';
import { Game } from '../src/sim/game';
import { clamp, distance, normalize, sub } from '../src/sim/math';
import { NAV, getNav } from '../src/sim/nav';
import type { Nav } from '../src/sim/nav';
import { firstSphereContact } from '../src/sim/projectiles';
import type { EnemySpawn, EnemyState, GameState, IWorld, Loadout, PortalDef, StageDef, V3 } from '../src/sim/types';
import { buildStage } from '../src/stage';
import { PORTAL_AXIS } from '../src/stage/blueprint';

// =====================================================================================================================
// 定数・小道具
// =====================================================================================================================
export const DEFAULT_LOADOUT: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
/** 「探索」の距離帯: 銃口から砲台の当たり判定中心まで (FCS射程120mに2mの余裕) */
export const SNIPE_MIN = 60;
export const SNIPE_MAX = 118;
/** 生存時間の実測に使うHP。kill / cover では被弾しても終了しないよう 1e9 にする (被弾でHPが実際に減ることを確認する) */
export const IMMORTAL_HP = 1e9;

const HALF = PLAYER.HALF;
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const dist3 = (a: V3, b: V3): number => distance(a, b);
const distH = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z);
const fmt = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : String(n));
/** プレイヤー中心 → 足元(床上面)の高さ */
const FOOT = HALF.y;
/** 衝突箱 (player.ts の COLLIDE_HALF と同じ縮め) */
const COLLIDE_HALF: V3 = { x: HALF.x - 5e-5, y: HALF.y - 5e-5, z: HALF.z - 5e-5 };
/** 立てる位置として要求する壁からの余裕 (片側) */
const STAND_MARGIN = 0.2;
const STAND_HALF: V3 = { x: HALF.x + STAND_MARGIN, y: HALF.y, z: HALF.z + STAND_MARGIN };
/** 足元が箱の上面に乗っているかを見る4隅の内側オフセット */
const SUPPORT_INSET = 0.6;

export interface Spot {
  x: number;
  z: number;
  /** 立つ床の上面の高さ(足元)。プレイヤー中心は floorY + 1.5 */
  floorY: number;
}
const centerOf = (s: Spot): V3 => v3(s.x, s.floorY + FOOT, s.z);

export interface ControlTurret {
  id: string;
  barrierId: string;
  sectorId: string;
  controlIndex: number;
  pos: V3;
}

/** ステージから制御砲台6体を取り出す (isGateControl, controlIndex 順) */
export function controlTurrets(stage: StageDef): ControlTurret[] {
  return stage.enemies
    .filter((e) => e.isGateControl)
    .sort((a, b) => (a.controlIndex ?? 0) - (b.controlIndex ?? 0))
    .map((e) => ({ id: e.id, barrierId: e.barrierId as string, sectorId: e.sectorId, controlIndex: e.controlIndex as number, pos: { ...e.pos } }));
}

// =====================================================================================================================
// 視点合わせ
// =====================================================================================================================
const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

function anglesFromCamera(from: V3, to: V3): { yaw: number; pitch: number } {
  const d = normalize(sub(to, from), { x: 0, y: 0, z: -1 });
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(clamp(d.y, -1, 1)) };
}

/** yaw/pitch を直接書いてカメラを更新し、カメラ位置(肩越し・後方8.5m)から見て point が画面中心に来るまで反復する (探索用) */
function aimDirect(state: GameState, world: IWorld, point: V3, iterations = 6): void {
  for (let i = 0; i < iterations; i++) {
    const a = anglesFromCamera(state.camera.pos, point);
    state.player.yaw = a.yaw;
    state.player.pitch = clamp(a.pitch, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
    updateCamera(state, world);
  }
}

/** マウス入力 (Game.look) で point を画面中心へ合わせる。yaw/pitch を直接書かない (実行用) */
export function aimByMouse(game: Game, point: V3, iterations = 6): void {
  const s = game.state;
  for (let i = 0; i < iterations; i++) {
    const a = anglesFromCamera(s.camera.pos, point);
    const dYaw = wrapPi(a.yaw - s.player.yaw);
    const dPitch = clamp(a.pitch, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX) - s.player.pitch;
    if (Math.abs(dYaw) < 1e-7 && Math.abs(dPitch) < 1e-7) break;
    game.look(-dYaw / CAMERA.SENSITIVITY, -dPitch / CAMERA.SENSITIVITY);
  }
}

// =====================================================================================================================
// 探索: 立てる床の列挙 → 到達性 → FCS / 弾道 / 被視認
// =====================================================================================================================
export interface Probe {
  stage: StageDef;
  game: Game;
  world: IWorld;
  state: GameState;
  /** 出撃直後の敵 (初期配置。位置は固定として扱う) */
  spawns: EnemySpawn[];
  /** 警備ロボットが使う歩行グラフ (体幅 2.7m の保守的な通行判定。到達性の独立した確認に使う) */
  nav: Nav;
}

/** 探索用の Game (本番と同じ World / camera / FCS)。全隔壁は閉じたまま */
export function makeProbe(stage: StageDef, loadout: Loadout = DEFAULT_LOADOUT): Probe {
  const game = new Game({ stage, loadout });
  game.sortie(loadout);
  return { stage, game, world: game.world, state: game.state, spawns: stage.enemies, nav: getNav(game.world, stage) };
}

/** 警備ロボットの体(半径1.35m)が余裕をもって立てる開けた床か */
export const openFloor = (probe: Probe, s: Spot): boolean => probe.nav.isFree(s.x, s.floorY, s.z, NAV.BODY_HALF);

/**
 * 区画の「歩き始め」の足元 (feet): 立つ床 floorY (既定=区画の床) の高さに敷居がある入口 portal の内側。その高さの入口がなければ
 * (+24のギャラリーから降りる S08/S13 の床)、その高さに立つ警備ロボットの足元 (=降下した後の床)。
 */
export function reachOrigin(probe: Probe, sectorId: string, floorY?: number): V3 | null {
  const sec = probe.stage.sectors.find((x) => x.id === sectorId) as StageDef['sectors'][number];
  const level = floorY ?? sec.floorY;
  for (const p of probe.stage.portals) {
    if (p.b !== sectorId && !(p.a === sectorId && p.barrierId === null)) continue;
    const sill = p.center.y - p.height / 2;
    if (Math.abs(sill - level) > 0.5) continue;
    const f = probe.nav.nearestFree(p.center.x, p.center.z, sill, 8);
    if (f) return f;
  }
  const g = probe.spawns.find((e) => e.sectorId === sectorId && e.kind === 'guard' && Math.abs(e.pos.y - ENEMIES.guard.centerHeight - level) < 0.5);
  return g ? v3(g.pos.x, g.pos.y - ENEMIES.guard.centerHeight, g.pos.z) : null;
}

/** 敵がいうる位置: 初期位置と、巡回経路(警備のみ)の各辺を 6m おきにたどった点 */
function postsOf(e: EnemySpawn): V3[] {
  const pts: V3[] = [e.pos];
  const pat = e.patrol;
  if (pat && pat.length > 1) {
    for (let i = 0; i < pat.length; i++) {
      const a = pat[i];
      const b = pat[(i + 1) % pat.length];
      const n = Math.max(1, Math.ceil(dist3(a, b) / 6));
      for (let k = 1; k <= n; k++) pts.push(v3(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, a.z + ((b.z - a.z) * k) / n));
    }
  }
  return pts;
}

/**
 * 敵 e が、プレイヤー中心 p を見つける(=撃ってくる)か: 距離 ≤ 索敵距離 かつ 銃口→p の線分が遮蔽されない (enemies.ts と同じ規則)。
 * patrol=true なら、初期位置だけでなく巡回経路上のどこかから見えるか。
 */
export function enemySeesPoint(world: IWorld, e: EnemySpawn, p: V3, patrol = false): boolean {
  const range = ENEMIES[e.kind].sensorRange + 1e-9;
  for (const post of patrol ? postsOf(e) : [e.pos]) {
    const m = enemyMuzzlePosition({ pos: post } as EnemyState);
    if (dist3(m, p) <= range && !world.segmentBlocked(m, p)) return true;
  }
  return false;
}

/** 敵のうち、p を見つける敵のID (except を除く) */
export function exposedTo(probe: Probe, p: V3, except: string | null = null, patrol = false): string[] {
  return probe.spawns.filter((e) => e.id !== except && enemySeesPoint(probe.world, e, p, patrol)).map((e) => e.id);
}

/** 足元 (x, z) の上面 top を、4隅とも箱で支えられているか (箱の合わせ面をまたぐ床も可) */
function supported(world: IWorld, x: number, z: number, top: number): boolean {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = x + sx * SUPPORT_INSET;
      const pz = z + sz * SUPPORT_INSET;
      if (!world.pointInSolid(v3(px, top - 0.01, pz))) return false;
      if (world.pointInSolid(v3(px, top + 0.01, pz))) return false;
    }
  }
  return true;
}

/** そこに立てるか (床に4隅で乗り、壁・天井から STAND_MARGIN 以上離れている) */
export function canStand(world: IWorld, s: Spot): boolean {
  if (!supported(world, s.x, s.z, s.floorY)) return false;
  return !world.overlapAABB(v3(s.x, s.floorY + FOOT + 0.001, s.z), STAND_HALF, 1e-4);
}

interface Node {
  id: number;
  ix: number;
  iz: number;
  spot: Spot;
}

/** 区画内の「立てる床」の格子 (2m) と、歩行/ジャンプ/降下でつながる到達集合 */
export class StandGrid {
  readonly nodes: Node[] = [];
  private readonly cell = new Map<number, number[]>();
  private readonly step: number;
  private readonly ox: number;
  private readonly oz: number;
  /** 出撃側の入口 (隔壁のない portal の内側) から歩き/ジャンプ(段差2.5m以下)/降下だけで着ける node の id */
  readonly walkable = new Set<number>();

  constructor(readonly probe: Probe, readonly sectorId: string, step = 2) {
    this.step = step;
    const sec = probe.stage.sectors.find((s) => s.id === sectorId) as StageDef['sectors'][number];
    const b = sec.bounds;
    this.ox = b.min.x + step / 2;
    this.oz = b.min.z + step / 2;
    const F = sec.floorY;
    const C = sec.ceilingY;
    const nx = Math.floor((b.max.x - b.min.x) / step);
    const nz = Math.floor((b.max.z - b.min.z) / step);
    const boxes = probe.stage.boxes.filter(
      (bx) => bx.sectorId === sectorId && bx.barrierId === undefined && bx.max.y >= F - 0.01 && bx.max.y <= C - 3.0 && bx.max.x - bx.min.x >= 1.2 && bx.max.z - bx.min.z >= 1.2,
    );
    const tops = new Map<number, Set<number>>();
    for (const bx of boxes) {
      const i0 = Math.max(0, Math.ceil((bx.min.x - this.ox) / step));
      const i1 = Math.min(nx - 1, Math.floor((bx.max.x - this.ox) / step));
      const k0 = Math.max(0, Math.ceil((bx.min.z - this.oz) / step));
      const k1 = Math.min(nz - 1, Math.floor((bx.max.z - this.oz) / step));
      const top = Math.round(bx.max.y * 1000) / 1000;
      for (let i = i0; i <= i1; i++) {
        for (let k = k0; k <= k1; k++) {
          const key = i * 4096 + k;
          let set = tops.get(key);
          if (!set) tops.set(key, (set = new Set()));
          set.add(top);
        }
      }
    }
    for (const [key, set] of tops) {
      const ix = Math.floor(key / 4096);
      const iz = key % 4096;
      const x = this.ox + ix * step;
      const z = this.oz + iz * step;
      for (const top of [...set].sort((p, q) => p - q)) {
        const spot: Spot = { x, z, floorY: top };
        if (!canStand(probe.world, spot)) continue;
        const node: Node = { id: this.nodes.length, ix, iz, spot };
        this.nodes.push(node);
        const list = this.cell.get(key);
        if (list) list.push(node.id);
        else this.cell.set(key, [node.id]);
      }
    }
    this.floodFromEntrances();
  }

  nodesAt(ix: number, iz: number): Node[] {
    return (this.cell.get(ix * 4096 + iz) ?? []).map((i) => this.nodes[i]);
  }

  /** a → b へ歩く/ジャンプで上る(2.5m以下)/降りる/低い障害物を跳び越える(頭が2.0m上がる)が、実際の衝突形状で可能か */
  private canMove(a: Spot, b: Spot): boolean {
    const w = this.probe.world;
    const dy = b.floorY - a.floorY;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    /** 足元を level に上げた姿勢で a の真上まで上がれて、水平に b の真上まで動け、(降下なら)b の真上から落ちられるか */
    const arc = (level: number): boolean => {
      const y = level + FOOT + 0.003;
      if (level > a.floorY + 0.01 && w.overlapAABB(v3(a.x, y, a.z), COLLIDE_HALF, 1e-4)) return false;
      if (w.sweepAABB(v3(a.x, y, a.z), COLLIDE_HALF, v3(dx, 0, dz))) return false;
      if (level > b.floorY + 0.01) return !w.sweepAABB(v3(b.x, y, b.z), COLLIDE_HALF, v3(0, -(level - b.floorY) + 0.02, 0));
      return true;
    };
    if (dy > 2.5) return false;
    if (Math.abs(dy) <= 0.31) return arc(Math.max(a.floorY, b.floorY)) || arc(Math.max(a.floorY, b.floorY) + 2.0);
    if (dy > 0) return arc(b.floorY);
    // 降下: 同じ高さで出られなければ、2.0m跳び上がって (手すり・低い壁を越えて) から落ちる
    return arc(a.floorY) || arc(a.floorY + 2.0);
  }

  private floodFromEntrances(): void {
    const { stage } = this.probe;
    const queue: number[] = [];
    for (const p of stage.portals) {
      // 入口 = この区画が b 側の portal (隔壁付きでも、手前の隔壁が開いた後の入口) / 隔壁のない扉。この区画の a 側の隔壁は出口なので使わない
      const entrance = p.b === this.sectorId || (p.a === this.sectorId && p.barrierId === null);
      if (!entrance) continue;
      const sill = p.center.y - p.height / 2;
      let best: Node | null = null;
      let bd = 10;
      for (const n of this.nodes) {
        if (Math.abs(n.spot.floorY - sill) > 0.5) continue;
        const d = distH(v3(n.spot.x, 0, n.spot.z), v3(p.center.x, 0, p.center.z));
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      if (best && !this.walkable.has(best.id)) {
        this.walkable.add(best.id);
        queue.push(best.id);
      }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const n = this.nodes[queue[qi]];
      // 隣(1マス)だけでなく2マス先(4m)まで: 手すりや縁との格子のずれで降下の着地点が隣に取れないことがある
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (!dx && !dz) continue;
          for (const m of this.nodesAt(n.ix + dx, n.iz + dz)) {
            if (this.walkable.has(m.id)) continue;
            if (this.canMove(n.spot, m.spot)) {
              this.walkable.add(m.id);
              queue.push(m.id);
            }
          }
        }
      }
    }
  }

  /** spot の近く(同じ高さの node が 2.1m 以内)の到達性: 歩行で着ける / 歩行到達点から飛行1回で着ける / どちらも不可 */
  accessOf(spot: Spot): { access: Access; flyFrom: Spot | null } {
    let near: Node | null = null;
    let bd = 2.1;
    const ix = Math.round((spot.x - this.ox) / this.step);
    const iz = Math.round((spot.z - this.oz) / this.step);
    for (let di = -1; di <= 1; di++) {
      for (let dk = -1; dk <= 1; dk++) {
        for (const n of this.nodesAt(ix + di, iz + dk)) {
          if (Math.abs(n.spot.floorY - spot.floorY) > 0.05) continue;
          const d = distH(v3(n.spot.x, 0, n.spot.z), v3(spot.x, 0, spot.z));
          if (d < bd) {
            bd = d;
            near = n;
          }
        }
      }
    }
    if (near && this.walkable.has(near.id)) return { access: 'walk', flyFrom: null };
    const f = this.flyFrom(spot);
    return f ? { access: 'fly', flyFrom: f.spot } : { access: 'none', flyFrom: null };
  }

  /** 歩行で着けない node へ、歩行到達 node から「飛行 1 回」(上昇 2.5〜16.5m, 水平 24m 以内) で着けるか。着けるなら出発 node を返す */
  flyFrom(target: Spot): Node | null {
    const w = this.probe.world;
    const R = 24;
    const ri = Math.ceil(R / this.step);
    const tix = Math.round((target.x - this.ox) / this.step);
    const tiz = Math.round((target.z - this.oz) / this.step);
    let best: Node | null = null;
    let bd = Infinity;
    for (let di = -ri; di <= ri; di++) {
      for (let dk = -ri; dk <= ri; dk++) {
        for (const n of this.nodesAt(tix + di, tiz + dk)) {
          if (!this.walkable.has(n.id)) continue;
          const up = target.floorY - n.spot.floorY;
          if (up < 2.5 || up > 16.5) continue;
          const dh = distH(v3(n.spot.x, 0, n.spot.z), v3(target.x, 0, target.z));
          if (dh > R || dh >= bd) continue;
          const a = centerOf(n.spot);
          const c = v3(target.x, target.floorY + FOOT + 0.05, target.z);
          const top = v3(a.x, c.y, a.z);
          // 垂直→水平 / 水平→垂直 / 斜め直進 のどれかが空いていればよい
          const free = (p: V3, q: V3): boolean => !w.sweepAABB(p, COLLIDE_HALF, sub(q, p));
          const lift = v3(a.x, a.y + 0.003, a.z);
          const ok = (free(lift, top) && free(top, c)) || (free(lift, v3(c.x, lift.y, c.z)) && free(v3(c.x, lift.y, c.z), c)) || free(lift, c);
          if (ok) {
            best = n;
            bd = dh;
          }
        }
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
export type Outcome = 'turret' | 'world' | 'none';

/** ビームの射線: 銃口→砲台中心 (resolveBeam と同じ順序: 世界の最初の面と敵球の手前側で先に当たる方) */
function beamOutcome(world: IWorld, muzzle: V3, target: V3, radius: number): Outcome {
  const d = normalize(sub(target, muzzle));
  const wh = world.raycast(muzzle, d, WEAPONS.beam.range);
  // 球への最初の交点距離
  const oc = sub(muzzle, target);
  const b = oc.x * d.x + oc.y * d.y + oc.z * d.z;
  const c = oc.x * oc.x + oc.y * oc.y + oc.z * oc.z - radius * radius;
  if (c <= 0) return 'turret';
  let ts = Infinity;
  if (b < 0) {
    const disc = b * b - c;
    if (disc >= 0) ts = c / (-b + Math.sqrt(disc));
  }
  if (ts > WEAPONS.beam.range) return wh ? 'world' : 'none';
  if (wh && wh.t <= ts) return 'world';
  return 'turret';
}

export interface MgArc {
  status: 'solved' | 'no_solution';
  t: number | null;
  outcome: Outcome;
  /** 命中(または世界に当たる)までの時間 [s] */
  contactAt: number | null;
}

/** 実際の解 (solveMachinegun) の放物線を、projectiles.ts と同じ 1/120 s 刻みの掃引 (world + 敵球) で辿る */
function mgArc(world: IWorld, muzzle: V3, target: V3, radius: number): MgArc {
  const sol = solveMachinegun(muzzle, target, v3(0, 0, 0));
  if (!sol) return { status: 'no_solution', t: null, outcome: 'none', contactAt: null };
  const cfg = WEAPONS.machinegun;
  for (let age0 = 0; age0 < cfg.lifetime - 1e-9; age0 += SIM.DT) {
    const age1 = Math.min(age0 + SIM.DT, cfg.lifetime);
    const a0 = mgPositionAt(muzzle, sol.velocity, age0);
    const a1 = mgPositionAt(muzzle, sol.velocity, age1);
    const chord = dist3(a0, a1);
    const wh = world.sweepSphere(a0, a1, cfg.bulletRadius);
    const uw = wh ? (chord > 1e-12 ? Math.min(1, wh.t / chord) : 0) : Infinity;
    const ue = firstSphereContact(a0, a1, target, target, radius + cfg.bulletRadius);
    if (ue !== null && ue < uw) return { status: 'solved', t: sol.t, outcome: 'turret', contactAt: age0 + ue * (age1 - age0) };
    if (wh) return { status: 'solved', t: sol.t, outcome: 'world', contactAt: age0 + uw * (age1 - age0) };
  }
  return { status: 'solved', t: sol.t, outcome: 'none', contactAt: null };
}

export interface SpotEval {
  spot: Spot;
  pos: V3;
  yaw: number;
  pitch: number;
  muzzle: V3;
  /** 銃口→砲台の当たり判定中心 (FCSの射程はこれで測る) */
  distMuzzle: number;
  /** プレイヤー中心→砲台中心 */
  distCenter: number;
  /** 水平距離 */
  distHoriz: number;
  /** 実際の isLockCandidate (カメラ・銃口の双方から視線が通り、画面円内・前方・120m以内) */
  lockable: boolean;
  /** lockable な敵のID (砲台以外が混じると別の敵を先にロックしうる) */
  lockCandidates: string[];
  mg: MgArc;
  beam: Outcome;
  missile: 'clear' | 'blocked';
  /** 初期配置の敵のうち、この位置のプレイヤーを見つける敵 (砲台自身を除く) */
  exposed: string[];
  /** 巡回経路上のどこかからこの位置を見つける敵 (exposed を含む上位集合) */
  patrolExposed: string[];
  /** 砲台自身がこの位置のプレイヤー中心を見つけるか (=撃ち返してくるか) */
  turretSees: boolean;
}

/** プレイヤーを spot に立たせ (探索用の状態)、砲台へ視点を合わせて、FCS・3武器の弾道・被視認を実際の関数で評価する */
export function evaluateSpot(probe: Probe, turret: { id: string; pos: V3 }, spot: Spot, viaMouse = false): SpotEval {
  const { state, world } = probe;
  const p = state.player;
  const pos = centerOf(spot);
  pos.y += 1e-4;
  p.pos = { ...pos };
  p.prevPos = { ...pos };
  p.vel = v3(0, 0, 0);
  p.grounded = true;
  if (viaMouse) aimByMouse(probe.game, turret.pos);
  else aimDirect(state, world, turret.pos);
  const muzzle = playerMuzzlePosition(p);
  const target = state.enemies.find((e) => e.id === turret.id) as EnemyState;
  const lockCandidates = state.enemies.filter((e) => isLockCandidate(state, world, e)).map((e) => e.id);
  const spawn = probe.spawns.find((e) => e.id === turret.id) as EnemySpawn;
  return {
    spot,
    pos,
    yaw: p.yaw,
    pitch: p.pitch,
    muzzle,
    distMuzzle: dist3(muzzle, target.pos),
    distCenter: dist3(pos, target.pos),
    distHoriz: distH(pos, target.pos),
    lockable: lockCandidates.includes(turret.id),
    lockCandidates,
    mg: mgArc(world, muzzle, target.pos, target.hitRadius),
    beam: beamOutcome(world, muzzle, target.pos, target.hitRadius),
    missile: (() => {
      const h = world.sweepSphere(muzzle, target.pos, WEAPONS.missile.radius);
      const d = dist3(muzzle, target.pos);
      return h && h.t < d - (target.hitRadius + WEAPONS.missile.radius) ? 'blocked' : 'clear';
    })(),
    exposed: exposedTo(probe, pos, turret.id),
    patrolExposed: exposedTo(probe, pos, turret.id, true),
    turretSees: enemySeesPoint(world, spawn, pos),
  };
}

/** 3武器とも砲台に当たる弾道か (放物線・直線・ミサイルの直進) */
export const weaponsClear = (e: SpotEval): boolean => e.mg.status === 'solved' && e.mg.outcome === 'turret' && e.beam === 'turret' && e.missile === 'clear';

export interface HidePoint {
  spot: Spot;
  /** 発射位置からの水平距離 */
  distance: number;
}

/**
 * 発射位置 fire の近くで、全ての敵(砲台自身を含む)から見えない同じ高さの立てる点 (中心と、左右前後 ±0.7m の4点が全て隠れている)。
 * fire との間を実際の掃引で直進できるものだけ。最も近いものを返す。
 */
export function findHide(probe: Probe, fire: Spot, maxDistance = 9): HidePoint | null {
  const { world } = probe;
  const a = centerOf(fire);
  a.y += 0.003;
  let best: HidePoint | null = null;
  for (let dx = -maxDistance; dx <= maxDistance; dx += 0.5) {
    for (let dz = -maxDistance; dz <= maxDistance; dz += 0.5) {
      const d = Math.hypot(dx, dz);
      if (d < 1.5 || d > maxDistance || (best && d >= best.distance)) continue;
      const s: Spot = { x: fire.x + dx, z: fire.z + dz, floorY: fire.floorY };
      if (!canStand(world, s)) continue;
      const c = centerOf(s);
      const hidden = [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]].every(([ox, oz]) => exposedTo(probe, v3(c.x + ox, c.y, c.z + oz), null, true).length === 0);
      if (!hidden) continue;
      if (world.sweepAABB(v3(a.x, a.y, a.z), COLLIDE_HALF, v3(dx, 0, dz))) continue;
      best = { spot: s, distance: d };
    }
  }
  return best;
}

export type Access = 'walk' | 'fly' | 'none';

export interface Candidate extends SpotEval {
  access: Access;
  /** access が fly のとき、飛び立つ歩行到達点 */
  flyFrom: Spot | null;
  /** 警備ロボットの体幅でも立てる開けた床か (false = 壁際など) */
  openFloor: boolean;
  hide: HidePoint | null;
  score: number;
}

export interface SearchOptions {
  min?: number;
  max?: number;
  /** 3武器の弾道が全て砲台に当たることを必須にする (既定 true) */
  requireAllWeapons?: boolean;
  /** 砲台以外がロック候補に入らないことを必須にする (既定 true) */
  requireOnlyTurretLock?: boolean;
  /** 歩行/飛行のどちらでも着けない位置を捨てる (既定 true) */
  requireAccess?: boolean;
  /** 砲台が(初期配置の位置から)プレイヤー中心を見つける=反撃を受ける位置だけにする (既定 true) */
  requireTurretSees?: boolean;
  /** 発射位置が警備ロボットの体幅でも立てる開けた床であること (既定 false。壁際・隙間の位置は順位が下がるだけ) */
  requireOpenFloor?: boolean;
  /** 掩蔽点(hide)を探す上位候補数 (既定 80) */
  hideTop?: number;
}

export interface SearchReport {
  turretId: string;
  sectorId: string;
  nodes: number;
  walkable: number;
  evaluated: number;
  lockable: number;
  inRange: number;
  /** inRange のうち警備ロボットの体幅でも立てる開けた床 */
  openFloor: number;
  clearAll: number;
  accessOk: number;
  /** clearAll と同じ条件 (ロック可・60〜118m・弾道◯・単独ロック) を満たすが、砲台がプレイヤー中心を見つけない (=撃ち返されない) 位置 */
  oneWay: number;
  candidates: Candidate[];
}

/** 候補の順位付け (小さいほど良い): 他の敵に見つからない・巡回でも見つからない・歩いて着ける・約90m・掩蔽点が近い */
export function scoreOf(c: Candidate): number {
  const others = c.exposed.length;
  const turrets = c.exposed.filter((id) => id.startsWith('T')).length;
  return others * 25 + turrets * 60 + (c.patrolExposed.length - others) * 15 + (c.access === 'fly' ? 18 : 0) + (c.openFloor ? 0 : 6) + Math.abs(c.distMuzzle - 90) * 0.15 + (c.hide ? c.hide.distance : 40);
}

/** 制御砲台 turretId の区画で、狙撃位置の候補を自動探索する。score が小さいほど良い */
export function searchSniperSpots(probe: Probe, turretId: string, opts: SearchOptions = {}): SearchReport {
  const min = opts.min ?? SNIPE_MIN;
  const max = opts.max ?? SNIPE_MAX;
  const turret = controlTurrets(probe.stage).find((t) => t.id === turretId) as ControlTurret;
  const grid = new StandGrid(probe, turret.sectorId);
  const rep: SearchReport = { turretId, sectorId: turret.sectorId, nodes: grid.nodes.length, walkable: grid.walkable.size, evaluated: 0, lockable: 0, inRange: 0, openFloor: 0, clearAll: 0, accessOk: 0, oneWay: 0, candidates: [] };
  const list: Candidate[] = [];
  for (const n of grid.nodes) {
    const c = centerOf(n.spot);
    if (dist3(c, turret.pos) > max + 3 || dist3(c, turret.pos) < min - 3) continue;
    rep.evaluated++;
    const ev = evaluateSpot(probe, turret, n.spot);
    if (!ev.lockable) continue;
    rep.lockable++;
    if (ev.distMuzzle < min || ev.distMuzzle > max) continue;
    rep.inRange++;
    const open = openFloor(probe, n.spot);
    if (open) rep.openFloor++;
    if (opts.requireOpenFloor && !open) continue;
    if ((opts.requireAllWeapons ?? true) && !weaponsClear(ev)) continue;
    if ((opts.requireOnlyTurretLock ?? true) && (ev.lockCandidates.length !== 1 || ev.lockCandidates[0] !== turretId)) continue;
    if (!ev.turretSees) rep.oneWay++;
    if ((opts.requireTurretSees ?? true) && !ev.turretSees) continue;
    rep.clearAll++;
    let access: Access = 'none';
    let flyFrom: Spot | null = null;
    if (grid.walkable.has(n.id)) access = 'walk';
    else {
      const f = grid.flyFrom(n.spot);
      if (f) {
        access = 'fly';
        flyFrom = f.spot;
      }
    }
    if ((opts.requireAccess ?? true) && access === 'none') continue;
    rep.accessOk++;
    list.push({ ...ev, access, flyFrom, openFloor: open, hide: null, score: 0 });
  }
  for (const c of list) c.score = scoreOf(c);
  list.sort((a, b) => a.score - b.score);
  const hideTop = opts.hideTop ?? 80;
  for (const c of list.slice(0, hideTop)) {
    c.hide = findHide(probe, c.spot);
    c.score = scoreOf(c);
  }
  list.sort((a, b) => a.score - b.score);
  rep.candidates = list;
  return rep;
}

/**
 * 砲台にロックして撃てる(銃口・カメラから砲台中心が見える)のに、砲台の側からはプレイヤー中心が見えない位置 (=撃ち返されない位置)。
 * 敵の視線判定はプレイヤー中心の1点だけで、プレイヤーの銃口は中心から前1.25m・右1.05m・上0.75m突き出るため、遮蔽の角から銃口だけを出すと成立する。
 * 他の敵(初期位置・巡回)からも見えない位置のうち、約90mのものを返す。
 */
export function findOneWaySpot(probe: Probe, turretId: string): Candidate | null {
  const rep = searchSniperSpots(probe, turretId, { requireTurretSees: false, hideTop: 0 });
  const list = rep.candidates.filter((c) => !c.turretSees && c.patrolExposed.length === 0 && c.access === 'walk');
  list.sort((a, b) => Math.abs(a.distMuzzle - 90) - Math.abs(b.distMuzzle - 90));
  return list[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// 区画作り込み担当が報告した「狙撃できる」領域の検証
// ---------------------------------------------------------------------------------------------------------------------
export interface HintRegion {
  turretId: string;
  /** 出典 (docs/STAGE_BLUEPRINT.md / sectors/*.ts のコメント) */
  where: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** 立つ床の高さ */
  floorY: number;
}

export const HINT_REGIONS: HintRegion[] = [
  { turretId: 'T03', where: 'S03 北の落下した足場/桁の陰 (257..269, 19..33)', x0: 257, x1: 269, z0: 19, z1: 33, floorY: 0 },
  { turretId: 'T07', where: 'S06 南西の監視ブース (552..558, 84..90)', x0: 552, x1: 558, z0: 84, z1: 90, floorY: 12 },
  { turretId: 'T08', where: 'S08 ギャラリー西端の手すりの窓 (413, 257.4) の周り', x0: 410, x1: 416, z0: 254, z1: 260, floorY: 24 },
  { turretId: 'T11', where: 'S11 西壁沿いの凹み (86, 204..218)', x0: 84, x1: 88, z0: 204, z1: 218, floorY: -14 },
];

export interface RegionReport {
  region: HintRegion;
  samples: number;
  standable: number;
  /** 立てる点での 銃口→砲台 の最短/最長距離 */
  minDist: number | null;
  maxDist: number | null;
  lockable: number;
  inRange: number;
  clearAll: number;
  /** clearAll のうち、砲台が撃ち返す (=反撃を受ける) もの */
  turretSees: number;
  best: Candidate | null;
}

/** 報告された領域を 1m 格子で走査し、立てる点・ロックできる点・60〜118m・3武器の弾道・反撃・掩蔽点を数える */
export function evaluateRegion(probe: Probe, region: HintRegion, step = 1): RegionReport {
  const turret = controlTurrets(probe.stage).find((t) => t.id === region.turretId) as ControlTurret;
  const grid = new StandGrid(probe, turret.sectorId);
  const rep: RegionReport = { region, samples: 0, standable: 0, minDist: null, maxDist: null, lockable: 0, inRange: 0, clearAll: 0, turretSees: 0, best: null };
  const list: Candidate[] = [];
  for (let x = region.x0; x <= region.x1 + 1e-9; x += step) {
    for (let z = region.z0; z <= region.z1 + 1e-9; z += step) {
      rep.samples++;
      const spot: Spot = { x, z, floorY: region.floorY };
      if (!canStand(probe.world, spot)) continue;
      rep.standable++;
      const ev = evaluateSpot(probe, turret, spot);
      rep.minDist = rep.minDist === null ? ev.distMuzzle : Math.min(rep.minDist, ev.distMuzzle);
      rep.maxDist = rep.maxDist === null ? ev.distMuzzle : Math.max(rep.maxDist, ev.distMuzzle);
      if (!ev.lockable) continue;
      rep.lockable++;
      if (ev.distMuzzle < SNIPE_MIN || ev.distMuzzle > SNIPE_MAX) continue;
      rep.inRange++;
      if (!weaponsClear(ev) || ev.lockCandidates.length !== 1) continue;
      rep.clearAll++;
      if (!ev.turretSees) continue;
      rep.turretSees++;
      const acc = grid.accessOf(spot);
      list.push({ ...ev, access: acc.access, flyFrom: acc.flyFrom, openFloor: openFloor(probe, spot), hide: findHide(probe, spot), score: 0 });
    }
  }
  for (const c of list) c.score = scoreOf(c);
  list.sort((a, b) => a.score - b.score);
  rep.best = list[0] ?? null;
  return rep;
}

// =====================================================================================================================
// 実際の Game を動かす実行系
// =====================================================================================================================
/** stand: 狙撃位置に立ったまま撃つ(回避しない) / cover: 掩蔽点から身を出して撃つ→引っ込む / idle: 何もしない */
export type BotKind = 'stand' | 'cover' | 'idle';

export interface RunConfig {
  turretId: string;
  weapon: WeaponId;
  bot: BotKind;
  /** 発射位置 (この位置でロックして撃つ) */
  fire: Spot;
  /** 掩蔽点 (cover ボットで必須。fire から数m、どの敵からも見えない点) */
  hide?: Spot;
  seed?: number;
  loadout?: Loadout;
  /** 配置時のプレイヤーHP。既定 IMMORTAL_HP (1e9)。生存時間の実測 (idle) では 1000 */
  hp?: number;
  /** 打ち切り (ゲーム内秒) */
  maxSeconds?: number;
  /** 破壊後にさらに進める秒数 */
  settleSeconds?: number;
  /** stand ボットが、ロック完了を待たずに最初から撃ち続ける (対照実験: ロック完了前のマシンガンは補正なしの自由射撃) */
  fireBeforeLock?: boolean;
}

export interface HitRecord {
  time: number;
  damage: number;
  /** 撃った敵のID ('?' = 特定できず) */
  from: string;
}

export interface RunResult {
  cfg: RunConfig;
  killed: boolean;
  /** 配置(t=0)から砲台のHPが0になった tick の終わりまでのゲーム内秒 */
  killAt: number | null;
  endTime: number;
  ticks: number;
  /** 標的の最初の選択 (取得中に入った) 時刻 / ロック完了時刻 */
  lockAcquireAt: number | null;
  lockedAt: number | null;
  /** 標的以外をロック完了した (=別の敵を先に取った) ID */
  lockedOther: string[];
  firstShotAt: number | null;
  fired: { machinegun: number; beam: number; missile: number };
  /** 出撃時の総弾数からの消費 (マシンガン / ミサイル) とビームのEN消費 */
  used: { machinegun: number; missile: number; beamEn: number };
  mg: {
    /** 標的に向けて撃った数 (射撃記録の targetId が標的) */
    firedAtTarget: number;
    hitsTarget: number;
    hitsOtherEnemy: number;
    /** 破壊までに世界(壁・柱・台座など)に当たった弾 */
    hitsWorld: number;
    /** 破壊の瞬間にまだ飛んでいた弾 (破壊後は当たらない) */
    inFlightAtKill: number;
    /** 破壊の瞬間までに決着した弾 = firedAtTarget - inFlightAtKill */
    resolvedAtKill: number;
    /** hitsTarget / resolvedAtKill (破壊できた実行だけ) */
    hitRate: number | null;
    /** hitsTarget / firedAtTarget (破壊の瞬間に飛翔中だった弾も分母に含める) */
    hitRateOfFired: number | null;
  };
  beamHits: number;
  missileHits: number;
  /** 実際に成立した射撃の射撃解の状態 (ShotRecord.solutionStatus) */
  shotStatus: { solved: number; no_solution: number; inactive: number };
  /** ロック完了直後の state.fc (HUD/射撃と同じ解) */
  fc: { status: string; predictedFlightSeconds: number | null; residualMeters: number | null } | null;
  hpStart: number;
  hpEnd: number;
  /** 実行全体 (破壊後の settle を含む) の被ダメージ */
  damageTaken: number;
  /** 破壊の瞬間までの被弾回数・被ダメージ (破壊できなかった実行では実行全体) */
  hitsAtKill: number;
  damageAtKill: number;
  hits: HitRecord[];
  damageByOwner: Record<string, { hits: number; damage: number }>;
  firstHitAt: number | null;
  /** 累計被ダメージが 1000 (実HP) に達した時刻 */
  damage1000At: number | null;
  failedAt: number | null;
  enemyShots: Record<string, number>;
  otherKills: string[];
  peeks: number;
  barrier: {
    id: string;
    /** barrierOpen イベントの時刻 (配置から)。破壊と同じ tick の終わり */
    openedAt: number | null;
    openIds: string[];
    boxesDisabled: boolean;
    portalPassableBefore: boolean;
    portalPassableAfter: boolean;
    controlsDestroyed: number;
    /** この実行の終わりで最終ゲートが開いているか */
    gateOpen: boolean;
  };
}

interface Sim {
  game: Game;
  turretId: string;
  fireLog: { o: V3; id: string }[];
  hits: HitRecord[];
  fired: { machinegun: number; beam: number; missile: number };
  mgHitWorld: number;
  mgHitEnemy: number;
  mgHitTarget: number;
  beamHits: number;
  missileHits: number;
  lockAcquireAt: number | null;
  lockedAt: number | null;
  lockedOther: string[];
  shotStatus: { solved: number; no_solution: number; inactive: number };
  fc: RunResult['fc'];
  firstShotAt: number | null;
  /** 標的(制御砲台)を対象にして成立した射撃の数 (射撃記録の targetId) */
  shotsAtTarget: number;
  killAt: number | null;
  inFlightAtKill: number;
  hitsAtKill: number | null;
  damageAtKill: number | null;
  /** 標的の隔壁の barrierOpen イベントの時刻 (t0 から) */
  barrierOpenAt: number | null;
  otherKills: string[];
  enemyShots: Record<string, number>;
  ammo0: { machinegun: number; missile: number };
  en0: number;
  hp0: number;
  dmg0: number;
  t0: number;
  failedAt: number | null;
  damage1000At: number | null;
}

/** 開いたポータルを、プレイヤー箱が実際に通り抜けられるか (portal の床の高さで、開口の前後6mを掃引) */
export function portalPassable(world: IWorld, portal: PortalDef): boolean {
  const axis = PORTAL_AXIS[portal.id];
  const y = portal.center.y - portal.height / 2 + FOOT + 0.01;
  const start = axis === 'x' ? v3(portal.center.x - 6, y, portal.center.z) : v3(portal.center.x, y, portal.center.z - 6);
  const delta = axis === 'x' ? v3(12, 0, 0) : v3(0, 0, 12);
  return !world.sweepAABB(start, COLLIDE_HALF, delta);
}

const barrierBoxesDisabled = (game: Game, barrierId: string): boolean => {
  const b = game.stage.barriers.find((x) => x.id === barrierId) as StageDef['barriers'][number];
  return b.boxIds.length > 0 && b.boxIds.every((id) => !game.world.isBoxEnabled(game.world.indexOfBox(id)));
};

/** 初期条件: プレイヤーを spot に置き (速度0・接地)、HP を設定し、視点を砲台へ向ける。ここまでが「配置」で、以降は入力と Game.step だけ */
export function placePlayer(game: Game, spot: Spot, targetPos: V3, hp: number | null): void {
  const p = game.state.player;
  const pos = centerOf(spot);
  pos.y += 1e-4;
  p.pos = { ...pos };
  p.prevPos = { ...pos };
  p.vel = v3(0, 0, 0);
  p.grounded = true;
  if (hp !== null) p.hp = hp;
  aimByMouse(game, targetPos);
}

function makeSim(game: Game, cfg: RunConfig): Sim {
  const s = game.state;
  return {
    game,
    turretId: cfg.turretId,
    fireLog: [],
    hits: [],
    fired: { machinegun: 0, beam: 0, missile: 0 },
    mgHitWorld: 0,
    mgHitEnemy: 0,
    mgHitTarget: 0,
    beamHits: 0,
    missileHits: 0,
    lockAcquireAt: null,
    lockedAt: null,
    lockedOther: [],
    shotStatus: { solved: 0, no_solution: 0, inactive: 0 },
    fc: null,
    firstShotAt: null,
    shotsAtTarget: 0,
    killAt: null,
    inFlightAtKill: 0,
    hitsAtKill: null,
    damageAtKill: null,
    barrierOpenAt: null,
    otherKills: [],
    enemyShots: {},
    ammo0: { ...s.player.ammo },
    en0: s.player.en,
    hp0: s.player.hp,
    dmg0: s.damageTaken,
    t0: s.time,
    failedAt: null,
    damage1000At: null,
  };
}

/** Game を1 tick 進め (Game.step のみ)、drainEvents で受け取ったイベントと状態差分を Sim の計測へ反映する */
function tick(sim: Sim): void {
  const g = sim.game;
  const s = g.state;
  const target = s.enemies.find((e) => e.id === sim.turretId) as EnemyState;
  const hp0 = target.hp;
  const seq0 = s.shotSeq;
  const wasAlive = target.alive;
  g.step();
  for (const ev of g.drainEvents()) {
    switch (ev.type) {
      case 'mgFire':
        sim.fired.machinegun++;
        break;
      case 'beamFire':
        sim.fired.beam++;
        if (ev.hit === 'enemy' && ev.targetId === sim.turretId) sim.beamHits++;
        break;
      case 'missileFire':
        sim.fired.missile++;
        break;
      case 'hit':
        // 破壊までに解決した弾だけを数える (破壊後に飛び続けた弾は inFlightAtKill として別に数える)
        if (ev.weapon === 'machinegun' && sim.killAt === null) {
          if (ev.on === 'world') sim.mgHitWorld++;
          else if (ev.on === 'enemy') sim.mgHitEnemy++;
        }
        break;
      case 'enemyFire':
        sim.fireLog.push({ o: ev.origin, id: ev.id });
        sim.enemyShots[ev.id] = (sim.enemyShots[ev.id] ?? 0) + 1;
        break;
      case 'playerHit': {
        // 弾の発射点 (= その敵が撃った時の銃口) で撃った敵を特定する
        let from = '?';
        let bd = 1e-3;
        for (let i = sim.fireLog.length - 1; i >= 0 && i >= sim.fireLog.length - 400; i--) {
          const d = dist3(sim.fireLog[i].o, ev.fromPos);
          if (d < bd) {
            bd = d;
            from = sim.fireLog[i].id;
          }
        }
        sim.hits.push({ time: ev.time, damage: ev.damage, from });
        break;
      }
      case 'enemyDown':
        if (ev.id !== sim.turretId) sim.otherKills.push(ev.id);
        break;
      case 'barrierOpen':
        if (ev.barrierId === target.barrierId) sim.barrierOpenAt = ev.time - sim.t0;
        break;
      default:
        break;
    }
  }
  if (sim.firstShotAt === null && s.shotSeq > seq0) sim.firstShotAt = s.shots[s.shots.length - 1].firedAtSeconds;
  // 標的への命中 (HP差: マシンガン12 / ミサイル180)
  const dHp = hp0 - target.hp;
  if (dHp > 0) {
    // 最後の1発はHPが0で止まるので、切り上げて命中数にする (12 / 180 未満の残りHPを削った命中も1発)
    if (s.player.weapon === 'machinegun') sim.mgHitTarget += Math.ceil(dHp / WEAPONS.machinegun.damage - 1e-9);
    else if (s.player.weapon === 'missile') sim.missileHits += Math.ceil(dHp / WEAPONS.missile.damage - 1e-9);
  }
  // 射撃解の状態 (このtickで成立した射撃だけを数える)
  for (let i = Math.max(0, s.shots.length - (s.shotSeq - seq0)); i < s.shots.length; i++) {
    sim.shotStatus[s.shots[i].solutionStatus]++;
    if (s.shots[i].targetId === sim.turretId) sim.shotsAtTarget++;
  }
  // ロックの時系列
  if (s.lock.targetId === sim.turretId) {
    if (sim.lockAcquireAt === null) sim.lockAcquireAt = s.time;
    if (s.lock.state === 'locked' && sim.lockedAt === null) {
      sim.lockedAt = s.time;
      sim.fc = { status: s.fc.status, predictedFlightSeconds: s.fc.predictedFlightSeconds, residualMeters: s.fc.residualMeters };
    }
  } else if (s.lock.state === 'locked' && s.lock.targetId && !sim.lockedOther.includes(s.lock.targetId)) {
    sim.lockedOther.push(s.lock.targetId);
  }
  if (wasAlive && !target.alive) {
    sim.killAt = s.time - sim.t0;
    sim.inFlightAtKill = s.bullets.length + s.missiles.length;
    sim.hitsAtKill = sim.hits.length;
    sim.damageAtKill = s.damageTaken - sim.dmg0;
  }
  if (sim.damage1000At === null && s.damageTaken - sim.dmg0 >= 1000) sim.damage1000At = s.time - sim.t0;
  if (sim.failedAt === null && s.mode === 'failed') sim.failedAt = s.time - sim.t0;
}

// ---------------------------------------------------------------------------------------------------------------------
// ボット (入力は Game.input と Game.look だけ)
// ---------------------------------------------------------------------------------------------------------------------
const releaseKeys = (game: Game): void => {
  const i = game.input;
  i.forward = false;
  i.back = false;
  i.left = false;
  i.right = false;
};

/** goal (プレイヤー中心の水平位置) へ WASD で歩く。制動距離 v²/(2·120) の手前でキーを離す。到着なら true */
function steerTo(game: Game, goal: V3): boolean {
  const p = game.state.player;
  const dx = goal.x - p.pos.x;
  const dz = goal.z - p.pos.z;
  const d = Math.hypot(dx, dz);
  const speed = Math.hypot(p.vel.x, p.vel.z);
  const stop = (speed * speed) / (2 * PLAYER.WALK_ACCEL);
  if (d < 0.12 || (speed > 1 && d <= stop + 0.03)) {
    releaseKeys(game);
    return d < 0.5;
  }
  const yaw = p.yaw;
  const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const df = (dx * fwd.x + dz * fwd.z) / d;
  const dr = (dx * right.x + dz * right.z) / d;
  const i = game.input;
  i.forward = df > 0.38;
  i.back = df < -0.38;
  i.right = dr > 0.38;
  i.left = dr < -0.38;
  return false;
}

/** 半直線 o + v t (t ≥ 0) が中心 c・半寸法 h の箱に入る最初の t (入らなければ null) */
function rayBoxEnter(o: V3, v: V3, c: V3, h: V3): number | null {
  let tn = 0;
  let tf = Infinity;
  for (const a of ['x', 'y', 'z'] as const) {
    const lo = c[a] - h[a];
    const hi = c[a] + h[a];
    if (Math.abs(v[a]) < 1e-12) {
      if (o[a] < lo || o[a] > hi) return null;
    } else {
      let t1 = (lo - o[a]) / v[a];
      let t2 = (hi - o[a]) / v[a];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tn = Math.max(tn, t1);
      tf = Math.min(tf, t2);
      if (tn > tf) return null;
    }
  }
  return tn;
}

/** 敵弾のうち「プレイヤーが center に立っていたら当たる」ものの最短到達時間 [s] (発射後 minAge 秒以上たったものだけ=弾が見えてから)。なければ Infinity */
function threatETA(state: GameState, world: IWorld, center: V3, minAge: number): number {
  const m = 0.5; // 掠める弾も脅威として扱う余裕
  let best = Infinity;
  for (const b of state.enemyBullets) {
    if (!b.alive || b.age < minAge) continue;
    const h = v3(HALF.x + b.radius + m, HALF.y + b.radius + m, HALF.z + b.radius + m);
    const t = rayBoxEnter(b.pos, b.vel, center, h);
    if (t === null || t > b.maxLife - b.age) continue;
    const at = v3(b.pos.x + b.vel.x * t, b.pos.y + b.vel.y * t, b.pos.z + b.vel.z * t);
    if (world.segmentBlocked(b.pos, at)) continue; // 途中の遮蔽で止まる弾は脅威ではない
    if (t < best) best = t;
  }
  return best;
}

/** cover ボットの規則 (人間の反応を想定した値) */
export const COVER_RULES = {
  /** 弾が撃たれてからこの秒数たって初めて「弾が見える」 */
  reactionSeconds: 0.2,
  /** 身を出したら、最低この発数を撃ってからでないと(被弾していなければ)引っ込まない */
  commitShots: 3,
  /** 掩蔽に入ってから最低この秒数は出ない */
  minHideSeconds: 0.4,
  /** 掩蔽に隠れたまま待つ上限 */
  maxHideSeconds: 3,
  /** 1回の身の出しの上限 */
  maxPeekSeconds: 5,
  /** 射線の通った警備ロボットがこの距離以内なら、その場でそれを撃つ (砲台より優先) */
  guardEngageRange: 70,
};

interface CoverState {
  mode: 'hidden' | 'peek';
  since: number;
  peeks: number;
  firedAtPeek: number;
  hitsAtPeek: number;
}

function coverControl(sim: Sim, cfg: RunConfig, cs: CoverState): void {
  const g = sim.game;
  const s = g.state;
  const world = g.world;
  const p = s.player;
  const target = s.enemies.find((e) => e.id === sim.turretId) as EnemyState;
  const F = centerOf(cfg.fire);
  const H = centerOf(cfg.hide as Spot);
  const t = s.time;
  // 自分を見ている警備ロボット (射線が通り、近い) がいれば、その場でそれを撃つ (FCSでロックできたら。砲台より優先)
  let guard: EnemyState | null = null;
  let gd = COVER_RULES.guardEngageRange;
  for (const e of s.enemies) {
    if (!e.alive || e.kind !== 'guard' || !e.hasLineOfSight) continue;
    const d = dist3(e.pos, p.pos);
    if (d < gd) {
      gd = d;
      guard = e;
    }
  }
  if (guard) {
    // 警備ロボットに見つかったら、その場で(隠れているなら隠れたまま)FCSで取って撃つ。倒すまで身の出し入れは止める
    aimByMouse(g, guard.pos);
    releaseKeys(g);
    g.input.fire = s.lock.state === 'locked' && s.lock.targetId === guard.id;
    if (cs.mode === 'peek') cs.since = t;
    return;
  }
  aimByMouse(g, target.pos);
  const locked = s.lock.state === 'locked' && s.lock.targetId === sim.turretId;
  const walkSeconds = distH(F, H) / PLAYER.WALK_SPEED + 0.15;
  const lead = walkSeconds + 0.05;
  if (cs.mode === 'peek') {
    const shots = sim.shotsAtTarget - cs.firedAtPeek;
    const took = sim.hits.length > cs.hitsAtPeek;
    const committed = shots >= COVER_RULES.commitShots || t - cs.since >= COVER_RULES.maxPeekSeconds;
    const eta = threatETA(s, world, p.pos, COVER_RULES.reactionSeconds);
    if (took || (committed && eta <= lead) || !target.alive) {
      cs.mode = 'hidden';
      cs.since = t;
    }
  } else {
    const home = arrivedAt(g, H);
    const waited = t - cs.since;
    const safe = threatETA(s, world, F, 0) === Infinity;
    if (home && waited >= COVER_RULES.minHideSeconds && (safe || waited >= COVER_RULES.maxHideSeconds) && target.alive) {
      cs.mode = 'peek';
      cs.since = t;
      cs.peeks++;
      cs.firedAtPeek = sim.shotsAtTarget;
      cs.hitsAtPeek = sim.hits.length;
    }
  }
  if (cs.mode === 'peek') steerTo(g, F);
  else steerTo(g, H);
  g.input.fire = cs.mode === 'peek' && locked && target.alive;
}

/** goal に(ほぼ静止して)いるか */
function arrivedAt(game: Game, goal: V3): boolean {
  const p = game.state.player;
  return Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z) < 0.6 && Math.hypot(p.vel.x, p.vel.z) < 1.5;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1回の実行
// ---------------------------------------------------------------------------------------------------------------------
/**
 * 制御砲台 cfg.turretId を、cfg.fire に立って cfg.weapon で破壊する (cfg.bot に従う)。game を渡すとそのGameを続きから使う
 * (最終ゲートの通し試験用。その場合 HP は変更しない)。プレイヤーの配置以降は Game.input / Game.look / Game.step だけで動かす。
 */
export function runScenario(stage: StageDef, cfg: RunConfig, existing?: Game): RunResult {
  const loadout = cfg.loadout ?? DEFAULT_LOADOUT;
  let game = existing;
  if (!game) {
    game = new Game({ stage, loadout, seed: cfg.seed });
    game.sortie(loadout, cfg.seed);
  }
  const g = game;
  const s0 = g.state;
  const target = s0.enemies.find((e) => e.id === cfg.turretId) as EnemyState;
  const barrierId = target.barrierId as string;
  const portal = stage.portals.find((p) => p.barrierId === barrierId) as PortalDef;
  const passableBefore = portalPassable(g.world, portal);
  // 掩蔽ボットは掩蔽点から始める (配置=初期条件)。以降は歩いて出入りする
  placePlayer(g, cfg.bot === 'cover' ? (cfg.hide as Spot) : cfg.fire, target.pos, existing ? (cfg.hp ?? null) : (cfg.hp ?? IMMORTAL_HP));
  const sim = makeSim(g, cfg);
  if (cfg.bot !== 'idle') g.input.weaponSelect = cfg.weapon;
  const cs: CoverState = { mode: 'hidden', since: -10, peeks: 0, firedAtPeek: 0, hitsAtPeek: 0 };
  const maxSeconds = cfg.maxSeconds ?? 60;
  const settleTicks = Math.ceil((cfg.settleSeconds ?? 0.5) / SIM.DT - 1e-9);
  let settleLeft = -1; // 破壊後に進める残り tick 数 (-1 = まだ破壊されていない)
  for (;;) {
    const s = g.state;
    if (s.mode !== 'playing') break;
    if (settleLeft === 0) break;
    if (settleLeft < 0 && s.time - sim.t0 >= maxSeconds) break;
    if (settleLeft > 0) {
      settleLeft--;
      g.input.fire = false;
      releaseKeys(g);
    } else if (cfg.bot === 'stand') {
      if (target.alive) aimByMouse(g, target.pos);
      g.input.fire = target.alive && (cfg.fireBeforeLock === true || (s.lock.state === 'locked' && s.lock.targetId === cfg.turretId));
    } else if (cfg.bot === 'cover') {
      coverControl(sim, cfg, cs);
    }
    tick(sim);
    if (!target.alive && settleLeft < 0) settleLeft = settleTicks;
  }
  const s = g.state;
  const byOwner: RunResult['damageByOwner'] = {};
  for (const h of sim.hits) {
    const o = (byOwner[h.from] ??= { hits: 0, damage: 0 });
    o.hits++;
    o.damage += h.damage;
  }
  const resolved = sim.shotsAtTarget - sim.inFlightAtKill;
  const hpEnd = s.player.hp;
  return {
    cfg,
    killed: !target.alive,
    killAt: sim.killAt,
    endTime: s.time - sim.t0,
    ticks: Math.round((s.time - sim.t0) / SIM.DT),
    lockAcquireAt: sim.lockAcquireAt === null ? null : sim.lockAcquireAt - sim.t0,
    lockedAt: sim.lockedAt === null ? null : sim.lockedAt - sim.t0,
    lockedOther: sim.lockedOther,
    firstShotAt: sim.firstShotAt === null ? null : sim.firstShotAt - sim.t0,
    fired: sim.fired,
    used: {
      machinegun: sim.ammo0.machinegun - s.player.ammo.machinegun,
      missile: sim.ammo0.missile - s.player.ammo.missile,
      beamEn: sim.fired.beam * WEAPONS.beam.enCost,
    },
    mg: {
      firedAtTarget: sim.shotsAtTarget,
      hitsTarget: sim.mgHitTarget,
      hitsOtherEnemy: sim.mgHitEnemy - sim.mgHitTarget,
      hitsWorld: sim.mgHitWorld,
      inFlightAtKill: sim.inFlightAtKill,
      resolvedAtKill: resolved,
      hitRate: sim.killAt !== null && resolved > 0 ? sim.mgHitTarget / resolved : null,
      hitRateOfFired: sim.killAt !== null && sim.shotsAtTarget > 0 ? sim.mgHitTarget / sim.shotsAtTarget : null,
    },
    beamHits: sim.beamHits,
    missileHits: sim.missileHits,
    shotStatus: sim.shotStatus,
    fc: sim.fc,
    hpStart: sim.hp0,
    hpEnd,
    damageTaken: s.damageTaken - sim.dmg0,
    hitsAtKill: sim.hitsAtKill ?? sim.hits.length,
    damageAtKill: sim.damageAtKill ?? s.damageTaken - sim.dmg0,
    hits: sim.hits,
    damageByOwner: byOwner,
    firstHitAt: sim.hits.length ? sim.hits[0].time - sim.t0 : null,
    damage1000At: sim.damage1000At,
    failedAt: sim.failedAt,
    enemyShots: sim.enemyShots,
    otherKills: sim.otherKills,
    peeks: cs.peeks,
    barrier: {
      id: barrierId,
      openedAt: sim.barrierOpenAt,
      openIds: [...s.objective.openBarrierIds],
      boxesDisabled: barrierBoxesDisabled(g, barrierId),
      portalPassableBefore: passableBefore,
      portalPassableAfter: portalPassable(g.world, portal),
      controlsDestroyed: s.objective.controlsDestroyed,
      gateOpen: s.objective.gateOpen,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 6体を1つの Game で順に破壊 → 最終ゲート
// ---------------------------------------------------------------------------------------------------------------------
export interface GateRun {
  results: RunResult[];
  gateOpen: boolean;
  controlsDestroyed: number;
  openBarrierIds: string[];
  gateBoxesDisabled: boolean;
  gatePassableBefore: boolean;
  gatePassableAfter: boolean;
}

/** 制御砲台 6 体を、それぞれの狙撃位置(配置は毎回の初期条件)からマシンガンで順に破壊する。同じ Game を使い続けるので、他の敵の状態は引き継がれる */
export function runGate(stage: StageDef, spots: Record<string, { fire: Spot; hide: Spot }>, seed?: number, weapon: WeaponId = 'machinegun'): GateRun {
  const loadout = DEFAULT_LOADOUT;
  const game = new Game({ stage, loadout, seed });
  game.sortie(loadout, seed);
  game.state.player.hp = IMMORTAL_HP;
  const gate = stage.barriers.find((b) => b.isFinal) as StageDef['barriers'][number];
  const gatePortal = stage.portals.find((p) => p.barrierId === gate.id) as PortalDef;
  const before = portalPassable(game.world, gatePortal);
  const results: RunResult[] = [];
  for (const t of controlTurrets(stage)) {
    results.push(runScenario(stage, { turretId: t.id, weapon, bot: 'stand', fire: spots[t.id].fire, seed }, game));
  }
  const s = game.state;
  return {
    results,
    gateOpen: s.objective.gateOpen,
    controlsDestroyed: s.objective.controlsDestroyed,
    openBarrierIds: [...s.objective.openBarrierIds],
    gateBoxesDisabled: barrierBoxesDisabled(game, gate.id),
    gatePassableBefore: before,
    gatePassableAfter: portalPassable(game.world, gatePortal),
  };
}

// =====================================================================================================================
// 静的な探索の上位候補を、実際の掩蔽ボットで試して選ぶ
// =====================================================================================================================
export interface PickRow {
  cand: Candidate;
  runs: RunResult[];
  killed: number;
  meanDamage: number;
  maxDamage: number;
  meanKillAt: number | null;
}

/**
 * 探索の上位候補(互いに minSeparation m 以上離す, 掩蔽点があるもの) k 個を、seeds ごとに cover ボットで実際に走らせ、
 * 破壊できた回数が多い順 → 被ダメージ平均が小さい順 → 所要時間が短い順に並べる (採用は pickWinner)。
 */
export function pickBySimulation(
  stage: StageDef,
  probe: Probe,
  turretId: string,
  opts: { k?: number; seeds?: number[]; minSeparation?: number; maxSeconds?: number; walkOnly?: boolean } = {},
): PickRow[] {
  const k = opts.k ?? 8;
  const seeds = opts.seeds ?? [DEFAULT_SEED];
  const sep = opts.minSeparation ?? 6;
  const rep = searchSniperSpots(probe, turretId, { hideTop: 150 });
  const chosen: Candidate[] = [];
  const admit = (c: Candidate): void => {
    if (!c.hide || chosen.length >= k) return;
    if ((opts.walkOnly ?? true) && c.access !== 'walk') return;
    if (chosen.some((o) => Math.hypot(o.spot.x - c.spot.x, o.spot.z - c.spot.z) < sep && Math.abs(o.spot.floorY - c.spot.floorY) < 1)) return;
    chosen.push(c);
  };
  for (const c of rep.candidates) admit(c);
  // 報告された領域の最良点も試す (k を超えても加える)
  for (const region of HINT_REGIONS.filter((r) => r.turretId === turretId)) {
    const best = evaluateRegion(probe, region).best;
    if (best && best.hide && !chosen.some((o) => o.spot.x === best.spot.x && o.spot.z === best.spot.z && o.spot.floorY === best.spot.floorY)) chosen.push(best);
  }
  const rows: PickRow[] = chosen.map((cand) => {
    const runs = seeds.map((seed) => runScenario(stage, { turretId, weapon: 'machinegun', bot: 'cover', fire: cand.spot, hide: (cand.hide as HidePoint).spot, seed, maxSeconds: opts.maxSeconds ?? 60 }));
    const killedRuns = runs.filter((r) => r.killed);
    return {
      cand,
      runs,
      killed: killedRuns.length,
      meanDamage: runs.reduce((a, r) => a + r.damageTaken, 0) / runs.length,
      maxDamage: Math.max(...runs.map((r) => r.damageTaken)),
      meanKillAt: killedRuns.length ? killedRuns.reduce((a, r) => a + (r.killAt as number), 0) / killedRuns.length : null,
    };
  });
  rows.sort((a, b) => b.killed - a.killed || a.meanDamage - b.meanDamage || (a.meanKillAt ?? 1e9) - (b.meanKillAt ?? 1e9));
  return rows;
}

/** 採用する狙撃位置: 全 seed で破壊でき、距離が min〜max m の中で被ダメージ平均が最小 (同点は破壊が早い方) */
export function pickWinner(rows: PickRow[], nSeeds: number, min = 75, max = 116): PickRow | null {
  const ok = rows.filter((r) => r.killed === nSeeds && r.cand.distMuzzle >= min && r.cand.distMuzzle <= max);
  ok.sort((a, b) => a.meanDamage - b.meanDamage || (a.meanKillAt ?? 1e9) - (b.meanKillAt ?? 1e9));
  return ok[0] ?? null;
}

// =====================================================================================================================
// 狙撃位置 (自動探索の結果。tools の --search で再現・更新する。tests は現在のステージで有効かを検証する)
// =====================================================================================================================
export const SNIPER_SPOTS: Record<string, { fire: Spot; hide: Spot }> = {
  // 選定は `--pick` (探索の上位候補と報告領域の最良点を、5 seed の cover ボットで実走。歩いて着ける位置のうち 距離 75〜116m で、
  // 5/5 破壊できたものの中で被ダメージ平均が最小 (同点は破壊が早い方))。docs/TURRET_KILL.md の「選定」に一覧
  T03: { fire: { x: 323, z: 91, floorY: 0 }, hide: { x: 320.5, z: 90.5, floorY: 0 } },
  T07: { fire: { x: 552, z: 89, floorY: 12 }, hide: { x: 550.5, z: 88.5, floorY: 12 } },
  T08: { fire: { x: 443, z: 143, floorY: 0 }, hide: { x: 446.5, z: 143, floorY: 0 } },
  T11: { fire: { x: 203, z: 241, floorY: -14 }, hide: { x: 200.5, z: 239.5, floorY: -14 } },
  T14: { fire: { x: 245, z: 485, floorY: 24 }, hide: { x: 243.5, z: 485, floorY: 24 } },
  T15: { fire: { x: 463, z: 441, floorY: 0 }, hide: { x: 460.5, z: 440.5, floorY: 0 } },
};

/** 表にある狙撃位置が、現在のステージで有効 (立てる・FCSでロックできる・3武器の弾道が通る・砲台が撃ち返す・掩蔽点は誰からも見えない) か */
export function verifySnipeSpot(probe: Probe, turretId: string): { ok: boolean; problems: string[]; eval: SpotEval; walkMeters: number | null } {
  const t = controlTurrets(probe.stage).find((x) => x.id === turretId) as ControlTurret;
  const sp = SNIPER_SPOTS[turretId];
  const problems: string[] = [];
  if (!canStand(probe.world, sp.fire)) problems.push('fire: 立てない');
  else if (new StandGrid(probe, t.sectorId).accessOf(sp.fire).access !== 'walk') problems.push('fire: 歩き/ジャンプ/降下で着けない (入口から)');
  // 独立した確認: 警備ロボット用の歩行グラフ (段差0.3m・体幅2.7m) で、区画の歩き始め → 発射位置の近くの開けた床 → 発射位置 (プレイヤーの体幅で直進)
  let walkMeters: number | null = null;
  const origin = reachOrigin(probe, t.sectorId, sp.fire.floorY);
  const near = probe.nav.nearestFree(sp.fire.x, sp.fire.z, sp.fire.floorY, 4);
  if (!origin || !near) problems.push('fire: 歩行グラフに乗る開けた床が近くにない');
  else {
    const path = probe.nav.findPath(origin, near);
    if (!path || path.partial) problems.push('fire: 歩行グラフで区画の歩き始めから通じない');
    else {
      walkMeters = path.length + Math.hypot(near.x - sp.fire.x, near.z - sp.fire.z);
      if (probe.nav.walkProbe(near, sp.fire.x, sp.fire.z, HALF.x + 0.05) === null) problems.push('fire: 近くの開けた床からプレイヤーの体幅で歩いて着けない');
    }
  }
  const ev = evaluateSpot(probe, t, sp.fire);
  if (!ev.lockable) problems.push('fire: 砲台をロックできない');
  if (ev.distMuzzle < SNIPE_MIN || ev.distMuzzle > SNIPE_MAX) problems.push(`fire: 距離 ${fmt(ev.distMuzzle)} m が ${SNIPE_MIN}〜${SNIPE_MAX} の外`);
  if (!weaponsClear(ev)) problems.push(`fire: 弾道が塞がれる (mg=${ev.mg.outcome} beam=${ev.beam} missile=${ev.missile})`);
  if (!ev.turretSees) problems.push('fire: 砲台がプレイヤーを見ない (反撃を受けない位置)');
  if (ev.lockCandidates.length !== 1 || ev.lockCandidates[0] !== turretId) problems.push(`fire: ロック候補が砲台だけでない (${ev.lockCandidates.join(',')})`);
  if (!canStand(probe.world, sp.hide)) problems.push('hide: 立てない');
  const hc = centerOf(sp.hide);
  for (const [ox, oz] of [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) {
    const seen = exposedTo(probe, v3(hc.x + ox, hc.y, hc.z + oz), null, true);
    if (seen.length) problems.push(`hide: (${ox},${oz}) を ${seen.join(',')} が見る`);
  }
  const a = centerOf(sp.fire);
  a.y += 0.003;
  if (probe.world.sweepAABB(a, COLLIDE_HALF, v3(hc.x - a.x, 0, hc.z - a.z))) problems.push('hide: fire との間を直進できない');
  return { ok: problems.length === 0, problems, eval: ev, walkMeters };
}

// =====================================================================================================================
// CLI
// =====================================================================================================================
const md = (headers: string[], rows: (string | number)[][]): string =>
  [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
const xyz = (s: Spot): string => `(${s.x}, ${s.floorY}, ${s.z})`;
const pct = (n: number | null): string => (n === null ? '-' : `${(n * 100).toFixed(0)}%`);
const sec = (n: number | null, d = 2): string => (n === null ? '-' : n.toFixed(d));
const stats = (xs: number[]): { mean: number; min: number; max: number } => ({ mean: xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length), min: Math.min(...xs), max: Math.max(...xs) });
const seedList = (n: number): number[] => [DEFAULT_SEED, ...Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 1)];
const ownerText = (r: RunResult): string => {
  const e = Object.entries(r.damageByOwner);
  return e.length ? e.map(([id, o]) => `${id}:${o.hits}回/${o.damage}`).join(' ') : '-';
};

function sectionSearch(stage: StageDef, probe: Probe, only: string | null, top: number): void {
  console.log('## 狙撃位置の探索 (自動)\n');
  for (const t of controlTurrets(stage)) {
    if (only && t.id !== only) continue;
    const t0 = performance.now();
    const rep = searchSniperSpots(probe, t.id, { hideTop: 150 });
    console.log(`### ${t.id} (${t.sectorId}, ${t.barrierId}) 砲台の当たり判定中心 (${t.pos.x}, ${t.pos.y}, ${t.pos.z})`);
    console.log(
      `立てる床の格子 ${rep.nodes} 点 (歩行到達 ${rep.walkable}) → 距離帯に入る評価 ${rep.evaluated} → FCSでロックできる ${rep.lockable} → 銃口距離 ${SNIPE_MIN}〜${SNIPE_MAX}m ${rep.inRange} (うち警備ロボットの体幅でも立てる開けた床 ${rep.openFloor}) → 3武器の弾道が通り/他の敵をロックせず/砲台が撃ち返す ${rep.clearAll} → 到達可 ${rep.accessOk} (別に、砲台が撃ち返さない位置 ${rep.oneWay}) (${((performance.now() - t0) / 1000).toFixed(1)} s)\n`,
    );
    const rows = rep.candidates
      .filter((c) => c.hide)
      .slice(0, top)
      .map((c) => [xyz(c.spot), fmt(c.distMuzzle), fmt(c.distHoriz), c.access, c.exposed.join(',') || '-', c.patrolExposed.filter((x) => !c.exposed.includes(x)).join(',') || '-', c.hide ? `${xyz(c.hide.spot)} ${fmt(c.hide.distance)}m` : '-', fmt(c.mg.t ?? NaN, 2), fmt(c.score)]);
    console.log(md(['発射位置 (x, 床y, z)', '銃口→砲台 [m]', '水平 [m]', '到達', '初期位置から見る敵', '巡回で見る敵', '掩蔽点 (距離)', 'MG飛翔 [s]', '順位値'], rows));
    console.log('');
  }
  console.log('### 区画作り込み担当が報告した領域の検証\n');
  const rrows: (string | number)[][] = [];
  for (const region of HINT_REGIONS) {
    if (only && region.turretId !== only) continue;
    const r = evaluateRegion(probe, region);
    rrows.push([
      region.turretId,
      region.where,
      `${r.standable}/${r.samples}`,
      r.minDist === null ? '-' : `${fmt(r.minDist)}〜${fmt(r.maxDist as number)}`,
      r.lockable,
      r.inRange,
      r.clearAll,
      r.turretSees,
      r.best ? `${xyz(r.best.spot)} d=${fmt(r.best.distMuzzle)} 掩蔽${r.best.hide ? fmt(r.best.hide.distance) + 'm' : '無'} 見る敵[${r.best.patrolExposed.join(',') || '-'}]` : '-',
    ]);
  }
  console.log(md(['砲台', '領域', '立てる点/走査点', '銃口→砲台 [m]', 'ロック可', '60〜118m', '弾道◯(3武器・単独ロック)', '砲台が撃ち返す', '領域内の最良'], rrows));
  console.log('');
}

function sectionPick(stage: StageDef, probe: Probe, only: string | null, seeds: number[]): void {
  console.log(`## 選定 (cover ボットで実走: seed ${seeds.length} 通り。★ = 採用 (全 seed で破壊・距離 75〜116m・被ダメージ平均が最小))\n`);
  for (const t of controlTurrets(stage)) {
    if (only && t.id !== only) continue;
    const rows = pickBySimulation(stage, probe, t.id, { k: 8, seeds });
    const win = pickWinner(rows, seeds.length);
    console.log(`### ${t.id}\n`);
    console.log(
      md(
        ['', '発射位置', '掩蔽点', '距離 [m]', '巡回で見る敵', `破壊/${seeds.length}`, '被ダメージ 平均/最大', '破壊までの秒 平均'],
        rows.map((r) => [r === win ? '★' : '', xyz(r.cand.spot), xyz((r.cand.hide as HidePoint).spot), fmt(r.cand.distMuzzle), r.cand.patrolExposed.join(',') || '-', r.killed, `${fmt(r.meanDamage, 0)} / ${r.maxDamage}`, sec(r.meanKillAt, 1)]),
      ),
    );
    const sp = SNIPER_SPOTS[t.id];
    const same = win && win.cand.spot.x === sp.fire.x && win.cand.spot.z === sp.fire.z && win.cand.spot.floorY === sp.fire.floorY;
    console.log(`\n採用 ${win ? xyz(win.cand.spot) : '(なし)'} / SNIPER_SPOTS ${xyz(sp.fire)} → ${same ? '一致' : '不一致 (表を更新すること)'}\n`);
  }
}

const WEAPON_LABEL: Record<WeaponId, string> = { machinegun: 'マシンガン', beam: 'ビーム', missile: 'ミサイル' };

function sectionWeapons(stage: StageDef, probe: Probe, only: string | null, seed: number): RunResult[] {
  console.log('## 3武器での破壊 (狙撃位置に立ったまま・回避しない。他の44体は生存、敵は実AIで反撃。プレイヤーHPは 1e9 (被弾でHPが実際に減ることを確認))\n');
  const out: RunResult[] = [];
  const rows: (string | number)[][] = [];
  for (const t of controlTurrets(stage)) {
    if (only && t.id !== only) continue;
    const sp = SNIPER_SPOTS[t.id];
    const ev = evaluateSpot(probe, t, sp.fire);
    for (const weapon of ['machinegun', 'beam', 'missile'] as WeaponId[]) {
      const r = runScenario(stage, { turretId: t.id, weapon, bot: 'stand', fire: sp.fire, seed, maxSeconds: 40 });
      out.push(r);
      const fired = weapon === 'machinegun' ? r.mg.firedAtTarget : weapon === 'beam' ? r.fired.beam : r.fired.missile;
      const hit = weapon === 'machinegun' ? r.mg.hitsTarget : weapon === 'beam' ? r.beamHits : r.missileHits;
      const used = weapon === 'machinegun' ? `${r.used.machinegun}発` : weapon === 'beam' ? `EN ${r.used.beamEn}` : `${r.used.missile}発`;
      rows.push([
        t.id,
        WEAPON_LABEL[weapon],
        `${xyz(sp.fire)} ${fmt(ev.distMuzzle)}m`,
        r.killed ? '破壊' : '未破壊',
        `${sec(r.lockAcquireAt, 3)}→${sec(r.lockedAt, 3)}`,
        r.fc ? `${r.fc.status}${r.fc.residualMeters !== null ? ` (残差${r.fc.residualMeters.toExponential(1)}m)` : ''}` : '-',
        `${fired}/${hit}${weapon === 'machinegun' ? ` (決着した弾の命中率 ${pct(r.mg.hitRate)} / 発射基準 ${pct(r.mg.hitRateOfFired)}, 壁に当たった弾${r.mg.hitsWorld}, 飛翔中${r.mg.inFlightAtKill})` : ''}`,
        used,
        `${sec(r.firstShotAt)}→${sec(r.killAt)}`,
        `${r.hitsAtKill}回/${r.damageAtKill}HP`,
        `${r.barrier.id} ${r.barrier.boxesDisabled ? '開' : '閉'} 通行${r.barrier.portalPassableBefore ? '可' : '不可'}→${r.barrier.portalPassableAfter ? '可' : '不可'}`,
      ]);
    }
  }
  console.log(md(['砲台', '武器', '発射位置 距離', '結果', 'ロック取得→完了 [s]', '射撃解', '標的への発射/命中', '消費', '初弾→破壊 [s]', '被弾(破壊まで)', '隔壁'], rows));
  console.log('');
  return out;
}

function sectionGate(stage: StageDef): GateRun {
  console.log('## 6体を1つのGameで順に破壊 → 最終ゲート (マシンガン, 毎回の配置は狙撃位置)\n');
  const run = runGate(stage, SNIPER_SPOTS, DEFAULT_SEED);
  console.log(
    md(
      ['砲台', '隔壁', '破壊 [s]', '累積破壊数', '開いた隔壁'],
      run.results.map((r) => [r.cfg.turretId, r.barrier.id, sec(r.killAt), r.barrier.controlsDestroyed, r.barrier.openIds.join(',')]),
    ),
  );
  console.log(`\nobjective.gateOpen=${run.gateOpen} / controlsDestroyed=${run.controlsDestroyed} / 開いた隔壁 ${run.openBarrierIds.join(',')} / 最終ゲートの箱が無効化 ${run.gateBoxesDisabled} / P15 通行 ${run.gatePassableBefore ? '可' : '不可'} → ${run.gatePassableAfter ? '可' : '不可'}\n`);
  return run;
}

function sectionCover(stage: StageDef, only: string | null, seeds: number[]): RunResult[] {
  console.log(`## 掩蔽ボット (掩蔽点から始め、身を出す→FCSロック→撃つ→弾が迫るか被弾で引っ込む。警備に見つかったらその場で撃つ。seed ${seeds.length} 通り, HP 1e9)\n`);
  const all: RunResult[] = [];
  const rows: (string | number)[][] = [];
  for (const t of controlTurrets(stage)) {
    if (only && t.id !== only) continue;
    const sp = SNIPER_SPOTS[t.id];
    const rs = seeds.map((seed) => runScenario(stage, { turretId: t.id, weapon: 'machinegun', bot: 'cover', fire: sp.fire, hide: sp.hide, seed, maxSeconds: 90 }));
    all.push(...rs);
    const killed = rs.filter((r) => r.killed);
    const dmg = stats(rs.map((r) => r.damageTaken));
    const tim = killed.length ? stats(killed.map((r) => r.killAt as number)) : null;
    const byKind = (kind: 'T' | 'G'): number => rs.reduce((a, r) => a + Object.entries(r.damageByOwner).filter(([id]) => id.startsWith(kind)).reduce((b, [, o]) => b + o.damage, 0), 0) / rs.length;
    rows.push([
      t.id,
      `${xyz(sp.fire)} ← ${xyz(sp.hide)}`,
      `${killed.length}/${rs.length}`,
      tim ? `${fmt(tim.mean)} (${fmt(tim.min)}〜${fmt(tim.max)})` : '-',
      fmt(stats(rs.map((r) => r.peeks)).mean),
      `${fmt(stats(rs.map((r) => r.mg.firedAtTarget)).mean, 1)} / ${fmt(stats(rs.map((r) => r.mg.hitsTarget)).mean, 1)}`,
      fmt(stats(rs.map((r) => r.mg.hitsWorld)).mean, 1),
      `${fmt(dmg.mean, 0)} (${fmt(dmg.min, 0)}〜${fmt(dmg.max, 0)})`,
      `${fmt(byKind('T'), 0)} / ${fmt(byKind('G'), 0)}`,
      fmt(stats(rs.map((r) => r.hits.length)).mean),
      rs.filter((r) => r.damageTaken >= 1000).length,
    ]);
  }
  console.log(md(['砲台', '発射位置 ← 掩蔽点', '破壊', '破壊まで [s] 平均(範囲)', '身を出した回数', '砲台向けの弾 発射/命中 (平均)', '壁に当たったMG弾 (警備向けを含む, 平均)', '被ダメージ 平均(範囲)', '内訳 砲台 / 警備', '被弾回数', '被ダメージ≥1000の実行数'], rows));
  console.log('');
  return all;
}

function sectionIdle(stage: StageDef, only: string | null, seeds: number[]): RunResult[] {
  console.log(`## 狙撃位置に何もせず立ち続けたとき (実HP 1000, 入力なし, 最大60秒, seed ${seeds.length} 通り)\n`);
  const all: RunResult[] = [];
  const rows: (string | number)[][] = [];
  for (const t of controlTurrets(stage)) {
    if (only && t.id !== only) continue;
    const sp = SNIPER_SPOTS[t.id];
    const rs = seeds.map((seed) => runScenario(stage, { turretId: t.id, weapon: 'machinegun', bot: 'idle', fire: sp.fire, seed, hp: PLAYER.MAX_HP, maxSeconds: 60 }));
    all.push(...rs);
    const died = rs.filter((r) => r.failedAt !== null);
    const first = rs.filter((r) => r.firstHitAt !== null);
    rows.push([
      t.id,
      xyz(sp.fire),
      first.length ? fmt(stats(first.map((r) => r.firstHitAt as number)).mean) : '-',
      died.length ? `${died.length}/${rs.length} (${fmt(stats(died.map((r) => r.failedAt as number)).mean, 1)} s)` : `0/${rs.length}`,
      fmt(stats(rs.map((r) => r.hits.length)).mean, 1),
      fmt(stats(rs.map((r) => r.damageTaken)).mean, 0),
      fmt(stats(rs.map((r) => r.hpEnd)).mean, 0),
      ownerText(rs[0]),
    ]);
  }
  console.log(md(['砲台', '位置', '最初の被弾 [s] 平均', '60秒以内に撃破された (平均生存)', '被弾回数 平均', '被ダメージ 平均', '最終HP 平均', '内訳 (seed 1本目)'], rows));
  console.log('');
  return all;
}

function sectionOneWay(stage: StageDef, probe: Probe, only: string | null): void {
  console.log('## 撃ち返されない位置 (砲台をロックして撃てるが、砲台からプレイヤー中心が見えない位置。マシンガン, 立ったまま, HP 1e9)\n');
  const rows: (string | number)[][] = [];
  for (const t of controlTurrets(stage)) {
    if (only && t.id !== only) continue;
    const rep = searchSniperSpots(probe, t.id, { hideTop: 0 });
    const c = findOneWaySpot(probe, t.id);
    if (!c) {
      rows.push([t.id, `${rep.oneWay}`, '-', '-', '-', '-', '-', '-']);
      continue;
    }
    const r = runScenario(stage, { turretId: t.id, weapon: 'machinegun', bot: 'stand', fire: c.spot, seed: DEFAULT_SEED, maxSeconds: 30 });
    rows.push([t.id, `${rep.oneWay} (撃ち返される ${rep.clearAll})`, `${xyz(c.spot)} ${fmt(c.distMuzzle)}m`, r.killed ? `破壊 ${sec(r.killAt)} s` : '未破壊', `${r.mg.hitsTarget}/${r.mg.resolvedAtKill}`, `${r.enemyShots[t.id] ?? 0}`, `${r.hitsAtKill}回/${r.damageAtKill}HP`, ownerText(r)]);
  }
  console.log(md(['砲台', '該当する位置の数 (比較: 撃ち返される位置)', '例 (約90m・他の敵から見えない)', '結果', '標的への命中/決着した弾', '砲台の発射数', '被弾(破壊まで)', '被弾の内訳(実行全体)'], rows));
  console.log('');
}

function sectionControl(stage: StageDef, only: string | null): void {
  console.log('## 対照実験: ロック完了を待たずに撃ち続ける (完了前のマシンガンは補正なしの自由射撃。照準は砲台中心に合わせたまま)\n');
  const rows: (string | number)[][] = [];
  for (const t of controlTurrets(stage)) {
    if (only && t.id !== only) continue;
    const r = runScenario(stage, { turretId: t.id, weapon: 'machinegun', bot: 'stand', fire: SNIPER_SPOTS[t.id].fire, fireBeforeLock: true, seed: DEFAULT_SEED, maxSeconds: 30 });
    rows.push([t.id, `${sec(r.firstShotAt)} / ${sec(r.lockedAt, 3)}`, `${r.shotStatus.inactive} / ${r.shotStatus.solved}`, `${r.mg.hitsTarget}`, `${r.mg.hitsWorld}`, r.killed ? `破壊 ${sec(r.killAt)} s` : '未破壊']);
  }
  console.log(md(['砲台', '初弾 / ロック完了 [s]', '自由射撃(inactive) / 補正射撃(solved) の発数', '標的への命中', '壁・床に当たった弾 (破壊まで)', '結果'], rows));
  console.log('');
}

function main(): void {
  const args = process.argv.slice(2);
  const has = (f: string): boolean => args.includes(f);
  const val = (f: string): string | null => {
    const i = args.indexOf(f);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const only = val('--turret');
  const nSeeds = Number(val('--seeds') ?? 5);
  const top = Number(val('--top') ?? 6);
  const sections = ['--search', '--pick', '--weapons', '--control', '--gate', '--cover', '--idle', '--oneway'];
  const all = !sections.some(has);
  const stage = buildStage();
  const probe = makeProbe(stage);
  const t0 = performance.now();
  console.log(`# turret-kill (loadout ${JSON.stringify(DEFAULT_LOADOUT)}, 既定seed ${DEFAULT_SEED}, dt=1/${SIM.HZ}s)\n`);
  const problems: string[] = [];
  const spotRows: (string | number)[][] = [];
  for (const t of controlTurrets(stage)) {
    if (only && t.id !== only) continue;
    const v = verifySnipeSpot(probe, t.id);
    if (!v.ok) problems.push(`${t.id}: ${v.problems.join(' / ')}`);
    const sp = SNIPER_SPOTS[t.id];
    spotRows.push([t.id, `${t.sectorId}/${t.barrierId}`, xyz(sp.fire), fmt(v.eval.distMuzzle), fmt(v.eval.distHoriz), `${xyz(sp.hide)} (${fmt(Math.hypot(sp.hide.x - sp.fire.x, sp.hide.z - sp.fire.z))}m)`, v.walkMeters === null ? '-' : fmt(v.walkMeters), v.eval.patrolExposed.join(',') || '-', v.ok ? '有効' : '無効']);
  }
  console.log(md(['砲台', '区画/隔壁', '狙撃位置 (x, 床y, z)', '銃口→砲台 [m]', '水平 [m]', '掩蔽点 (距離)', '歩行経路 [m] (警備用Nav)', '巡回で見る敵', '表の検証'], spotRows));
  console.log(problems.length ? `\n狙撃位置の表 (SNIPER_SPOTS) が現在のステージで無効:\n- ${problems.join('\n- ')}\n` : '\n狙撃位置の表 (SNIPER_SPOTS) は現在のステージで全て有効 (立てる / 歩いて着ける / ロック可 / 60〜118m / 3武器の弾道 / 砲台が撃ち返す / 掩蔽点は全ての敵(巡回位置を含む)から見えない)\n');
  if (all || has('--search')) sectionSearch(stage, probe, only, top);
  if (has('--pick')) sectionPick(stage, probe, only, seedList(nSeeds));
  if (all || has('--weapons')) sectionWeapons(stage, probe, only, DEFAULT_SEED);
  if (all || has('--control')) sectionControl(stage, only);
  if (all || has('--gate')) sectionGate(stage);
  if (all || has('--cover')) sectionCover(stage, only, seedList(nSeeds));
  if (all || has('--idle')) sectionIdle(stage, only, seedList(nSeeds));
  if (all || has('--oneway')) sectionOneWay(stage, probe, only);
  console.log(`(実行時間 ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
