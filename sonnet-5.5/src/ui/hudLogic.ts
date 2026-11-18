/**
 * HUD の表示ロジック(DOM非依存の純粋関数)。
 * GameState だけから表示値を作る。HUD専用の架空の値は作らない (SPEC §9)。
 * マーカー位置は sim/project.ts の projectToScreen (FCSの判定と同一の投影) を使う。
 */
import { ENEMIES, PLAYER, STAGE, WEAPONS } from '../config';
import { playerMuzzlePosition } from '../sim/camera';
import { distance } from '../sim/math';
import { projectToScreen } from '../sim/project';
import type { CameraState, EnemyState, GameState, SolutionStatus, V3, WeaponId } from '../sim/types';

/** UI専用の表示定数(ゲームロジックの数値ではない) */
export const HUD_CONST = {
  NOTICE_SECONDS: 1.6,
  DAMAGE_SHOW_SECONDS: 1.2,
  FLASH_SECONDS: 0.3,
  FLASH_MAX_ALPHA: 0.16,
  MESSAGE_SECONDS: 4,
  /**
   * 画面外矢印を置く端からの余白 [CSS px]。1280x720 (UI単位 u=12.24px) での値で、
   * 実際の余白は edgeInsetFor が解像度に合わせて拡大する。y は左下の武器パネル(下端から約10.6u)と
   * 左上のミッションパネル(上端から約7.4u)に矢印が重ならないだけの値。
   */
  EDGE_INSET: { x: 56, y: 144 },
  /** UI単位 u の式 (style.css の --u: clamp(12px, 1.7vmin, 32px) と同じ) */
  UNIT: { ratio: 0.017, min: 12, max: 32 },
  /** 同時に描く制御砲台マーカーの最大数 (次の目標を含む) */
  CONTROL_MARKERS_MAX: 3,
  /** マーカーのラベル同士が重なるとみなす範囲 [CSS px] と、重なったときにずらす量 */
  LABEL_BOX: { w: 150, h: 22 },
  /** 被弾方向ウェッジを置く半径 = この比率 × min(W,H) */
  DAMAGE_RING_RATIO: 0.42,
  /** 時刻比較の許容誤差 */
  EPS: 1e-9,
} as const;

// ---------------------------------------------------------------------------
// マーカー配置
// ---------------------------------------------------------------------------
export interface MarkerPlacement {
  /** ビューポート左上原点の CSS px */
  x: number;
  y: number;
  /** true: 画面内(x,yは対象の投影位置そのもの)。false: x,yは端の矢印位置 */
  onScreen: boolean;
  inFront: boolean;
  /** 矢印の向き[rad]。0=上, 正=時計回り (画面外のときのみ意味を持つ) */
  angle: number;
  depth: number;
}

/** CSS の --u と同じ UI 単位 [px] */
export function hudUnit(w: number, h: number): number {
  const u = HUD_CONST.UNIT;
  return Math.min(u.max, Math.max(u.min, u.ratio * Math.min(w, h)));
}

/** 解像度に合わせた画面外矢印の余白 (1280x720 で HUD_CONST.EDGE_INSET と一致) */
export function edgeInsetFor(w: number, h: number): { x: number; y: number } {
  const k = hudUnit(w, h) / hudUnit(1280, 720);
  return { x: HUD_CONST.EDGE_INSET.x * k, y: HUD_CONST.EDGE_INSET.y * k };
}

