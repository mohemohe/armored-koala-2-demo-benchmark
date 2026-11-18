/**
 * 一時停止画面と結果画面（純粋な DOM + CSS）。
 * ボタンは実際の <button> 要素。クリック等のポインターイベントは stopPropagation して
 * ゲームの射撃入力として伝播させない（main 側でも防御する）。
 */
import { OBJECTIVE } from '../params';
import { CONTROLS_SECTIONS } from './controlsText';

export interface ResultSummary {
  elapsedSeconds: number;
  controlsDestroyed: number;
  enemiesDestroyed: number;
  failReason: 'hp' | 'fall' | null;
}

const POINTER_EVENTS_TO_STOP = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'auxclick'] as const;

/** 子要素の操作をゲーム入力へ伝播させない */
export function stopPointerPropagation(root: HTMLElement): void {
  for (const type of POINTER_EVENTS_TO_STOP) {
    root.addEventListener(type, (ev) => ev.stopPropagation());
  }
}

/** 操作説明（CONTROLS_SECTIONS）をスクロール可能な箱として生成する */
export function renderControlsSections(): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'ak2-controls-box';
  for (const sec of CONTROLS_SECTIONS) {
    const h = document.createElement('h3');
    h.textContent = sec.title;
    box.appendChild(h);
    const ul = document.createElement('ul');
    for (const line of sec.lines) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  return box;
}

/**
 * 秒を「分」と「0.1 秒単位に丸めた残り秒」に分ける。
 * 先に 0.1 秒へ丸めてから分を切り出すので、59.96 s は 0 分 60.0 秒ではなく 1 分 0.0 秒になる。
 */
export function splitMinutesTenths(sec: number): { minutes: number; seconds: number } {
  const tenths = Math.round(Math.max(0, Number.isFinite(sec) ? sec : 0) * 10);
  const minutes = Math.floor(tenths / 600);
  return { minutes, seconds: (tenths - minutes * 600) / 10 };
}

export function formatElapsed(sec: number): string {
  const { minutes, seconds } = splitMinutesTenths(sec);
  return `${minutes}分 ${seconds.toFixed(1)}秒`;
}

function button(label: string, onClick: () => void, className = 'ak2-btn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  return b;
}

function div(className: string, parent?: Element): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (parent) parent.appendChild(d);
  return d;
}

/**
 * ポインターロック取得失敗の説明箱（題名・説明・失敗メッセージ・再試行ボタン）。
 * 一時停止画面（再開）と結果画面（再出撃）で共用する。
 */
function pointerLockErrorBox(parent: Element, tail: string, onRetry: () => void): { box: HTMLDivElement; msg: HTMLDivElement } {
  const box = div('ak2-plerror', parent);
  const title = div('title', box);
  title.textContent = 'ポインターロックを取得できませんでした';
  const desc = div('', box);
  desc.textContent =
    'ブラウザーがマウス捕捉を拒否したか、直前に解除されたばかりで再取得が制限されています。' +
    'ページが前面にあることを確認し、少し待ってから「再試行」を押してください。' +
    tail;
  const msg = div('msg', box);
  const btns = div('ak2-dialog-buttons', box);
  btns.appendChild(button('再試行', onRetry));
  return { box, msg };
}

export class Overlays {
  private readonly root: HTMLDivElement;
  private readonly pauseDialog: HTMLDivElement;
  private readonly resultDialog: HTMLDivElement;
  private readonly pauseError: HTMLDivElement;
  private readonly pauseErrorMsg: HTMLDivElement;
  private readonly resultTitle: HTMLHeadingElement;
  private readonly resultReason: HTMLDivElement;
  private readonly resultTime: HTMLTableCellElement;
  private readonly resultControls: HTMLTableCellElement;
  private readonly resultEnemies: HTMLTableCellElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly resultError: HTMLDivElement;
  private readonly resultErrorMsg: HTMLDivElement;

