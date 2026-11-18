/**
 * 戦闘中 HUD（純粋な DOM + CSS）。
 * 全ての値は HudView（main が Game から組み立てる）と src/params.ts から取り、UI 専用の数値を持たない。
 * - 中央: FCS ロック円（半径 = view.lock.radiusCssPx [CSS px]。判定円と一致）、照準点、ロック状態の文字
 * - マーカー: 対象 [ ]、補正照準 ◇（補正中/解なし）、予告 !、制御砲台、目標方向。画面外は端の矢印
 * - 左: 武器と残弾、右: EN と移動モード、下: HP、上: 目標。発射拒否トースト、被弾方向インジケーター
 * DOM ノードはキャッシュし、文字列は変化したときだけ更新する。マーカーの位置は transform で指定する。
 */
import { GENERATORS, LEGS, OBJECTIVE, PLAYER, WEAPONS } from '../params';
import type { FireDenialReason, HudView, LockState, ScreenMarker, Weapon } from '../types';
import { splitMinutesTenths } from './overlays';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 発射拒否トーストの表示時間 [s] */
const DENIAL_TOAST_SECONDS = 1.5;
/** 被弾インジケーターの表示時間 [s]（ageSeconds 0→1 で消える） */
const HIT_INDICATOR_SECONDS = 1.0;
/** 被弾時の画面端の縁取りが消えるまでの時間 [s] */
const HIT_VIGNETTE_SECONDS = 0.35;
/** 被弾くさびの角度半幅 [rad] */
const HIT_WEDGE_HALF_ANGLE = 0.28;
/** 画面外マーカーの端からの余白 [px] */
const EDGE_MARGIN = 44;
/** 発射拒否トーストの高さの見積もり [px]（styles.css: 16px 文字 + 上下 6px 余白 + 枠）。ロック文字との重なり回避に使う */
const TOAST_HEIGHT_PX = 34;
/** 発射拒否トーストの中心からの最小オフセット [px]（照準点 ±7px の下） */
const TOAST_MIN_TOP_PX = 36;
/** 定常グライド速度に対し、これを超えていれば慣性減速中とみなす倍率 */
const GLIDE_DECEL_RATIO = 1.05;
/** HP バーの警告閾値（割合） */
const HP_AMBER_RATIO = 0.5;
const HP_RED_RATIO = 0.25;

const WEAPON_ORDER: Weapon[] = ['machinegun', 'beam', 'missile'];
const WEAPON_LABEL: Record<Weapon, string> = { machinegun: 'マシンガン', beam: 'ビーム', missile: 'ハンドミサイル' };
const WEAPON_KEY: Record<Weapon, string> = { machinegun: '1', beam: '2', missile: '3' };
const DENIAL_LABEL: Record<FireDenialReason, string> = {
  noAmmo: '弾切れ',
  noEn: 'EN不足',
  noLock: 'ロック未完了のため発射拒否',
};
const VERTICAL_LABEL: Record<HudView['movement']['verticalMode'], string> = {
  grounded: '接地',
  rising: '上昇',
  flying: '飛行',
  falling: '落下',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: Element): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (parent) parent.appendChild(e);
  return e;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  if (parent) parent.appendChild(e);
  return e;
}

/** 文字列が変わったときだけ textContent を書き換える */
class Txt {
  private last = '';
  constructor(readonly el: HTMLElement, initial = '') {
    if (initial) this.set(initial);
  }
  set(s: string): void {
    if (s === this.last) return;
    this.last = s;
    this.el.textContent = s;
  }
}

/** class の有無を変化時だけ書き換える */
function setClass(e: Element, name: string, on: boolean): void {
  if (e.classList.contains(name) !== on) e.classList.toggle(name, on);
}

function setAttr(e: Element, name: string, value: string): void {
  if (e.getAttribute(name) !== value) e.setAttribute(name, value);
}

