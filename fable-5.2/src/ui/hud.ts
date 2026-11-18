/**
 * In-game HUD (HTML/CSS overlay) — docs/SPEC.md §8, §5, §4.2/§4.3, §2.3, §2.1.
 *
 * Everything shown is read from the live simulation state (`Sim`) and from `src/config.ts`; the HUD
 * keeps no gameplay numbers of its own. Transient indicators (damage direction, telegraph warnings,
 * reject notices, toasts) are driven by `SimEvent`s and timed in SIMULATION time, so they freeze while
 * the game is paused.
 *
 * Rendering rules:
 *  - the DOM is touched only when a displayed value actually changed (every field has a cached key);
 *  - moving things (markers, bars) use transforms only — no layout thrash;
 *  - the per-frame path creates no objects/arrays/closures (strings only when a value changes);
 *  - all element pools are fixed size (no unbounded growth).
 *
 * The FCS lock circle is drawn with exactly `sim.lock.radiusCssPx` around the centre of `sim.viewport`
 * (the same numbers the lock test uses), so the displayed circle is the judged circle, also after a resize.
 */
import './hud.css';
import { CAMERA, ENEMIES, PLAYER, WEAPONS, WEAPON_ORDER } from '../config';
import type { V3 } from '../core/vec';
import { getRouteHint, type RouteHint } from '../sim/guide';
import type { Sim } from '../sim/sim';
import type { EnemyState, FireRejectReason, SimEvent, Weapon } from '../sim/types';

/** Projects a world point to CSS px in the game display area (origin top-left). Returns false if behind the camera. */
export type Projector = (p: V3, out: { x: number; y: number; depth: number }) => boolean;

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEG = 180 / Math.PI;
const TAN_HALF_FOV = Math.tan((CAMERA.fovYDeg * Math.PI) / 360);

/** HUD design size: 1 em = 16 px at 1280×720. */
const BASE_W = 1280;
const BASE_H = 720;
const BASE_EM = 16;
const MIN_SCALE = 0.8;
const MAX_SCALE = 3.5;

const DAMAGE_SLOTS = 8;
const DAMAGE_HOLD = 0.2;
const DAMAGE_FADE = 1.0;
const TELE_SLOTS = 12;
const TELE_TAIL = 0.25;
/** Banner + two toasts stay above the largest (0.30 D) lock circle at 1280×720. */
const TOAST_SLOTS = 2;
const TOAST_SECONDS = 4.5;
const NOTICE_SECONDS = 1.0;
const QB_REJECT_SECONDS = 0.6;
const HIT_SECONDS = 0.14;
const KILL_SECONDS = 0.9;
const LOW_HP_FRACTION = 0.3;
const MID_HP_FRACTION = 0.6;
const OBJECTIVE_REFRESH_SECONDS = 0.5;
/**
 * Half size (em) of the square around the screen centre that the text tag of the route marker keeps clear:
 * the centre reticle (arms to 13 px at 1280×720, i.e. 0.81 em, plus its outline) with a small margin.
 */
const RETICLE_KEEP_EM = 1.25;
/** Padding (em) of the keep-out rectangles around the HUD panels (see Hud.measureLayout / Hud.locate). */
const KEEP_PAD_EM = 1.5;
/** Route marker (sim.guide): full opacity from this distance (m), hidden below ROUTE_NEAR_HIDE. */
const ROUTE_NEAR_FULL = 6;
const ROUTE_NEAR_HIDE = 2.5;
/** Farther than this from the recommended route (m) the marker reads "rejoin" instead of "next". */
const ROUTE_OFF_METERS = 12;
/** Route marker modes (what the level-ground label says). */
const ROUTE_NEXT = 0;
const ROUTE_FIRE = 1;
const ROUTE_BACK = 2;
const ROUTE_REJOIN = 3;
const ROUTE_MODE_TEXT: readonly string[] = ['進路 NEXT', '射撃位置 FIRE POS', '戻る BACK', '合流 REJOIN'];
/** Opacity strings for the 16 fade levels (avoids number→string conversions while fading). */
const FADE_LEVELS = 16;
const FADE_STR: string[] = [];
for (let i = 0; i <= FADE_LEVELS; i++) FADE_STR.push((i / FADE_LEVELS).toFixed(3));

const LOCK_TEXT = {
  none: 'NO LOCK / 未ロック',
  acquiring: 'LOCKING / ロック中',
  locked: '◆ LOCK ON / ロック完了',
  reject: '✕ ミサイル発射不可 — ロック未完了',
} as const;

const HMODE_TEXT = {
  walk: 'WALK 歩行',
  glide: 'GLIDE グライド',
  quickboost: 'QUICK BOOST',
  brake: 'BRAKE ブレーキ',
} as const;
type HMode = keyof typeof HMODE_TEXT;

const VMODE_TEXT = {
  grounded: 'GROUND 接地',
  rising: 'RISING 上昇',
  flying: 'FLIGHT 飛行',
  falling: 'FALL 落下',
} as const;
type VMode = keyof typeof VMODE_TEXT;

type WeaponStatus = 'ready' | 'cool' | 'empty' | 'noen' | 'nolock';
type EnStatus = 'full' | 'regen' | 'wait' | 'air' | 'use';
type QbStatus = 'ready' | 'cool' | 'noen' | 'brake';

/** Notice codes of the weapon panel. */
const NOTICE_NONE = 0;
const NOTICE_NO_LOCK = 1;
const NOTICE_NO_EN = 2;
const NOTICE_EMPTY_MG = 3;
const NOTICE_EMPTY_MSL = 4;
const NOTICE_TEXT: string[] = [
  '',
  `ロック未完了 — ミサイル発射不可`,
  `EN不足 — ビーム発射不可（1射 ${WEAPONS.beam.enCost} EN）`,
  `弾切れ — ${WEAPONS.machinegun.label} 残弾 0`,
  `弾切れ — ${WEAPONS.missile.label} 残弾 0`,
];

// ───────────────────────── small DOM helpers ─────────────────────────
function el(tag: string, cls: string, parent: Element | null, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function svgEl(tag: string, cls: string, parent: Element | null): SVGElement {
  const e = document.createElementNS(SVG_NS, tag) as SVGElement;
  if (cls) e.setAttribute('class', cls);
  if (parent) parent.appendChild(e);
  return e;
}

function textNode(parent: Element, s = ''): Text {
  const t = document.createTextNode(s);
  parent.appendChild(t);
  return t;
}

const ARROW_SVG =
  '<svg viewBox="-16 -16 32 32"><path d="M14 0 L-4 -9.5 L0 0 L-4 9.5 Z" fill="currentColor" stroke="rgba(0,0,0,.65)" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const CHEVRON_SVG =
  '<svg viewBox="-16 -16 32 32"><path d="M2 -10 L13 0 L2 10 L6 0 Z M-9 -10 L2 0 L-9 10 L-5 0 Z" fill="currentColor" stroke="rgba(0,0,0,.65)" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const BANG_SVG =
  '<svg viewBox="0 0 24 22"><path class="tri" d="M12 1.5 L22.5 20.5 H1.5 Z"/><path class="ex" d="M10.7 7.6 h2.6 l-0.5 7 h-1.6 Z M12 16 a1.5 1.5 0 1 0 0.001 0 Z"/></svg>';
const DIAMOND_SVG =
  '<svg class="dia" viewBox="-12 -12 24 24"><path class="d" d="M0 -10 L10 0 L0 10 L-10 0 Z"/><circle class="dot" r="2.3"/>' +
  '<line class="x" x1="-10" y1="-10" x2="10" y2="10"/><line class="x" x1="-10" y1="10" x2="10" y2="-10"/></svg>';
const PIN_SVG = '<svg class="pin" viewBox="-11 -24 22 24"><path d="M-9 -22.5 H9 L0 -1.5 Z"/><circle cx="0" cy="-16.5" r="2.6"/></svg>';
/**
 * Route marker: an OPEN double chevron (never filled — the objective pin is a filled triangle, the lock target
 * corner brackets, the aim point a diamond). Pointing down at the spot; pointing up for a climb; with a ground
 * bar for a drop. `ol` = dark outline drawn under the coloured stroke.
 */
const ROUTE_DN = 'M-8 -12 L0 -4 L8 -12 M-8 -3 L0 5 L8 -3';
const ROUTE_UP = 'M-8 4 L0 -4 L8 4 M-8 -5 L0 -13 L8 -5';
const ROUTE_BAR = 'M-9 10 H9';
const ROUTE_SVG =
  '<svg class="rt" viewBox="-12 -16 24 28">' +
  `<path class="ol dn" d="${ROUTE_DN}"/><path class="c dn" d="${ROUTE_DN}"/>` +
  `<path class="ol up" d="${ROUTE_UP}"/><path class="c up" d="${ROUTE_UP}"/>` +
  `<path class="ol bar" d="${ROUTE_BAR}"/><path class="c bar" d="${ROUTE_BAR}"/></svg>`;
/** Edge arrow of the route marker: three open chevrons (the other edge arrows are filled). */
const ROUTE_EDGE = 'M-11 -8 L-4 0 L-11 8 M-3 -8 L4 0 L-3 8 M5 -8 L12 0 L5 8';
const ROUTE_ARROW_SVG =
  '<svg viewBox="-16 -16 32 32" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
  `<path d="${ROUTE_EDGE}" stroke="rgba(0,0,0,.7)" stroke-width="5.2"/><path d="${ROUTE_EDGE}" stroke="currentColor" stroke-width="2.7"/></svg>`;

/** A world-anchored marker: on-screen body or an edge arrow + label when the point is off-screen / behind. */
interface Marker {
  el: HTMLElement;
  arrow: HTMLElement;
  elabel: HTMLElement;
  shown: boolean;
  edge: boolean;
  x: number;
  y: number;
  ang: number;
  /** Inward offset of the edge label, in the label's own em. */
  labelRx: number;
  labelRy: number;
}

function makeMarker(parent: Element, cls: string, arrowSvg: string, labelCls: string, labelRx: number, labelRy: number): { m: Marker; on: HTMLElement } {
  const root = el('div', 'hud-mk ' + cls + ' is-off', parent);
  const on = el('div', 'on', root);
  const edge = el('div', 'edge', root);
  const arrow = el('div', 'hud-mk-arrow', edge);
  arrow.innerHTML = arrowSvg;
  const elabel = el('div', labelCls, edge);
  return { m: { el: root, arrow, elabel, shown: false, edge: false, x: NaN, y: NaN, ang: NaN, labelRx, labelRy }, on };
}

/** Rough width of a label in its own em (CJK ≈ 1, symbols ≈ 0.9, Latin / digits ≈ 0.62 incl. letter spacing). */
function textEm(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w += c > 0x2e7f ? 1.04 : c > 0x7f ? 0.9 : 0.64;
  }
  return w;
}

function hideMarker(m: Marker): void {
  if (!m.shown) return;
  m.shown = false;
  m.el.classList.add('is-off');
}

interface Loc {
  x: number;
  y: number;
  /** Unit screen direction from the centre (edge mode). */
  dx: number;
  dy: number;
  depth: number;
  on: boolean;
}

function placeMarker(m: Marker, L: Loc): void {
  if (!m.shown) {
    m.shown = true;
    m.el.classList.remove('is-off');
  }
  const x = Math.round(L.x * 2) / 2;
  const y = Math.round(L.y * 2) / 2;
  if (x !== m.x || y !== m.y) {
    m.x = x;
    m.y = y;
    m.el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
  }
  const edge = !L.on;
  if (edge !== m.edge) {
    m.edge = edge;
    m.el.classList.toggle('is-edge', edge);
  }
  if (edge) {
    const a = Math.round(Math.atan2(L.dy, L.dx) * DEG);
    if (a !== m.ang) {
      m.ang = a;
      m.arrow.style.transform = 'rotate(' + a + 'deg)';
      const ox = -Math.cos(a / DEG) * m.labelRx;
      const oy = -Math.sin(a / DEG) * m.labelRy;
      m.elabel.style.transform = 'translate(calc(-50% + ' + ox.toFixed(2) + 'em),calc(-50% + ' + oy.toFixed(2) + 'em))';
    }
  }
}

interface WeaponRow {
  weapon: Weapon;
  el: HTMLElement;
  ammoText: Text | null;
  statText: Text;
  cd: HTMLElement;
  selected: boolean;
  ammoKey: number;
  status: WeaponStatus | '';
  statKey: number;
  cdKey: number;
}

interface DamageSlot {
  el: SVGElement;
  active: boolean;
  at: number;
  src: V3;
  enemyId: string | null;
  ang: number;
  fade: number;
  heavy: boolean;
}

