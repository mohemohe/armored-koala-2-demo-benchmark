/**
 * HUD (DOM + SVG)。表示値は全て buildHudModel(state) (= GameState由来) から。
 * 中央の判定円は state.lock.radiusCssPx、マーカー位置は projectToScreen による投影 (FCSと同一)。
 */
import { LIMITS, STAGE } from '../config';
import type { GameState } from '../sim/types';
import { buildHudModel, HUD_CONST, HudMessages, hudUnit } from './hudLogic';
import type { HudModel, MarkerPlacement } from './hudLogic';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
  if (cls) e.setAttribute('class', cls);
  return e;
}

/** 値が変わったときだけDOMへ書く */
class Cached {
  private v = '';
  constructor(private node: Element) {}
  set(s: string): void {
    if (s !== this.v) {
      this.v = s;
      this.node.textContent = s;
    }
  }
}

function toggle(node: Element, cls: string, on: boolean): void {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
}

function setAttr(node: Element, k: string, v: string): void {
  if (node.getAttribute(k) !== v) node.setAttribute(k, v);
}

const f1 = (n: number): string => n.toFixed(1);
const deg = (rad: number): number => (rad * 180) / Math.PI;

// ---------------------------------------------------------------------------
// SVG マーカー
// ---------------------------------------------------------------------------
type MarkerKind = 'target' | 'aim' | 'control' | 'escape' | 'telegraph';

interface MarkerNode {
  g: SVGGElement;
  shape: SVGGElement;
  arrow: SVGGElement;
  label: SVGTextElement;
  /** ラベルの基準 y (labelDy を足して置く) */
  baseY: number;
  text: string;
  shown: boolean;
  extra: Record<string, SVGElement>;
}

function makeMarker(kind: MarkerKind): MarkerNode {
  const g = svg('g', {}, `hud-mk hud-mk-${kind}`);
  const shape = svg('g', {}, 'hud-mk-shape');
  const arrow = svg('g', {}, 'hud-mk-arrow');
  arrow.appendChild(svg('polygon', { points: '0,-12 9,8 0,3 -9,8' }));
  const label = svg('text', { x: 16, y: -8 }, 'hud-lbl');
  const extra: Record<string, SVGElement> = {};
  switch (kind) {
    case 'target':
      shape.appendChild(svg('path', { d: 'M-13,-6 V-13 H-6 M6,-13 H13 V-6 M13,6 V13 H6 M-6,13 H-13 V6' }, 'hud-stroke'));
      break;
    case 'aim': {
      const solved = svg('g', {}, 'hud-aim-solved');
      solved.appendChild(svg('path', { d: 'M0,-10 L10,0 L0,10 L-10,0 Z' }, 'hud-stroke'));
      solved.appendChild(svg('circle', { r: 2 }, 'hud-fill'));
      const none = svg('g', {}, 'hud-aim-none');
      none.appendChild(svg('path', { d: 'M-8,-8 L8,8 M8,-8 L-8,8' }, 'hud-stroke'));
      none.appendChild(svg('circle', { r: 11, 'stroke-dasharray': '3 4' }, 'hud-stroke'));
      shape.append(solved, none);
      extra.solved = solved;
      extra.none = none;
      // 対象マーカー (ラベルは右側) と補正照準点は近い位置に出るので、補正点のラベルは左側に置いて重ならないようにする
      label.setAttribute('y', '4');
      label.setAttribute('x', '-14');
      break;
    }
    case 'control':
      shape.appendChild(svg('path', { d: 'M0,-8 L7,-4 L7,4 L0,8 L-7,4 L-7,-4 Z' }, 'hud-stroke'));
      shape.appendChild(svg('circle', { r: 1.8 }, 'hud-fill'));
      break;
    case 'escape':
      shape.appendChild(svg('path', { d: 'M-10,3 L0,-6 L10,3 M-10,10 L0,1 L10,10' }, 'hud-stroke'));
      break;
    case 'telegraph': {
      shape.appendChild(svg('path', { d: 'M0,-16 L15,11 L-15,11 Z' }, 'hud-stroke'));
      const bang = svg('text', { x: 0, y: 8, 'text-anchor': 'middle' }, 'hud-bang');
      bang.textContent = '!';
      shape.appendChild(bang);
      label.setAttribute('y', '30'); // 同位置の制御砲台/ロック対象のラベルと重ならないよう下へ
      break;
    }
  }
  g.append(shape, arrow, label);
  g.style.display = 'none';
  return { g, shape, arrow, label, baseY: Number(label.getAttribute('y')), text: '', shown: false, extra };
}

