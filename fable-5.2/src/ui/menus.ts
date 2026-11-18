/**
 * Menus — docs/SPEC.md §2.1, §8, §9: pause overlay, result overlay (cleared / failed) and the
 * pointer-lock error panel.
 *
 * The overlay covers the whole display area and swallows pointer events, so a click on a menu button can
 * never reach the game as a shot. The app decides what the buttons do (the callbacks are invoked from the
 * click itself, i.e. inside a user gesture, so the pointer lock can be requested from them) and hides the
 * overlay with hideAll() once the game really continues.
 *
 * Only what is on screen is in the document: the overlay is attached while a panel is shown and holds just
 * that panel, so DOM / text queries never hit a hidden duplicate of a button.
 *
 * Buttons are not focused automatically, and the follow-up clicks of a rapid click series are ignored for a
 * moment after a panel appears: a player who is still hammering Space or the fire button when the game
 * pauses / ends must not trigger "再開" or "再出撃" by accident. A single click always counts.
 */
import './ui.css';
import { CONTROLS_REQUIRED, PLAYER } from '../config';
import type { Loadout } from '../sim/types';
import { UI_ARM_DELAY_MS, attachScrollHint, audioStatusText, controlsHelpHtml, el, loadoutLabels, shieldUiEvents, uiNow } from './help';

export interface ResultInfo {
  elapsedSeconds: number;
  hp: number;
  controlsDestroyed: number;
  enemiesDestroyed: number;
  totalEnemies: number;
  failReason: 'destroyed' | 'fell' | null;
  loadout: Loadout;
}

export interface MenuCallbacks {
  /** "再開" and the retry button of the pointer-lock error. */
  onResume(): void;
  /** "同じ構成で再出撃". */
  onRestart(): void;
  /** "格納庫へ戻る". */
  onGarage(): void;
}

export type MenuView = 'pause' | 'result' | 'plerror';

/** mm:ss.s (h:mm:ss.s from one hour on). */
export function formatElapsed(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 10) / 10 : 0;
  const whole = Math.floor(total);
  const tenths = Math.floor((total - whole) * 10 + 1e-6);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const two = (n: number): string => (n < 10 ? '0' + n : String(n));
  return (h > 0 ? h + ':' + two(m) : two(m)) + ':' + two(s) + '.' + tenths;
}

const ICON_CLEARED = `
<svg class="res-icon" viewBox="0 0 48 48" aria-hidden="true">
  <path d="M24 3 42 13.5v21L24 45 6 34.5v-21Z" fill="rgba(134,247,196,0.12)" stroke="#86f7c4" stroke-width="2.5"/>
  <path d="M14.5 24.5 21.5 31.5 34 17.5" fill="none" stroke="#86f7c4" stroke-width="4.5" stroke-linecap="square"/>
</svg>`;
const ICON_FAILED = `
<svg class="res-icon" viewBox="0 0 48 48" aria-hidden="true">
  <path d="M15 4h18l11 11v18L33 44H15L4 33V15Z" fill="rgba(255,90,79,0.12)" stroke="#ff5a4f" stroke-width="2.5"/>
  <path d="M16 16 32 32M32 16 16 32" fill="none" stroke="#ff5a4f" stroke-width="4.5" stroke-linecap="square"/>
</svg>`;
const ICON_WARN = `
<svg class="menu-warn-icon" viewBox="0 0 24 22" aria-hidden="true">
  <path d="M12 1.5 23 20.5H1Z" fill="none" stroke="#ffb53a" stroke-width="2"/>
  <path d="M12 8v6.5M12 16.4v1.9" stroke="#ffb53a" stroke-width="2.2"/>
</svg>`;

export class Menus {
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly wrap: HTMLDivElement;
  private readonly cb: MenuCallbacks;
  private readonly pausePanel: HTMLElement;
  private readonly pauseHelp: HTMLDivElement;
  private readonly pauseHelpButton: HTMLButtonElement;
  private readonly pauseAudio: Text;
  private readonly resultPanel: HTMLElement;
  private readonly resIconHost: HTMLElement;
  private readonly resTitle: HTMLElement;
  private readonly resSub: HTMLElement;
  private readonly resSubNote: HTMLElement;
  private readonly resTime: Text;
  private readonly resHp: Text;
  private readonly resHpBar: HTMLElement;
  private readonly resHpFill: HTMLElement;
  private readonly resControls: Text;
  private readonly resPips: HTMLElement[] = [];
  private readonly resEnemies: Text;
  private readonly resEnemiesTotal: Text;
  private readonly resEnemyFill: HTMLElement;
  private readonly resBuild: Text[] = [];
  private readonly errPanel: HTMLElement;
  private readonly errReason: Text;
  private view: MenuView | null = null;
  private shownAt = 0;
  private lastActionAt = -1e9;
  private helpLoaded = false;
  private updateHelpHint: () => void = () => {};