interface TeleSlot {
  m: Marker;
  ring: HTMLElement;
  active: boolean;
  enemyId: string;
  endAt: number;
  kind: 'guard' | 'turret' | '';
  ringPx: number;
  tail: boolean;
}

interface ToastSlot {
  el: HTMLElement;
  main: Text;
  sub: Text;
  active: boolean;
  until: number;
  warn: boolean;
}

interface BarrierCell {
  id: string;
  el: HTMLElement;
  state: Text;
  open: boolean;
}

export class Hud {
  private readonly hud: HTMLElement;

  // ── size / layout ──
  private w = 0;
  private h = 0;
  private scale = 1;
  private em = BASE_EM;
  private layoutDirty = true;
  /** Keep-out rectangles (x0,y0,x1,y1) for edge indicators: the panels. */
  private readonly keep = new Float64Array(6 * 4);
  private keepCount = 0;
  private topCenterTop = NaN;

  // ── sim tracking ──
  private sim: Sim | null = null;
  private lastTime = -1;

  // ── centre ──
  private readonly gCenter: SVGElement;
  /** Centre group of the reticle layer (drawn above the world markers). */
  private readonly gCenterTop: SVGElement;
  private readonly lockOl: SVGElement;
  private readonly lockRing: SVGElement;
  private readonly lockOuter: SVGElement;
  private readonly lockProgOl: SVGElement;
  private readonly lockProg: SVGElement;
  private readonly lockNotch: SVGElement;
  private readonly lockCard: SVGElement;
  private readonly gReticle: SVGElement;
  private readonly gHit: SVGElement;
  private readonly lockLabel: HTMLElement;
  private readonly lockLabelText: Text;
  private readonly lockPct: HTMLElement;
  private readonly lockPctText: Text;
  private readonly killTag: HTMLElement;
  private cx = NaN;
  private cy = NaN;
  private lockR = NaN;
  private geomDirty = true;
  private lockState = '';
  private lockLabelKey = '';
  private lockProgKey = -1;
  private lockPctKey = -1;
  private lockRejectUntil = -1;
  private hitUntil = -1;
  private killUntil = -1;
  private hitOn = false;
  private killOn = false;

  // ── damage direction ──
  private readonly dmg: DamageSlot[] = [];

  // ── markers ──
  private readonly loc: Loc = { x: 0, y: 0, dx: 0, dy: -1, depth: 0, on: false };
  private readonly proj = { x: 0, y: 0, depth: 0 };
  private readonly tgt: Marker;
  private readonly tgtBox: HTMLElement;
  private readonly tgtId: Text;
  private readonly tgtKind: Text;
  private readonly tgtDist: Text;
  private readonly tgtHp: HTMLElement;
  private readonly tgtEdgeId: Text;
  private readonly tgtEdgeDist: Text;
  private readonly tgtEdgeAim: HTMLElement;
  private readonly tgtEdgeAimText: Text;
  private tgtEdgeAimKey: '' | 'solved' | 'no_solution' = '';
  private aimFlip = false;
  private tgtIdKey: string | null = null;
  private tgtKindKey = '';
  private tgtDistKey = -1;
  private tgtHpKey = -1;
  private tgtBoxKey = -1;
  private tgtStateKey = '';
  private readonly aim: Marker;
  private readonly aimMain: Text;
  private readonly aimSub: Text;
  private readonly aimEdge: Text;
  private aimStatusKey = '';
  private aimSubKey = -2;
  private readonly leadLine: HTMLElement;
  private leadShown = false;
  private leadX = NaN;
  private leadY = NaN;
  private leadA = NaN;
  private leadLen = NaN;
  private leadNoSol = false;
  private readonly obj: Marker;
  private readonly objName: Text;
  private readonly objDist: Text;
  private readonly objEdgeName: Text;
  private readonly objEdgeDist: Text;
  private objKind: 'control' | 'exit' | '' = '';
  private readonly objPos: V3 = { x: 0, y: 0, z: 0 };
  private objValid = false;
  private objDirty = true;
  private objTimer = 0;
  private objLabel = '';
  private objDistKey = -1;
  private objNameKey = '';
  private objNoTag = false;
  /** Estimated width of the objective tag / edge label in their own em (see textEm). */
  private objTagEm = 0;
  private objEdgeEm = 0;
  /** Scratch boxes (centre x, centre y, half width, half height in CSS px). */
  private readonly boxA = new Float64Array(4);
  private readonly boxB = new Float64Array(4);
  /** Lock-state label: half width in CSS px (measured when its text or the scale changed; -1 = not yet). */
  private lockLabelHalfW = -1;
  private killUp = false;
  private readonly tele: TeleSlot[] = [];

  // ── route guidance (sim.guide): marker + the "進路" row of the top-left panel ──
  private readonly route: Marker;
  private readonly routeMain: Text;
  private readonly routeDist: Text;
  private readonly routeSub: HTMLElement;
  private readonly routeBlk: HTMLElement;
  private readonly routeBlkText: Text;
  private readonly routeEdgeMain: Text;
  private readonly routeEdgeDist: Text;
  private readonly routeEdgeBlk: HTMLElement;
  private readonly routeEdgeBlkText: Text;
  private routeKey = -1;
  private routeKind = -1;
  private routeDistKey = -1;
  private routeBlkId: string | null | undefined = undefined;
  private routeBlkEnemy: string | null | undefined = undefined;
  private routeFade = -1;
  private routeFlip = false;
  /** How the route tag avoids the centre reticle: 0 not needed, 1 moved below the chevrons, 2 hidden. */
  private routeDodge = 0;
  private routeSide = 0;
  private routeMainEm = 0;
  private routeBlkEm = 0;
  private routeInLock = false;
  private readonly routeRow: HTMLElement;
  private readonly routeRowText: Text;
  private readonly routeRowDist: Text;
  private routeRowOn: boolean | null = null;
  private routeRowKey = -1;
  private routeRowSector: string | null | undefined = undefined;
  private routeRowBlk: string | null | undefined = undefined;
  private routeRowEnemy: string | null | undefined = undefined;
  private routeRowDistKey = -1;
  private routeRowDigits = 0;

  // ── weapon panel ──
  private readonly rows: WeaponRow[] = [];
  private readonly notice: HTMLElement;
  private readonly noticeText: Text;
  private noticeCode = NOTICE_NONE;
  private noticeFlash = false;
  private noticeEventCode = NOTICE_NONE;
  private noticeUntil = -1;

  // ── EN / QB / mode panel ──
  private readonly right: HTMLElement;
  private readonly enNum: Text;
  private readonly enMax: Text;
  private readonly enStateMain: Text;
  private readonly enStateSub: Text;
  private readonly enFill: HTMLElement;
  private readonly enMark: HTMLElement;
  private readonly enMarkText: Text;
  private enKey = -1;
  private enMaxKey = -1;
  private enFillKey = -1;
  private enStatus: EnStatus | '' = '';
  private enSubKey = -1;
  private enLow: boolean | null = null;
  private readonly qb: HTMLElement;
  private readonly qbText: Text;
  private readonly qbBar: HTMLElement;
  private readonly qbCost: HTMLElement;
  private qbStatus: QbStatus | '' = '';
  private qbTextKey = -1;
  private qbBarKey = -1;
  private qbCostWarn: boolean | null = null;
  private qbRejectUntil = -1;
  private qbRejectOn = false;
  private readonly hModeEl: HTMLElement;
  private readonly hModeText: Text;
  private readonly vModeEl: HTMLElement;
  private readonly vModeText: Text;
  private readonly speedText: Text;
  private readonly glideText: Text;
  private hMode: HMode | '' = '';
  private vMode: VMode | '' = '';
  private speedKey = -1;
  private glideKey: boolean | null = null;

  // ── HP panel ──
  private readonly bottom: HTMLElement;
  private readonly hpNum: Text;
  private readonly hpFill: HTMLElement;
  private readonly hpGhost: HTMLElement;
  private hpKey = -1;
  private hpFillKey = -1;
  private hpGhostKey = -1;
  private hpGhost01 = -1;
  private hpBand = '';

  // ── top ──
  private readonly topLeft: HTMLElement;
  private readonly topRight: HTMLElement;
  private readonly topCenter: HTMLElement;
  private readonly left: HTMLElement;
  private readonly sectorEl: HTMLElement;
  private readonly sectorText: Text;
  private readonly sectorEn: Text;
  private sectorKey: string | null | undefined = undefined;
  private sectorPulse = false;
  private readonly objText: Text;
  private readonly objPanelDist: Text;
  private readonly ctrl: HTMLElement;
  private readonly ctrlText: Text;
  private ctrlDone = -1;
  private ctrlReq = -1;
  private readonly barriersEl: HTMLElement;
  private readonly cells: BarrierCell[] = [];
  private cellsStage: unknown = null;
  private openCount = -1;
  private readonly gateText: Text;
  private gateOpen: boolean | null = null;
  private readonly banner: HTMLElement;
  private readonly toasts: ToastSlot[] = [];

