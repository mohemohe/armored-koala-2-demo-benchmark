/**
 * Garage (hangar) overlay — docs/SPEC.md §2.1, §3.
 *
 * HTML/CSS overlay shown before a sortie: choose 1 of 3 FCS, 1 of 3 generators and 1 of 2 leg types
 * (18 builds), read every option's strengths and weaknesses, the effective (legs-adjusted) stats, the
 * weapons and the controls, then sortie. The 3D mech preview is rendered on the game canvas BEHIND this
 * overlay: the centre of the screen is left transparent and click-through (see getPreviewRect()).
 *
 * Every number shown is read from src/config.ts (part tables, WEAPONS, computeEffectiveStats) — the same
 * definitions the simulation uses; nothing is duplicated here.
 *
 * The overlay is created hidden: call show(). While hidden it is detached from the document (and the help
 * dialog is attached only while open), so DOM / text queries only ever find what is really on screen.
 */
import './ui.css';
import {
  CONTROLS_REQUIRED,
  DEFAULT_LOADOUT,
  DEFAULT_WEAPON,
  FCS_PARTS,
  GENERATOR_PARTS,
  LEGS_PARTS,
  WEAPONS,
  WEAPON_ORDER,
  computeEffectiveStats,
} from '../config';
import type { FcsId, GeneratorId, LegsId, Loadout } from '../sim/types';
import { UI_ARM_DELAY_MS, attachScrollHint, audioStatusText, controlsHelpHtml, el, shieldUiEvents, uiNow } from './help';

export interface GarageOptions {
  initial: Loadout;
  /** Called immediately whenever a selection changes (the renderer swaps the 3D legs). */
  onChange(loadout: Loadout): void;
  /** Called by the "出撃 SORTIE" button — a user gesture, so the pointer lock may be requested from it. */
  onSortie(loadout: Loadout): void;
}

type GroupId = keyof Loadout;

const FCS_IDS = Object.keys(FCS_PARTS) as FcsId[];
const GENERATOR_IDS = Object.keys(GENERATOR_PARTS) as GeneratorId[];
const LEGS_IDS = Object.keys(LEGS_PARTS) as LegsId[];
const BUILD_COUNT = FCS_IDS.length * GENERATOR_IDS.length * LEGS_IDS.length;

const MAX_EN = Math.max(...GENERATOR_IDS.map((id) => GENERATOR_PARTS[id].maxEn));
const MAX_REGEN = Math.max(...GENERATOR_IDS.map((g) => GENERATOR_PARTS[g].regen)) * Math.max(...LEGS_IDS.map((l) => LEGS_PARTS[l].regenMult));
const MAX_LOCK_SECONDS = Math.max(...FCS_IDS.map((f) => FCS_PARTS[f].lockSeconds)) / Math.min(...LEGS_IDS.map((l) => LEGS_PARTS[l].lockSpeedMult));
const MAX_RADIUS = Math.max(...FCS_IDS.map((id) => FCS_PARTS[id].radiusFactor));

const f1 = (v: number): string => v.toFixed(1);
const f2 = (v: number): string => v.toFixed(2);
const f3 = (v: number): string => v.toFixed(3);
/** Number without trailing zeros (10, 7.5, 11.25). */
const trim = (v: number): string => String(Math.round(v * 1000) / 1000);

interface OptionView {
  group: GroupId;
  id: string;
  button: HTMLButtonElement;
}

/** A stat row: value text node + bar. */
interface StatView {
  value: Text;
  valueEl: HTMLElement;
  formula: Text | null;
  bar: HTMLElement | null;
  last: string;
}

