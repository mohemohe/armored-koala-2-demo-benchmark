/**
 * 操作説明 (格納庫と一時停止画面の両方から開ける)。数値は config.ts の値を使う。
 */
import { FCS, PLAYER, STAGE, WEAPONS } from '../config';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface HelpRow {
  key: string;
  desc: string;
}

export interface HelpSection {
  title: string;
  rows: HelpRow[];
  /** 行にしない段落 */
  notes?: string[];
}

export function helpSections(): HelpSection[] {
  const q = PLAYER.QB;
  return [
    {
      title: '基本操作',
      rows: [
        { key: 'W / A / S / D', desc: `移動 (2脚で ${PLAYER.WALK_SPEED} m/s。カメラの向き基準。入力を離すと停止へ向かって減速)` },
        { key: 'マウス移動', desc: '視点の旋回と照準' },
        {
          key: 'Space',
          desc: `接地中に押すとジャンプ。${PLAYER.FLIGHT_HOLD_SECONDS}秒以上の長押しで飛行 (上昇。${PLAYER.FLIGHT_EN_PER_SEC} EN/秒)`,
        },
        { key: 'Shift', desc: 'グライドのON/OFF切り替え (1回押すだけ。押し続ける必要はない。0 EN)' },
        { key: '左Ctrl', desc: 'ブレーキ (グライド解除 + 減速)' },
        {
          key: 'Q',
          desc: `クイックブースト: 単発・${q.COST} EN。${q.DURATION}秒の噴射のあと自動でグライドへ移行し慣性で進む。押し続けても再発動しない (離して押し直す)`,
        },
        { key: '1 / 2 / 3', desc: 'マシンガン / ビーム / ハンドミサイル に切り替え (切り替えで残弾・ENはリセットされない)' },
        { key: '左クリック', desc: '射撃 (押している間、武器の射撃間隔で連射)' },
        { key: 'Esc', desc: '一時停止 (ポインターロック解除)' },
      ],
    },
    {
      title: 'FCS (射撃管制) と照準',
      rows: [
        {
          key: '補正は自動',
          desc: '対象をFCS円の中に保つだけで偏差と重力を自動補正する。中央の照準を補正マーカーへ手動で合わせる必要はない。',
        },
        { key: 'ロック', desc: `円の中に対象(生存・${FCS.RANGE}m以内・遮蔽なし)があると自動で取得・進行する。完了すると補正が実際の射撃方向へ適用される` },
        { key: 'マーカー', desc: '四角の枠 = 対象の現在位置 / ひし形 = 補正照準(実際の射出方向)。「補正解なし」のときは×印で現在位置へ直接照準' },
        { key: 'マシンガン', desc: `${WEAPONS.machinegun.totalAmmo}発。ロック不要の自由射撃も可。ロック完了中は偏差と重力を同時に補正` },
        { key: 'ビーム', desc: `弾数無制限。1射 ${WEAPONS.beam.enCost} EN。即時命中(対象の現在位置へ)` },
        { key: 'ハンドミサイル', desc: `${WEAPONS.missile.totalAmmo}発。ロック完了時のみ発射可能。未ロックでは発射されない` },
      ],
    },
    {
      title: '移動とEN',
      rows: [
        { key: 'グライドは0 EN', desc: 'ENが0でも使える。接地中はEN回復も妨げない' },
        { key: '停止', desc: '左CtrlまたはShiftでのグライド解除で停止へ向かう。WASDを離しただけではグライド中は止まらない' },
        { key: 'ENを使う動作', desc: `クイックブースト(${q.COST} EN)・飛行(${PLAYER.FLIGHT_EN_PER_SEC} EN/秒)・ビーム(${WEAPONS.beam.enCost} EN/射)` },
        { key: 'EN回復', desc: `接地中で、最後のEN消費から${PLAYER.EN_REGEN_DELAY}秒後から回復 (空中では回復しない)` },
      ],
    },
    {
      title: '目的',
      rows: [
        { key: '脱出', desc: `制御砲台${STAGE.CONTROLS_REQUIRED}体を破壊 → 対応する隔壁が開く → 全て破壊すると最終ゲートが開く → 脱出領域へ入ればクリア。他の敵の全滅は不要` },
        { key: 'HP', desc: `HPは ${PLAYER.MAX_HP}。自然回復・補給はない。0になるか、ステージ外へ落下すると失敗` },
      ],
    },
  ];
}

export function buildHelpContent(): HTMLElement {
  const root = el('div', 'help-content');
  for (const sec of helpSections()) {
    const s = el('section', 'help-sec');
    s.appendChild(el('h3', 'help-h', sec.title));
    const grid = el('dl', 'help-grid');
    for (const r of sec.rows) {
      grid.appendChild(el('dt', 'help-key', r.key));
      grid.appendChild(el('dd', 'help-desc', r.desc));
    }
    s.appendChild(grid);
    for (const n of sec.notes ?? []) s.appendChild(el('p', 'help-note', n));
    root.appendChild(s);
  }
  return root;
}

/** 操作説明モーダル。格納庫・一時停止のどちらからも同じインスタンスを開く。 */
export class HelpModal {
  private overlay: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private returnFocus: HTMLElement | null = null;
  onClose: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.overlay = el('div', 'overlay help-overlay');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', '操作方法');
    const box = el('div', 'dialog help-dialog');
    const head = el('div', 'dialog-head');
    head.appendChild(el('h2', 'dialog-title', '操作方法'));
    this.closeBtn = el('button', 'btn', '閉じる');
    this.closeBtn.type = 'button';
    this.closeBtn.addEventListener('click', () => this.close());
    head.appendChild(this.closeBtn);
    const body = el('div', 'help-body');
    body.appendChild(buildHelpContent());
    box.append(head, body);
    this.overlay.appendChild(box);
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    parent.appendChild(this.overlay);
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  open(): void {
    if (this.isOpen) return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.overlay.hidden = false;
    this.closeBtn.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.overlay.hidden = true;
    const r = this.returnFocus;
    this.returnFocus = null;
    if (r && r.isConnected && !r.closest('[hidden]')) r.focus();
    this.onClose?.();
  }
}