  constructor(root: HTMLElement) {
    if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
    const hud = (this.hud = el('div', 'ak2-hud', root));
    hud.setAttribute('data-lock', 'none');
    hud.setAttribute('aria-hidden', 'true');

    el('div', 'hud-vignette', hud);

    // ── centre SVG ──
    const svg = svgEl('svg', 'hud-svg', hud);
    const g = (this.gCenter = svgEl('g', 'hud-center', svg));
    this.lockOl = svgEl('circle', 'hud-lock-ol', g);
    this.lockRing = svgEl('circle', 'hud-lock-ring', g);
    this.lockOuter = svgEl('circle', 'hud-lock-outer', g);
    this.lockProgOl = svgEl('circle', 'hud-lock-prog-ol', g);
    this.lockProg = svgEl('circle', 'hud-lock-prog', g);
    for (const c of [this.lockProgOl, this.lockProg]) {
      c.setAttribute('pathLength', '100');
      c.setAttribute('transform', 'rotate(-90)');
      c.setAttribute('stroke-dasharray', '0 100');
    }
    this.lockCard = svgEl('path', 'hud-lock-card', g);
    this.lockNotch = svgEl('path', 'hud-lock-notch', g);
    for (let i = 0; i < DAMAGE_SLOTS; i++) {
      const p = svgEl('path', 'hud-dmg', g);
      p.style.display = 'none';
      this.dmg.push({ el: p, active: false, at: 0, src: { x: 0, y: 0, z: 0 }, enemyId: null, ang: NaN, fade: -1, heavy: false });
    }

    this.lockLabel = el('div', 'hud-locklabel', hud);
    this.lockLabelText = textNode(this.lockLabel, LOCK_TEXT.none);
    this.lockPct = el('span', 'pct is-off', this.lockLabel);
    this.lockPctText = textNode(this.lockPct, '0%');
    this.killTag = el('div', 'hud-killtag is-off', hud, '撃破 DESTROYED');

    // ── markers ──
    const markers = el('div', 'hud-markers', hud);
    {
      // route marker: created first, so every other marker (lock target, aim point, objective) is drawn above it
      const { m, on } = makeMarker(markers, 'hud-mk-route', ROUTE_ARROW_SVG, 'hud-mk-elabel', 6.4, 2.5);
      this.route = m;
      on.insertAdjacentHTML('beforeend', ROUTE_SVG);
      const tag = el('div', 'hud-rtag', on);
      this.routeMain = textNode(tag, ROUTE_MODE_TEXT[ROUTE_NEXT] + ' ');
      this.routeDist = textNode(el('span', 'd', tag), '');
      this.routeSub = el('div', 's is-off', tag, 'Space長押し');
      this.routeBlk = el('div', 'b is-off', tag);
      this.routeBlkText = textNode(this.routeBlk);
      this.routeEdgeMain = textNode(m.elabel, ROUTE_MODE_TEXT[ROUTE_NEXT] + ' ');
      this.routeEdgeDist = textNode(el('span', 'd', m.elabel), '');
      this.routeEdgeBlk = el('div', 'rb is-off', m.elabel);
      this.routeEdgeBlkText = textNode(this.routeEdgeBlk);
    }
    this.leadLine = el('div', 'hud-leadline is-off', markers);

    {
      const { m, on } = makeMarker(markers, 'hud-mk-obj', ARROW_SVG, 'hud-mk-elabel', 3.6, 2.5);
      this.obj = m;
      on.insertAdjacentHTML('beforeend', PIN_SVG);
      const tag = el('div', 'hud-otag', on);
      this.objName = textNode(tag, '目標');
      this.objDist = textNode(el('span', 'd', tag), '');
      this.objEdgeName = textNode(m.elabel, '目標 ');
      this.objEdgeDist = textNode(m.elabel, '');
    }
    {
      const { m, on } = makeMarker(markers, 'hud-mk-target', ARROW_SVG, 'hud-mk-elabel', 3.6, 2.5);
      this.tgt = m;
      const box = (this.tgtBox = el('div', 'hud-tbox', on));
      for (let i = 0; i < 4; i++) el('i', '', box);
      const tag = el('div', 'hud-ttag', box);
      this.tgtId = textNode(el('span', 'id', tag));
      this.tgtKind = textNode(el('span', 'kind', tag));
      this.tgtDist = textNode(el('span', 'dist', tag));
      this.tgtHp = el('i', '', el('div', 'hud-thp', tag));
      this.tgtEdgeId = textNode(m.elabel);
      this.tgtEdgeDist = textNode(m.elabel);
      this.tgtEdgeAim = el('div', 'x is-off', m.elabel);
      this.tgtEdgeAimText = textNode(this.tgtEdgeAim);
    }
    {
      const { m, on } = makeMarker(markers, 'hud-mk-aim', ARROW_SVG, 'hud-mk-elabel', 4.6, 2.5);
      this.aim = m;
      on.insertAdjacentHTML('beforeend', DIAMOND_SVG);
      const tag = el('div', 'hud-atag', on);
      this.aimMain = textNode(tag);
      this.aimSub = textNode(el('span', 'sub', tag));
      this.aimEdge = textNode(m.elabel);
    }
    for (let i = 0; i < TELE_SLOTS; i++) {
      const { m, on } = makeMarker(markers, 'hud-mk-tele', CHEVRON_SVG, 'bang', 1.9, 1.9);
      const ring = el('div', 'hud-tring', on);
      el('div', 'hud-tbang', ring).innerHTML = BANG_SVG;
      m.elabel.innerHTML = BANG_SVG;
      this.tele.push({ m, ring, active: false, enemyId: '', endAt: 0, kind: '', ringPx: -1, tail: false });
    }

    // The lock-state label and the kill tag are painted ABOVE the world markers (later siblings win): a pin, a
    // chevron or a marker tag that projects onto them can never make the lock state unreadable (SPEC §8).
    hud.appendChild(this.lockLabel);
    hud.appendChild(this.killTag);

    // ── centre reticle + hit ticks: a layer of their own ABOVE the world markers, so that no marker or
    //    marker label (route, objective, target, aim point) can ever be painted over the aiming point ──
    {
      const top = svgEl('svg', 'hud-svg hud-svg-top', hud);
      const gTop = (this.gCenterTop = svgEl('g', 'hud-center', top));
      const ret = (this.gReticle = svgEl('g', 'hud-reticle', gTop));
      const RET = 'M-13 0H-6M6 0H13M0 -13V-6M0 6V13';
      svgEl('path', 'hud-ret-ol', ret).setAttribute('d', RET);
      svgEl('path', 'hud-ret', ret).setAttribute('d', RET);
      svgEl('circle', 'hud-ret-dot', ret).setAttribute('r', '1.7');
      const hit = (this.gHit = svgEl('g', 'hud-hit-g', ret));
      const HIT = 'M-12 -12L-6.5 -6.5M12 -12L6.5 -6.5M-12 12L-6.5 6.5M12 12L6.5 6.5';
      svgEl('path', 'hud-hit-ol', hit).setAttribute('d', HIT);
      svgEl('path', 'hud-hit', hit).setAttribute('d', HIT);
      hit.style.display = 'none';
    }

    // ── top-left: sector + objective ──
    const tl = (this.topLeft = el('div', 'hud-panel hud-top-left', hud));
    el('div', 'hud-cap', tl, 'SECTOR').appendChild(el('b', '', null, '現在区画'));
    this.sectorEl = el('div', 'hud-sector', tl);
    this.sectorText = textNode(this.sectorEl, '—');
    this.sectorEn = textNode(el('span', 'en', this.sectorEl));
    const objRow = el('div', 'hud-objective', tl);
    el('span', 'k', objRow, '目標');
    this.objText = textNode(el('span', 't', objRow));
    this.objPanelDist = textNode(el('span', 'd', objRow));
    // next leg of the recommended route in words (sim.guide)
    this.routeRow = el('div', 'hud-route is-off', tl);
    el('span', 'k', this.routeRow, '進路');
    this.routeRowText = textNode(el('span', 't', this.routeRow));
    this.routeRowDist = textNode(el('span', 'd', this.routeRow));

    // ── top-right: control turrets, barriers, final gate ──
    const tr = (this.topRight = el('div', 'hud-panel hud-top-right', hud));
    el('div', 'hud-cap', tr, 'PROGRESS').appendChild(el('b', '', null, '進行状況'));
    this.ctrl = el('div', 'hud-ctrl', tr);
    el('span', 'l', this.ctrl, '制御砲台');
    this.ctrlText = textNode(el('span', 'n', this.ctrl), '0/0');
    this.barriersEl = el('div', 'hud-barriers', tr);
    const gate = el('div', 'hud-gate', tr, '最終ゲート');
    this.gateText = textNode(el('span', 'v', gate), '閉鎖 LOCKED');

    // ── top-centre: gate banner + toasts ──
    const tc = (this.topCenter = el('div', 'hud-top-center', hud));
    this.banner = el('div', 'hud-banner is-off', tc);
    el('i', 'g', this.banner);
    el('div', 'm', this.banner, '最終ゲート開放 — 脱出可能');
    el('div', 's', this.banner, 'FINAL GATE OPEN — PROCEED TO EXIT');
    for (let i = 0; i < TOAST_SLOTS; i++) {
      const t = el('div', 'hud-toast is-off', tc);
      const main = textNode(t);
      const sub = textNode(el('span', 's', t));
      this.toasts.push({ el: t, main, sub, active: false, until: 0, warn: false });
    }

    // ── left: weapons ──
    const left = (this.left = el('div', 'hud-panel hud-left', hud));
    el('div', 'hud-cap', left, 'WEAPONS').appendChild(el('b', '', null, '武装 — 1/2/3 切替'));
    for (let i = 0; i < WEAPON_ORDER.length; i++) {
      const w = WEAPON_ORDER[i];
      const cfg = WEAPONS[w];
      const row = el('div', 'hud-wrow', left);
      row.setAttribute('data-w', w);
      el('span', 'sel', row, '▶');
      el('span', 'key', row, String(i + 1));
      el('span', 'name', row, cfg.label);
      const ammo = el('span', 'ammo', row);
      let ammoText: Text | null = null;
      if (Number.isFinite(cfg.ammo)) {
        ammoText = textNode(ammo, String(cfg.ammo));
        el('span', 'mx', ammo, ' / ' + cfg.ammo);
      } else {
        el('span', 'inf', ammo, '∞');
        el('span', 'per', ammo, cfg.enCost + ' EN/射');
      }
      const stat = el('span', 'stat', row);
      const statText = textNode(stat, 'READY');
      const cd = el('i', '', el('div', 'cd', row));
      this.rows.push({ weapon: w, el: row, ammoText, statText, cd, selected: false, ammoKey: -1, status: '', statKey: -1, cdKey: -1 });
    }
    this.notice = el('div', 'hud-notice', left);
    this.noticeText = textNode(this.notice, ' ');

    // ── right: EN, QB, movement mode ──
    const right = (this.right = el('div', 'hud-panel hud-right', hud));
    const enHead = el('div', 'hud-enhead', right);
    el('span', 'lbl', enHead, 'EN');
    this.enNum = textNode(el('span', 'num', enHead), '0.0');
    this.enMax = textNode(el('span', 'max', enHead), '/ 0');
    const enState = el('span', 'hud-enstate', enHead);
    this.enStateMain = textNode(enState);
    this.enStateSub = textNode(enState);
    const enBar = el('div', 'hud-enbar', right);
    const clip = el('div', 'clip', enBar);
    this.enFill = el('i', 'fill', clip);
    el('i', 'stripes', this.enFill);
    this.enMark = el('div', 'mark', enBar);
    this.enMarkText = textNode(el('b', '', this.enMark), 'QB ' + PLAYER.qbCost);
    const qb = (this.qb = el('div', 'hud-qb', right));
    el('span', 'lbl', qb, 'QB');
    this.qbText = textNode(el('span', 'st', qb), 'READY');
    this.qbBar = el('i', '', el('div', 'bar', qb));
    this.qbCost = el('span', 'cost', qb, '1回 ' + PLAYER.qbCost + ' EN');
    const mode = el('div', 'hud-mode', right);
    const hc = el('div', 'cell', mode);
    el('div', 'hud-cap', hc, 'MOVE').appendChild(el('b', '', null, '水平'));
    this.hModeEl = el('div', 'v', hc);
    this.hModeText = textNode(this.hModeEl);
    const vc = el('div', 'cell', mode);
    el('div', 'hud-cap', vc, 'VERT').appendChild(el('b', '', null, '垂直'));
    this.vModeEl = el('div', 'v', vc);
    this.vModeText = textNode(this.vModeEl);
    const sp = el('div', 'hud-speed', mode, 'SPD ');
    this.speedText = textNode(el('b', '', sp), '0.0');
    textNode(sp, ' m/s');
    this.glideText = textNode(el('span', 'g', sp));

    // ── bottom: HP ──
    const bottom = (this.bottom = el('div', 'hud-panel hud-bottom', hud));
    const hpHead = el('div', 'hud-hphead', bottom);
    el('span', 'lbl', hpHead, 'HP');
    this.hpNum = textNode(el('span', 'num', hpHead), '0');
    el('span', 'max', hpHead, '/ ' + PLAYER.maxHp);
    const hpBar = el('div', 'hud-hpbar', bottom);
    el('div', 'hud-hpwarn', bottom, '⚠ HP低下 DANGER — 残り30%未満');
    this.hpGhost = el('i', 'ghost', hpBar);
    this.hpFill = el('i', 'fill', hpBar);
    el('div', 'seg', hpBar);

    this.resize(BASE_W, BASE_H);
  }

  // ═══════════════════════════ public API ═══════════════════════════

  setVisible(visible: boolean): void {
    this.hud.classList.toggle('is-hidden', !visible);
  }