const EMBLEM_SVG = `
<svg class="gar-emblem" viewBox="0 0 64 56" aria-hidden="true">
  <circle cx="12.5" cy="15" r="11" fill="#56616e" stroke="#63e6f2" stroke-width="1.6"/>
  <circle cx="12.5" cy="15" r="6" fill="#d8d2c8"/>
  <circle cx="51.5" cy="15" r="11" fill="#56616e" stroke="#63e6f2" stroke-width="1.6"/>
  <circle cx="51.5" cy="15" r="6" fill="#d8d2c8"/>
  <path d="M13 27 Q13 11 32 11 Q51 11 51 27 L51 37 Q51 52 32 52 Q13 52 13 37 Z" fill="#8f99a6" stroke="#63e6f2" stroke-width="1.6"/>
  <path d="M13 31 H51" stroke="#56616e" stroke-width="2"/>
  <rect x="18" y="23" width="8" height="4.5" fill="#63e6f2"/>
  <rect x="38" y="23" width="8" height="4.5" fill="#63e6f2"/>
  <ellipse cx="32" cy="34" rx="5.5" ry="9" fill="#090b0d"/>
  <rect x="25" y="46.5" width="14" height="2" fill="#ff8a2a"/>
</svg>`;

export class GarageUi {
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly scale: HTMLDivElement;
  private readonly centre: HTMLDivElement;
  private readonly helpLayer: HTMLDivElement;
  private readonly helpBody: HTMLDivElement;
  private readonly helpButton: HTMLButtonElement;
  private readonly helpClose: HTMLButtonElement;
  private readonly sortieButton: HTMLButtonElement;
  private readonly notice: HTMLDivElement;
  private readonly noticeText: Text;
  private readonly audioText: Text;
  private readonly options: OptionView[] = [];
  private readonly buildChips: Record<GroupId, Text>;
  private readonly stats: Record<'maxEn' | 'regen' | 'lock' | 'radius' | 'mult' | 'walk' | 'glide' | 'air' | 'qb', StatView>;
  private readonly updateHelpHint: () => void;
  private readonly opts: GarageOptions;
  private loadout: Loadout;
  private shown = false;
  private shownAt = 0;
  private lastSortieAt = -1e9;