  constructor(container: HTMLElement, private readonly callbacks: { onResume(): void; onRetry(): void; onGarage(): void }) {
    this.root = div('ak2-overlays', container);
    stopPointerPropagation(this.root);

    // ---- 一時停止
    this.pauseDialog = div('ak2-dialog ak2-pause', this.root);
    const ph = document.createElement('h1');
    ph.textContent = '一時停止';
    this.pauseDialog.appendChild(ph);
    const pnote = div('ak2-garage-sub', this.pauseDialog);
    pnote.style.textAlign = 'center';
    pnote.textContent = '一時停止中はゲーム内時間・敵・弾体・EN・ロック・待ち時間は進みません。再開ボタンのクリックでポインターロック（マウス捕捉）を再取得します。';
    const pbtns = div('ak2-dialog-buttons', this.pauseDialog);
    this.resumeButton = button('再開', () => this.callbacks.onResume(), 'ak2-btn primary');
    pbtns.appendChild(this.resumeButton);
    pbtns.appendChild(button('格納庫へ戻る', () => this.callbacks.onGarage()));

    const pe = pointerLockErrorBox(this.pauseDialog, '捕捉できるまで戦闘は再開しません。', () => this.callbacks.onResume());
    this.pauseError = pe.box;
    this.pauseErrorMsg = pe.msg;

    const ch = document.createElement('h2');
    ch.textContent = '操作方法';
    this.pauseDialog.appendChild(ch);
    this.pauseDialog.appendChild(renderControlsSections());

    // ---- 結果
    this.resultDialog = div('ak2-dialog ak2-result', this.root);
    this.resultTitle = document.createElement('h1');
    this.resultDialog.appendChild(this.resultTitle);
    this.resultReason = div('ak2-result-reason', this.resultDialog);
    const table = document.createElement('table');
    table.className = 'ak2-result-table';
    const addRow = (label: string): HTMLTableCellElement => {
      const tr = document.createElement('tr');
      const k = document.createElement('td');
      k.textContent = label;
      const v = document.createElement('td');
      v.className = 'ak2-num';
      tr.appendChild(k);
      tr.appendChild(v);
      table.appendChild(tr);
      return v;
    };
    this.resultTime = addRow('経過時間');
    this.resultControls = addRow('制御砲台の破壊');
    this.resultEnemies = addRow('撃破した敵');
    this.resultDialog.appendChild(table);
    const rbtns = div('ak2-dialog-buttons', this.resultDialog);
    rbtns.appendChild(button('再出撃（同じ構成）', () => this.callbacks.onRetry(), 'ak2-btn primary'));
    rbtns.appendChild(button('格納庫へ戻る', () => this.callbacks.onGarage()));
    const rnote = div('ak2-garage-sub', this.resultDialog);
    rnote.style.textAlign = 'center';
    rnote.textContent = '再出撃では位置・HP・EN・残弾・全ての敵・隔壁・ゲート・経過時間を初期化し、機体構成だけを保持します。クリックでポインターロックを取得します。';
    // 再出撃（＝出撃）のポインターロック取得失敗: 説明と再試行（§9）
    const re = pointerLockErrorBox(this.resultDialog, '捕捉できるまで再出撃は開始しません。', () => this.callbacks.onRetry());
    this.resultError = re.box;
    this.resultErrorMsg = re.msg;
  }

  showPause(pointerLockError: string | null): void {
    this.resultDialog.classList.remove('show');
    this.pauseDialog.classList.add('show');
    this.root.classList.add('show');
    if (pointerLockError) {
      this.pauseErrorMsg.textContent = pointerLockError;
      this.pauseError.classList.add('show');
    } else {
      this.pauseErrorMsg.textContent = '';
      this.pauseError.classList.remove('show');
    }
    this.pauseDialog.scrollTop = 0;
  }

  /**
   * 結果画面を表示する。pointerLockError は再出撃時のポインターロック取得失敗メッセージ
   * （main.ts は 3 引数で呼ぶ。null/省略で失敗表示を消す）。
   */
  showResult(kind: 'cleared' | 'failed', summary: ResultSummary, pointerLockError: string | null = null): void {
    this.pauseDialog.classList.remove('show');
    this.pauseError.classList.remove('show');
    this.resultDialog.classList.add('show');
    this.root.classList.add('show');
    if (pointerLockError) {
      this.resultErrorMsg.textContent = pointerLockError;
      this.resultError.classList.add('show');
    } else {
      this.resultErrorMsg.textContent = '';
      this.resultError.classList.remove('show');
    }
    if (kind === 'cleared') {
      this.resultTitle.textContent = '脱出成功';
      this.resultTitle.className = 'cleared';
      this.resultReason.textContent = '最終搬出ゲートを抜けて脱出領域へ到達した';
    } else {
      this.resultTitle.textContent = summary.failReason === 'fall' ? '落下' : '撃破された';
      this.resultTitle.className = 'failed';
      this.resultReason.textContent =
        summary.failReason === 'fall'
          ? '復帰不能なステージ外へ落下した（失敗）'
          : summary.failReason === 'hp'
            ? 'HP が 0 になった（失敗）'
            : '失敗';
    }
    this.resultTime.textContent = formatElapsed(summary.elapsedSeconds);
    this.resultControls.textContent = `${summary.controlsDestroyed} / ${OBJECTIVE.controlsRequired}`;
    this.resultEnemies.textContent = `${summary.enemiesDestroyed} / ${OBJECTIVE.totalEnemies}`;
    this.resultDialog.scrollTop = 0;
  }

  hide(): void {
    this.root.classList.remove('show');
    this.pauseDialog.classList.remove('show');
    this.resultDialog.classList.remove('show');
  }
}
