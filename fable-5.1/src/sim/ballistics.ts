/**
 * 偏差・重力補正の解法（仕様 §4.3 / §4.4）。
 * 純粋な数学モジュール。Three.js / DOM に依存しない。
 *
 * - solveMachinegunLead: 重力を受ける弾体（初速 s）で等速直線運動する対象に当てる
 *   最小の正の到達時間 t∈(0, maxT] と射出方向を求める（4 次方程式）。
 * - solveLinearLead: 直進弾（ミサイル・敵弾）の等速偏差（2 次方程式）。
 * - quarticRootsInRange: 4 次以下の多項式の実根を [0, maxT] の範囲で列挙する
 *   （導関数による区間分離 ＋ 二分法 ＋ ニュートン磨き。重根と端点も扱う）。
 */
import { WEAPONS } from '../params';
import type { Vec3 } from '../types';
import { addScaled, dot, isFinite3, length, lengthSq, scale } from './vec';

export interface LeadSolution {
  t: number;
  direction: Vec3;
  residualMeters: number;
}

/**
 * 採用時刻における弾体と等速予測対象中心の距離の上限 [m]（仕様 §4.3: 0.01 m 以下）。
 * 仕様 §4.3 / ARCHITECTURE §3.3 に固定された合格基準であり、src/params.ts には対応する項目が無い。
 * params.ts に追加された場合はそちらを import すること。
 */
const MAX_RESIDUAL_METERS: number = WEAPONS.machinegun.maxResidualMeters;
/** 銃口と対象中心がほぼ同一とみなす距離 [m] */
const MIN_RANGE_METERS = 1e-6;
/** 2 次項をゼロとみなす閾値（§4.4 の 1 次式扱い） */
const LINEAR_EPS = 1e-9;
/** 二分法の打ち切り: 反復回数と区間幅 */
const BISECT_MAX_ITER = 200;
const BISECT_MIN_ITER = 80;
const BISECT_WIDTH = 1e-13;
/** ニュートン磨きの回数 */
const NEWTON_STEPS = 4;
/**
 * 極値点・端点を根として受理する相対許容値。
 * 基準は評価点 t における各項の大きさ Σ|c_i|·|t|^i（localScale）であり、
 * 区間全体の maxT^n に比例する大域スケールは使わない（maxT が大きいと存在しない根を捏造するため）。
 */
const DOUBLE_ROOT_REL_TOL = 1e-9;
/** 次数を落とす判定: 最高次項の区間内寄与が全項の寄与のこの割合以下なら無視 */
const DEGREE_DROP_REL = 1e-12;
/** 近接する根を同一とみなす間隔 */
const ROOT_MERGE_EPS = 1e-10;

/** 昇べき順係数の多項式を t で評価（ホーナー法） */
function evalPoly(c: readonly number[], t: number): number {
  let acc = 0;
  for (let i = c.length - 1; i >= 0; i--) acc = acc * t + c[i];
  return acc;
}

/** 昇べき順係数の導関数 */
function derivative(c: readonly number[]): number[] {
  const d: number[] = [];
  for (let i = 1; i < c.length; i++) d.push(c[i] * i);
  return d;
}

/**
 * 区間 [0, hi] における各項の寄与の大きさ（許容値のスケール）。
 * Σ|c_i|·hi^i。少なくとも 1。
 */
function polyScale(c: readonly number[], hi: number): number {
  let s = 0;
  let p = 1;
  const h = Math.max(1, Math.abs(hi));
  for (let i = 0; i < c.length; i++) {
    s += Math.abs(c[i]) * p;
    p *= h;
  }
  return Math.max(1, s);
}

/**
 * 評価点 t における各項の大きさ Σ|c_i|·|t|^i。
 * ホーナー法による f(t) の丸め誤差はこの値 × 数 ulp で抑えられるため、
 * 「f(t) が数値的に 0 か」の判定はこの局所スケールに対する相対値で行う。
 */
function localScale(c: readonly number[], t: number): number {
  let s = 0;
  let p = 1;
  const a = Math.abs(t);
  for (let i = 0; i < c.length; i++) {
    s += Math.abs(c[i]) * p;
    p *= a;
  }
  return s;
}

/**
 * 区間内で寄与が無視できる最高次項を落として実効次数を下げる。
 * 全て無視できる場合は空配列（恒等的に 0 とみなす）。
 */
function trimDegree(c: readonly number[], hi: number): number[] {
  const out = c.slice();
  const total = polyScale(out, hi);
  const h = Math.max(1, Math.abs(hi));
  while (out.length > 0) {
    const n = out.length - 1;
    const lead = out[n];
    const contribution = Math.abs(lead) * Math.pow(h, n);
    if (lead === 0 || (n > 0 && contribution <= DEGREE_DROP_REL * total)) {
      out.pop();
    } else {
      break;
    }
  }
  if (out.length === 1 && Math.abs(out[0]) <= DEGREE_DROP_REL * total) return [];
  return out;
}