  constructor(root: HTMLElement, opts: GarageOptions) {
    this.opts = opts;
    const i = opts.initial;
    this.loadout = {
      fcs: i.fcs in FCS_PARTS ? i.fcs : DEFAULT_LOADOUT.fcs,
      generator: i.generator in GENERATOR_PARTS ? i.generator : DEFAULT_LOADOUT.generator,
      legs: i.legs in LEGS_PARTS ? i.legs : DEFAULT_LOADOUT.legs,
    };

    this.host = root;
    this.root = el('div', 'ak2-ui ak2-garage');
    this.root.setAttribute('data-ui', 'garage');
    shieldUiEvents(this.root);
    this.scale = el('div', 'ui-scale', undefined, this.root);
    const gar = el('div', 'gar', undefined, this.scale);

    // ───────── top bar ─────────
    const top = el('header', 'gar-top', undefined, gar);
    const brand = el('div', 'gar-brand', undefined, top);
    brand.insertAdjacentHTML('beforeend', EMBLEM_SVG);
    const titles = el('div', 'gar-titles', undefined, brand);
    const title = el('h1', 'gar-title', 'ARMORED KOALA 2 ', titles);
    el('span', 'demo', 'DEMO', title);
    const sub = el('div', 'gar-sub', undefined, titles);
    el('span', 'en', 'HANGAR', sub);
    // (button labels such as 出撃 / 操作方法 are deliberately not repeated in passive text before the buttons)
    sub.appendChild(document.createTextNode('格納庫 — 機体構成の選択'));
    const brief = el('div', 'gar-brief', undefined, top);
    el('span', 'en', 'MISSION', brief);
    brief.appendChild(document.createTextNode('廃工場から脱出せよ。'));
    el('b', undefined, `制御砲台 ${CONTROLS_REQUIRED} 基を破壊`, brief);
    brief.appendChild(document.createTextNode(' → 最終搬出ゲート開放 → '));
    el('b', undefined, '脱出領域へ到達', brief);

    // ───────── left: FCS + generator ─────────
    const left = el('div', 'gar-col gar-left', undefined, gar);
    this.buildGroup(left, 'fcs', '01', 'FCS', '射撃管制', 'D = 画面の短辺 ・ 時間は2脚での値', FCS_IDS, (id) => {
      const p = FCS_PARTS[id as FcsId];
      return { label: p.label, pros: p.pros, cons: p.cons, nums: [['半径', f2(p.radiusFactor) + 'D', ''], ['ロック', f2(p.lockSeconds), '秒']], numsRow: false };
    });
    this.buildGroup(left, 'generator', '02', 'GENERATOR', 'ジェネレーター', '最大EN ｜ 基本回復率', GENERATOR_IDS, (id) => {
      const p = GENERATOR_PARTS[id as GeneratorId];
      return { label: p.label, pros: p.pros, cons: p.cons, nums: [['', String(p.maxEn), 'EN'], ['', trim(p.regen), 'EN/秒']], numsRow: false };
    });

    // ───────── centre (transparent: the 3D preview shows through) ─────────
    this.centre = el('div', 'gar-centre', undefined, gar);
    this.centre.setAttribute('aria-hidden', 'true');

    // ───────── right: legs + effective stats + weapons ─────────
    const right = el('div', 'gar-col gar-right', undefined, gar);
    this.buildGroup(right, 'legs', '03', 'LEGS', '脚部', '3Dモデルも切り替わります', LEGS_IDS, (id) => {
      const p = LEGS_PARTS[id as LegsId];
      return {
        label: p.label,
        pros: p.pros,
        cons: p.cons,
        nums: [['水平速度', '×' + f2(p.speedMult), ''], ['EN回復', '×' + f2(p.regenMult), ''], ['ロック速度', '×' + f2(p.lockSpeedMult), '']],
        numsRow: true,
      };
    });

    const statsPanel = el('section', 'ui-panel gar-stats', undefined, right);
    const sh = el('h2', 'ui-panel-h', undefined, statsPanel);
    el('span', 'en', 'EFFECTIVE STATS', sh);
    el('span', 'jp', '実効性能', sh);
    el('span', 'hint', '脚部補正を適用した値', sh);
    const stat = (label: string, unit: string, withFormula: boolean): StatView => {
      const rowEl = el('div', 'gar-stat', undefined, statsPanel);
      el('span', 'k', label, rowEl);
      const v = el('span', 'v', undefined, rowEl);
      const value = document.createTextNode('');
      v.appendChild(value);
      if (unit) el('span', 'u', unit, v);
      const f = el('span', 'f', undefined, rowEl);
      let formula: Text | null = null;
      if (withFormula) {
        formula = document.createTextNode('');
        f.appendChild(formula);
      }
      const bar = el('span', 'bar', undefined, rowEl);
      const fill = el('i', undefined, undefined, bar);
      return { value, valueEl: v, formula, bar: fill, last: '' };
    };
    const maxEn = stat('最大EN', 'EN', true);
    const regen = stat('EN回復率', 'EN/秒', true);
    const lock = stat('ロック所要時間', '秒', true);
    const radius = stat('ロック領域半径', '× D', true);
    const speedHead = el('div', 'gar-speed-h', undefined, statsPanel);
    el('span', 'k', '水平移動速度', speedHead);
    const multWrap = el('span', 'm', '脚部倍率', speedHead);
    const multB = el('b', undefined, undefined, multWrap);
    const multText = document.createTextNode('');
    multB.appendChild(multText);
    const speeds = el('div', 'gar-speeds', undefined, statsPanel);
    const speed = (label: string): StatView => {
      const cell = el('div', 'gar-speed', undefined, speeds);
      el('span', 'k', label, cell);
      const v = el('span', 'v', undefined, cell);
      const value = document.createTextNode('');
      v.appendChild(value);
      el('span', 'u', 'm/s', cell);
      return { value, valueEl: v, formula: null, bar: null, last: '' };
    };
    this.stats = {
      maxEn,
      regen,
      lock,
      radius,
      mult: { value: multText, valueEl: multB, formula: null, bar: null, last: '' },
      walk: speed('歩行'),
      glide: speed('グライド'),
      air: speed('空中'),
      qb: speed('QB 初速'),
    };

    this.buildWeapons(right);

    // ───────── bottom centre: build summary, notice, actions ─────────
    const bottom = el('footer', 'gar-bottom', undefined, gar);
    const build = el('div', 'gar-build', undefined, bottom);
    el('span', 'h', '現在の構成', build);
    const chip = (tag: string): Text => {
      const c = el('span', 'chip', undefined, build);
      el('i', undefined, tag, c);
      const b = el('b', undefined, undefined, c);
      const t = document.createTextNode('');
      b.appendChild(t);
      return t;
    };
    this.buildChips = { fcs: chip('FCS'), generator: chip('GEN'), legs: chip('LEGS') };

    const actions = el('div', 'gar-actions', undefined, bottom);
    this.helpButton = el('button', 'ui-btn gar-help-btn', undefined, actions);
    this.helpButton.type = 'button';
    this.helpButton.setAttribute('data-act', 'help');
    this.helpButton.setAttribute('aria-haspopup', 'dialog');
    el('span', 'jp', '操作方法', this.helpButton);
    el('span', 'en', 'CONTROLS', this.helpButton);
    const sortieWrap = el('div', 'gar-sortie-wrap', undefined, actions);
    this.sortieButton = el('button', 'gar-sortie', undefined, sortieWrap);
    this.sortieButton.type = 'button';
    this.sortieButton.setAttribute('data-act', 'sortie');
    this.sortieButton.setAttribute('aria-label', '出撃 SORTIE');
    el('span', 'jp', '出撃', this.sortieButton);
    el('span', 'en', 'SORTIE', this.sortieButton);
    el('span', 'arrow', undefined, this.sortieButton);
    el('div', 'gar-foot', `全 ${BUILD_COUNT} 通りの構成から選択 ・ 出撃後は変更できません ・ Esc で一時停止`, bottom);
    // sound state as text ("音声 ON [M]" / "音声 OFF [M]") on a line of its own; the app keeps it current (setAudioMuted)
    const audioLine = el('div', 'gar-foot gar-audio-line', undefined, bottom);
    const audio = el('b', 'gar-audio', undefined, audioLine);
    this.audioText = document.createTextNode(audioStatusText(false));
    audio.appendChild(this.audioText);
    audioLine.appendChild(document.createTextNode(' — M キーで切り替え'));
    // The notice floats above this block (CSS); it comes last in DOM order, after the buttons.
    this.notice = el('div', 'gar-notice is-off', undefined, bottom);
    this.notice.setAttribute('role', 'alert');
    const noticeSpan = el('span', 't', undefined, this.notice);
    this.noticeText = document.createTextNode('');
    noticeSpan.appendChild(this.noticeText);

    // ───────── controls help dialog ─────────
    this.helpLayer = el('div', 'gar-help'); // attached to this.scale only while open
    const helpPanel = el('section', 'ui-panel gar-help-panel', undefined, this.helpLayer);
    helpPanel.setAttribute('role', 'dialog');
    helpPanel.setAttribute('aria-modal', 'true');
    helpPanel.setAttribute('aria-label', '操作方法');
    const helpHead = el('div', 'gar-help-head', undefined, helpPanel);
    const hh = el('h2', undefined, '操作方法', helpHead);
    el('span', 'en', 'CONTROLS', hh);
    el('span', 'note', '一時停止メニューからも参照できます', helpHead);
    this.helpClose = el('button', 'ui-btn', '閉じる ✕', helpHead);
    this.helpClose.type = 'button';
    this.helpClose.setAttribute('data-act', 'help-close');
    this.helpBody = el('div', 'gar-help-body ui-scroll', undefined, helpPanel);
    this.helpBody.tabIndex = 0;
    this.helpBody.innerHTML = controlsHelpHtml();
    this.updateHelpHint = attachScrollHint(this.helpBody);

    // ───────── events (all on our own elements: nothing to duplicate or leak) ─────────
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('keydown', this.onKeyDown);

    this.refresh(false);
  }