function formatTime(sec: number): string {
  const { minutes, seconds } = splitMinutesTenths(sec);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

/**
 * 脚部の水平移動速度倍率を HudView から推定する。
 * HudView は脚部を持たないが、最大EN がジェネレーターを一意に決め、回復率 = 基本回復率 × 脚部回復倍率で
 * 脚部が決まる（params.ts の 3×2 構成で一意）。判別できなければ 1.0（2脚）として扱う。
 */
export function inferHorizontalSpeedMultiplier(view: Pick<HudView, 'maxEn' | 'regenPerSecond'>): number {
  const gen = Object.values(GENERATORS).find((g) => Math.abs(g.maxEn - view.maxEn) < 1e-6);
  if (!gen) return 1;
  for (const legs of Object.values(LEGS)) {
    if (Math.abs(gen.regen * legs.regenMul - view.regenPerSecond) < 1e-6) return legs.speedMul;
  }
  return 1;
}

/** 画面中心から角度 angle（右=0、下=+π/2）へ伸ばした半直線と、余白 margin を残した画面矩形の交点 */
function edgePoint(angle: number, w: number, h: number, margin: number): { x: number; y: number } {
  const cx = w / 2;
  const cy = h / 2;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const hw = Math.max(1, w / 2 - margin);
  const hh = Math.max(1, h / 2 - margin);
  const tx = Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const ty = Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * 画面上のマーカー 1 個。画面内では形（shape）＋ラベル、画面外では端の矢印＋ラベル。
 * 位置は transform: translate() で指定する。
 */
/** 敵 ID 't02' → 表示名 'T-02'（ステージの目標説明と表記を揃える） */
export function formatTurretId(id: string): string {
  const m = /^t(\d+)$/.exec(id);
  return m ? `T-${m[1]}` : id;
}

class Marker {
  readonly root: HTMLDivElement;
  private readonly arrow: HTMLDivElement;
  private readonly arrowGlyph: HTMLSpanElement;
  private readonly label: Txt;
  private lastTransform = '';
  private lastArrowTransform = '';
  private visible = false;
  private offscreen = false;

  constructor(layer: HTMLElement, kindClass: string) {
    this.root = el('div', `ak2-marker ${kindClass}`, layer);
    this.root.style.display = 'none';
    el('div', 'ak2-marker-shape', this.root);
    this.arrow = el('div', 'ak2-marker-arrow', this.root);
    this.arrowGlyph = el('span', '', this.arrow);
    this.arrowGlyph.textContent = '▶';
    this.label = new Txt(el('div', 'ak2-marker-label', this.root));
  }

  show(m: ScreenMarker, label: string, w: number, h: number): void {
    if (!this.visible) {
      this.visible = true;
      this.root.style.display = '';
    }
    let x = m.x;
    let y = m.y;
    const off = !m.onScreen;
    if (off) {
      const p = edgePoint(m.angle, w, h, EDGE_MARGIN);
      x = p.x;
      y = p.y;
      const at = `rotate(${((m.angle * 180) / Math.PI).toFixed(1)}deg)`;
      if (at !== this.lastArrowTransform) {
        this.lastArrowTransform = at;
        this.arrow.style.transform = at;
      }
    }
    if (off !== this.offscreen) {
      this.offscreen = off;
      setClass(this.root, 'offscreen', off);
    }
    const t = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    if (t !== this.lastTransform) {
      this.lastTransform = t;
      this.root.style.transform = t;
    }
    this.label.set(label);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.style.display = 'none';
  }
}

/** 同種マーカーのプール（予告・制御砲台など個数が変わるもの） */
class MarkerPool {
  private readonly items: Marker[] = [];
  private used = 0;
  constructor(private readonly layer: HTMLElement, private readonly kindClass: string) {}

  begin(): void {
    this.used = 0;
  }

  next(): Marker {
    let m = this.items[this.used];
    if (!m) {
      m = new Marker(this.layer, this.kindClass);
      this.items.push(m);
    }
    this.used++;
    return m;
  }

  end(): void {
    for (let i = this.used; i < this.items.length; i++) this.items[i].hide();
  }
}

export class Hud {
  private readonly root: HTMLDivElement;
  private visible = true;

  // 中央
  private readonly center: HTMLDivElement;
  private readonly lockSvg: SVGSVGElement;
  private readonly lockBase: SVGCircleElement;
  private readonly lockProgress: SVGCircleElement;
  private readonly lockSolid: SVGCircleElement;
  private readonly crosshair: HTMLDivElement;
  private readonly lockTextEl: HTMLDivElement;
  private readonly lockMain: Txt;
  private readonly lockSub: Txt;
  private lastRadius = -1;
  private lastLockState: LockState | null = null;
  private lastProgressDash = '';

  // マーカー
  private readonly markerLayer: HTMLDivElement;
  private readonly targetMarker: Marker;
  private readonly aimMarker: Marker;
  private readonly objectiveMarker: Marker;
  private readonly telegraphPool: MarkerPool;
  private readonly controlPool: MarkerPool;
  private lastAimNoSolution: boolean | null = null;
  private lastTargetLocked: boolean | null = null;

  // 被弾
  private readonly vignette: HTMLDivElement;
  private lastVignetteOpacity = -1;
  private readonly hitSvg: SVGSVGElement;
  private readonly hitPaths: SVGPathElement[] = [];
  private lastHitRadius = -1;

  // 左: 武器
  private readonly weaponRows: Record<Weapon, { row: HTMLDivElement; ammo: Txt; ammoEl: HTMLSpanElement }>;
  private lastWeapon: Weapon | null = null;

  // 右: EN
  private readonly enValue: Txt;
  private readonly enBar: HTMLDivElement;
  private readonly enSub: Txt;
  private lastEnScale = '';

  // 右: 移動
  private readonly moveMode: Txt;
  private readonly moveVertical: Txt;
  private readonly qbLine: HTMLDivElement;
  private readonly qbValue: Txt;
  private lastQbClass = '';
  private readonly speedValue: Txt;

  // 下: HP
  private readonly hpPanel: HTMLDivElement;
  private readonly hpValue: Txt;
  private readonly hpBar: HTMLDivElement;
  private readonly hpState: Txt;
  private lastHpScale = '';
  private lastHpClass = '';

  // 上: 目標
  private readonly objSector: Txt;
  private readonly objNext: Txt;
  private readonly objControls: Txt;
  private readonly objGate: HTMLSpanElement;
  private readonly objGateTxt: Txt;
  private readonly objEnemies: Txt;
  private readonly objTime: Txt;
  private readonly objBarriers: Txt;
  private readonly objRecent: Txt;

  // トースト
  private readonly toast: HTMLDivElement;
  private readonly toastTxt: Txt;
  private toastShown = false;

  constructor(container: HTMLElement) {
    this.root = el('div', 'ak2-hud', container);

    // 被弾の縁取り（最背面）
    this.vignette = el('div', 'ak2-hud-vignette', this.root);
    this.vignette.style.opacity = '0';

    // マーカー層
    this.markerLayer = el('div', 'ak2-hud-layer', this.root);

    // 中央: ロック円
    this.center = el('div', 'ak2-hud-center', this.root);
    this.lockSvg = svg('svg', this.center);
    this.lockSvg.setAttribute('class', 'ak2-lock-svg');
    this.lockSvg.setAttribute('data-state', 'none');
    this.lockBase = svg('circle', this.lockSvg);
    this.lockBase.setAttribute('class', 'ak2-lock-base');
    this.lockProgress = svg('circle', this.lockSvg);
    this.lockProgress.setAttribute('class', 'ak2-lock-progress');
    this.lockSolid = svg('circle', this.lockSvg);
    this.lockSolid.setAttribute('class', 'ak2-lock-solid');
    // 被弾くさび（中央基準の SVG）
    this.hitSvg = svg('svg', this.center);
    this.hitSvg.setAttribute('class', 'ak2-hit-svg');
    // 照準点
    this.crosshair = el('div', 'ak2-crosshair', this.center);
    const lh = el('div', 'ak2-crosshair-line h', this.crosshair);
    lh.style.left = '-7px';
    const lv = el('div', 'ak2-crosshair-line v', this.crosshair);
    lv.style.top = '-7px';
    // ロック文字
    this.lockTextEl = el('div', 'ak2-lock-text', this.center);
    this.lockTextEl.setAttribute('data-state', 'none');
    this.lockMain = new Txt(el('span', '', this.lockTextEl));
    this.lockSub = new Txt(el('span', 'ak2-lock-sub', this.lockTextEl));

    // マーカー
    this.targetMarker = new Marker(this.markerLayer, 'ak2-marker-target');
    this.aimMarker = new Marker(this.markerLayer, 'ak2-marker-aim');
    this.objectiveMarker = new Marker(this.markerLayer, 'ak2-marker-objective');
    this.telegraphPool = new MarkerPool(this.markerLayer, 'ak2-marker-telegraph');
    this.controlPool = new MarkerPool(this.markerLayer, 'ak2-marker-control');

    // 左: 武器
    const weaponPanel = el('div', 'ak2-panel ak2-weapon', this.root);
    new Txt(el('div', 'ak2-panel-title', weaponPanel), '武器');
    const rows = {} as Record<Weapon, { row: HTMLDivElement; ammo: Txt; ammoEl: HTMLSpanElement }>;
    for (const w of WEAPON_ORDER) {
      const row = el('div', 'ak2-weapon-row', weaponPanel);
      new Txt(el('span', 'ak2-weapon-key ak2-num', row), WEAPON_KEY[w]);
      new Txt(el('span', 'ak2-weapon-name', row), WEAPON_LABEL[w]);
      const ammoEl = el('span', 'ak2-weapon-ammo ak2-num', row);
      rows[w] = { row, ammo: new Txt(ammoEl), ammoEl };
    }
    this.weaponRows = rows;

    // 右: EN
    const enPanel = el('div', 'ak2-panel ak2-en', this.root);
    new Txt(el('div', 'ak2-panel-title', enPanel), 'EN');
    this.enValue = new Txt(el('div', 'ak2-en-value ak2-num', enPanel));
    const enBarWrap = el('div', 'ak2-bar', enPanel);
    this.enBar = el('div', 'ak2-bar-fill', enBarWrap);
    this.enSub = new Txt(el('div', 'ak2-en-sub ak2-num', enPanel));

    // 右: 移動
    const movePanel = el('div', 'ak2-panel ak2-move', this.root);
    new Txt(el('div', 'ak2-panel-title', movePanel), '移動');
    const mkLine = (key: string, cls = ''): { line: HTMLDivElement; v: Txt } => {
      const line = el('div', `ak2-move-line ${cls}`.trim(), movePanel);
      new Txt(el('span', 'k', line), key);
      const v = new Txt(el('span', 'v ak2-num', line));
      return { line, v };
    };
    this.moveMode = mkLine('水平').v;
    this.moveVertical = mkLine('垂直').v;
    const qb = mkLine('QB', 'qb');
    this.qbLine = qb.line;
    this.qbValue = qb.v;
    this.speedValue = mkLine('速度').v;

    // 下: HP
    this.hpPanel = el('div', 'ak2-panel ak2-hp', this.root);
    this.hpValue = new Txt(el('div', 'ak2-hp-value ak2-num', this.hpPanel));
    const hpBarWrap = el('div', 'ak2-bar', this.hpPanel);
    this.hpBar = el('div', 'ak2-bar-fill', hpBarWrap);
    this.hpState = new Txt(el('div', 'ak2-hp-state', this.hpPanel));

    // 上: 目標
    const objPanel = el('div', 'ak2-panel ak2-objective', this.root);
    this.objSector = new Txt(el('div', 'ak2-obj-sector', objPanel));
    this.objNext = new Txt(el('div', 'ak2-obj-next', objPanel));
    const row = el('div', 'ak2-obj-row ak2-num', objPanel);
    this.objControls = new Txt(el('span', '', row));
    this.objGate = el('span', 'gate', row);
    this.objGateTxt = new Txt(this.objGate);
    this.objEnemies = new Txt(el('span', '', row));
    this.objTime = new Txt(el('span', '', row));
    this.objBarriers = new Txt(el('div', 'ak2-obj-barriers', objPanel));
    this.objRecent = new Txt(el('div', 'ak2-obj-recent', objPanel));

    // トースト（発射拒否）: ロック円の内側・照準点の下に置き、円の下のロック文字と重ならないようにする
    this.toast = el('div', 'ak2-toast', this.center);
    this.toast.style.top = `${TOAST_MIN_TOP_PX}px`;
    this.toastTxt = new Txt(this.toast);
  }

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
  }

  update(view: HudView): void {
    if (!this.visible) return;
    const w = view.viewportWidth;
    const h = view.viewportHeight;
    this.updateLock(view);
    this.updateMarkers(view, w, h);
    this.updateHits(view);
    this.updateWeapons(view);
    this.updateEn(view);
    this.updateMovement(view);
    this.updateHp(view);
    this.updateObjective(view);
    this.updateToast(view);
  }

  // -------------------------------------------------------------- 中央

  private updateLock(view: HudView): void {
    // NaN/Infinity は上流の不具合なので属性へ書き込まず、直前の正常な半径（無ければ 0）を保つ
    const raw = view.lock.radiusCssPx;
    const r = Number.isFinite(raw) ? Math.max(0, raw) : this.lastRadius >= 0 ? this.lastRadius : 0;
    const strokePad = 4;
    if (r !== this.lastRadius) {
      this.lastRadius = r;
      const size = 2 * r + strokePad * 2;
      const c = size / 2;
      // SVG は中心ブロック（0×0）の中央に置く
      this.lockSvg.setAttribute('width', String(size));
      this.lockSvg.setAttribute('height', String(size));
      this.lockSvg.setAttribute('viewBox', `0 0 ${size} ${size}`);
      this.lockSvg.style.transform = `translate(${-c}px, ${-c}px)`;
      for (const circle of [this.lockBase, this.lockProgress, this.lockSolid]) {
        circle.setAttribute('cx', String(c));
        circle.setAttribute('cy', String(c));
        circle.setAttribute('r', String(r));
      }
      // 進捗弧は 12 時から時計回りに伸びる
      this.lockProgress.setAttribute('transform', `rotate(-90 ${c} ${c})`);
      this.lastProgressDash = '';
      // ロック文字は円の下
      this.lockTextEl.style.top = `${r + 10}px`;
      // トーストは照準点の下・ロック文字の上（円の内側）。半径が小さいときは照準点直下に寄せる
      const toastTop = Math.min(Math.max(TOAST_MIN_TOP_PX, r * 0.5), Math.max(TOAST_MIN_TOP_PX, r + 10 - TOAST_HEIGHT_PX - 2));
      this.toast.style.top = `${toastTop.toFixed(0)}px`;
    }

    const st = view.lock.state;
    if (st !== this.lastLockState) {
      this.lastLockState = st;
      setAttr(this.lockSvg, 'data-state', st);
      setAttr(this.lockTextEl, 'data-state', st);
    }
    if (st === 'acquiring') {
      const circ = 2 * Math.PI * r;
      const p = Math.min(1, Math.max(0, view.lock.progress));
      const dash = `${(circ * p).toFixed(2)} ${circ.toFixed(2)}`;
      if (dash !== this.lastProgressDash) {
        this.lastProgressDash = dash;
        this.lockProgress.setAttribute('stroke-dasharray', dash);
      }
      this.lockMain.set(`LOCK ${Math.floor(p * 100)}%`);
      this.lockSub.set(`${view.lock.targetId ?? ''}  残り ${Math.max(0, (1 - p) * view.lock.lockSeconds).toFixed(2)} s`);
    } else if (st === 'locked') {
      const fc = view.fireControl;
      let dist = '';
      if (fc.targetPosition && fc.muzzlePosition) {
        const d = Math.hypot(
          fc.targetPosition[0] - fc.muzzlePosition[0],
          fc.targetPosition[1] - fc.muzzlePosition[1],
          fc.targetPosition[2] - fc.muzzlePosition[2],
        );
        dist = ` ${d.toFixed(0)} m`;
      }
      this.lockMain.set(`LOCKED ${view.lock.targetId ?? ''}${dist}`);
      const sol =
        fc.status === 'solved'
          ? view.weapon === 'missile'
            ? '補正中（初期偏差）'
            : view.weapon === 'beam'
              ? '補正中（現在位置へ即時命中）'
              : '補正中（偏差＋重力）'
          : fc.status === 'no_solution'
            ? '補正解なし（現在位置へ直接照準）'
            : '';
      this.lockSub.set(sol);
    } else {
      this.lockMain.set('FCS 未取得');
      this.lockSub.set('');
    }
  }

  // ---------------------------------------------------------- マーカー

  private updateMarkers(view: HudView, w: number, h: number): void {
    const tm = view.targetMarker;
    if (tm) {
      const locked = view.lock.state === 'locked';
      if (locked !== this.lastTargetLocked) {
        this.lastTargetLocked = locked;
        setClass(this.targetMarker.root, 'locked', locked);
      }
      this.targetMarker.show(tm, `対象 ${view.lock.targetId ?? ''}`.trim(), w, h);
    } else {
      this.targetMarker.hide();
    }

    const am = view.aimMarker;
    if (am) {
      const noSol = am.status === 'no_solution';
      if (noSol !== this.lastAimNoSolution) {
        this.lastAimNoSolution = noSol;
        setClass(this.aimMarker.root, 'no-solution', noSol);
      }
      const label = noSol ? '解なし' : view.weapon === 'missile' ? '補正 初期偏差' : '補正中';
      this.aimMarker.show(am, label, w, h);
    } else {
      this.aimMarker.hide();
    }

    this.telegraphPool.begin();
    for (const m of view.telegraphMarkers) this.telegraphPool.next().show(m, '!', w, h);
    this.telegraphPool.end();

    this.controlPool.begin();
    for (const m of view.controlTurretMarkers) {
      const mk = this.controlPool.next();
      setClass(mk.root, 'dead', !m.alive);
      const label = formatTurretId(m.id);
      mk.show(m, m.alive ? `制御 ${label}` : `制御 ${label} 破壊済`, w, h);
    }
    this.controlPool.end();

    const om = view.objectiveMarker;
    if (om) this.objectiveMarker.show(om, om.label, w, h);
    else this.objectiveMarker.hide();
  }

  // ------------------------------------------------------------ 被弾

  private updateHits(view: HudView): void {
    const inds = view.hitIndicators;
    // 円の外側にくさびを描く
    const R = Math.max(70, this.lastRadius + 26);
    if (R !== this.lastHitRadius) {
      this.lastHitRadius = R;
      const size = 2 * R + 24;
      this.hitSvg.setAttribute('width', String(size));
      this.hitSvg.setAttribute('height', String(size));
      this.hitSvg.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`);
      this.hitSvg.style.transform = `translate(${-size / 2}px, ${-size / 2}px)`;
    }
    let vig = 0;
    let n = 0;
    for (const hit of inds) {
      const age = hit.ageSeconds;
      if (age < 0 || age >= HIT_INDICATOR_SECONDS) continue;
      vig = Math.max(vig, 1 - age / HIT_VIGNETTE_SECONDS);
      let path = this.hitPaths[n];
      if (!path) {
        path = svg('path', this.hitSvg);
        this.hitPaths.push(path);
      }
      // 0=前方(上)、正=時計回り → 画面座標（右=0、下=+π/2）
      const a = hit.angle - Math.PI / 2;
      const a0 = a - HIT_WEDGE_HALF_ANGLE;
      const a1 = a + HIT_WEDGE_HALF_ANGLE;
      const x0 = (R * Math.cos(a0)).toFixed(1);
      const y0 = (R * Math.sin(a0)).toFixed(1);
      const x1 = (R * Math.cos(a1)).toFixed(1);
      const y1 = (R * Math.sin(a1)).toFixed(1);
      setAttr(path, 'd', `M ${x0} ${y0} A ${R} ${R} 0 0 1 ${x1} ${y1}`);
      setAttr(path, 'opacity', (1 - age / HIT_INDICATOR_SECONDS).toFixed(2));
      if (path.style.display !== '') path.style.display = '';
      n++;
    }
    for (let i = n; i < this.hitPaths.length; i++) {
      if (this.hitPaths[i].style.display !== 'none') this.hitPaths[i].style.display = 'none';
    }
    const vo = Math.max(0, Math.min(1, vig));
    if (vo !== this.lastVignetteOpacity) {
      this.lastVignetteOpacity = vo;
      this.vignette.style.opacity = vo.toFixed(2);
    }
  }

  // ------------------------------------------------------------ 武器

  private updateWeapons(view: HudView): void {
    if (view.weapon !== this.lastWeapon) {
      this.lastWeapon = view.weapon;
      for (const w of WEAPON_ORDER) setClass(this.weaponRows[w].row, 'active', w === view.weapon);
    }
    const mg = this.weaponRows.machinegun;
    mg.ammo.set(`残弾 ${view.ammo.machinegun} / ${WEAPONS.machinegun.ammo}`);
    setClass(mg.ammoEl, 'empty', view.ammo.machinegun <= 0);
    const ms = this.weaponRows.missile;
    ms.ammo.set(`残弾 ${view.ammo.missile} / ${WEAPONS.missile.ammo}`);
    setClass(ms.ammoEl, 'empty', view.ammo.missile <= 0);
    const bm = this.weaponRows.beam;
    bm.ammo.set(`∞（弾数制限なし）／1射 ${view.beamEnCost} EN`);
    setClass(bm.ammoEl, 'empty', view.en < view.beamEnCost);
  }

  // -------------------------------------------------------------- EN

  private updateEn(view: HudView): void {
    const maxEn = Math.max(1e-9, view.maxEn);
    const en = Math.max(0, Math.min(maxEn, view.en));
    this.enValue.set(`EN ${en.toFixed(1)} / ${view.maxEn}`);
    const scale = `scaleX(${(en / maxEn).toFixed(4)})`;
    if (scale !== this.lastEnScale) {
      this.lastEnScale = scale;
      this.enBar.style.transform = scale;
    }
    this.enSub.set(`回復 ${view.regenPerSecond.toFixed(2)} EN/秒（接地中・消費後 ${PLAYER.enRegenDelaySeconds.toFixed(2)} s 経過で回復）`);
  }

  // ------------------------------------------------------------ 移動

  private updateMovement(view: HudView): void {
    const mv = view.movement;
    let mode: string;
    if (mv.horizontalMode === 'quickboost') {
      mode = `QB噴射中 ${mv.qbImpulseRemainingSeconds.toFixed(2)} s`;
    } else if (mv.horizontalMode === 'glide') {
      // 定常グライド速度（22 / 16 × 脚部倍率）を超えていれば QB 後の慣性減速中
      const mul = Number.isFinite(mv.horizontalSpeedMultiplier) && mv.horizontalSpeedMultiplier > 0 ? mv.horizontalSpeedMultiplier : inferHorizontalSpeedMultiplier(view);
      const steady = (mv.verticalMode === 'grounded' ? PLAYER.glideGroundSpeed : PLAYER.airSpeed) * mul;
      mode = mv.speed > steady * GLIDE_DECEL_RATIO ? '慣性減速中(グライド)' : 'グライド';
    } else {
      mode = mv.glideEnabled ? '歩行（グライド待機）' : '歩行';
    }
    this.moveMode.set(mode);
    this.moveVertical.set(VERTICAL_LABEL[mv.verticalMode]);

    let qbText: string;
    let qbClass: string;
    if (mv.qbImpulseRemainingSeconds > 0) {
      qbText = `噴射中 ${mv.qbImpulseRemainingSeconds.toFixed(2)} s`;
      qbClass = 'boosting';
    } else if (mv.qbReady) {
      qbText = `使用可 (${mv.qbCost} EN)`;
      qbClass = 'ready';
    } else if (mv.qbCooldownRemainingSeconds > 0) {
      // 切り上げ: 残りがある間は 0.0s と表示しない。EN も足りなければ併記する
      const shown = Math.ceil(mv.qbCooldownRemainingSeconds * 10) / 10;
      qbText = `冷却 ${shown.toFixed(1)}s${view.en < mv.qbCost ? '・EN不足' : ''}`;
      qbClass = 'cooling';
    } else {
      qbText = `EN不足 (${mv.qbCost} EN 必要)`;
      qbClass = 'noen';
    }
    this.qbValue.set(qbText);
    if (qbClass !== this.lastQbClass) {
      if (this.lastQbClass) this.qbLine.classList.remove(this.lastQbClass);
      this.qbLine.classList.add(qbClass);
      this.lastQbClass = qbClass;
    }
    this.speedValue.set(`${mv.speed.toFixed(1)} m/s`);
  }

  // -------------------------------------------------------------- HP

  private updateHp(view: HudView): void {
    const maxHp = Math.max(1e-9, view.maxHp);
    const hp = Math.max(0, Math.min(maxHp, view.hp));
    // 四捨五入。ただし生存中（hp > 0）に 0 と表示しない
    const shownHp = hp > 0 ? Math.max(1, Math.round(hp)) : 0;
    this.hpValue.set(`HP ${shownHp} / ${view.maxHp}`);
    const ratio = hp / maxHp;
    const scale = `scaleX(${ratio.toFixed(4)})`;
    if (scale !== this.lastHpScale) {
      this.lastHpScale = scale;
      this.hpBar.style.transform = scale;
    }
    const cls = ratio < HP_RED_RATIO ? 'red' : ratio < HP_AMBER_RATIO ? 'amber' : '';
    if (cls !== this.lastHpClass) {
      if (this.lastHpClass) {
        this.hpPanel.classList.remove(this.lastHpClass);
        this.hpBar.classList.remove(this.lastHpClass);
      }
      if (cls) {
        this.hpPanel.classList.add(cls);
        this.hpBar.classList.add(cls);
      }
      this.lastHpClass = cls;
    }
    this.hpState.set(cls === 'red' ? '危険 — HP 25% 未満' : cls === 'amber' ? '注意 — HP 50% 未満' : '');
  }

  // ------------------------------------------------------------ 目標

  private updateObjective(view: HudView): void {
    const o = view.objective;
    this.objSector.set(o.currentSectorName || (o.currentSectorId ?? '区画外'));
    this.objNext.set(o.nextObjective ? `次の目標: ${o.nextObjective}` : '');
    this.objControls.set(`制御砲台 ${o.controlsDestroyed}/${o.controlsRequired || OBJECTIVE.controlsRequired}`);
    this.objGateTxt.set(o.gateOpen ? '最終ゲート: 開放 — 脱出可能' : '最終ゲート: 閉鎖');
    setClass(this.objGate, 'open', o.gateOpen);
    this.objEnemies.set(`敵 ${o.enemiesAlive}/${o.enemiesTotal || OBJECTIVE.totalEnemies}`);
    this.objTime.set(formatTime(view.elapsedSeconds));
    this.objBarriers.set(o.openBarrierIds.length > 0 ? `開放済み隔壁: ${o.openBarrierIds.join(', ')}` : '開放済み隔壁: なし');
    this.objRecent.set(o.recentBarrierLabel ? `隔壁開放: ${o.recentBarrierLabel}` : '');
  }

  // ---------------------------------------------------------- トースト

  private updateToast(view: HudView): void {
    const fd = view.fireDenied;
    const show = !!fd && fd.ageSeconds >= 0 && fd.ageSeconds < DENIAL_TOAST_SECONDS;
    if (show && fd) this.toastTxt.set(`${WEAPON_LABEL[fd.weapon]}: ${DENIAL_LABEL[fd.reason]}`);
    if (show !== this.toastShown) {
      this.toastShown = show;
      setClass(this.toast, 'show', show);
    }
  }
}