/** 区間 [a, b]（f(a)·f(b) < 0）で二分法。区間幅 < BISECT_WIDTH または上限回数で停止 */
function bisect(c: readonly number[], a: number, b: number, fa: number): number {
  let lo = a;
  let hi = b;
  let flo = fa;
  for (let i = 0; i < BISECT_MAX_ITER; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid === lo || mid === hi) break;
    const fm = evalPoly(c, mid);
    if (fm === 0) return mid;
    if ((fm < 0) === (flo < 0)) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
    if (i >= BISECT_MIN_ITER && hi - lo < BISECT_WIDTH) break;
  }
  return 0.5 * (lo + hi);
}

/** ニュートン法で数回磨く。|f| が減らない・区間外・非有限なら採用しない */
function newtonPolish(c: readonly number[], d: readonly number[], t0: number, lo: number, hi: number): number {
  let t = t0;
  let ft = Math.abs(evalPoly(c, t));
  for (let i = 0; i < NEWTON_STEPS; i++) {
    const fp = evalPoly(d, t);
    if (fp === 0 || !Number.isFinite(fp)) break;
    const tn = t - evalPoly(c, t) / fp;
    if (!Number.isFinite(tn) || tn < lo || tn > hi) break;
    const fn = Math.abs(evalPoly(c, tn));
    if (fn >= ft) break;
    t = tn;
    ft = fn;
    if (ft === 0) break;
  }
  return t;
}

/** 昇順ソートし、近接する根を 1 つにまとめる */
function sortedUnique(roots: number[]): number[] {
  roots.sort((x, y) => x - y);
  const out: number[] = [];
  for (const r of roots) {
    if (out.length === 0 || r - out[out.length - 1] > ROOT_MERGE_EPS * Math.max(1, Math.abs(r))) out.push(r);
  }
  return out;
}

/**
 * 昇べき順係数の多項式の実根を閉区間 [lo, hi] で列挙する（昇順、重根は 1 回）。
 * 次数 1 は解析的、次数 ≥ 2 は導関数の根（再帰）で単調区間へ分離し、
 * 符号変化のある区間を二分法＋ニュートンで解く。
 * 評価点（端点・極値点）で |f| が局所許容内なら根（重根や t=maxT 端点）として受理するが、
 * 隣接区間に厳密な符号変化がある場合は受理しない：その根は二分法で見つかる真の根であり、
 * 極値点を重ねて返すと「近接する 2 つの単根 ＋ 根でない極値点」の 3 点になってしまうため。
 */
function polyRootsInInterval(c: readonly number[], lo: number, hi: number): number[] {
  const p = trimDegree(c, hi);
  const n = p.length - 1;
  if (n < 1) return []; // 定数（0 も含む）: 孤立根なし
  if (n === 1) {
    const t = -p[0] / p[1];
    return Number.isFinite(t) && t >= lo && t <= hi ? [t] : [];
  }
  const d = derivative(p);
  const crit = polyRootsInInterval(d, lo, hi);
  // 評価点: lo, 臨界点, hi
  const pts: number[] = [lo];
  for (const t of crit) if (t > lo && t < hi) pts.push(t);
  pts.push(hi);
  const vals = pts.map((t) => evalPoly(p, t));
  // 各単調区間 [pts[i], pts[i+1]] に厳密な符号変化があるか（どちらかが厳密に 0 なら「変化なし」扱い）
  const signChange: boolean[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const fa = vals[i];
    const fb = vals[i + 1];
    signChange.push(fa !== 0 && fb !== 0 && (fa < 0) !== (fb < 0));
  }

  const roots: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const leftChange = i > 0 && signChange[i - 1];
    const rightChange = i + 1 < pts.length && signChange[i];
    // 端点・極値点そのものが根（重根や t=maxT 端点）。隣接区間で符号が変わるなら二分法に任せる
    if (!leftChange && !rightChange) {
      const tol = DOUBLE_ROOT_REL_TOL * localScale(p, pts[i]);
      if (Math.abs(vals[i]) <= tol) roots.push(pts[i]);
    }
    if (rightChange) {
      // 単調区間で厳密な符号変化 → 単根
      const a = pts[i];
      const b = pts[i + 1];
      const t = bisect(p, a, b, vals[i]);
      roots.push(newtonPolish(p, d, t, a, b));
    }
  }
  return sortedUnique(roots);
}

/**
 * 4 次方程式 c4 t^4 + c3 t^3 + c2 t^2 + c1 t + c0 = 0 の (0, maxT] 内の実根を昇順で返す
 * （重根・端点 t=maxT を含む）。c4=0 などの退化は次数を落として扱う（重力 0 なら 2 次式）。
 */