  // ───────────────────────── public API ─────────────────────────
  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.shownAt = uiNow();
    this.host.appendChild(this.root);
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.closeHelp(false);
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
    this.root.remove();
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Copy of the currently selected build. */
  getLoadout(): Loadout {
    return { fcs: this.loadout.fcs, generator: this.loadout.generator, legs: this.loadout.legs };
  }

  /** Programmatic selection (e.g. restoring a build). Calls onChange only when `notify` is true. */
  setLoadout(loadout: Loadout, notify = false): void {
    let changed = false;
    if (loadout.fcs in FCS_PARTS && loadout.fcs !== this.loadout.fcs) {
      this.loadout.fcs = loadout.fcs;
      changed = true;
    }
    if (loadout.generator in GENERATOR_PARTS && loadout.generator !== this.loadout.generator) {
      this.loadout.generator = loadout.generator;
      changed = true;
    }
    if (loadout.legs in LEGS_PARTS && loadout.legs !== this.loadout.legs) {
      this.loadout.legs = loadout.legs;
      changed = true;
    }
    if (!changed) return;
    this.refresh(true);
    if (notify) this.opts.onChange(this.getLoadout());
  }

  /** Message shown above the sortie button (e.g. why the pointer lock failed); null hides it. */
  setNotice(text: string | null): void {
    const t = text ?? '';
    if (this.noticeText.data !== t) this.noticeText.data = t;
    this.notice.classList.toggle('is-off', t === '');
  }

