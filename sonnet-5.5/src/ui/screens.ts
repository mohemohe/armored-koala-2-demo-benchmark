/**
 * 一時停止 / 結果 / ポインターロック失敗 の各オーバーレイ。
 * 一時停止・結果画面はフォーカスをダイアログ本体に置く (押しっぱなしのSpace/Enterでボタンが誤作動しないように)。
 */
import type { ResultModel } from './hudLogic';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', `btn ${cls}`.trim(), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export interface ScreensOptions {
  onResume(): void;
  onPauseToGarage(): void;
  onHelp(): void;
  onRetrySortie(): void;
  onResultToGarage(): void;
  onLockRetry(): void;
  onLockCancel(): void;
}

export type LockContext = 'sortie' | 'resume' | 'retry';

const LOCK_ERROR_TEXT: Record<LockContext, string> = {
  sortie: '出撃はまだ開始していません。',
  resume: '一時停止のままです。ゲームは進行していません。',
  retry: '再出撃はまだ開始していません。',
};

export class Screens {
  private pause: HTMLElement;
  private pauseReason: HTMLElement;
  private pauseResume: HTMLButtonElement;
  private result: HTMLElement;
  private resultTitle: HTMLElement;
  private resultReason: HTMLElement;
  private resultRows: HTMLElement;
  private lockErr: HTMLElement;
  private lockErrLead: HTMLElement;
  private lockErrDetail: HTMLElement;
  private lockRetry: HTMLButtonElement;
  private toast: HTMLElement;
  private fatal: HTMLElement;
  private fatalMsg: HTMLElement;

  constructor(
    root: HTMLElement,
    private opts: ScreensOptions,
  ) {
    // ---- 一時停止
    this.pause = this.overlay('pause', '一時停止');
    const pd = this.dialog(this.pause);
    pd.appendChild(el('h2', 'dialog-title', '一時停止'));
    this.pauseReason = el('p', 'dialog-lead');
    pd.appendChild(this.pauseReason);
    pd.appendChild(
      el(
        'p',
        'dialog-text',
        '敵・弾・HP・EN・ロック・待ち時間・経過時間は停止しています。再開するとマウスを再びロックします。',
      ),
    );
    const pb = el('div', 'dialog-buttons');
    this.pauseResume = button('再開', 'btn-primary btn-big', () => opts.onResume());
    pb.append(this.pauseResume, button('操作方法', '', () => opts.onHelp()), button('格納庫へ', '', () => opts.onPauseToGarage()));
    pd.appendChild(pb);

    // ---- 結果
    this.result = this.overlay('result', '結果');
    const rd = this.dialog(this.result);
    this.resultTitle = el('h2', 'dialog-title result-title');
    this.resultReason = el('p', 'dialog-lead');
    this.resultRows = el('dl', 'result-grid');
    const rb = el('div', 'dialog-buttons');
    rb.append(button('同じ構成で再出撃', 'btn-primary btn-big', () => opts.onRetrySortie()), button('格納庫へ戻る', '', () => opts.onResultToGarage()));
    rd.append(this.resultTitle, this.resultReason, this.resultRows, rb);

    // ---- ポインターロック失敗
    this.lockErr = this.overlay('lockerr', 'ポインターロックを取得できません');
    this.lockErr.classList.add('overlay-top');
    const ld = this.dialog(this.lockErr);
    ld.appendChild(el('h2', 'dialog-title warn', 'マウスのロックを取得できませんでした'));
    this.lockErrLead = el('p', 'dialog-lead');
    ld.appendChild(this.lockErrLead);
    ld.appendChild(
      el(
        'p',
        'dialog-text',
        'ブラウザーがポインターロックを許可しなかった可能性があります。このページのウィンドウがアクティブであることを確認し、「再試行」を押してください。Escで解除した直後は、1秒ほど待つと再取得できます。',
      ),
    );
    this.lockErrDetail = el('p', 'dialog-detail');
    ld.appendChild(this.lockErrDetail);
    const lb = el('div', 'dialog-buttons');
    this.lockRetry = button('再試行', 'btn-primary btn-big', () => opts.onLockRetry());
    lb.append(this.lockRetry, button('戻る', '', () => opts.onLockCancel()));
    ld.appendChild(lb);

    // ---- 取得中トースト
    this.toast = el('div', 'lock-toast', 'ポインターロックを取得しています...');
    this.toast.hidden = true;
    this.toast.setAttribute('role', 'status');

    // ---- 致命的エラー
    this.fatal = this.overlay('fatal', 'エラー');
    this.fatal.classList.add('overlay-top');
    const fd = this.dialog(this.fatal);
    fd.appendChild(el('h2', 'dialog-title warn', '起動できませんでした'));
    this.fatalMsg = el('p', 'dialog-text');
    fd.appendChild(this.fatalMsg);

    root.append(this.pause, this.result, this.lockErr, this.toast, this.fatal);
  }

  private overlay(name: string, label: string): HTMLElement {
    const o = el('div', `overlay screen-${name}`);
    o.hidden = true;
    o.setAttribute('role', 'dialog');
    o.setAttribute('aria-modal', 'true');
    o.setAttribute('aria-label', label);
    return o;
  }

  private dialog(overlay: HTMLElement): HTMLElement {
    const d = el('div', 'dialog');
    d.tabIndex = -1;
    overlay.appendChild(d);
    return d;
  }

  private focusDialog(overlay: HTMLElement): void {
    const d = overlay.querySelector<HTMLElement>('.dialog');
    d?.focus();
  }

  showPause(reason: string): void {
    this.pauseReason.textContent = reason;
    this.pause.hidden = false;
    this.focusDialog(this.pause);
  }
  hidePause(): void {
    this.pause.hidden = true;
  }
  get pauseVisible(): boolean {
    return !this.pause.hidden;
  }

  showResult(m: ResultModel): void {
    this.resultTitle.textContent = m.title;
    this.resultTitle.classList.toggle('clear', m.cleared);
    this.resultTitle.classList.toggle('fail', !m.cleared);
    this.resultReason.textContent = m.reason;
    this.resultRows.textContent = '';
    for (const r of m.rows) {
      this.resultRows.appendChild(el('dt', 'stat-k', r.label));
      this.resultRows.appendChild(el('dd', 'stat-v', r.value));
    }
    this.result.hidden = false;
    this.focusDialog(this.result);
  }
  hideResult(): void {
    this.result.hidden = true;
  }

  showLockError(ctx: LockContext, detail: string): void {
    this.lockErrLead.textContent = LOCK_ERROR_TEXT[ctx];
    this.lockErrDetail.textContent = detail;
    this.lockErr.hidden = false;
    this.lockRetry.focus();
  }
  hideLockError(): void {
    this.lockErr.hidden = true;
  }
  get lockErrorVisible(): boolean {
    return !this.lockErr.hidden;
  }

  setPending(pending: boolean): void {
    this.toast.hidden = !pending;
  }

  showFatal(message: string): void {
    this.fatalMsg.textContent = message;
    this.fatal.hidden = false;
  }

  hideAll(): void {
    this.hidePause();
    this.hideResult();
    this.hideLockError();
    this.setPending(false);
  }
}