class MarkerLayer {
  private nodes = new Map<string, MarkerNode>();
  private used = new Set<string>();
  constructor(
    private layer: SVGGElement,
    private cx: () => number,
  ) {}

  begin(): void {
    this.used.clear();
  }

  /** マーカーを置く (画面内=投影位置、画面外=端の矢印) */
  put(key: string, kind: MarkerKind, pl: MarkerPlacement, label: string, cls: string, labelDy = 0): MarkerNode {
    let n = this.nodes.get(key);
    if (!n) {
      n = makeMarker(kind);
      this.nodes.set(key, n);
      this.layer.appendChild(n.g);
    }
    this.used.add(key);
    if (!n.shown) {
      n.g.style.display = '';
      n.shown = true;
    }
    setAttr(n.g, 'class', `hud-mk hud-mk-${kind} ${cls}${pl.onScreen ? '' : ' off'}`);
    n.g.setAttribute('transform', `translate(${f1(pl.x)} ${f1(pl.y)})`);
    if (pl.onScreen) {
      n.shape.style.display = '';
      n.arrow.style.display = 'none';
      setAttr(n.label, 'text-anchor', kind === 'aim' ? 'end' : 'start');
    } else {
      n.shape.style.display = 'none';
      n.arrow.style.display = '';
      n.arrow.setAttribute('transform', `rotate(${f1(deg(pl.angle))})`);
      // ラベルは画面の内側へ
      const left = pl.x < this.cx();
      setAttr(n.label, 'text-anchor', left ? 'start' : 'end');
    }
    const offRight = !pl.onScreen && pl.x >= this.cx();
    const lx = pl.onScreen ? (kind === 'aim' ? -14 : 16) : offRight ? -16 : 16;
    setAttr(n.label, 'x', String(lx));
    setAttr(n.label, 'y', String(n.baseY + labelDy));
    if (n.text !== label) {
      n.text = label;
      n.label.textContent = label;
    }
    return n;
  }