  /** Shows whether the sound is on or muted (the M key toggles it; the app owns the state). */
  setAudioMuted(muted: boolean): void {
    const t = audioStatusText(muted);
    if (this.audioText.data !== t) this.audioText.data = t;
  }

  /** Opens the controls help (also reachable with the "操作方法" button). */
  openHelp(): void {
    if (this.helpOpen) return;
    this.scale.appendChild(this.helpLayer);
    this.helpButton.setAttribute('aria-expanded', 'true');
    this.helpBody.scrollTop = 0;
    this.updateHelpHint();
    this.helpClose.focus({ preventScroll: true });
  }

  closeHelp(restoreFocus = true): void {
    if (!this.helpOpen) return;
    this.helpLayer.remove();
    this.helpButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.helpButton.focus({ preventScroll: true });
  }

  get helpOpen(): boolean {
    return this.helpLayer.parentNode !== null;
  }

  /**
   * The transparent, click-through area in the middle of the garage (CSS pixels relative to the viewport)
   * in which the renderer should frame the mech preview. Only meaningful while the garage is shown; it
   * changes with the window size but not with the selection or the notice.
   */
  getPreviewRect(): { x: number; y: number; width: number; height: number } {
    const r = this.centre.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  /** Removes the overlay from the document. */
  dispose(): void {
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('keydown', this.onKeyDown);
    this.root.remove();
  }

  // ───────────────────────── construction helpers ─────────────────────────
  private buildGroup(
    parent: HTMLElement,
    group: GroupId,
    num: string,
    en: string,
    jp: string,
    hint: string,
    ids: readonly string[],
    describe: (id: string) => { label: string; pros: string; cons: string; nums: Array<[string, string, string]>; numsRow: boolean },
  ): void {
    const panel = el('section', 'ui-panel gar-group', undefined, parent);
    panel.setAttribute('data-group', group);
    const h = el('h2', 'ui-panel-h', undefined, panel);
    h.id = 'gar-h-' + group;
    el('span', 'num', num, h);
    el('span', 'en', en, h);
    el('span', 'jp', jp, h);
    el('span', 'hint', hint, h);
    const list = el('div', 'gar-opts', undefined, panel);
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-labelledby', h.id);
    for (const id of ids) {
      const d = describe(id);
      const b = el('button', 'gar-opt', undefined, list);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('data-group', group);
      b.setAttribute('data-id', id);
      const head = el('span', 'gar-opt-head', undefined, b);
      el('span', 'gar-opt-mark', undefined, head);
      el('span', 'gar-opt-label', d.label, head);
      el('span', 'gar-opt-tag', '選択中', head);
      const nums = el('span', d.numsRow ? 'gar-opt-nums row' : 'gar-opt-nums', undefined, d.numsRow ? b : head);
      d.nums.forEach(([key, value, unit], idx) => {
        if (idx > 0) el('span', 'sep', undefined, nums);
        if (key) el('span', undefined, key, nums);
        el('b', undefined, value, nums);
        if (unit) el('span', undefined, unit, nums);
      });
      const pro = el('span', 'gar-opt-line pro', undefined, b);
      el('span', 'badge', '長所', pro);
      el('span', 't', d.pros, pro);
      const con = el('span', 'gar-opt-line con', undefined, b);
      el('span', 'badge', '短所', con);
      el('span', 't', d.cons, con);
      this.options.push({ group, id, button: b });
    }
  }

  private buildWeapons(parent: HTMLElement): void {
    const panel = el('section', 'ui-panel gar-weapons', undefined, parent);
    const h = el('h2', 'ui-panel-h', undefined, panel);
    el('span', 'en', 'WEAPONS', h);
    el('span', 'jp', '武装', h);
    el('span', 'hint', `3種すべて携行 ・ 初期選択 ${WEAPONS[DEFAULT_WEAPON].label}`, h);
    const table = el('table', 'gar-wtable', undefined, panel);
    const thead = el('thead', undefined, undefined, table);
    const hr = el('tr', undefined, undefined, thead);
    for (const t of ['武器（切替キー）', '威力', '間隔', '総弾数', 'EN/発', '重力', 'ロック']) {
      const th = el('th', undefined, t, hr);
      th.scope = 'col';
    }
    const tbody = el('tbody', undefined, undefined, table);
    WEAPON_ORDER.forEach((w, idx) => {
      const spec = WEAPONS[w];
      const tr = el('tr', undefined, undefined, tbody);
      const th = el('th', undefined, undefined, tr);
      th.scope = 'row';
      el('span', 'key', String(idx + 1), th);
      th.appendChild(document.createTextNode(spec.label));
      el('b', undefined, String(spec.damage), el('td', undefined, undefined, tr));
      el('td', undefined, f2(spec.interval) + '秒', tr);
      el('td', undefined, Number.isFinite(spec.ammo) ? String(spec.ammo) : '∞ 無制限', tr);
      el('td', spec.enCost > 0 ? 'warn' : undefined, String(spec.enCost), tr);
      el('td', undefined, 'gravity' in spec && spec.gravity > 0 ? 'あり' : 'なし', tr);
      el('td', spec.requiresLock ? 'warn' : undefined, spec.requiresLock ? '必須' : '不要', tr);
    });
  }

  // ───────────────────────── state → DOM ─────────────────────────
  private setStat(view: StatView, text: string, flash: boolean, formula?: string, ratio?: number): void {
    if (view.formula && formula !== undefined && view.formula.data !== formula) view.formula.data = formula;
    if (view.bar && ratio !== undefined) view.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio)).toFixed(4)})`;
    if (view.last === text) return;
    view.last = text;
    view.value.data = text;
    if (flash) {
      view.valueEl.classList.remove('gar-flash');
      void view.valueEl.offsetWidth; // restart the highlight animation
      view.valueEl.classList.add('gar-flash');
    }
  }

  private refresh(flash: boolean): void {
    const l = this.loadout;
    for (const o of this.options) {
      const selected = l[o.group] === o.id;
      o.button.classList.toggle('is-selected', selected);
      o.button.setAttribute('aria-checked', selected ? 'true' : 'false');
      o.button.tabIndex = selected ? 0 : -1;
    }
    const fcs = FCS_PARTS[l.fcs];
    const gen = GENERATOR_PARTS[l.generator];
    const legs = LEGS_PARTS[l.legs];
    this.buildChips.fcs.data = fcs.label;
    this.buildChips.generator.data = gen.label;
    this.buildChips.legs.data = legs.label;

    const s = computeEffectiveStats(l);
    const st = this.stats;
    this.setStat(st.maxEn, String(s.maxEn), flash, '脚部補正なし', s.maxEn / MAX_EN);
    this.setStat(st.regen, f2(s.regenPerSecond), flash, `基本 ${trim(gen.regen)} × ${f2(legs.regenMult)}`, s.regenPerSecond / MAX_REGEN);
    this.setStat(st.lock, f3(s.lockSeconds), flash, `基本 ${f2(fcs.lockSeconds)} ÷ ${f2(legs.lockSpeedMult)}`, s.lockSeconds / MAX_LOCK_SECONDS);
    this.setStat(st.radius, f2(s.lockRadiusFactor), flash, 'D = 画面の短辺', s.lockRadiusFactor / MAX_RADIUS);
    this.setStat(st.mult, '×' + f2(s.horizontalSpeedMultiplier), flash);
    this.setStat(st.walk, f1(s.walkSpeed), flash);
    this.setStat(st.glide, f1(s.glideSpeed), flash);
    this.setStat(st.air, f1(s.airSpeed), flash);
    this.setStat(st.qb, f1(s.qbSpeed), flash);
  }

  private select(group: GroupId, id: string): void {
    if (this.loadout[group] === id) return;
    if (group === 'fcs') {
      if (!(id in FCS_PARTS)) return;
      this.loadout.fcs = id as FcsId;
    } else if (group === 'generator') {
      if (!(id in GENERATOR_PARTS)) return;
      this.loadout.generator = id as GeneratorId;
    } else {
      if (!(id in LEGS_PARTS)) return;
      this.loadout.legs = id as LegsId;
    }
    this.refresh(true);
    this.opts.onChange(this.getLoadout());
  }

  // ───────────────────────── events ─────────────────────────
  private readonly onClick = (e: MouseEvent): void => {
    const target = e.target as Element | null;
    if (!target || !this.shown) return;
    if (target === this.helpLayer) {
      this.closeHelp(); // click on the dimmed area outside the help panel
      return;
    }
    const button = target.closest('button');
    if (!button || !this.root.contains(button)) return;
    const group = button.getAttribute('data-group') as GroupId | null;
    if (group) {
      this.select(group, button.getAttribute('data-id') ?? '');
      return;
    }
    switch (button.getAttribute('data-act')) {
      case 'help':
        this.openHelp();
        break;
      case 'help-close':
        this.closeHelp();
        break;
      case 'sortie': {
        const now = uiNow();
        // Ignore the stray second click of a double click (on this button, or on the button that opened the
        // garage a moment ago). Single clicks and keyboard activation (detail 0 / 1) always count.
        if (e.detail >= 2 && (now - this.shownAt < UI_ARM_DELAY_MS || now - this.lastSortieAt < 500)) return;
        this.lastSortieAt = now;
        this.opts.onSortie(this.getLoadout());
        break;
      }
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.shown) return;
    if (this.helpOpen) {
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeHelp();
      } else if (e.code === 'Tab') {
        // Keep the focus inside the dialog (close button ⇄ scrollable body).
        e.preventDefault();
        (document.activeElement === this.helpClose ? this.helpBody : this.helpClose).focus({ preventScroll: true });
      }
      return;
    }
    const target = e.target as Element | null;
    const button = target ? target.closest('.gar-opt') : null;
    if (!button) return;
    // Radio-group keyboard behaviour: arrows move the selection inside the group.
    const group = button.getAttribute('data-group') as GroupId;
    const members = this.options.filter((o) => o.group === group);
    const index = members.findIndex((o) => o.button === button);
    let next = -1;
    if (e.code === 'ArrowDown' || e.code === 'ArrowRight') next = (index + 1) % members.length;
    else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') next = (index - 1 + members.length) % members.length;
    else if (e.code === 'Home') next = 0;
    else if (e.code === 'End') next = members.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const o = members[next];
    this.select(o.group, o.id);
    o.button.focus({ preventScroll: true });
  };
}