/** 世界座標 p の画面上の位置。画面外(背後含む)なら中心から見た方向の画面端に置く。ロックは解除しない(表示のみ)。 */
export function placeMarker(cam: CameraState, p: V3, inset: { x: number; y: number } = edgeInsetFor(cam.viewportW, cam.viewportH)): MarkerPlacement {
  const sp = projectToScreen(cam, p);
  const cx = cam.viewportW / 2;
  const cy = cam.viewportH / 2;
  if (sp.onScreen) return { x: cx + sp.x, y: cy + sp.y, onScreen: true, inFront: true, angle: 0, depth: sp.depth };
  let dx = sp.inFront ? sp.x : sp.camRight;
  let dy = sp.inFront ? sp.y : -sp.camUp;
  let len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) {
    dx = 0;
    dy = 1;
    len = 1;
  }
  dx /= len;
  dy /= len;
  const hx = Math.max(1, cx - inset.x);
  const hy = Math.max(1, cy - inset.y);
  const tx = Math.abs(dx) > 1e-9 ? hx / Math.abs(dx) : Number.MAX_VALUE;
  const ty = Math.abs(dy) > 1e-9 ? hy / Math.abs(dy) : Number.MAX_VALUE;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t, onScreen: false, inFront: sp.inFront, angle: Math.atan2(dx, -dy), depth: sp.depth };
}

// ---------------------------------------------------------------------------
// 方向 (カメラ基準の水平方位)
// ---------------------------------------------------------------------------
/** カメラ水平前方を0、右を正とする方位角[rad, -π..π]。水平成分が無ければ null */
export function bearingAngle(cam: CameraState, dir: V3): number | null {
  // カメラの right は常に水平単位ベクトル。水平前方 = (right.z, -right.x)
  const rx = cam.right.x;
  const rz = cam.right.z;
  const fx = rz;
  const fz = -rx;
  if (Math.hypot(dir.x, dir.z) < 1e-9) return null;
  return Math.atan2(dir.x * rx + dir.z * rz, dir.x * fx + dir.z * fz);
}

const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'] as const;
const BEARING_LABELS = ['前方', '右前', '右', '右後', '後方', '左後', '左', '左前'] as const;

export interface Bearing {
  angle: number;
  /** 8方位のインデックス 0=前方 1=右前 ... */
  index: number;
  label: string;
  arrow: string;
}

export function bearingOf(cam: CameraState, from: V3, to: V3): Bearing {
  const a = bearingAngle(cam, { x: to.x - from.x, y: 0, z: to.z - from.z });
  const angle = a ?? 0;
  const index = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  return { angle, index, label: BEARING_LABELS[index], arrow: ARROWS[index] };
}

export function verticalLabel(dy: number): string {
  if (dy > 4) return `上方${Math.round(dy)}m`;
  if (dy < -4) return `下方${Math.round(-dy)}m`;
  return '';
}

// ---------------------------------------------------------------------------
// 数値の整形 (表示は state の値から)
// ---------------------------------------------------------------------------
/** ENは切り捨て: 「36」と表示されたらQB可能な36以上であることを意味する */
export const fmtEn = (en: number): number => Math.max(0, Math.floor(en + 1e-6));
/** HPは切り上げ: 0表示は本当に0のときだけ */
export const fmtHp = (hp: number): number => Math.max(0, Math.ceil(hp - 1e-9));
export const fmtMeters = (m: number): string => `${Math.round(m)}m`;

export function formatTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// HUD モデル
// ---------------------------------------------------------------------------
export interface LockView {
  phase: 'none' | 'acquiring' | 'locked';
  /** 実際の判定円の半径 = state.lock.radiusCssPx */
  radius: number;
  progress: number;
  targetId: string | null;
  targetName: string | null;
  /** 円の上に出す文字 (none は空) */
  label: string;
  distance: number | null;
}

export interface AimView {
  status: 'solved' | 'no_solution';
  placement: MarkerPlacement;
  label: string;
  weapon: WeaponId;
}

export interface TargetView {
  id: string;
  placement: MarkerPlacement;
  distance: number;
  phase: 'acquiring' | 'locked';
  /** 制御砲台がロック対象のとき true (ラベルを対象マーカーに統合する) */
  isControl: boolean;
}

export interface ControlView {
  id: string;
  placement: MarkerPlacement;
  distance: number;
  bearing: Bearing;
  isNext: boolean;
}