  constructor(root: HTMLElement, cb: MenuCallbacks) {
    this.cb = cb;
    this.host = root;
    this.root = el('div', 'ak2-ui ak2-menus');
    this.root.setAttribute('data-ui', 'menus');
    shieldUiEvents(this.root);
    const scale = el('div', 'ui-scale', undefined, this.root);
    el('div', 'menu-backdrop', undefined, scale);
    this.wrap = el('div', 'menu-wrap', undefined, scale);

    const button = (parent: HTMLElement, act: string, jp: string, en: string, primary = false): HTMLButtonElement => {
      const b = el('button', primary ? 'ui-btn primary' : 'ui-btn', undefined, parent);
      b.type = 'button';
      b.setAttribute('data-act', act);
      el('span', 'jp', jp, b);
      el('span', 'en', en, b);
      return b;
    };
    const dialog = (className: string, label: string): HTMLElement => {
      const p = el('section', 'ui-panel menu-panel ' + className); // attached to this.wrap only while shown
      p.setAttribute('role', 'dialog');
      p.setAttribute('aria-modal', 'true');
      p.setAttribute('aria-label', label);
      p.tabIndex = -1;
      return p;
    };

    // ───────── pause ─────────
    this.pausePanel = dialog('menu-pause', '一時停止');
    const side = el('div', 'menu-side', undefined, this.pausePanel);
    const pk = el('div', 'menu-kicker', undefined, side);
    const pi = el('span', 'menu-pause-icon', undefined, pk);
    el('i', undefined, undefined, pi);
    el('i', undefined, undefined, pi);
    pk.appendChild(document.createTextNode('PAUSED'));
    el('h2', 'menu-title', '一時停止', side);
    // (the button labels are deliberately not repeated in the passive text of a panel)
    el('p', 'menu-note', 'ゲーム内の時間は停止しています。敵・弾・EN・ロックは進みません。', side);
    const pb = el('div', 'menu-btns', undefined, side);
    button(pb, 'resume', '再開', 'RESUME', true);
    this.pauseHelpButton = button(pb, 'help', '操作方法', 'CONTROLS');
    this.pauseHelpButton.setAttribute('aria-expanded', 'false');
    button(pb, 'restart', '同じ構成で再出撃', 'RESTART');
    button(pb, 'garage', '格納庫へ戻る', 'HANGAR');
    // sound state as text ("音声 ON [M]" / "音声 OFF [M]"); the app keeps it current (setAudioMuted)
    const audio = el('p', 'menu-audio', undefined, side);
    this.pauseAudio = document.createTextNode(audioStatusText(false));
    el('b', undefined, undefined, audio).appendChild(this.pauseAudio);
    audio.appendChild(document.createTextNode(' — M キーで切り替え'));
    el('p', 'menu-foot', 'ゲームに戻るとマウスカーソルを再び画面に固定します。押したままのキーは、いったん離してから押し直すまで無効です。', side);
    this.pauseHelp = el('div', 'menu-help ui-scroll', undefined, this.pausePanel);
    this.pauseHelp.tabIndex = 0;

    // ───────── result ─────────
    this.resultPanel = dialog('menu-result', '結果');
    el('div', 'res-band', undefined, this.resultPanel);
    const rb = el('div', 'res-body', undefined, this.resultPanel);
    el('div', 'menu-kicker', 'RESULT / 結果', rb);
    const head = el('div', 'res-head', undefined, rb);
    this.resIconHost = el('span', 'res-icon-host', undefined, head);
    const headText = el('div', undefined, undefined, head);
    this.resTitle = el('h2', 'res-title', '', headText);
    this.resSub = el('div', 'res-sub', undefined, headText);
    this.resSub.appendChild(document.createTextNode(''));
    this.resSubNote = el('small', undefined, '', this.resSub);

    const grid = el('div', 'res-grid', undefined, rb);
    const cell = (en: string, jp: string, wide = false): { cell: HTMLElement; value: HTMLElement } => {
      const c = el('div', wide ? 'res-cell wide' : 'res-cell', undefined, grid);
      const k = el('div', 'k', undefined, c);
      el('span', 'en', en, k);
      k.appendChild(document.createTextNode(jp));
      return { cell: c, value: el('div', 'v', undefined, c) };
    };
    const textIn = (parent: HTMLElement, text = ''): Text => {
      const t = document.createTextNode(text);
      parent.appendChild(t);
      return t;
    };
    const time = cell('TIME', '経過時間');
    this.resTime = textIn(time.value);
    const hp = cell('HP', '残りHP');
    this.resHp = textIn(hp.value);
    el('small', undefined, '/ ' + PLAYER.maxHp, hp.value);
    this.resHpBar = el('div', 'res-bar', undefined, hp.cell);
    this.resHpFill = el('i', undefined, undefined, this.resHpBar);
    const ctl = cell('CONTROLS', '制御砲台の破壊');
    this.resControls = textIn(ctl.value);
    el('small', undefined, '/ ' + CONTROLS_REQUIRED, ctl.value);
    const pips = el('div', 'res-pips', undefined, ctl.cell);
    for (let i = 0; i < CONTROLS_REQUIRED; i++) this.resPips.push(el('i', undefined, undefined, pips));
    const en = cell('ENEMIES', '敵の撃破');
    this.resEnemies = textIn(en.value);
    const enTotal = el('small', undefined, undefined, en.value);
    this.resEnemiesTotal = textIn(enTotal);
    const enBar = el('div', 'res-bar', undefined, en.cell);
    this.resEnemyFill = el('i', undefined, undefined, enBar);
    this.resEnemyFill.style.background = 'var(--ui-line)';
    const build = cell('BUILD', '機体構成', true);
    build.value.classList.add('build');
    for (let i = 0; i < 3; i++) this.resBuild.push(textIn(el('span', undefined, undefined, build.value)));

    const rbtn = el('div', 'res-btns', undefined, rb);
    button(rbtn, 'restart', '同じ構成で再出撃', 'RETRY', true);
    button(rbtn, 'garage', '格納庫へ戻る', 'HANGAR');

    // ───────── pointer-lock error ─────────
    this.errPanel = dialog('menu-plerr', 'ポインターロックエラー');
    const ek = el('div', 'menu-kicker', undefined, this.errPanel);
    ek.insertAdjacentHTML('beforeend', ICON_WARN);
    ek.appendChild(document.createTextNode('POINTER LOCK ERROR'));
    el('h2', 'menu-title', 'ポインターロックを取得できませんでした', this.errPanel);
    el(
      'p',
      'menu-note',
      'マウスカーソルを画面に固定できないため、機体を操作できません。戦闘は一時停止したままで、ゲーム内の時間は進んでいません。',
      this.errPanel,
    );
    const reason = el('div', 'plerr-reason', undefined, this.errPanel);
    el('span', 'k', '原因', reason);
    this.errReason = textIn(reason);
    const list = el('ul', 'plerr-list', undefined, this.errPanel);
    el('li', undefined, '下の左のボタンを押すと、もう一度マウスカーソルの固定を要求してゲームに戻ります。', list);
    el('li', undefined, 'Esc で固定を解除した直後は、ブラウザーの制限で 1〜2 秒ほど取得できないことがあります。少し待ってからもう一度押してください。', list);
    el('li', undefined, 'ブラウザーのウィンドウが最前面で選択されていること、ページがマウスの固定を禁止されていないことを確認してください。', list);
    const ebtn = el('div', 'res-btns', undefined, this.errPanel);
    button(ebtn, 'resume', '再試行', 'RETRY', true);
    button(ebtn, 'garage', '格納庫へ戻る', 'HANGAR');

    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('keydown', this.onKeyDown);
  }