export function quarticRootsInRange(c4: number, c3: number, c2: number, c1: number, c0: number, maxT: number): number[] {
  if (!(maxT > 0) || !Number.isFinite(maxT)) return [];
  const coeffs = [c0, c1, c2, c3, c4];
  if (!coeffs.every((x) => Number.isFinite(x))) return [];
  return polyRootsInInterval(coeffs, 0, maxT).filter((t) => t > 0 && t <= maxT && Number.isFinite(t));
}

/**
 * §4.3 マシンガン: 重力 gravity、初速 speed の弾体で、r = p − m にいて速度 v で等速直線運動する
 * 対象中心に到達する最小の正の t∈(0, maxT] と射出方向。
 * w(t) = r + v t − 0.5 g t²、条件 |w(t)|² − speed² t² = 0。
 * residualMeters = | |w(t)| − speed·t |（採用時刻の弾体と対象中心の距離）。
 * residual > 0.01 m、r≈0、非有限値のときは null。
 */
export function solveMachinegunLead(r: Vec3, v: Vec3, speed: number, gravity: Vec3, maxT: number): LeadSolution | null {
  if (!isFinite3(r) || !isFinite3(v) || !isFinite3(gravity)) return null;
  if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(maxT) || maxT <= 0) return null;
  const rLen = length(r);
  if (!(rLen >= MIN_RANGE_METERS)) return null;

  const hvec = scale(gravity, -0.5);
  const c4 = dot(hvec, hvec);
  const c3 = 2 * dot(v, hvec);
  const c2 = dot(v, v) + 2 * dot(r, hvec) - speed * speed;
  const c1 = 2 * dot(r, v);
  const c0 = dot(r, r);

  // 昇順の根を順に検証し、残差条件（≤ 0.01 m）を満たす最小の正の解を採用する。
  // 条件を満たさない解は返さない（次の根へ進む）。
  const roots = quarticRootsInRange(c4, c3, c2, c1, c0, maxT);
  for (const t of roots) {
    if (!Number.isFinite(t) || t <= 0 || t > maxT) continue;
    // w(t) = r + v t + hvec t²
    const w = addScaled(addScaled(r, v, t), hvec, t * t);
    const wLen = length(w);
    if (!Number.isFinite(wLen) || wLen <= 1e-12) continue;
    const direction: Vec3 = [w[0] / wLen, w[1] / wLen, w[2] / wLen];
    const residualMeters = Math.abs(wLen - speed * t);
    if (!isFinite3(direction) || !Number.isFinite(residualMeters)) continue;
    if (residualMeters > MAX_RESIDUAL_METERS) continue;
    return { t, direction, residualMeters };
  }
  return null;
}

/**
 * §4.4 ミサイル/敵弾: (v·v − speed²) t² + 2 (r·v) t + r·r = 0 の最小の正の解 t∈(0, maxT]。
 * 2 次項がほぼ 0 なら 1 次式 2(r·v) t + r·r = 0 として解く。解がなければ null。
 */
export function solveLinearLead(r: Vec3, v: Vec3, speed: number, maxT: number): LeadSolution | null {
  if (!isFinite3(r) || !isFinite3(v)) return null;
  if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(maxT) || maxT <= 0) return null;
  const a = dot(v, v) - speed * speed;
  const b = 2 * dot(r, v);
  const c = lengthSq(r);

  let t: number | null = null;
  if (Math.abs(a) < LINEAR_EPS) {
    if (b !== 0) {
      const tl = -c / b;
      if (Number.isFinite(tl) && tl > 0 && tl <= maxT) t = tl;
    }
  } else {
    let disc = b * b - 4 * a * c;
    // 接する根（判別式 ≈ 0）が丸めで僅かに負になった場合を救う
    if (disc < 0 && disc >= -1e-12 * Math.max(b * b, Math.abs(4 * a * c))) disc = 0;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let t1: number;
      let t2: number;
      if (b === 0) {
        t1 = sq / (2 * a);
        t2 = -sq / (2 * a);
      } else {
        // 桁落ちを避ける安定な形
        const q = -0.5 * (b + Math.sign(b) * sq);
        t1 = q / a;
        t2 = q !== 0 ? c / q : Number.NaN;
      }
      const candidates = [t1, t2].filter((x) => Number.isFinite(x) && x > 0 && x <= maxT).sort((x, y) => x - y);
      if (candidates.length > 0) t = candidates[0];
    }
  }
  if (t === null) return null;

  const w = addScaled(r, v, t);
  const wLen = length(w);
  if (!Number.isFinite(wLen) || wLen <= 1e-12) return null;
  const direction: Vec3 = [w[0] / wLen, w[1] / wLen, w[2] / wLen];
  const residualMeters = Math.abs(wLen - speed * t);
  if (!isFinite3(direction) || !Number.isFinite(residualMeters) || residualMeters > MAX_RESIDUAL_METERS) return null;
  return { t, direction, residualMeters };
}