  end(): void {
    for (const [k, n] of this.nodes) {
      if (!this.used.has(k) && n.shown) {
        n.g.style.display = 'none';
        n.shown = false;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HUD 本体
// ---------------------------------------------------------------------------
export class Hud {
  private root: HTMLElement;
  private wrap: HTMLElement;
  private flash: HTMLElement;
  private svgRoot: SVGSVGElement;
  private reticle: SVGGElement;
  private retBase: SVGCircleElement;
  private retProg: SVGCircleElement;
  private retTicks: SVGPathElement;
  private retLabel: SVGTextElement;
  private retAim: SVGTextElement;
  private markers: MarkerLayer;
  private wedges: { g: SVGGElement; arc: SVGPathElement; tip: SVGPolygonElement; on: boolean }[] = [];
  private dmgLayer: SVGGElement;
  private cx = 0;
  private cy = 0;
  private vbW = -1;
  private vbH = -1;
  private radius = -1;
  private messages = new HudMessages();

  // panels
  private sectorTxt: Cached;
  private visitedTxt: Cached;
  private ctlTxt: Cached;
  private pips: HTMLElement[] = [];
  private barrierBox: HTMLElement;
  private barrierKey = '';
  private gateEl: HTMLElement;
  private gateTxt: Cached;
  private nextEl: HTMLElement;
  private nextTxt: Cached;
  private nextSub: Cached;
  private msgBox: HTMLElement;
  private msgKey = '';
  private fcsState: HTMLElement;
  private fcsStateTxt: Cached;
  private fcsIdTxt: Cached;
  private fcsAimTxt: Cached;
  private fcsAimEl: HTMLElement;
  private weaponRows: { row: HTMLElement; key: Cached; name: Cached; ammo: Cached; sub: Cached }[] = [];
  private enFill: HTMLElement;
  private enTxt: Cached;
  private enEl: HTMLElement;
  private moveMode: HTMLElement;
  private moveModeTxt: Cached;
  private moveVert: Cached;
  private qbEl: HTMLElement;
  private qbTxt: Cached;
  private qbCdTxt: Cached;
  private hpFill: HTMLElement;
  private hpTxt: Cached;
  private noticeBox: HTMLElement;
  private noticeKey = '';
  private fills = new Map<HTMLElement, string>();

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('hud');
    this.wrap = el('div', 'hud-wrap');
    this.flash = el('div', 'hud-flash');

    // ---- SVG レイヤー
    this.svgRoot = svg('svg', { preserveAspectRatio: 'none', 'aria-hidden': 'true' }, 'hud-svg');
    this.dmgLayer = svg('g', {}, 'hud-dmg');
    for (let i = 0; i < LIMITS.DAMAGE_INDICATORS; i++) {
      const g = svg('g', {}, 'hud-wedge');
      const arc = svg('path', {}, 'hud-wedge-arc');
      const tip = svg('polygon', { points: '0,-9 8,7 -8,7' }, 'hud-wedge-tip');
      g.append(arc, tip);
      g.style.display = 'none';
      this.dmgLayer.appendChild(g);
      this.wedges.push({ g, arc, tip, on: false });
    }
    this.reticle = svg('g', {}, 'hud-reticle');
    this.retBase = svg('circle', { r: 100 }, 'ret-base');
    this.retProg = svg('circle', { r: 100 }, 'ret-prog');
    this.retTicks = svg('path', {}, 'ret-ticks');
    const cross = svg(
      'path',
      { d: 'M-16,0 H-5 M5,0 H16 M0,-16 V-5 M0,5 V16' },
      'ret-cross',
    );
    const dot = svg('circle', { r: 1.4 }, 'ret-dot');
    this.retLabel = svg('text', { 'text-anchor': 'middle' }, 'hud-lbl ret-label');
    this.retAim = svg('text', { 'text-anchor': 'middle' }, 'hud-lbl ret-aim');
    this.reticle.append(this.retBase, this.retProg, this.retTicks, cross, dot, this.retLabel, this.retAim);
    const markerLayer = svg('g', {}, 'hud-markers');
    this.svgRoot.append(this.dmgLayer, markerLayer, this.reticle);
    this.markers = new MarkerLayer(markerLayer, () => this.cx);

    // ---- 左上: ミッション
    const mission = el('div', 'hud-panel hud-mission');
    const sectorRow = el('div', 'hud-row');
    sectorRow.append(el('span', 'hud-k', '区画'));
    const sectorName = el('span', 'hud-v hud-sector');
    this.sectorTxt = new Cached(sectorName);
    const visited = el('span', 'hud-dim');
    this.visitedTxt = new Cached(visited);
    sectorRow.append(sectorName, visited);
    const ctlRow = el('div', 'hud-row');
    ctlRow.append(el('span', 'hud-k', '制御砲台'));
    const ctlVal = el('span', 'hud-v');
    this.ctlTxt = new Cached(ctlVal);
    const pipBox = el('span', 'hud-pips');
    for (let i = 0; i < STAGE.CONTROLS_REQUIRED; i++) {
      const p = el('i', 'hud-pip');
      this.pips.push(p);
      pipBox.appendChild(p);
    }
    ctlRow.append(ctlVal, pipBox);
    const barRow = el('div', 'hud-row');
    barRow.append(el('span', 'hud-k', '隔壁'));
    this.barrierBox = el('span', 'hud-barriers');
    barRow.appendChild(this.barrierBox);
    this.gateEl = el('div', 'hud-gate');
    this.gateTxt = new Cached(this.gateEl);
    mission.append(sectorRow, ctlRow, barRow, this.gateEl);

    // ---- 上中央: 次の目標
    const nextBox = el('div', 'hud-panel hud-next');
    this.nextEl = el('div', 'hud-next-main');
    this.nextTxt = new Cached(this.nextEl);
    const nextSub = el('div', 'hud-next-sub');
    this.nextSub = new Cached(nextSub);
    this.msgBox = el('div', 'hud-msgs');
    nextBox.append(this.nextEl, nextSub, this.msgBox);

    // ---- 右上: FCS
    const fcs = el('div', 'hud-panel hud-fcs');
    const fcsHead = el('div', 'hud-row');
    fcsHead.append(el('span', 'hud-k', 'FCS'));
    this.fcsState = el('span', 'hud-v hud-fcs-state');
    this.fcsStateTxt = new Cached(this.fcsState);
    fcsHead.appendChild(this.fcsState);
    const fcsId = el('div', 'hud-row');
    fcsId.append(el('span', 'hud-k', 'LOCK ID'));
    const fcsIdV = el('span', 'hud-v');
    this.fcsIdTxt = new Cached(fcsIdV);
    fcsId.appendChild(fcsIdV);
    const fcsAim = el('div', 'hud-row');
    fcsAim.append(el('span', 'hud-k', '補正'));
    this.fcsAimEl = el('span', 'hud-v');
    this.fcsAimTxt = new Cached(this.fcsAimEl);
    fcsAim.appendChild(this.fcsAimEl);
    fcs.append(fcsHead, fcsId, fcsAim);

    // ---- 左: 武器
    const weapons = el('div', 'hud-panel hud-weapons');
    weapons.appendChild(el('div', 'hud-head', 'WEAPON'));
    for (let i = 0; i < 3; i++) {
      const row = el('div', 'hud-wrow');
      const key = el('span', 'hud-wkey');
      const name = el('span', 'hud-wname');
      const ammo = el('span', 'hud-wammo');
      const sub = el('span', 'hud-wsub');
      row.append(key, name, ammo, sub);
      weapons.appendChild(row);
      this.weaponRows.push({ row, key: new Cached(key), name: new Cached(name), ammo: new Cached(ammo), sub: new Cached(sub) });
    }

    // ---- 右: EN と移動
    const right = el('div', 'hud-panel hud-right');
    right.appendChild(el('div', 'hud-head', 'ENERGY'));
    this.enEl = el('div', 'hud-bar hud-bar-en');
    this.enFill = el('div', 'hud-fill');
    this.enEl.appendChild(this.enFill);
    const enNum = el('div', 'hud-num');
    this.enTxt = new Cached(enNum);
    right.append(this.enEl, enNum);
    const mv = el('div', 'hud-move');
    const modeRow = el('div', 'hud-row');
    modeRow.append(el('span', 'hud-k', '移動'));
    this.moveMode = el('span', 'hud-mode');
    this.moveModeTxt = new Cached(this.moveMode);
    const vert = el('span', 'hud-dim');
    this.moveVert = new Cached(vert);
    modeRow.append(this.moveMode, vert);
    const qbRow = el('div', 'hud-row');
    qbRow.append(el('span', 'hud-k', 'QB'));
    this.qbEl = el('span', 'hud-v hud-qb');
    this.qbTxt = new Cached(this.qbEl);
    qbRow.appendChild(this.qbEl);
    const qbCd = el('div', 'hud-row');
    qbCd.append(el('span', 'hud-k', '次のQBまで'));
    const qbCdV = el('span', 'hud-v');
    this.qbCdTxt = new Cached(qbCdV);
    qbCd.appendChild(qbCdV);
    mv.append(modeRow, qbRow, qbCd);
    right.appendChild(mv);

    // ---- 下: HP
    const hp = el('div', 'hud-panel hud-hp');
    const hpHead = el('div', 'hud-row');
    hpHead.append(el('span', 'hud-k', 'HP'));
    const hpNum = el('span', 'hud-v');
    this.hpTxt = new Cached(hpNum);
    hpHead.appendChild(hpNum);
    const hpBar = el('div', 'hud-bar hud-bar-hp');
    this.hpFill = el('div', 'hud-fill');
    hpBar.appendChild(this.hpFill);
    hp.append(hpHead, hpBar);

    // ---- 通知
    this.noticeBox = el('div', 'hud-notices');

    this.wrap.append(this.flash, this.svgRoot, mission, nextBox, fcs, weapons, right, hp, this.noticeBox);
    root.appendChild(this.wrap);
    this.setVisible(false);
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  private setFill(node: HTMLElement, ratio: number): void {
    const v = `${(ratio * 100).toFixed(2)}%`;
    if (this.fills.get(node) !== v) {
      this.fills.set(node, v);
      node.style.width = v;
    }
  }

  update(state: GameState): void {
    const m = buildHudModel(state);
    this.layout(m);
    this.drawReticle(m);
    this.drawMarkers(m);
    this.drawWedges(m);
    this.drawPanels(m, state);
  }

  private layout(m: HudModel): void {
    if (m.width !== this.vbW || m.height !== this.vbH) {
      this.vbW = m.width;
      this.vbH = m.height;
      this.svgRoot.setAttribute('viewBox', `0 0 ${m.width} ${m.height}`);
      this.cx = m.width / 2;
      this.cy = m.height / 2;
      this.reticle.setAttribute('transform', `translate(${this.cx} ${this.cy})`);
      this.dmgLayer.setAttribute('transform', `translate(${this.cx} ${this.cy})`);
    }
  }

  private drawReticle(m: HudModel): void {
    const L = m.lock;
    const r = L.radius;
    if (r !== this.radius) {
      this.radius = r;
      const c = 2 * Math.PI * r;
      this.retBase.setAttribute('r', String(r));
      this.retProg.setAttribute('r', String(r));
      this.retProg.setAttribute('data-c', String(c));
      this.retProg.setAttribute('transform', 'rotate(-90)');
      const t = 12;
      this.retTicks.setAttribute(
        'd',
        `M0,${-r - t} V${-r + t} M0,${r - t} V${r + t} M${-r - t},0 H${-r + t} M${r - t},0 H${r + t}`,
      );
      const u = hudUnit(this.vbW, this.vbH); // CSS の --u と同じ式 (hudLogic と共有)
      this.retLabel.setAttribute('y', String(-r - 2.3 * u));
      this.retAim.setAttribute('y', String(-r - 0.9 * u));
    }
    setAttr(this.reticle, 'class', `hud-reticle ret-${L.phase}`);
    const c = 2 * Math.PI * r;
    const prog = L.phase === 'acquiring' ? Math.max(0, Math.min(1, L.progress)) : 0;
    setAttr(this.retProg, 'stroke-dasharray', `${(c * prog).toFixed(2)} ${c.toFixed(2)}`);
    const label = L.label;
    if (this.retLabel.textContent !== label) this.retLabel.textContent = label;
    const aimText = L.phase === 'locked' ? m.aimStatusText : '';
    if (this.retAim.textContent !== aimText) this.retAim.textContent = aimText;
    toggle(this.retAim, 'nosol', L.phase === 'locked' && m.aim !== null && m.aim.status === 'no_solution');
  }

  private drawMarkers(m: HudModel): void {
    const mk = this.markers;
    mk.begin();
    // 制御砲台 (次の目標を強調し、他は近い順に最大 CONTROL_MARKERS_MAX 個まで。画面端の密集を避ける)
    for (const c of m.controlMarkers) {
      // ロック対象が制御砲台のときは対象マーカーのラベルに統合 (重なり防止)
      const merged = m.target !== null && m.target.id === c.id;
      const text = c.isNext ? `NEXT ${c.id} ${Math.round(c.distance)}m ${c.bearing.arrow}` : `${c.id} ${Math.round(c.distance)}m`;
      mk.put(`ctl:${c.id}`, 'control', c.placement, merged ? '' : text, c.isNext ? 'next' : 'dim', c.labelDy);
    }
    if (m.escape) {
      mk.put('escape', 'escape', m.escape.placement, `脱出 ${Math.round(m.escape.distance)}m`, 'next');
    }
    // 射撃予告
    for (const t of m.telegraphs) {
      mk.put(`tel:${t.id}`, 'telegraph', t.placement, `射撃予告 ${t.id}`, 'warn pulse');
    }
    // ロック対象
    if (m.target) {
      mk.put('target', 'target', m.target.placement, `${m.target.isControl ? '制御砲台 ' : ''}${m.target.id} ${Math.round(m.target.distance)}m`, m.target.phase === 'locked' ? 'locked' : 'acq');
    }
    // 補正照準
    if (m.aim) {
      // 詳しい文言 (補正中 偏差+重力 など) は中央の円の上と FCS パネルに出ているので、マーカーの横は短くして対象付近の文字の重なりを減らす
      const n = mk.put('aim', 'aim', m.aim.placement, m.aim.status === 'solved' ? '補正点' : '補正解なし', m.aim.status === 'solved' ? 'solved' : 'nosol');
      (n.extra.solved as SVGElement).style.display = m.aim.status === 'solved' ? '' : 'none';
      (n.extra.none as SVGElement).style.display = m.aim.status === 'solved' ? 'none' : '';
    }
    mk.end();
  }

  private drawWedges(m: HudModel): void {
    const R = HUD_CONST.DAMAGE_RING_RATIO * Math.min(m.width, m.height);
    for (let i = 0; i < this.wedges.length; i++) {
      const w = this.wedges[i];
      const d = m.wedges[i];
      if (!d) {
        if (w.on) {
          w.g.style.display = 'none';
          w.on = false;
        }
        continue;
      }
      if (!w.on) {
        w.g.style.display = '';
        w.on = true;
      }
      const a0 = d.angle - 0.3;
      const a1 = d.angle + 0.3;
      const p = (a: number, rr: number): string => `${(rr * Math.sin(a)).toFixed(1)} ${(-rr * Math.cos(a)).toFixed(1)}`;
      w.arc.setAttribute('d', `M${p(a0, R)} A${R.toFixed(1)} ${R.toFixed(1)} 0 0 1 ${p(a1, R)}`);
      w.tip.setAttribute('transform', `translate(${p(d.angle, R + 20)}) rotate(${f1(deg(d.angle))})`);
      w.g.style.opacity = d.alpha.toFixed(2);
    }
    const fl = m.flashAlpha.toFixed(3);
    if (this.flash.dataset.a !== fl) {
      this.flash.dataset.a = fl;
      this.flash.style.opacity = fl;
    }
  }

  private drawPanels(m: HudModel, state: GameState): void {
    const ms = m.mission;
    this.sectorTxt.set(ms.sectorId ? `${ms.sectorId} ${ms.sectorName}` : ms.sectorName);
    this.visitedTxt.set(`通過 ${ms.visited}/${ms.sectorCount}`);
    this.ctlTxt.set(`${ms.controlsDestroyed}/${ms.controlsRequired}`);
    for (let i = 0; i < this.pips.length; i++) toggle(this.pips[i], 'on', i < ms.controlsDestroyed);
    const bkey = ms.barriers.map((b) => `${b.id}:${b.open ? 1 : 0}`).join(',');
    if (bkey !== this.barrierKey) {
      this.barrierKey = bkey;
      this.barrierBox.textContent = '';
      for (const b of ms.barriers) {
        const chip = el('span', `hud-chip${b.open ? ' open' : ''}`, `${b.id} ${b.open ? '開放' : '閉'}`);
        chip.title = b.label;
        this.barrierBox.appendChild(chip);
      }
      if (ms.barriers.length === 0) this.barrierBox.textContent = '-';
    }
    this.gateTxt.set(ms.gateText);
    toggle(this.gateEl, 'open', ms.gateOpen);

    // 次の目標
    const n = m.next;
    this.nextTxt.set(n.text);
    toggle(this.nextEl, 'escape', n.kind === 'escape');
    this.nextSub.set(
      n.distance === null ? '' : `${n.arrow} ${n.bearingLabel}  ${Math.round(n.distance)}m${n.vertical ? '  ' + n.vertical : ''}`,
    );
    const msgs = this.messages.update(state);
    const mkey = msgs.map((x) => x.text).join('|');
    if (mkey !== this.msgKey) {
      this.msgKey = mkey;
      this.msgBox.textContent = '';
      for (const x of msgs) this.msgBox.appendChild(el('div', `hud-msg ${x.kind}`, x.text));
    }

    // FCS
    const L = m.lock;
    this.fcsStateTxt.set(L.phase === 'none' ? '未取得' : L.phase === 'acquiring' ? `取得中 ${L.label.replace('LOCKING ', '')}` : 'ロック完了 LOCKED');
    setAttr(this.fcsState, 'data-phase', L.phase);
    this.fcsIdTxt.set(L.targetId ? `${L.targetId} ${L.targetName ?? ''} ${L.distance !== null ? Math.round(L.distance) + 'm' : ''}`.trim() : '---');
    this.fcsAimTxt.set(m.aimStatusText);
    toggle(this.fcsAimEl, 'nosol', m.aim !== null && m.aim.status === 'no_solution');

    // 武器
    for (let i = 0; i < 3; i++) {
      const w = m.weapons[i];
      const r = this.weaponRows[i];
      r.key.set(w.key);
      r.name.set(w.name);
      r.ammo.set(w.ammoText);
      r.sub.set(w.subText);
      toggle(r.row, 'sel', w.selected);
      toggle(r.row, 'empty', w.empty);
    }

    // EN / 移動
    this.setFill(this.enFill, m.en.ratio);
    this.enTxt.set(`${m.en.value} / ${m.en.max}`);
    toggle(this.enEl, 'low', m.en.low);
    const mv = m.movement;
    this.moveModeTxt.set(mv.mode);
    setAttr(this.moveMode, 'data-mode', mv.mode);
    this.moveVert.set(mv.vertical);
    this.qbTxt.set(mv.qbText);
    setAttr(this.qbEl, 'data-qb', mv.qb);
    this.qbCdTxt.set(`${mv.qbCooldown.toFixed(1)}s`);

    // HP
    this.setFill(this.hpFill, m.hp.ratio);
    this.hpTxt.set(`${m.hp.value} / ${m.hp.max}`);
    toggle(this.hpFill, 'low', m.hp.ratio <= 0.3);

    // 通知
    const nkey = m.notices.map((x) => x.kind + x.at).join('|');
    if (nkey !== this.noticeKey) {
      this.noticeKey = nkey;
      this.noticeBox.textContent = '';
      for (const x of m.notices.slice(0, 3)) this.noticeBox.appendChild(el('div', `hud-notice ${x.kind}`, x.text));
    }
  }
}