  // ───────────────────────── public API ─────────────────────────
  /** True while any of the panels is shown. */
  get visible(): boolean {
    return this.view !== null;
  }

  /** Which panel is shown (null: none). */
  get current(): MenuView | null {
    return this.view;
  }

  /** Shows whether the sound is on or muted in the pause menu (the M key toggles it; the app owns the state). */
  setAudioMuted(muted: boolean): void {
    const t = audioStatusText(muted);
    if (this.pauseAudio.data !== t) this.pauseAudio.data = t;
  }

  showPause(): void {
    if (this.view === 'pause') return; // already shown: keep the help as the player left it
    this.setHelpOpen(false);
    this.open('pause', this.pausePanel);
  }

  showResult(kind: 'cleared' | 'failed', info: ResultInfo): void {
    const cleared = kind === 'cleared';
    const p = this.resultPanel;
    p.classList.toggle('is-cleared', cleared);
    p.classList.toggle('is-failed', !cleared);
    this.resIconHost.innerHTML = cleared ? ICON_CLEARED : ICON_FAILED;
    this.resTitle.textContent = cleared ? 'MISSION CLEAR' : 'MISSION FAILED';
    const sub = this.resSub.firstChild as Text;
    if (cleared) {
      sub.data = '脱出成功';
      this.resSubNote.textContent = '最終搬出ゲートを抜け、廃工場から脱出しました';
    } else if (info.failReason === 'fell') {
      sub.data = 'ステージ外へ落下';
      this.resSubNote.textContent = '復帰できない領域へ落下しました';
    } else {
      sub.data = '機体大破';
      this.resSubNote.textContent = 'HP が 0 になりました';
    }

    this.resTime.data = formatElapsed(info.elapsedSeconds);
    const hp = Math.max(0, Math.min(PLAYER.maxHp, Number.isFinite(info.hp) ? info.hp : 0));
    this.resHp.data = String(hp > 0 ? Math.max(1, Math.round(hp)) : 0);
    this.resHpFill.style.transform = `scaleX(${(hp / PLAYER.maxHp).toFixed(4)})`;
    this.resHpBar.classList.toggle('low', hp / PLAYER.maxHp <= 0.25);
    const controls = Math.max(0, Math.min(CONTROLS_REQUIRED, Math.floor(info.controlsDestroyed)));
    this.resControls.data = String(controls);
    this.resPips.forEach((pip, i) => pip.classList.toggle('on', i < controls));
    const total = Math.max(0, Math.floor(info.totalEnemies));
    const destroyed = Math.max(0, Math.min(total, Math.floor(info.enemiesDestroyed)));
    this.resEnemies.data = String(destroyed);
    this.resEnemiesTotal.data = '/ ' + total;
    this.resEnemyFill.style.transform = `scaleX(${(total > 0 ? destroyed / total : 0).toFixed(4)})`;
    const labels = loadoutLabels(info.loadout);
    this.resBuild[0].data = labels.fcs;
    this.resBuild[1].data = labels.generator;
    this.resBuild[2].data = labels.legs;

    this.open('result', p);
  }