export interface ControlMarkerView extends ControlView {
  /** ラベルを下へずらす量 [CSS px] (画面内で他のマーカーのラベルと重なるとき) */
  labelDy: number;
}

/**
 * 制御砲台マーカーの整理。全ての生存制御砲台を常時描くと、同じ方向の画面端に矢印とラベルが密集して読めない。
 * - 次の目標 (isNext) は必ず描く (先頭)。残りは近い順に、合計 max 個まで。
 * - 画面外の矢印は、既に置いた矢印・マーカーと重なる場合に縦へずらす (端の余白の範囲内)。
 * - 画面内のマーカーのラベルが重なる場合はラベルだけを下へずらす。
 * 位置は投影 (placeMarker) から得たもので、ずらすのは表示のみ (ロック判定には使わない)。
 */
export function layoutControlMarkers(controls: readonly ControlView[], w: number, h: number, max: number = HUD_CONST.CONTROL_MARKERS_MAX): ControlMarkerView[] {
  const picked = [...controls]
    .sort((a, b) => (a.isNext === b.isNext ? a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.isNext ? -1 : 1))
    .slice(0, Math.max(0, Math.floor(max)));
  const box = HUD_CONST.LABEL_BOX;
  const inset = edgeInsetFor(w, h);
  const lo = inset.y;
  const hi = h - inset.y;
  const placed: { x: number; y: number }[] = [];
  const hits = (x: number, y: number): boolean => placed.some((q) => Math.abs(q.x - x) < box.w && Math.abs(q.y - y) < box.h);
  const out: ControlMarkerView[] = [];
  for (const c of picked) {
    let pl = c.placement;
    let labelDy = 0;
    if (pl.onScreen) {
      for (let k = 0; k < picked.length && hits(pl.x, pl.y + labelDy); k++) labelDy += box.h;
    } else {
      // 元の位置 -> 下 -> 上 -> さらに下 ... の順に、端の余白内で他と重ならない y を探す
      let chosen = pl.y;
      for (let k = 0; k <= 2 * picked.length; k++) {
        const y = pl.y + (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * box.h;
        if (y < lo - 1e-6 || y > hi + 1e-6) continue;
        if (!hits(pl.x, y)) {
          chosen = y;
          break;
        }
      }
      if (chosen !== pl.y) pl = { ...pl, y: chosen };
    }
    placed.push({ x: pl.x, y: pl.y + labelDy });
    out.push({ ...c, placement: pl, labelDy });
  }
  return out;
}

export interface NextObjective {
  kind: 'control' | 'escape' | 'none';
  text: string;
  id: string | null;
  distance: number | null;
  arrow: string;
  bearingLabel: string;
  vertical: string;
}

export interface TelegraphView {
  id: string;
  placement: MarkerPlacement;
  progress: number;
  distance: number;
}

export interface DamageWedge {
  /** カメラ基準の方位[rad]。0=前方(画面上), 正=右 */
  angle: number;
  alpha: number;
}

export interface WeaponRow {
  id: WeaponId;
  key: string;
  name: string;
  ammoText: string;
  subText: string;
  selected: boolean;
  empty: boolean;
}

/** QB が今すぐ成立するなら READY。成立しない理由があれば、その理由 (待ち時間 / EN不足 / 左Ctrl押下中=ブレーキ) */
export type QbLabel = 'READY' | 'COOLDOWN' | 'EN不足' | 'BRAKE';

export interface MovementView {
  mode: 'WALK' | 'GLIDE' | 'QB';
  vertical: string;
  qb: QbLabel;
  qbText: string;
  /** 次のQBまでの残り時間[s] */
  qbCooldown: number;
  qbCost: number;
}

export interface NoticeView {
  kind: 'noLock' | 'noEn' | 'noAmmo' | 'noSolution';
  text: string;
  at: number;
}

export interface MissionView {
  sectorId: string | null;
  sectorName: string;
  visited: number;
  sectorCount: number;
  controlsDestroyed: number;
  controlsRequired: number;
  barriers: { id: string; open: boolean; label: string }[];
  gateOpen: boolean;
  gateText: string;
}

export interface HudModel {
  width: number;
  height: number;
  lock: LockView;
  target: TargetView | null;
  aim: AimView | null;
  /** ロック完了時の補正状態の文字 (未ロックは「補正: 待機」) */
  aimStatusText: string;
  controls: ControlView[];
  /** 実際に描く制御砲台マーカー (controls から整理したもの。layoutControlMarkers) */
  controlMarkers: ControlMarkerView[];
  escape: { placement: MarkerPlacement; distance: number } | null;
  next: NextObjective;
  telegraphs: TelegraphView[];
  wedges: DamageWedge[];
  flashAlpha: number;
  weapons: WeaponRow[];
  en: { value: number; max: number; ratio: number; low: boolean };
  hp: { value: number; max: number; ratio: number };
  movement: MovementView;
  mission: MissionView;
  notices: NoticeView[];
}

const WEAPON_KEYS: Record<WeaponId, string> = { machinegun: '1', beam: '2', missile: '3' };

function weaponRows(state: GameState): WeaponRow[] {
  const p = state.player;
  const mgMax = WEAPONS.machinegun.totalAmmo;
  const msMax = WEAPONS.missile.totalAmmo;
  return [
    {
      id: 'machinegun',
      key: WEAPON_KEYS.machinegun,
      name: WEAPONS.machinegun.name,
      ammoText: `${p.ammo.machinegun}/${mgMax}`,
      subText: p.ammo.machinegun <= 0 ? '弾切れ' : '',
      selected: p.weapon === 'machinegun',
      empty: p.ammo.machinegun <= 0,
    },
    {
      id: 'beam',
      key: WEAPON_KEYS.beam,
      name: WEAPONS.beam.name,
      ammoText: '弾数無制限',
      subText: `1射 ${WEAPONS.beam.enCost} EN`,
      selected: p.weapon === 'beam',
      empty: false,
    },
    {
      id: 'missile',
      key: WEAPON_KEYS.missile,
      name: WEAPONS.missile.name,
      ammoText: `${p.ammo.missile}/${msMax}`,
      subText: p.ammo.missile <= 0 ? '弾切れ' : 'ロック必須',
      selected: p.weapon === 'missile',
      empty: p.ammo.missile <= 0,
    },
  ];
}

const VERTICAL_LABEL = { grounded: '接地', rising: '上昇', flying: '飛行', falling: '落下' } as const;

function movementView(state: GameState): MovementView {
  const mv = state.player.mv;
  const cd = mv.qbCooldownRemaining > HUD_CONST.EPS ? mv.qbCooldownRemaining : 0;
  const lackEn = state.player.en < PLAYER.QB.COST - HUD_CONST.EPS;
  let qb: QbLabel = 'READY';
  let qbText = 'READY';
  if (cd > 0) {
    qb = 'COOLDOWN';
    qbText = `COOLDOWN ${cd.toFixed(1)}s`;
  } else if (lackEn) {
    qb = 'EN不足';
    qbText = 'EN不足';
  } else if (state.input.ctrl) {
    // SPEC §7.3: 左Ctrlを押している間の新しいQB要求は不成立 (ENも予約も無し)。READY と出すと実際の挙動と食い違う
    qb = 'BRAKE';
    qbText = 'BRAKE Ctrl解除';
  }
  const mode = mv.horizontalMode === 'quickboost' ? 'QB' : mv.horizontalMode === 'glide' ? 'GLIDE' : 'WALK';
  return { mode, vertical: VERTICAL_LABEL[mv.verticalMode], qb, qbText, qbCooldown: cd, qbCost: PLAYER.QB.COST };
}

function noticeViews(state: GameState): NoticeView[] {
  const n = state.notices;
  const t = state.time;
  const out: NoticeView[] = [];
  const add = (kind: NoticeView['kind'], at: number | null, text: string): void => {
    if (at === null) return;
    const age = t - at;
    if (age >= -HUD_CONST.EPS && age < HUD_CONST.NOTICE_SECONDS) out.push({ kind, text, at });
  };
  add('noLock', n.noLockAt, 'NO LOCK  未ロックのためミサイルは発射できません');
  add('noEn', n.noEnAt, 'EN不足');
  add('noAmmo', n.noAmmoAt, '弾切れ');
  add('noSolution', n.noSolutionAt, '補正解なし  現在位置へ直接照準');
  out.sort((a, b) => b.at - a.at);
  return out;
}

function findEnemy(state: GameState, id: string | null): EnemyState | undefined {
  if (id === null) return undefined;
  return state.enemies.find((e) => e.id === id);
}

function aimStatusLabel(status: SolutionStatus, weapon: WeaponId): string {
  if (status === 'no_solution') return '補正解なし';
  if (status === 'solved') {
    if (weapon === 'machinegun') return '補正中 偏差+重力';
    if (weapon === 'beam') return '補正中 現在位置';
    return '補正中 偏差';
  }
  return '補正待機';
}

function boxCenter(b: { min: V3; max: V3 }): V3 {
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
}

export function buildHudModel(state: GameState): HudModel {
  const cam = state.camera;
  const p = state.player;
  const muzzle = playerMuzzlePosition(p);

  // ---- FCS ロック (判定円は state.lock.radiusCssPx そのもの)
  const lockEnemy = state.lock.state === 'none' ? undefined : findEnemy(state, state.lock.targetId);
  const phase = lockEnemy && lockEnemy.alive ? state.lock.state : 'none';
  const lockDistance = lockEnemy && phase !== 'none' ? distance(muzzle, lockEnemy.pos) : null;
  const pct = Math.max(0, Math.min(100, Math.floor(state.lock.progress * 100 + 1e-6)));
  const lock: LockView = {
    phase,
    radius: state.lock.radiusCssPx,
    progress: phase === 'none' ? 0 : state.lock.progress,
    targetId: phase === 'none' ? null : state.lock.targetId,
    targetName: lockEnemy && phase !== 'none' ? ENEMIES[lockEnemy.kind].name : null,
    label: phase === 'acquiring' ? `LOCKING ${pct}%` : phase === 'locked' ? 'LOCKED' : '',
    distance: lockDistance,
  };

  const target: TargetView | null =
    lockEnemy && phase !== 'none'
      ? { id: lockEnemy.id, placement: placeMarker(cam, lockEnemy.pos), distance: lockDistance ?? 0, phase, isControl: lockEnemy.controlIndex !== null }
      : null;

  // ---- 補正照準マーカー (ロック完了かつ同一対象の補正解があるときだけ)
  let aim: AimView | null = null;
  let aimStatusText = '待機';
  if (phase === 'locked') {
    const fc = state.fc;
    aimStatusText = fc.targetId === state.lock.targetId ? aimStatusLabel(fc.status, fc.weapon) : '補正待機';
    if (fc.targetId === state.lock.targetId && fc.aimPoint && (fc.status === 'solved' || fc.status === 'no_solution')) {
      aim = { status: fc.status, placement: placeMarker(cam, fc.aimPoint), label: aimStatusText, weapon: fc.weapon };
    }
  }

  // ---- 制御砲台 / 次の目標
  const aliveControls = state.enemies.filter((e) => e.alive && e.controlIndex !== null);
  let nextId: string | null = null;
  let nextIdx = Infinity;
  for (const e of aliveControls) {
    if ((e.controlIndex as number) < nextIdx) {
      nextIdx = e.controlIndex as number;
      nextId = e.id;
    }
  }
  const controls: ControlView[] = aliveControls.map((e) => ({
    id: e.id,
    placement: placeMarker(cam, e.pos),
    distance: distance(p.pos, e.pos),
    bearing: bearingOf(cam, p.pos, e.pos),
    isNext: e.id === nextId,
  }));

  const escapeCenter = boxCenter(state.stage.escapeZone);
  const escape = state.objective.gateOpen
    ? { placement: placeMarker(cam, escapeCenter), distance: distance(p.pos, escapeCenter) }
    : null;

  let next: NextObjective = { kind: 'none', text: '次の目標: なし', id: null, distance: null, arrow: '', bearingLabel: '', vertical: '' };
  const nextEnemy = findEnemy(state, nextId);
  if (nextEnemy) {
    const b = bearingOf(cam, p.pos, nextEnemy.pos);
    const barrier = state.stage.barriers.find((x) => x.controlEnemyId === nextEnemy.id);
    next = {
      kind: 'control',
      text: `次の目標: 制御砲台 ${nextEnemy.id} を破壊${barrier ? ` (${barrier.label})` : ''}`,
      id: nextEnemy.id,
      distance: distance(p.pos, nextEnemy.pos),
      arrow: b.arrow,
      bearingLabel: b.label,
      vertical: verticalLabel(nextEnemy.pos.y - p.pos.y),
    };
  } else if (state.objective.gateOpen) {
    const b = bearingOf(cam, p.pos, escapeCenter);
    next = {
      kind: 'escape',
      text: '次の目標: 最終ゲートから脱出領域へ',
      id: null,
      distance: distance(p.pos, escapeCenter),
      arrow: b.arrow,
      bearingLabel: b.label,
      vertical: verticalLabel(escapeCenter.y - p.pos.y),
    };
  }

  // ---- 射撃予告 (telegraphing中の敵)
  const telegraphs: TelegraphView[] = [];
  for (const e of state.enemies) {
    if (!e.alive || !(e.telegraph > 0)) continue;
    telegraphs.push({ id: e.id, placement: placeMarker(cam, e.pos), progress: Math.min(1, e.telegraph), distance: distance(p.pos, e.pos) });
  }

  // ---- 被弾方向 (カメラ基準) と控えめな赤フラッシュ
  const wedges: DamageWedge[] = [];
  let flashAlpha = 0;
  for (const ind of state.damageIndicators) {
    const age = state.time - ind.time;
    if (age < -HUD_CONST.EPS || age >= HUD_CONST.DAMAGE_SHOW_SECONDS) continue;
    const a = bearingAngle(cam, ind.dirToSource);
    const fade = 1 - Math.max(0, age) / HUD_CONST.DAMAGE_SHOW_SECONDS;
    if (a !== null) wedges.push({ angle: a, alpha: 0.35 + 0.65 * fade });
    if (age < HUD_CONST.FLASH_SECONDS) {
      const f = HUD_CONST.FLASH_MAX_ALPHA * (1 - Math.max(0, age) / HUD_CONST.FLASH_SECONDS);
      if (f > flashAlpha) flashAlpha = f;
    }
  }

  // ---- EN / HP
  const maxEn = state.stats.maxEn;
  const enRatio = maxEn > 0 ? Math.max(0, Math.min(1, p.en / maxEn)) : 0;
  const hpRatio = Math.max(0, Math.min(1, p.hp / PLAYER.MAX_HP));

  // ---- ミッション
  const sector = state.stage.sectors.find((s) => s.id === state.progress.currentSectorId);
  const mission: MissionView = {
    sectorId: state.progress.currentSectorId,
    sectorName: sector ? sector.name : '---',
    visited: state.progress.visitedSectorIds.length,
    sectorCount: state.stage.sectors.length,
    controlsDestroyed: state.objective.controlsDestroyed,
    controlsRequired: STAGE.CONTROLS_REQUIRED,
    barriers: state.stage.barriers
      .filter((b) => !b.isFinal)
      .map((b) => ({ id: b.id, open: state.objective.openBarrierIds.includes(b.id), label: b.label })),
    gateOpen: state.objective.gateOpen,
    gateText: state.objective.gateOpen ? '最終ゲート開放 - 脱出可能' : '最終ゲート 閉鎖中',
  };

  return {
    width: cam.viewportW,
    height: cam.viewportH,
    lock,
    target,
    aim,
    aimStatusText,
    controls,
    controlMarkers: layoutControlMarkers(controls, cam.viewportW, cam.viewportH),
    escape,
    next,
    telegraphs,
    wedges,
    flashAlpha,
    weapons: weaponRows(state),
    en: { value: fmtEn(p.en), max: maxEn, ratio: enRatio, low: p.en < PLAYER.QB.COST - HUD_CONST.EPS },
    hp: { value: fmtHp(p.hp), max: PLAYER.MAX_HP, ratio: hpRatio },
    movement: movementView(state),
    mission,
    notices: noticeViews(state),
  };
}

// ---------------------------------------------------------------------------
// 一時メッセージ (隔壁開放・最終ゲート開放): 状態の変化から作る。時刻は state.time なので一時停止中は進まない。
// ---------------------------------------------------------------------------
export interface HudMessage {
  text: string;
  kind: 'barrier' | 'gate';
  until: number;
}

export class HudMessages {
  private ref: GameState | null = null;
  private lastTime = 0;
  private barriers = new Set<string>();
  private gate = false;
  private msgs: HudMessage[] = [];

  update(state: GameState): HudMessage[] {
    if (this.ref !== state || state.time < this.lastTime - HUD_CONST.EPS) {
      // 新しい出撃(state差し替え): 現在の状態を既知として履歴を初期化
      this.ref = state;
      this.barriers = new Set(state.objective.openBarrierIds);
      this.gate = state.objective.gateOpen;
      this.msgs = [];
    } else {
      for (const id of state.objective.openBarrierIds) {
        if (this.barriers.has(id)) continue;
        this.barriers.add(id);
        const b = state.stage.barriers.find((x) => x.id === id);
        this.msgs.push({ text: `隔壁 ${id} 開放${b ? `: ${b.label}` : ''}`, kind: 'barrier', until: state.time + HUD_CONST.MESSAGE_SECONDS });
      }
      if (state.objective.gateOpen && !this.gate) {
        this.gate = true;
        this.msgs.push({ text: '最終搬出ゲート開放 - 脱出せよ', kind: 'gate', until: state.time + HUD_CONST.MESSAGE_SECONDS });
      }
    }
    this.lastTime = state.time;
    this.msgs = this.msgs.filter((m) => state.time < m.until - HUD_CONST.EPS);
    return this.msgs;
  }
}

// ---------------------------------------------------------------------------
// 結果画面
// ---------------------------------------------------------------------------
export interface ResultModel {
  cleared: boolean;
  title: string;
  reason: string;
  rows: { label: string; value: string }[];
}

export function buildResultModel(state: GameState): ResultModel {
  const cleared = state.mode === 'cleared';
  let reason = '';
  if (state.endReason === 'escaped' || (cleared && state.endReason === null)) reason = '工場からの脱出に成功しました';
  else if (state.endReason === 'hp') reason = '機体が大破しました (HP 0)';
  else if (state.endReason === 'fall') reason = 'ステージ外へ転落しました';
  return {
    cleared,
    title: cleared ? 'MISSION CLEAR' : 'MISSION FAILED',
    reason,
    rows: [
      { label: '経過時間', value: formatTime(state.time) },
      { label: '撃破数', value: `${state.killCount} / ${state.enemies.length}` },
      { label: '制御砲台', value: `${state.objective.controlsDestroyed} / ${STAGE.CONTROLS_REQUIRED}` },
      { label: '被ダメージ', value: `${Math.round(state.damageTaken)}` },
      { label: '通過区画数', value: `${state.progress.visitedSectorIds.length} / ${state.stage.sectors.length}` },
    ],
  };
}