  /** CSS px of the game display area. Scales the whole HUD (1 em = 16 px at 1280×720) and re-anchors it. */
  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.w = w;
    this.h = h;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(w / BASE_W, h / BASE_H)));
    this.scale = s;
    this.em = BASE_EM * s;
    const st = this.hud.style;
    st.inset = '0 auto auto 0';
    st.width = w + 'px';
    st.height = h + 'px';
    st.fontSize = this.em.toFixed(3) + 'px';
    this.gReticle.setAttribute('transform', 'scale(' + s.toFixed(4) + ')');
    this.geomDirty = true;
    this.layoutDirty = true;
  }

  /** Damage direction, telegraph warnings, reject notices, toasts, hit confirmation. */
  handleEvents(events: readonly SimEvent[], sim: Sim): void {
    this.syncSim(sim);
    const t = sim.time;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case 'player-damaged':
          this.addDamage(e.sourcePos, e.amount, e.fromEnemyId, t);
          break;
        case 'enemy-telegraph':
          this.addTelegraph(e.enemyId, e.duration, t);
          break;
        case 'fire-rejected':
          this.addFireReject(e.weapon, e.reason, t);
          break;
        case 'weapon-switched':
        case 'player-shot':
          // The notice of a refused trigger pull belongs to that pull: another weapon was selected, or the
          // selected weapon has fired since — the message is no longer true (SPEC §8).
          this.noticeUntil = -1;
          this.lockRejectUntil = -1;
          break;
        case 'qb-rejected':
          this.qbRejectUntil = t + QB_REJECT_SECONDS;
          break;
        case 'enemy-damaged':
          this.hitUntil = t + HIT_SECONDS;
          break;
        case 'enemy-destroyed':
          this.hitUntil = t + HIT_SECONDS;
          this.killUntil = t + KILL_SECONDS;
          this.objDirty = true;
          if (e.isGateControl) {
            const o = sim.objective;
            this.addToast('制御砲台 ' + e.enemyId + ' 撃破', o.controlsDestroyed + '/' + o.controlsRequired + ' DESTROYED', true, t);
          }
          break;
        case 'barrier-opened':
          this.objDirty = true;
          this.addToast('隔壁 ' + e.barrierId + ' 開放', 'BARRIER OPEN', false, t);
          break;
        case 'gate-opened':
          // announced by the persistent banner (driven by sim.objective.gateOpen in update())
          this.objDirty = true;
          break;
        case 'sector-entered':
          // alternate between two identical one-shot animations to restart the pulse
          this.sectorPulse = !this.sectorPulse;
          this.sectorEl.classList.toggle('pulse-a', this.sectorPulse);
          this.sectorEl.classList.toggle('pulse-b', !this.sectorPulse);
          break;
        default:
          break;
      }
    }
  }

  /** Once per rendered frame while playing / paused. */
  update(sim: Sim, project: Projector, realDt: number): void {
    this.syncSim(sim);
    // The judged display area is sim.viewport: follow it even if resize() was not called after a change.
    if (sim.viewport.width !== this.w || sim.viewport.height !== this.h) this.resize(sim.viewport.width, sim.viewport.height);
    const dt = realDt > 0 && realDt < 1 ? realDt : 0;
    this.updateCentre(sim);
    this.updateObjective(sim, project, dt);
    this.updateRoute(sim, project);
    this.updateLockMarkers(sim, project);
    if (this.killOn) {
      // "撃破 DESTROYED" (≈ 7 em × 1 em, right below the reticle) keeps clear of the tag of the next lock
      // target (.hud-ttag: under the brackets, ≈ 8 em × 1.3 em): it moves above the reticle line instead.
      const tg = this.tgt;
      const em = this.em;
      let up = false;
      if (tg.shown && !tg.edge) {
        const tagY = tg.y + this.tgtBoxKey / 2 + 0.85 * em;
        up = Math.abs(tagY - (this.cy + 1.35 * em)) < 1.3 * em && tg.x + 4.2 * em > this.cx + 1.1 * em && tg.x - 4.2 * em < this.cx + 8.2 * em;
      }
      if (up !== this.killUp) this.placeKillTag(up);
    }
    this.updateTelegraphs(sim, project);
    this.updateDamage(sim);
    this.updateWeapons(sim);
    this.updateEnergy(sim);
    this.updateHp(sim, dt);
    this.updateTop(sim);
    if (this.layoutDirty) this.measureLayout();
    this.lastTime = sim.time;
  }

  /** New sortie: clears every transient indicator. */
  reset(): void {
    for (let i = 0; i < this.dmg.length; i++) {
      const d = this.dmg[i];
      if (d.active) {
        d.active = false;
        d.el.style.display = 'none';
      }
    }
    for (let i = 0; i < this.tele.length; i++) {
      const s = this.tele[i];
      s.active = false;
      hideMarker(s.m);
    }
    for (let i = 0; i < this.toasts.length; i++) {
      const s = this.toasts[i];
      if (s.active) {
        s.active = false;
        s.el.classList.add('is-off');
        this.layoutDirty = true;
      }
    }
    this.noticeUntil = -1;
    this.noticeEventCode = NOTICE_NONE;
    this.lockRejectUntil = -1;
    this.qbRejectUntil = -1;
    this.hitUntil = -1;
    this.killUntil = -1;
    this.hpGhost01 = -1;
    this.objDirty = true;
    this.objValid = false;
    this.lastTime = -1;
  }

  // ═══════════════════════════ internals ═══════════════════════════

  /** Detects a different Sim instance or a restarted clock (re-sortie) and clears transient state. */
  private syncSim(sim: Sim): void {
    if (sim !== this.sim) {
      this.sim = sim;
      this.reset();
      this.sectorKey = undefined;
      this.cellsStage = null;
    } else if (sim.time < this.lastTime - 1e-6) {
      this.reset();
    }
    if (this.lastTime < 0) this.lastTime = sim.time;
  }

  // ───────────── centre: lock circle, label, reticle, hit ticks ─────────────
  private updateCentre(sim: Sim): void {
    const lock = sim.lock;
    const t = sim.time;
    const cx = sim.viewport.width / 2;
    const cy = sim.viewport.height / 2;
    const r = lock.radiusCssPx;
    if (cx !== this.cx || cy !== this.cy) {
      this.cx = cx;
      this.cy = cy;
      this.gCenter.setAttribute('transform', 'translate(' + cx + ' ' + cy + ')');
      this.gCenterTop.setAttribute('transform', 'translate(' + cx + ' ' + cy + ')');
      this.geomDirty = true;
    }
    if (r !== this.lockR) {
      this.lockR = r;
      // The ring's centre line is exactly the judged radius.
      const rs = String(r);
      this.lockOl.setAttribute('r', rs);
      this.lockRing.setAttribute('r', rs);
      this.lockProgOl.setAttribute('r', rs);
      this.lockProg.setAttribute('r', rs);
      this.geomDirty = true;
    }
    if (this.geomDirty) this.rebuildCentreGeometry();

    // a rejected missile launch replaces the label for ~1 s (never while the lock is complete)
    const rejecting = t < this.lockRejectUntil && lock.state !== 'locked';
    if (lock.state !== this.lockState) {
      this.lockState = lock.state;
      this.hud.setAttribute('data-lock', lock.state);
    }
    const labelKey = rejecting ? 'reject' : lock.state;
    if (labelKey !== this.lockLabelKey) {
      this.lockLabelKey = labelKey;
      this.lockLabelText.data = LOCK_TEXT[labelKey];
      this.lockLabel.classList.toggle('reject', rejecting);
      this.lockPct.classList.toggle('is-off', labelKey !== 'acquiring');
      this.lockLabelHalfW = -1;
    }
    if (lock.state === 'acquiring') {
      const p = lock.progress < 0 ? 0 : lock.progress > 1 ? 1 : lock.progress;
      const key = Math.round(p * 200);
      if (key !== this.lockProgKey) {
        this.lockProgKey = key;
        const dash = key / 2 + ' 100';
        this.lockProg.setAttribute('stroke-dasharray', dash);
        this.lockProgOl.setAttribute('stroke-dasharray', dash);
      }
      const pct = Math.floor(p * 100 + 1e-6);
      if (pct !== this.lockPctKey) {
        this.lockPctKey = pct;
        this.lockPctText.data = pct + '%';
      }
    }

    const hitOn = t < this.hitUntil;
    const killOn = t < this.killUntil;
    if (hitOn !== this.hitOn || killOn !== this.killOn) {
      this.hitOn = hitOn;
      this.killOn = killOn;
      this.gHit.style.display = hitOn || killOn ? '' : 'none';
      this.gHit.setAttribute('class', killOn ? 'hud-hit-g kill' : 'hud-hit-g');
      this.killTag.classList.toggle('is-off', !killOn);
    }
  }

  /** Everything whose shape depends on the centre, the lock radius or the HUD scale. */
  private rebuildCentreGeometry(): void {
    this.geomDirty = false;
    this.lockLabelHalfW = -1;
    const r = this.lockR;
    const s = this.scale;
    const em = this.em;
    if (!(r >= 0)) return;
    this.lockOuter.setAttribute('r', String(r + 5.5 * s));
    // cardinal ticks just outside the circle
    const a = r + 4 * s;
    const b = r + 11 * s;
    this.lockCard.setAttribute(
      'd',
      'M0 ' + -a + 'V' + -b + 'M0 ' + a + 'V' + b + 'M' + -a + ' 0H' + -b + 'M' + a + ' 0H' + b,
    );
    // four inward notches on the diagonals (lock complete)
    let d = '';
    const tip = Math.max(0, r - 10 * s);
    const base = r + 1 * s;
    const hw = (5 * s) / Math.max(base, 1);
    for (let k = 0; k < 4; k++) {
      const ang = Math.PI / 4 + (k * Math.PI) / 2;
      d +=
        'M' + (Math.cos(ang) * tip).toFixed(2) + ' ' + (Math.sin(ang) * tip).toFixed(2) +
        'L' + (Math.cos(ang - hw) * base).toFixed(2) + ' ' + (Math.sin(ang - hw) * base).toFixed(2) +
        'L' + (Math.cos(ang + hw) * base).toFixed(2) + ' ' + (Math.sin(ang + hw) * base).toFixed(2) + 'Z';
    }
    this.lockNotch.setAttribute('d', d);
    // damage wedge (pointing up = ahead; rotated per slot)
    // A crescent just outside the circle: thick in the middle (towards the source), pointed at both ends.
    const ro = r + 60 * s;
    const al = (27 * Math.PI) / 180;
    const chord = ro * Math.sin(al);
    const sagOuter = ro * (1 - Math.cos(al));
    const thick = Math.min(13 * s, sagOuter * 0.8);
    const sagInner = sagOuter - thick;
    const rc = (chord * chord + sagInner * sagInner) / (2 * sagInner);
    const ex = chord.toFixed(2);
    const ey = (-ro * Math.cos(al)).toFixed(2);
    const wedge =
      'M-' + ex + ' ' + ey + 'A' + ro.toFixed(2) + ' ' + ro.toFixed(2) + ' 0 0 1 ' + ex + ' ' + ey +
      'A' + rc.toFixed(2) + ' ' + rc.toFixed(2) + ' 0 0 0 -' + ex + ' ' + ey + 'Z';
    for (let i = 0; i < this.dmg.length; i++) this.dmg[i].el.setAttribute('d', wedge);
    // label under the circle, kill tag next to the reticle
    this.lockLabel.style.transform =
      'translate(calc(' + this.cx.toFixed(1) + 'px - 50%),' + (this.cy + r + 0.55 * em).toFixed(1) + 'px)';
    this.placeKillTag(this.killUp);
  }

  /** Kill tag next to the reticle: below-right, or above-right while the tag of a lock target sits below-right. */
  private placeKillTag(up: boolean): void {
    this.killUp = up;
    const em = this.em;
    this.killTag.style.transform = 'translate(' + (this.cx + 1.1 * em).toFixed(1) + 'px,' + (this.cy + (up ? -1.85 : 0.9) * em).toFixed(1) + 'px)';
  }

  // ───────────── marker placement ─────────────
  /**
   * Fills this.loc for a world point: its projection when it is on screen, otherwise a point on the
   * screen border (pulled inwards so it never lands on a panel) plus the direction towards the point.
   * Points behind the camera use their bearing relative to the camera yaw (right → right edge, behind → bottom).
   *
   * Markers that carry a text tag (objective pin, route marker) pass the box of marker + tag around the anchor
   * (`halfW` to either side, `above` / `below` it, CSS px; the anchor itself is drawn `lift` px above the
   * projection). Where that box would lie on a HUD panel — the point is under a panel or right beside one —
   * the marker is shown like an off-screen one: an arrow on the line from the centre, in front of the panel,
   * pointing at the point.
   */
  private locate(p: V3, sim: Sim, project: Projector, halfW = -1, above = 0, below = 0, lift = 0): void {
    const L = this.loc;
    const o = this.proj;
    const front = project(p, o);
    const w = this.w;
    const h = this.h;
    const cx = w / 2;
    const cy = h / 2;
    const k = this.keep;
    const pad = KEEP_PAD_EM * this.em;
    const gap = 0.3 * this.em;
    const py = o.y - lift;
    L.depth = o.depth;
    let reach = Infinity;
    const boxed = halfW >= 0;
    if (front && o.x >= 0 && o.x <= w && py >= 0 && py <= h) {
      let covered = false;
      if (boxed) {
        for (let i = 0; i < this.keepCount && !covered; i++) {
          const j = i * 4;
          // (the keep-out rectangle is the panel + pad on every side)
          covered =
            o.x + halfW + gap > k[j] + pad && o.x - halfW - gap < k[j + 2] - pad && py + below + gap > k[j + 1] + pad && py - above - gap < k[j + 3] - pad;
        }
      }
      if (!covered) {
        L.on = true;
        L.x = o.x;
        L.y = py;
        return;
      }
      // never farther out than the point itself
      reach = Math.hypot(o.x - cx, py - cy);
    }
    let dx: number;
    let dy: number;
    if (front && Number.isFinite(o.x) && Number.isFinite(py)) {
      dx = o.x - cx;
      dy = py - cy;
    } else {
      const pl = sim.player;
      const rx = p.x - pl.pos.x;
      const rz = p.z - pl.pos.z;
      const sy = Math.sin(pl.yaw);
      const cyw = Math.cos(pl.yaw);
      dx = rx * cyw - rz * sy; // right
      dy = rx * sy + rz * cyw; // -forward: behind → down
    }
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      dx = 0;
      dy = 1;
    } else {
      dx /= len;
      dy /= len;
    }
    const inset = 1.9 * this.em;
    let t = Math.min(
      reach,
      dx !== 0 ? (cx - inset) / Math.abs(dx) : Infinity,
      dy !== 0 ? (cy - inset) / Math.abs(dy) : Infinity,
    );
    // an on-screen point that gave way to a panel: the arrow also stays out of the zone its tag would not fit in
    const grow = reach < Infinity;
    for (let i = 0; i < this.keepCount; i++) {
      const j = i * 4;
      let x0 = k[j];
      let y0 = k[j + 1];
      let x1 = k[j + 2];
      let y1 = k[j + 3];
      if (grow) {
        x0 = Math.min(x0, x0 + pad - halfW - gap);
        x1 = Math.max(x1, x1 - pad + halfW + gap);
        y0 = Math.min(y0, y0 + pad - below - gap);
        y1 = Math.max(y1, y1 - pad + above + gap);
      }
      // slab test of the ray centre + dir·t against the keep-out rectangle
      let t0 = 0;
      let t1 = t;
      if (dx !== 0) {
        const a = (x0 - cx) / dx;
        const b = (x1 - cx) / dx;
        t0 = Math.max(t0, Math.min(a, b));
        t1 = Math.min(t1, Math.max(a, b));
      } else if (cx < x0 || cx > x1) continue;
      if (dy !== 0) {
        const a = (y0 - cy) / dy;
        const b = (y1 - cy) / dy;
        t0 = Math.max(t0, Math.min(a, b));
        t1 = Math.min(t1, Math.max(a, b));
      } else if (cy < y0 || cy > y1) continue;
      if (t0 <= t1 && t0 < t) t = t0;
    }
    L.on = false;
    L.x = cx + dx * t;
    L.y = cy + dy * t;
    L.dx = dx;
    L.dy = dy;
  }

  /**
   * Edge arrow at this.loc: moves it in along its own line (steps of 1.05 em, at most 9) until its label —
   * `widthEm` wide, `lines` high, in the label's own em — lies on no panel and, with `other` (centre x / y,
   * half width / height of another marker's edge label + that marker's arrow at ox / oy), neither arrow nor
   * label of the one lies on arrow or label of the other.
   */
  private settleEdge(m: Marker, widthEm: number, lines: number, other: Float64Array | null, ox: number, oy: number): void {
    const L = this.loc;
    const em = this.em;
    const B = this.boxB;
    const k = this.keep;
    const pad = KEEP_PAD_EM * em;
    const gap = 0.3 * em;
    // half size of an edge arrow: a 2 em square, up to 2 em · √2 across when it is turned by 45°
    const arrow = 1.45 * em;
    const ang = Math.round(Math.atan2(L.dy, L.dx) * DEG);
    for (let step = 0; step < 9; step++) {
      this.edgeLabelBox(m, L.x, L.y, ang, widthEm, lines, B);
      let hit = false;
      for (let i = 0; i < this.keepCount && !hit; i++) {
        const j = i * 4;
        hit = B[0] + B[2] + gap > k[j] + pad && B[0] - B[2] - gap < k[j + 2] - pad && B[1] + B[3] + gap > k[j + 1] + pad && B[1] - B[3] - gap < k[j + 3] - pad;
      }
      if (!hit && other !== null) {
        hit =
          (Math.abs(other[0] - B[0]) < other[2] + B[2] + gap && Math.abs(other[1] - B[1]) < other[3] + B[3] + gap) || // label / label
          (Math.abs(other[0] - L.x) < other[2] + arrow && Math.abs(other[1] - L.y) < other[3] + arrow) || // other label / this arrow
          (Math.abs(B[0] - ox) < B[2] + arrow && Math.abs(B[1] - oy) < B[3] + arrow) || // this label / other arrow
          (Math.abs(L.x - ox) < 2 * arrow && Math.abs(L.y - oy) < 2 * arrow); // arrow / arrow
      }
      if (!hit) break;
      L.x -= L.dx * 1.05 * em;
      L.y -= L.dy * 1.05 * em;
    }
  }

  /** Apparent radius in CSS px of a sphere of `radius` metres at view depth `depth`. */
  private apparentPx(radius: number, depth: number): number {
    if (!(depth > 0.05)) return 0;
    return (radius * (this.h / 2)) / (TAN_HALF_FOV * depth);
  }

  // ───────────── lock target + corrected-aim markers ─────────────
  private updateLockMarkers(sim: Sim, project: Projector): void {
    const lock = sim.lock;
    const L = this.loc;
    const em = this.em;
    let enemy: EnemyState | undefined;
    if (lock.state !== 'none' && lock.targetId !== null) enemy = sim.enemyById.get(lock.targetId);
    if (!enemy) {
      hideMarker(this.tgt);
      hideMarker(this.aim);
      this.setLead(false, 0, 0, 0, 0, false);
      this.setTargetEdgeAim('');
      return;
    }
    // ── target marker: the target's CURRENT hit-volume centre ──
    this.locate(enemy.pos, sim, project);
    placeMarker(this.tgt, L);
    const tgtOn = L.on;
    const tx = L.x;
    const ty = L.y;
    const locked = lock.state === 'locked';
    const stateKey = locked ? 'lck' : 'acq';
    if (stateKey !== this.tgtStateKey) {
      this.tgtStateKey = stateKey;
      this.tgt.el.classList.toggle('lck', locked);
      this.tgt.el.classList.toggle('acq', !locked);
    }
    let half = this.apparentPx(enemy.radius, L.depth) * 1.3;
    half = Math.min(6.5 * em, Math.max(1.0 * em, half));
    // while acquiring the brackets close in on the target as the progress advances
    if (!locked) half *= 1 + 0.55 * (1 - Math.min(1, Math.max(0, lock.progress)));
    const boxKey = Math.round(half) * 2;
    if (boxKey !== this.tgtBoxKey) {
      this.tgtBoxKey = boxKey;
      const px = boxKey + 'px';
      this.tgtBox.style.width = px;
      this.tgtBox.style.height = px;
    }
    if (enemy.id !== this.tgtIdKey) {
      this.tgtIdKey = enemy.id;
      this.tgtId.data = enemy.id;
      this.tgtEdgeId.data = enemy.id + ' ';
    }
    const kind = enemy.isGateControl ? '制御砲台' : ENEMIES[enemy.kind].label;
    if (kind !== this.tgtKindKey) {
      this.tgtKindKey = kind;
      this.tgtKind.data = kind;
    }
    const m = sim.player.muzzle;
    const dist = Math.round(Math.hypot(enemy.pos.x - m.x, enemy.pos.y - m.y, enemy.pos.z - m.z));
    if (dist !== this.tgtDistKey) {
      this.tgtDistKey = dist;
      const s = dist + 'm';
      this.tgtDist.data = s;
      this.tgtEdgeDist.data = s;
    }
    const hpKey = enemy.maxHp > 0 && Number.isFinite(enemy.maxHp) ? Math.round(Math.min(1, Math.max(0, enemy.hp / enemy.maxHp)) * 50) : 50;
    if (hpKey !== this.tgtHpKey) {
      this.tgtHpKey = hpKey;
      this.tgtHp.style.transform = 'scaleX(' + hpKey / 50 + ')';
    }

    // ── corrected-aim marker: only with a COMPLETE lock and an evaluated solution ──
    const fc = sim.fireControl;
    const aimPoint = fc.aimPoint;
    if (!locked || fc.status === 'inactive' || aimPoint === null || fc.targetId !== lock.targetId) {
      hideMarker(this.aim);
      this.setLead(false, 0, 0, 0, 0, false);
      this.setTargetEdgeAim('');
      return;
    }
    const noSol = fc.status === 'no_solution';
    this.locate(aimPoint, sim, project);
    if (!tgtOn && !L.on && Math.hypot(L.x - tx, L.y - ty) < 6 * em) {
      // both markers are edge arrows at (almost) the same place: one arrow, the aim status in its label
      hideMarker(this.aim);
      this.setLead(false, 0, 0, 0, 0, noSol);
      this.setTargetEdgeAim(noSol ? 'no_solution' : 'solved');
      return;
    }
    this.setTargetEdgeAim('');
    placeMarker(this.aim, L);
    // near the top edge the tag goes below the diamond so it stays on screen
    const flip = L.on && L.y < 3.4 * em;
    if (flip !== this.aimFlip) {
      this.aimFlip = flip;
      this.aim.el.classList.toggle('flip', flip);
    }
    if (fc.status !== this.aimStatusKey) {
      this.aimStatusKey = fc.status;
      this.aim.el.classList.toggle('nosol', noSol);
      this.aimMain.data = noSol ? '補正解なし NO SOLUTION' : '補正中 LEAD';
      this.aimEdge.data = noSol ? '補正解なし NO SOLUTION' : '補正中 LEAD';
      this.aimSubKey = -2;
    }
    const subKey = noSol || fc.flightSeconds === null ? -1 : Math.round(fc.flightSeconds * 100);
    if (subKey !== this.aimSubKey) {
      this.aimSubKey = subKey;
      this.aimSub.data = subKey < 0 ? '直接照準' : (subKey / 100).toFixed(2) + 's';
    }
    // thin line joining target and aim markers (both on screen, far enough apart)
    if (tgtOn && L.on) {
      const ddx = L.x - tx;
      const ddy = L.y - ty;
      const d = Math.hypot(ddx, ddy);
      const startGap = half * 0.75;
      const endGap = 1.05 * em;
      if (d > startGap + endGap + 4) {
        const ux = ddx / d;
        const uy = ddy / d;
        this.setLead(true, tx + ux * startGap, ty + uy * startGap, Math.atan2(uy, ux), d - startGap - endGap, noSol);
        return;
      }
    }
    this.setLead(false, 0, 0, 0, 0, noSol);
  }

  /** Aim status line inside the target's edge label ('' = none). */
  private setTargetEdgeAim(key: '' | 'solved' | 'no_solution'): void {
    if (key === this.tgtEdgeAimKey) return;
    this.tgtEdgeAimKey = key;
    this.tgtEdgeAim.classList.toggle('is-off', key === '');
    this.tgtEdgeAim.classList.toggle('nosol', key === 'no_solution');
    this.tgtEdgeAimText.data = key === 'no_solution' ? '補正解なし NO SOLUTION' : key === 'solved' ? '補正中 LEAD' : '';
  }

  private setLead(show: boolean, x: number, y: number, a: number, len: number, noSol: boolean): void {
    if (show !== this.leadShown) {
      this.leadShown = show;
      this.leadLine.classList.toggle('is-off', !show);
    }
    if (!show) return;
    if (noSol !== this.leadNoSol) {
      this.leadNoSol = noSol;
      this.leadLine.classList.toggle('nosol', noSol);
    }
    const rx = Math.round(x * 2) / 2;
    const ry = Math.round(y * 2) / 2;
    const ra = Math.round(a * 200) / 200;
    const rl = Math.round(len);
    if (rx !== this.leadX || ry !== this.leadY || ra !== this.leadA || rl !== this.leadLen) {
      this.leadX = rx;
      this.leadY = ry;
      this.leadA = ra;
      this.leadLen = rl;
      this.leadLine.style.transform = 'translate3d(' + rx + 'px,' + ry + 'px,0) rotate(' + ra + 'rad) scaleX(' + rl + ')';
    }
  }

  // ───────────── objective waypoint ─────────────
  private updateObjective(sim: Sim, project: Projector, dt: number): void {
    this.objTimer -= dt;
    if (this.objDirty || this.objTimer <= 0 || !this.objValid) {
      // getObjectiveTarget() allocates, so it is polled at a low rate and on objective events only.
      const o = sim.getObjectiveTarget();
      this.objDirty = false;
      this.objValid = true;
      this.objTimer = OBJECTIVE_REFRESH_SECONDS;
      this.objPos.x = o.position.x;
      this.objPos.y = o.position.y;
      this.objPos.z = o.position.z;
      if (o.kind !== this.objKind) {
        this.objKind = o.kind;
        this.obj.el.classList.toggle('exit', o.kind === 'exit');
      }
      if (o.label !== this.objLabel) {
        this.objLabel = o.label;
        this.objText.data = o.label;
        this.layoutDirty = true;
      }
      const name = o.kind === 'exit' ? '脱出 EXIT' : o.id !== null ? '目標 ' + o.id : '目標';
      if (name !== this.objNameKey) {
        this.objNameKey = name;
        this.objName.data = name;
        const edgeName = o.kind === 'exit' ? '脱出 EXIT ' : '目標 ';
        this.objEdgeName.data = edgeName;
        this.objTagEm = textEm(name) + 3.2; // + the distance ("123m") and its gap
        this.objEdgeEm = textEm(edgeName) + 2.6;
      }
    }
    // Distance from the MUZZLE, like the tag of the lock target: one target never shows two different
    // distances (the muzzle distance is also the one the 120 m FCS range is judged with).
    const pp = sim.player.muzzle;
    const op = this.objPos;
    const dist = Math.round(Math.hypot(op.x - pp.x, op.y - pp.y, op.z - pp.z));
    if (dist !== this.objDistKey) {
      this.objDistKey = dist;
      const s = dist + 'm';
      this.objDist.data = s;
      this.objEdgeDist.data = s;
      this.objPanelDist.data = s;
    }
    // hover the pin above the turret so it does not cover the lock brackets
    let lift = 0;
    if (this.objKind === 'control' && project(op, this.proj)) {
      lift = Math.min(4 * this.em, this.apparentPx(ENEMIES.turret.radius, this.proj.depth) * 1.3 + 0.2 * this.em);
    }
    // pin + tag (.hud-otag: font 0.7 em, one line, 1.95 em above the anchor; the pin is 1.6 em × 1.75 em)
    const te = 0.7 * this.em;
    const tagHalfW = (this.objTagEm * te) / 2;
    this.locate(op, sim, project, Math.max(tagHalfW, 0.8 * this.em), 3.15 * te, 0, lift);
    const L = this.loc;
    let noTag = false;
    if (L.on) {
      // The tag never lies on the lock-state label under the circle: there only the pin remains (the distance
      // is still in the top-left panel).
      noTag = this.hitsLockLabel(L.x, L.y - 1.95 * te - 0.6 * te, tagHalfW, 0.6 * te);
    } else {
      this.settleEdge(this.obj, this.objEdgeEm, 1, null, 0, 0);
    }
    if (noTag !== this.objNoTag) {
      this.objNoTag = noTag;
      this.obj.el.classList.toggle('no-tag', noTag);
    }
    placeMarker(this.obj, L);
  }

  /**
   * True when the box (centre x / y, half width / height in CSS px) touches the lock-state label under the lock
   * circle. The label's width is read from the layout once per text / scale change.
   */
  private hitsLockLabel(x: number, y: number, halfW: number, halfH: number): boolean {
    const em = this.em;
    const top = this.cy + this.lockR + 0.55 * em;
    // (.hud-locklabel: font 0.8 em, line 1.25, padding 0.26 em, border 2 px)
    const halfLabelH = (0.8 * em * 1.51 + 2) / 2;
    const gap = 0.25 * em;
    if (Math.abs(y - (top + halfLabelH)) >= halfH + halfLabelH + gap) return false;
    if (this.lockLabelHalfW < 0) this.lockLabelHalfW = this.lockLabel.offsetWidth / 2;
    return Math.abs(x - this.cx) < halfW + this.lockLabelHalfW + gap;
  }

  /** Centre and half size (CSS px) of a marker's edge label for an arrow at (x, y) pointing along `angDeg`. */
  private edgeLabelBox(m: Marker, x: number, y: number, angDeg: number, widthEm: number, lines: number, out: Float64Array): void {
    // (.hud-mk-elabel: font 0.72 em, line 1.15, padding 0.1 em / 0.4 em, border 1 px; see placeMarker)
    const fe = 0.72 * this.em;
    const a = angDeg / DEG;
    out[0] = x - Math.cos(a) * m.labelRx * fe;
    out[1] = y - Math.sin(a) * m.labelRy * fe;
    // (textEm under-estimates bold Latin capitals and the letter spacing by up to 13 %: 15 % is added)
    out[2] = (widthEm * 1.15 * fe) / 2 + 0.4 * fe + 1;
    out[3] = (lines * 1.15 * fe) / 2 + 0.1 * fe + 1;
  }

  // ───────────── route guidance: the next point of the recommended route (sim.guide) ─────────────
  /**
   * Marker at the hint of src/sim/guide.ts (edge arrow when off-screen / behind) and the "進路" row of the
   * top-left panel. The marker stays out of the way: it is drawn under every other marker, fades inside the
   * lock circle and near the reticle, fades out when the point is closer than ROUTE_NEAR_FULL metres, and gives
   * way to the objective pin when both would sit on the same spot or the control turret is in view.
   * States differ in shape and text, never in colour alone: chevrons down / up / down with a ground bar, and
   * the words NEXT / FIRE POS / BACK / REJOIN / ▲ FLY +n m / ▼ DROP n m (+ the boxed "■ 隔壁 … 閉鎖" line).
   */
  private updateRoute(sim: Sim, project: Projector): void {
    const h = getRouteHint(sim);
    if (h === null) {
      hideMarker(this.route);
      if (this.routeRowOn !== false) {
        this.routeRowOn = false;
        this.routeRow.classList.add('is-off');
        this.layoutDirty = true;
      }
      return;
    }
    const em = this.em;
    const mk = this.route;
    const blocked = h.blockedByBarrierId !== null;
    const mode = blocked ? ROUTE_FIRE : h.backtrack ? ROUTE_BACK : h.offRouteMeters > ROUTE_OFF_METERS ? ROUTE_REJOIN : ROUTE_NEXT;
    const kind = h.kind === 'climb' ? 1 : h.kind === 'drop' ? 2 : 0;
    const rise = kind === 0 ? 0 : Math.min(999, Math.round(Math.abs(h.rise)));

    // ── texts (rebuilt only when something shown changes) ──
    const key = kind + mode * 4 + rise * 16;
    let relabel = false;
    if (key !== this.routeKey) {
      this.routeKey = key;
      // off the route the point is where to rejoin it, not a flight / drop instruction: only the height is added
      const main =
        (mode === ROUTE_REJOIN
          ? ROUTE_MODE_TEXT[mode] + (kind === 1 ? ' ▲+' + rise + 'm' : kind === 2 ? ' ▼' + rise + 'm' : '')
          : kind === 1
            ? '▲ 飛行 FLY +' + rise + 'm'
            : kind === 2
              ? '▼ 降下 DROP ' + rise + 'm'
              : ROUTE_MODE_TEXT[mode]) + ' ';
      this.routeMain.data = main;
      this.routeEdgeMain.data = main;
      this.routeMainEm = textEm(main) + 2.6; // + the distance ("123m")
      relabel = true;
      if (kind !== this.routeKind) {
        this.routeKind = kind;
        mk.el.classList.toggle('climb', kind === 1);
        mk.el.classList.toggle('drop', kind === 2);
      }
      this.routeSub.classList.toggle('is-off', kind !== 1 || mode === ROUTE_REJOIN);
    }
    if (h.blockedByBarrierId !== this.routeBlkId || h.controlEnemyId !== this.routeBlkEnemy) {
      this.routeBlkId = h.blockedByBarrierId;
      this.routeBlkEnemy = h.controlEnemyId;
      const t = blocked ? '■ ' + this.routeBlockText(sim, h) : '';
      this.routeBlkText.data = t;
      this.routeEdgeBlkText.data = t;
      this.routeBlk.classList.toggle('is-off', !blocked);
      this.routeEdgeBlk.classList.toggle('is-off', !blocked);
      this.routeBlkEm = textEm(t) * 0.95;
      relabel = true;
    }
    if (relabel) {
      // the edge label sits beside its arrow at the left / right edge: half its (estimated) width + the arrow
      mk.labelRx = Math.max(this.routeMainEm, this.routeBlkEm) / 2 + 2.3;
      mk.ang = NaN;
    }
    const dist = Math.round(h.distance);
    if (dist !== this.routeDistKey) {
      this.routeDistKey = dist;
      const s = dist + 'm';
      this.routeDist.data = s;
      this.routeEdgeDist.data = s;
    }
    this.updateRouteRow(sim, h, kind, mode, rise);

    // ── placement and fading ──
    // the control turret is in view from here: the objective pin is all the player needs
    let fade = blocked && h.controlVisible ? 0 : 1;
    if (h.distance < ROUTE_NEAR_FULL) fade = Math.min(fade, (h.distance - ROUTE_NEAR_HIDE) / (ROUTE_NEAR_FULL - ROUTE_NEAR_HIDE));
    if (!(fade > 0)) {
      hideMarker(mk);
      return;
    }
    {
      // chevrons + tag (.hud-rtag: font 0.7 em, line 1.2; above the chevrons, or below them when flipped)
      const te = 0.7 * em;
      const tagLines = 1 + (kind === 1 && mode !== ROUTE_REJOIN ? 1 : 0) + (blocked ? 1.5 : 0);
      const tagW = (blocked ? Math.max(this.routeMainEm, this.routeBlkEm) : this.routeMainEm) * te;
      this.locate(h.position, sim, project, tagW / 2, (1.55 + tagLines * 1.2) * te, (1.1 + tagLines * 1.2) * te, 0);
    }
    const L = this.loc;
    const obj = this.obj;
    let inLock = false;
    let underPin = false;
    let lockBusy = false;
    if (L.on) {
      if (obj.shown && !obj.edge && Math.hypot(L.x - obj.x, L.y - obj.y) < 4.2 * em) {
        const op = this.objPos;
        if (this.objValid && Math.hypot(op.x - h.position.x, op.y - h.position.y, op.z - h.position.z) < 14) {
          // the hint IS the objective (the exit zone): the pin is enough
          hideMarker(mk);
          return;
        }
        // another place in the same direction (a control turret far behind the next waypoint): the pin keeps
        // its tag above, the route tag goes below the chevrons
        underPin = true;
      }
      const d = Math.hypot(L.x - this.cx, L.y - this.cy);
      const r = this.lockR;
      if (d < r + 1.2 * em) {
        // inside the lock circle: dimmed, most of all near the reticle and while a target is being locked;
        // a climb / drop cue stays a little stronger (it is what the player has to act on)
        inLock = true;
        const busy = sim.lock.state !== 'none';
        lockBusy = busy;
        const near = d < Math.max(0.45 * r, 2.6 * em);
        let cap = busy ? (near ? 0.22 : 0.4) : near ? 0.7 : 0.85;
        if (!busy && kind !== 0) cap = 0.85;
        if (fade > cap) fade = cap;
      }
    } else {
      // Edge arrow: it moves in along its own line until its label lies on no panel and — when the objective
      // is an edge arrow as well (that one stays where it is) — until neither arrow nor label of the one lies
      // on arrow or label of the other. (Judged with the label boxes: a label is up to 12 em wide, so two
      // arrows 10 em apart at the bottom edge can still collide.)
      const both = obj.shown && obj.edge;
      if (both) this.edgeLabelBox(obj, obj.x, obj.y, obj.ang, this.objEdgeEm, 1, this.boxA);
      this.settleEdge(mk, blocked ? Math.max(this.routeMainEm, this.routeBlkEm) : this.routeMainEm, blocked ? 2 : 1, both ? this.boxA : null, obj.x, obj.y);
    }
    placeMarker(mk, L);
    // near the top edge the tag goes below the chevrons so it stays on screen
    let flip = L.on && (underPin || L.y < 5 * em);
    // The tag never lies across the centre reticle (the aiming point must stay readable, SPEC §8). Where it
    // would, it moves to the other side of the chevrons; where that side is taken as well (the point is dead
    // ahead, or the objective pin's tag sits there) only the chevrons remain — the distance is still in the
    // "進路" row of the top-left panel. Sizes are those of .hud-rtag in hud.css (font 0.7 em, line 1.2,
    // 1.55 em above / 1.1 em below the anchor); once dodging, the tag returns a little later (no flicker).
    let dodge = 0;
    if (L.on) {
      const te = 0.7 * em;
      const lines = inLock ? 1 : 1 + (kind === 1 && mode !== ROUTE_REJOIN ? 1 : 0) + (blocked ? 1.5 : 0);
      const halfW = ((inLock || !blocked ? this.routeMainEm : Math.max(this.routeMainEm, this.routeBlkEm)) * te) / 2;
      const keep = (RETICLE_KEEP_EM + (this.routeDodge !== 0 ? 0.4 : 0)) * em;
      if (Math.abs(L.x - this.cx) < halfW + keep) {
        const tagH = lines * 1.2 * te;
        const dy = L.y - this.cy;
        const hitsAbove = dy - 1.55 * te > -keep && dy - 1.55 * te - tagH < keep;
        const hitsBelow = dy + 1.1 * te < keep && dy + 1.1 * te + tagH > -keep;
        if (flip ? hitsBelow : hitsAbove) {
          if (!flip && !hitsBelow) {
            flip = true;
            dodge = 1;
          } else dodge = 2;
        }
      }
      // Only the chevrons remain as well: while a target is being locked / is locked inside the lock circle
      // (its brackets, its tag and the aim marker are there), and where the tag would lie on the lock-state
      // label under the circle or on the tag of the objective pin.
      if (dodge !== 2) {
        const tagH = lines * 1.2 * te;
        const tagY = flip ? L.y + 1.1 * te + tagH / 2 : L.y - 1.55 * te - tagH / 2;
        if (lockBusy || this.hitsLockLabel(L.x, tagY, halfW, tagH / 2)) dodge = 2;
        else if (obj.shown && !obj.edge && !this.objNoTag) {
          const ote = 0.7 * em;
          const oy = obj.y - 1.95 * ote - 0.6 * ote;
          if (Math.abs(L.x - obj.x) < halfW + (this.objTagEm * ote) / 2 + 0.2 * em && Math.abs(tagY - oy) < tagH / 2 + 0.6 * ote + 0.15 * em) dodge = 2;
        }
      }
    }
    if (flip !== this.routeFlip) {
      this.routeFlip = flip;
      mk.el.classList.toggle('flip', flip);
    }
    if (dodge !== this.routeDodge) {
      if ((dodge === 2) !== (this.routeDodge === 2)) mk.el.classList.toggle('no-tag', dodge === 2);
      this.routeDodge = dodge;
    }
    // near the left / right edge the tag is aligned to its inner side instead of centred (the longest line,
    // "■ 隔壁 … 閉鎖 — 制御砲台 … を破壊", is about 16 em wide)
    const side = !L.on ? 0 : L.x > this.w - 9 * em ? 1 : L.x < 9 * em ? -1 : 0;
    if (side !== this.routeSide) {
      this.routeSide = side;
      mk.el.classList.toggle('tag-l', side < 0);
      mk.el.classList.toggle('tag-r', side > 0);
    }
    if (inLock !== this.routeInLock) {
      this.routeInLock = inLock;
      mk.el.classList.toggle('in-lock', inLock);
    }
    const q = Math.max(1, Math.ceil(fade * FADE_LEVELS));
    if (q !== this.routeFade) {
      this.routeFade = q;
      mk.el.style.opacity = FADE_STR[q];
    }
  }

  /** "隔壁 B3 閉鎖 — 制御砲台 T06 を破壊" (the hint is the firing position in front of a closed barrier). */
  private routeBlockText(sim: Sim, h: RouteHint): string {
    const id = h.blockedByBarrierId;
    if (id === sim.stage.finalGate.id) return '最終ゲート閉鎖 — 制御砲台を全て破壊';
    return '隔壁 ' + id + ' 閉鎖 — ' + (h.controlEnemyId !== null ? '制御砲台 ' + h.controlEnemyId + ' を破壊' : '制御砲台を破壊');
  }

  /** The "進路" row of the top-left panel: the next leg in words + route metres left to the current goal. */
  private updateRouteRow(sim: Sim, h: RouteHint, kind: number, mode: number, rise: number): void {
    if (this.routeRowOn !== true) {
      this.routeRowOn = true;
      this.routeRow.classList.remove('is-off');
      this.layoutDirty = true;
    }
    const exitGoal = sim.objective.gateOpen;
    const key = kind + mode * 4 + rise * 16 + (h.controlVisible ? 16384 : 0) + (exitGoal ? 32768 : 0);
    if (key !== this.routeRowKey || h.nextSectorId !== this.routeRowSector || h.blockedByBarrierId !== this.routeRowBlk || h.controlEnemyId !== this.routeRowEnemy) {
      this.routeRowKey = key;
      this.routeRowSector = h.nextSectorId;
      this.routeRowBlk = h.blockedByBarrierId;
      this.routeRowEnemy = h.controlEnemyId;
      // where the leg leads: the next sector on the route, else the goal inside the current sector
      let dest = exitGoal ? '脱出領域' : '射撃位置';
      if (h.nextSectorId !== null) {
        dest = h.nextSectorId;
        const sectors = sim.stage.sectors;
        for (let i = 0; i < sectors.length; i++) {
          if (sectors[i].id === h.nextSectorId) {
            dest = h.nextSectorId + ' ' + sectors[i].name;
            break;
          }
        }
      }
      const how = kind === 1 ? '▲ 上へ飛行 +' + rise + 'm（Space長押し）' : kind === 2 ? '▼ 下へ降下 ' + rise + 'm ' : '';
      let t: string;
      if (mode === ROUTE_FIRE) {
        t = how + '■ ' + this.routeBlockText(sim, h) + (h.controlVisible ? '（射線あり）' : h.backtrack ? '（戻れ）' : '');
      } else if (mode === ROUTE_BACK) t = how + '↩ 戻る → 射撃位置（隔壁は閉鎖中）';
      else if (mode === ROUTE_REJOIN) t = '経路外 — 合流 → ' + dest + (kind === 1 ? '（▲ ' + rise + 'm 上）' : kind === 2 ? '（▼ ' + rise + 'm 下）' : '');
      else t = how + '→ ' + dest;
      this.routeRowText.data = t;
      this.layoutDirty = true;
    }
    const rem = Math.round(h.remainingMeters);
    if (rem !== this.routeRowDistKey) {
      this.routeRowDistKey = rem;
      this.routeRowDist.data = '残り ' + rem + 'm';
      const digits = rem < 10 ? 1 : rem < 100 ? 2 : rem < 1000 ? 3 : 4;
      if (digits !== this.routeRowDigits) {
        this.routeRowDigits = digits;
        this.layoutDirty = true;
      }
    }
  }

  // ───────────── telegraph warnings ─────────────
  private addTelegraph(enemyId: string, duration: number, t: number): void {
    let slot: TeleSlot | null = null;
    let oldest: TeleSlot = this.tele[0];
    for (let i = 0; i < this.tele.length; i++) {
      const s = this.tele[i];
      if (s.active && s.enemyId === enemyId) {
        slot = s;
        break;
      }
      if (!s.active && slot === null) slot = s;
      if (s.endAt < oldest.endAt) oldest = s;
    }
    if (slot === null) slot = oldest;
    slot.active = true;
    slot.enemyId = enemyId;
    slot.endAt = t + (duration > 0 ? duration : 0);
  }

  private updateTelegraphs(sim: Sim, project: Projector): void {
    const t = sim.time;
    const em = this.em;
    for (let i = 0; i < this.tele.length; i++) {
      const s = this.tele[i];
      if (!s.active) continue;
      const enemy = sim.enemyById.get(s.enemyId);
      if (!enemy || !enemy.alive || t >= s.endAt + TELE_TAIL) {
        s.active = false;
        hideMarker(s.m);
        continue;
      }
      if (enemy.kind !== s.kind) {
        s.kind = enemy.kind;
        s.m.el.classList.toggle('turret', enemy.kind === 'turret');
      }
      const tail = t >= s.endAt;
      if (tail !== s.tail) {
        s.tail = tail;
        s.m.el.classList.toggle('tail', tail);
      }
      this.locate(enemy.pos, sim, project);
      placeMarker(s.m, this.loc);
      if (this.loc.on) {
        const px = Math.round(Math.min(11 * em, Math.max(2.2 * em, this.apparentPx(enemy.radius, this.loc.depth) * 3.2)));
        if (px !== s.ringPx) {
          s.ringPx = px;
          const v = px + 'px';
          s.ring.style.width = v;
          s.ring.style.height = v;
        }
      }
    }
  }

  // ───────────── damage direction ─────────────
  private addDamage(src: V3, amount: number, enemyId: string | null, t: number): void {
    let slot: DamageSlot | null = null;
    let oldest: DamageSlot = this.dmg[0];
    for (let i = 0; i < this.dmg.length; i++) {
      const d = this.dmg[i];
      if (d.active && enemyId !== null && d.enemyId === enemyId) {
        slot = d;
        break;
      }
      if (!d.active && slot === null) slot = d;
      if (d.at < oldest.at) oldest = d;
    }
    if (slot === null) slot = oldest;
    if (!slot.active) {
      slot.active = true;
      slot.el.style.display = '';
    }
    slot.at = t;
    slot.src.x = src.x;
    slot.src.y = src.y;
    slot.src.z = src.z;
    slot.enemyId = enemyId;
    const heavy = amount >= ENEMIES.turret.damage;
    if (heavy !== slot.heavy) {
      slot.heavy = heavy;
      slot.el.setAttribute('class', heavy ? 'hud-dmg heavy' : 'hud-dmg');
    }
  }

  private updateDamage(sim: Sim): void {
    const t = sim.time;
    const pl = sim.player;
    const sy = Math.sin(pl.yaw);
    const cyw = Math.cos(pl.yaw);
    for (let i = 0; i < this.dmg.length; i++) {
      const d = this.dmg[i];
      if (!d.active) continue;
      const age = t - d.at;
      if (age >= DAMAGE_FADE || age < -1e-6) {
        d.active = false;
        d.el.style.display = 'none';
        continue;
      }
      // bearing of the source relative to the camera yaw: 0 = ahead (top), +90° = right, 180° = behind (bottom)
      const rx = d.src.x - pl.pos.x;
      const rz = d.src.z - pl.pos.z;
      const fwd = -rx * sy - rz * cyw;
      const right = rx * cyw - rz * sy;
      const ang = fwd === 0 && right === 0 ? 0 : Math.round(Math.atan2(right, fwd) * DEG);
      if (ang !== d.ang) {
        d.ang = ang;
        d.el.setAttribute('transform', 'rotate(' + ang + ')');
      }
      const a = age <= DAMAGE_HOLD ? 1 : 1 - (age - DAMAGE_HOLD) / (DAMAGE_FADE - DAMAGE_HOLD);
      const q = Math.max(1, Math.ceil(a * FADE_LEVELS));
      if (q !== d.fade) {
        d.fade = q;
        d.el.style.opacity = FADE_STR[q];
      }
    }
  }

  // ───────────── weapon panel ─────────────
  private addFireReject(weapon: Weapon, reason: FireRejectReason, t: number): void {
    let code = NOTICE_NONE;
    if (reason === 'no-lock') {
      code = NOTICE_NO_LOCK;
      this.lockRejectUntil = t + NOTICE_SECONDS;
    } else if (reason === 'no-en') code = NOTICE_NO_EN;
    else code = weapon === 'missile' ? NOTICE_EMPTY_MSL : NOTICE_EMPTY_MG;
    this.noticeEventCode = code;
    this.noticeUntil = t + NOTICE_SECONDS;
  }

  private updateWeapons(sim: Sim): void {
    const p = sim.player;
    const t = sim.time;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const w = row.weapon;
      const cfg = WEAPONS[w];
      const selected = p.weapon === w;
      if (selected !== row.selected) {
        row.selected = selected;
        row.el.classList.toggle('selected', selected);
      }
      const ammo = w === 'machinegun' ? p.ammo.machinegun : w === 'missile' ? p.ammo.missile : Infinity;
      if (row.ammoText !== null && ammo !== row.ammoKey) {
        row.ammoKey = ammo;
        row.ammoText.data = String(ammo);
      }
      const remaining = p.nextFireAt[w] - t;
      let st: WeaponStatus = 'ready';
      if (ammo <= 0) st = 'empty';
      else if (cfg.enCost > 0 && p.en < cfg.enCost) st = 'noen';
      else if (cfg.requiresLock && sim.lock.state !== 'locked') st = 'nolock';
      else if (remaining > 1e-9 && cfg.interval >= 0.5) st = 'cool';
      const statKey = st === 'cool' ? Math.ceil(remaining * 10 - 1e-6) : 0;
      if (st !== row.status || statKey !== row.statKey) {
        if (st !== row.status) row.el.setAttribute('data-st', st);
        row.status = st;
        row.statKey = statKey;
        row.statText.data =
          st === 'ready' ? 'READY' : st === 'empty' ? '弾切れ' : st === 'noen' ? 'EN不足' : st === 'nolock' ? '要ロック' : (statKey / 10).toFixed(1) + 's';
      }
      // ready/cooldown bar from nextFireAt (full = ready)
      const f = remaining <= 0 ? 1 : 1 - Math.min(1, remaining / cfg.interval);
      const cdKey = Math.round(f * 40);
      if (cdKey !== row.cdKey) {
        row.cdKey = cdKey;
        row.cd.style.transform = 'scaleX(' + cdKey / 40 + ')';
      }
    }
    // notice: a rejected trigger pull for ~1 s, otherwise "empty" for as long as the selected magazine is empty
    let code = NOTICE_NONE;
    let flash = false;
    if (t < this.noticeUntil) {
      code = this.noticeEventCode;
      flash = true;
    } else if (p.weapon === 'machinegun' && p.ammo.machinegun <= 0) code = NOTICE_EMPTY_MG;
    else if (p.weapon === 'missile' && p.ammo.missile <= 0) code = NOTICE_EMPTY_MSL;
    if (code !== this.noticeCode) {
      this.noticeCode = code;
      this.noticeText.data = code === NOTICE_NONE ? ' ' : NOTICE_TEXT[code];
      this.notice.classList.toggle('on', code !== NOTICE_NONE);
    }
    if (flash !== this.noticeFlash) {
      this.noticeFlash = flash;
      this.notice.classList.toggle('flash', flash);
    }
  }

  // ───────────── EN, quick boost, movement mode ─────────────
  private updateEnergy(sim: Sim): void {
    const p = sim.player;
    const t = sim.time;
    const maxEn = sim.stats.maxEn;
    const en = p.en;
    const enKey = Math.round(en * 10);
    if (enKey !== this.enKey) {
      this.enKey = enKey;
      this.enNum.data = (enKey / 10).toFixed(1);
    }
    if (maxEn !== this.enMaxKey) {
      this.enMaxKey = maxEn;
      this.enMax.data = '/ ' + maxEn;
      this.enMark.style.left = ((PLAYER.qbCost / maxEn) * 100).toFixed(2) + '%';
      this.enMarkText.data = 'QB ' + PLAYER.qbCost;
    }
    const frac = maxEn > 0 ? Math.min(1, Math.max(0, en / maxEn)) : 0;
    const fillKey = Math.round(frac * 500);
    if (fillKey !== this.enFillKey) {
      this.enFillKey = fillKey;
      this.enFill.style.transform = 'translateX(' + (fillKey / 5 - 100).toFixed(1) + '%)';
    }
    // regenerating / waiting / airborne hint — the same conditions the simulation uses (SPEC §6)
    const waitLeft = p.lastEnSpentAt === null ? 0 : p.lastEnSpentAt + PLAYER.enRegenDelaySeconds - t;
    let st: EnStatus;
    if (p.flying) st = 'use';
    else if (!p.grounded) st = 'air';
    else if (en >= maxEn - 1e-6) st = 'full';
    else if (waitLeft > 1e-9) st = 'wait';
    else st = 'regen';
    const subKey = st === 'wait' ? Math.ceil(waitLeft * 10 - 1e-6) : st === 'regen' ? Math.round(sim.stats.regenPerSecond * 100) : 0;
    if (st !== this.enStatus) {
      this.enStatus = st;
      this.right.setAttribute('data-en', st);
      this.enStateMain.data =
        st === 'use'
          ? '▼ 飛行消費 −' + PLAYER.flyEnPerSecond + '/s'
          : st === 'air'
            ? '✕ 空中 — 回復停止'
            : st === 'full'
              ? '■ FULL 最大'
              : st === 'wait'
                ? '… 回復待ち '
                : '▲ 回復中 ';
      this.enSubKey = -1;
    }
    if (subKey !== this.enSubKey) {
      this.enSubKey = subKey;
      this.enStateSub.data =
        st === 'wait' ? (subKey / 10).toFixed(1) + 's' : st === 'regen' ? '+' + (subKey / 100).toFixed(subKey % 10 === 0 ? 1 : 2) + '/s' : '';
    }
    const low = en < PLAYER.qbCost;
    if (low !== this.enLow) {
      this.enLow = low;
      this.right.classList.toggle('en-low', low);
    }

    // quick boost: cooldown countdown → EN shortage → brake held → ready
    const cdLeft = p.qbLastStartedAt === null ? 0 : p.qbLastStartedAt + PLAYER.qbCooldownSeconds - t;
    let qs: QbStatus;
    if (cdLeft > 1e-9) qs = 'cool';
    else if (low) qs = 'noen';
    else if (p.braking) qs = 'brake';
    else qs = 'ready';
    const qbKey = qs === 'cool' ? Math.ceil(cdLeft * 100 - 1e-6) : 0;
    if (qs !== this.qbStatus || qbKey !== this.qbTextKey) {
      if (qs !== this.qbStatus) this.qb.setAttribute('data-qb', qs);
      this.qbStatus = qs;
      this.qbTextKey = qbKey;
      this.qbText.data = qs === 'cool' ? (qbKey / 100).toFixed(2) + 's' : qs === 'noen' ? 'EN不足' : qs === 'brake' ? 'ブレーキ中' : 'READY';
    }
    const barKey = cdLeft > 0 ? Math.round((1 - Math.min(1, cdLeft / PLAYER.qbCooldownSeconds)) * 50) : 50;
    if (barKey !== this.qbBarKey) {
      this.qbBarKey = barKey;
      this.qbBar.style.transform = 'scaleX(' + barKey / 50 + ')';
    }
    if (low !== this.qbCostWarn) {
      this.qbCostWarn = low;
      this.qbCost.classList.toggle('warn', low);
    }
    const rejecting = t < this.qbRejectUntil;
    if (rejecting !== this.qbRejectOn) {
      this.qbRejectOn = rejecting;
      this.qb.classList.toggle('reject', rejecting);
    }

    // movement mode: horizontal and vertical are separate readouts
    const hm: HMode = p.horizontalMode === 'quickboost' ? 'quickboost' : p.braking ? 'brake' : p.horizontalMode === 'glide' ? 'glide' : 'walk';
    if (hm !== this.hMode) {
      this.hMode = hm;
      this.hModeEl.setAttribute('data-m', hm);
      this.hModeText.data = HMODE_TEXT[hm];
    }
    const vm: VMode = p.flying ? 'flying' : p.verticalMode;
    if (vm !== this.vMode) {
      this.vMode = vm;
      this.vModeEl.setAttribute('data-m', vm);
      this.vModeText.data = VMODE_TEXT[vm];
    }
    const spKey = Math.round(Math.hypot(p.vel.x, p.vel.z) * 10);
    if (spKey !== this.speedKey) {
      this.speedKey = spKey;
      this.speedText.data = (spKey / 10).toFixed(1);
    }
    if (p.glideEnabled !== this.glideKey) {
      this.glideKey = p.glideEnabled;
      this.glideText.data = p.glideEnabled ? 'グライド ON（消費 0 EN）' : 'グライド OFF';
    }
  }

  // ───────────── HP ─────────────
  private updateHp(sim: Sim, dt: number): void {
    const hp = sim.player.hp;
    const max = PLAYER.maxHp;
    const hpKey = Math.max(0, Math.ceil(hp - 1e-9));
    if (hpKey !== this.hpKey) {
      this.hpKey = hpKey;
      this.hpNum.data = String(hpKey);
    }
    const frac = Math.min(1, Math.max(0, hp / max));
    const fillKey = Math.round(frac * 500);
    if (fillKey !== this.hpFillKey) {
      this.hpFillKey = fillKey;
      this.hpFill.style.transform = 'translateX(' + (fillKey / 5 - 100).toFixed(1) + '%)';
    }
    // white "recent damage" bar trailing the real value
    let ghost = this.hpGhost01;
    if (ghost < 0 || ghost < frac) ghost = frac;
    else if (ghost > frac) ghost = Math.max(frac, ghost - dt * 0.45);
    this.hpGhost01 = ghost;
    const ghostKey = Math.round(ghost * 500);
    if (ghostKey !== this.hpGhostKey) {
      this.hpGhostKey = ghostKey;
      this.hpGhost.style.transform = 'translateX(' + (ghostKey / 5 - 100).toFixed(1) + '%)';
    }
    const band = frac < LOW_HP_FRACTION ? 'low' : frac < MID_HP_FRACTION ? 'mid' : 'ok';
    if (band !== this.hpBand) {
      this.hpBand = band;
      this.bottom.setAttribute('data-hp', band);
      this.hud.classList.toggle('low-hp', band === 'low');
    }
  }

  // ───────────── top: sector, control turrets, barriers, gate, toasts ─────────────
  private updateTop(sim: Sim): void {
    const t = sim.time;
    const id = sim.currentSectorId;
    if (id !== this.sectorKey) {
      this.sectorKey = id;
      let name = '— 区画外';
      let en = '';
      if (id !== null) {
        const sectors = sim.stage.sectors;
        name = id;
        for (let i = 0; i < sectors.length; i++) {
          if (sectors[i].id === id) {
            name = id + ' ' + sectors[i].name;
            en = sectors[i].nameEn;
            break;
          }
        }
      }
      this.sectorText.data = name;
      this.sectorEn.data = en;
      this.layoutDirty = true;
    }
    const o = sim.objective;
    if (o.controlsDestroyed !== this.ctrlDone || o.controlsRequired !== this.ctrlReq) {
      this.ctrlDone = o.controlsDestroyed;
      this.ctrlReq = o.controlsRequired;
      this.ctrlText.data = o.controlsDestroyed + '/' + o.controlsRequired;
      this.ctrl.classList.toggle('done', o.controlsRequired > 0 && o.controlsDestroyed >= o.controlsRequired);
    }
    if (this.cellsStage !== sim.stage) this.rebuildBarrierCells(sim);
    if (o.openBarrierIds.length !== this.openCount) {
      this.openCount = o.openBarrierIds.length;
      for (let i = 0; i < this.cells.length; i++) {
        const c = this.cells[i];
        const open = o.openBarrierIds.includes(c.id);
        if (open !== c.open) {
          c.open = open;
          c.el.classList.toggle('open', open);
          c.state.data = open ? '開放' : '閉鎖';
        }
      }
    }
    if (o.gateOpen !== this.gateOpen) {
      this.gateOpen = o.gateOpen;
      this.hud.classList.toggle('gate-open', o.gateOpen);
      this.gateText.data = o.gateOpen ? '開放 OPEN' : '閉鎖 LOCKED';
      this.banner.classList.toggle('is-off', !o.gateOpen);
      this.objDirty = true;
      this.layoutDirty = true;
    }
    for (let i = 0; i < this.toasts.length; i++) {
      const s = this.toasts[i];
      if (s.active && t >= s.until) {
        s.active = false;
        s.el.classList.add('is-off');
        this.layoutDirty = true;
      }
    }
  }

  private rebuildBarrierCells(sim: Sim): void {
    this.cellsStage = sim.stage;
    this.openCount = -1;
    this.cells.length = 0;
    const host = this.barriersEl;
    while (host.firstChild) host.removeChild(host.firstChild);
    const barriers = sim.stage.barriers;
    if (barriers.length === 0) {
      el('div', 'hud-bnone', host, '隔壁 — なし');
    } else {
      el('div', 'hud-blabel', host, '隔壁');
      for (let i = 0; i < barriers.length; i++) {
        const c = el('div', 'hud-bcell', host);
        textNode(c, barriers[i].id);
        const state = textNode(el('span', 's', c), '閉鎖');
        this.cells.push({ id: barriers[i].id, el: c, state, open: false });
      }
    }
    this.layoutDirty = true;
  }

  private addToast(main: string, sub: string, warn: boolean, t: number): void {
    let slot: ToastSlot | null = null;
    let oldest: ToastSlot = this.toasts[0];
    for (let i = 0; i < this.toasts.length; i++) {
      const s = this.toasts[i];
      if (!s.active && slot === null) slot = s;
      if (s.until < oldest.until) oldest = s;
    }
    if (slot === null) slot = oldest;
    slot.active = true;
    slot.until = t + TOAST_SECONDS;
    slot.main.data = main;
    slot.sub.data = sub;
    if (warn !== slot.warn) {
      slot.warn = warn;
      slot.el.classList.toggle('warn', warn);
    }
    slot.el.classList.remove('is-off');
    // newest toast last
    if (slot.el.parentNode && slot.el.parentNode.lastChild !== slot.el) slot.el.parentNode.appendChild(slot.el);
    this.layoutDirty = true;
  }

  // ───────────── layout (only after a resize or when a panel's content changed size) ─────────────
  private measureLayout(): void {
    this.layoutDirty = false;
    const em = this.em;
    const W = this.w;
    const tl = this.topLeft;
    const tr = this.topRight;
    const tc = this.topCenter;
    const tlR = tl.offsetLeft + tl.offsetWidth;
    const tlB = tl.offsetTop + tl.offsetHeight;
    const trL = tr.offsetLeft;
    const trB = tr.offsetTop + tr.offsetHeight;
    const tcW = tc.offsetWidth;
    const tcH = tc.offsetHeight;
    // the banner / toasts sit between the two top panels when they fit, otherwise below them
    let top = 0.8 * em;
    if (tcW > 0 && (W / 2 - tcW / 2 < tlR + 0.5 * em || W / 2 + tcW / 2 > trL - 0.5 * em)) top = Math.max(tlB, trB) + 0.4 * em;
    top = Math.round(top);
    if (top !== this.topCenterTop) {
      this.topCenterTop = top;
      tc.style.top = top + 'px';
    }
    const pad = KEEP_PAD_EM * em;
    let n = 0;
    const k = this.keep;
    const add = (x0: number, y0: number, x1: number, y1: number): void => {
      k[n * 4] = x0 - pad;
      k[n * 4 + 1] = y0 - pad;
      k[n * 4 + 2] = x1 + pad;
      k[n * 4 + 3] = y1 + pad;
      n++;
    };
    add(tl.offsetLeft, tl.offsetTop, tlR, tlB);
    add(trL, tr.offsetTop, trL + tr.offsetWidth, trB);
    if (tcW > 0 && tcH > 0) add(W / 2 - tcW / 2, top, W / 2 + tcW / 2, top + tcH);
    const l = this.left;
    add(l.offsetLeft, l.offsetTop, l.offsetLeft + l.offsetWidth, l.offsetTop + l.offsetHeight);
    const r = this.right;
    add(r.offsetLeft, r.offsetTop, r.offsetLeft + r.offsetWidth, r.offsetTop + r.offsetHeight);
    const b = this.bottom;
    add(W / 2 - b.offsetWidth / 2, b.offsetTop, W / 2 + b.offsetWidth / 2, b.offsetTop + b.offsetHeight);
    this.keepCount = n;
  }
}