  /** Explanation + retry button (retry calls onResume). `message` says why the request failed. */
  showPointerLockError(message: string): void {
    this.errReason.data = message && message.trim() !== '' ? message : 'ブラウザーがマウスカーソルの固定を許可しませんでした。';
    this.open('plerror', this.errPanel);
  }

  hideAll(): void {
    if (this.view === null) return;
    this.view = null;
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
    this.root.remove();
    this.wrap.replaceChildren();
  }

  /** Removes the overlay from the document. */
  dispose(): void {
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('keydown', this.onKeyDown);
    this.root.remove();
  }

  // ───────────────────────── internals ─────────────────────────
  private open(view: MenuView, panel: HTMLElement): void {
    if (panel.parentNode !== this.wrap || this.wrap.childElementCount !== 1) this.wrap.replaceChildren(panel);
    if (this.root.parentNode !== this.host) this.host.appendChild(this.root);
    if (this.view !== view) this.shownAt = uiNow();
    this.view = view;
    // Focus the dialog itself, not a button: Tab reaches the buttons, a stray Space / Enter does nothing.
    panel.focus({ preventScroll: true });
  }

  private setHelpOpen(open: boolean): void {
    if (open && !this.helpLoaded) {
      this.pauseHelp.innerHTML = controlsHelpHtml();
      this.updateHelpHint = attachScrollHint(this.pauseHelp);
      this.helpLoaded = true;
    }
    this.pausePanel.classList.toggle('has-help', open);
    this.pauseHelpButton.classList.toggle('is-on', open);
    this.pauseHelpButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      this.pauseHelp.scrollTop = 0;
      this.updateHelpHint();
    }
  }

  private readonly onClick = (e: MouseEvent): void => {
    if (this.view === null) return;
    const target = e.target as Element | null;
    const button = target ? target.closest('button') : null;
    if (!button || !this.root.contains(button)) return;
    const act = button.getAttribute('data-act');
    if (act === 'help') {
      this.setHelpOpen(!this.pausePanel.classList.contains('has-help'));
      return;
    }
    // Stray clicks: the second (third …) click of a rapid click series (`detail` ≥ 2) is ignored right after a
    // panel appeared (a player who was tapping the fire button) and right after an accepted action (double
    // click). Single clicks and keyboard activation always count.
    const now = uiNow();
    if (e.detail >= 2 && (now - this.shownAt < UI_ARM_DELAY_MS || now - this.lastActionAt < 500)) return;
    this.lastActionAt = now;
    if (act === 'resume') this.cb.onResume();
    else if (act === 'restart') this.cb.onRestart();
    else if (act === 'garage') this.cb.onGarage();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.view !== 'pause' || e.code !== 'Escape') return;
    if (!this.pausePanel.classList.contains('has-help')) return;
    // Esc closes the inline help; it never resumes the game (a pointer lock needs a click anyway).
    e.preventDefault();
    e.stopPropagation();
    this.setHelpOpen(false);
  };
}
