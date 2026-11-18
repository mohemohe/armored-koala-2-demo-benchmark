/**
 * 格納庫 UI（純粋な DOM + CSS）。
 * 部品選択（FCS 3 / ジェネレーター 3 / 脚部 2）、各選択肢の長所短所（PART_DESCRIPTIONS）と生の数値、
 * computeEffectiveStats による実効値、操作説明、出撃ボタン、ポインターロック失敗の説明と再試行。
 * 3D の機体プレビューは描画側が DOM の背後に描くため、パネルは画面右側（約 45%）だけを占める。
 */
import { DEFAULT_LOADOUT, FCS, GENERATORS, LEGS, PART_DESCRIPTIONS, PLAYER, computeEffectiveStats } from '../params';
import type { FcsKind, GeneratorKind, LegsKind, Loadout } from '../types';
import { renderControlsSections, stopPointerPropagation } from './overlays';

const FCS_KINDS: FcsKind[] = ['wide', 'medium', 'narrow'];
const GENERATOR_KINDS: GeneratorKind[] = ['capacity', 'balanced', 'recovery'];
const LEGS_KINDS: LegsKind[] = ['biped', 'quadruped'];

const f2 = (n: number): string => n.toFixed(2);

function div(className: string, parent?: Element): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (parent) parent.appendChild(d);
  return d;
}

function heading(tag: 'h1' | 'h2', text: string, parent: Element): HTMLHeadingElement {
  const h = document.createElement(tag);
  h.textContent = text;
  parent.appendChild(h);
  return h;
}

function span(className: string, text: string, parent: Element): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  parent.appendChild(s);
  return s;
}

export class GarageUI {
  private readonly root: HTMLDivElement;
  private loadout: Loadout = { ...DEFAULT_LOADOUT };
  private readonly partButtons = new Map<string, HTMLButtonElement>();
  private readonly selectedText: HTMLDivElement;
  private readonly statCells: {
    maxEn: HTMLTableCellElement;
    regen: HTMLTableCellElement;
    lock: HTMLTableCellElement;
    radius: HTMLTableCellElement;
    speed: HTMLTableCellElement;
  };
  private readonly errorBox: HTMLDivElement;
  private readonly errorMsg: HTMLDivElement;
  private visible = true;

  constructor(container: HTMLElement, private readonly callbacks: { onLoadoutChange(l: Loadout): void; onLaunch(): void }) {
    this.root = div('ak2-garage', container);
    stopPointerPropagation(this.root);

    heading('h1', 'ARMORED KOALA 2 — 格納庫', this.root);
    const sub = div('ak2-garage-sub', this.root);
    sub.textContent = '機体構成を選択し、操作方法を確認してから出撃してください。出撃後は構成を変更できません。左側に機体の 3D プレビューを表示します（脚部の変更でモデルも変わります）。';

    // ---- FCS
    heading('h2', 'FCS（ロック範囲とロック所要時間）', this.root);
    const fcsGroup = div('ak2-part-group', this.root);
    for (const k of FCS_KINDS) {
      const def = FCS.kinds[k];
      const desc = PART_DESCRIPTIONS.fcs[k];
      this.addPartButton(fcsGroup, 'fcs', k, def.label, `ロック円半径 ${f2(def.radiusFactor)}D ／ 基本ロック所要時間 ${f2(def.lockSeconds)} 秒（2脚）`, desc.pros, desc.cons, () => {
        this.select({ fcs: k });
      });
    }

    // ---- ジェネレーター
    heading('h2', 'ジェネレーター（最大 EN と回復率）', this.root);
    const genGroup = div('ak2-part-group', this.root);
    for (const k of GENERATOR_KINDS) {
      const def = GENERATORS[k];
      const desc = PART_DESCRIPTIONS.generator[k];
      this.addPartButton(genGroup, 'generator', k, def.label, `最大EN ${def.maxEn} ／ 基本回復率 ${def.regen} EN/秒（積 ${def.maxEn * def.regen}）`, desc.pros, desc.cons, () => {
        this.select({ generator: k });
      });
    }

    // ---- 脚部
    heading('h2', '脚部（速度・回復・ロック速度の倍率）', this.root);
    const legsGroup = div('ak2-part-group two', this.root);
    for (const k of LEGS_KINDS) {
      const def = LEGS[k];
      const desc = PART_DESCRIPTIONS.legs[k];
      this.addPartButton(
        legsGroup,
        'legs',
        k,
        def.label,
        `水平移動速度 ×${f2(def.speedMul)} ／ EN回復率 ×${f2(def.regenMul)} ／ ロック速度 ×${f2(def.lockSpeedMul)}`,
        desc.pros,
        desc.cons,
        () => {
          this.select({ legs: k });
        },
      );
    }

    // ---- 現在の構成（実効値）
    heading('h2', '現在の構成（脚部補正適用後の実効値）', this.root);
    const stats = div('ak2-stats', this.root);
    this.selectedText = div('ak2-stats-selected', stats);
    const table = document.createElement('table');
    stats.appendChild(table);
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
    this.statCells = {
      maxEn: addRow('最大EN'),
      regen: addRow('EN回復率'),
      lock: addRow('ロック所要時間'),
      radius: addRow('ロック円半径'),
      speed: addRow('水平移動速度'),
    };
    const note = div('ak2-garage-sub', stats);
    note.textContent = `初期武器はマシンガン。QB は発動時 ${PLAYER.qb.cost} EN、飛行は ${PLAYER.flightEnPerSecond} EN/秒、グライドは 0 EN。`;

    // ---- 操作説明
    heading('h2', '操作方法', this.root);
    this.root.appendChild(renderControlsSections());

    // ---- 出撃
    const launchArea = div('ak2-launch-area', this.root);
    const launch = document.createElement('button');
    launch.type = 'button';
    launch.className = 'ak2-btn primary';
    launch.textContent = '出撃';
    launch.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.callbacks.onLaunch();
    });
    launchArea.appendChild(launch);
    const launchNote = div('ak2-launch-note', launchArea);
    launchNote.textContent = 'このクリックでポインターロック（マウス捕捉）を取得して出撃します。Esc で一時停止・捕捉解除。クリックは射撃として扱われません。';

    // ---- ポインターロック失敗
    this.errorBox = div('ak2-plerror', launchArea);
    const et = div('title', this.errorBox);
    et.textContent = 'ポインターロックを取得できませんでした';
    const ed = div('', this.errorBox);
    ed.textContent =
      'ブラウザーがマウス捕捉を拒否したか、直前に解除されたばかりで再取得が制限されています（Esc 直後は 1〜2 秒待つ必要があります）。' +
      'ページが前面にあり、他のダイアログが開いていないことを確認してから「再試行」を押してください。捕捉できるまで出撃しません。';
    this.errorMsg = div('msg', this.errorBox);
    const eb = div('ak2-dialog-buttons', this.errorBox);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ak2-btn';
    retry.textContent = '再試行';
    retry.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.callbacks.onLaunch();
    });
    eb.appendChild(retry);

    this.refresh();
  }

  private addPartButton(
    group: HTMLElement,
    part: keyof Loadout,
    kind: string,
    name: string,
    nums: string,
    pros: string,
    cons: string,
    onSelect: () => void,
  ): void {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ak2-part-btn';
    b.setAttribute('aria-pressed', 'false');
    b.dataset.part = part;
    b.dataset.kind = kind;
    span('name', name, b);
    span('nums ak2-num', nums, b);
    span('pros', `長所: ${pros}`, b);
    span('cons', `短所: ${cons}`, b);
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onSelect();
    });
    group.appendChild(b);
    this.partButtons.set(`${part}:${kind}`, b);
  }

  private select(patch: Partial<Loadout>): void {
    const next: Loadout = { ...this.loadout, ...patch };
    if (next.fcs === this.loadout.fcs && next.generator === this.loadout.generator && next.legs === this.loadout.legs) return;
    this.loadout = next;
    this.refresh();
    this.callbacks.onLoadoutChange({ ...this.loadout });
  }

  /** 外部から構成を設定する（コールバックは呼ばない） */
  setLoadout(l: Loadout): void {
    this.loadout = { fcs: l.fcs, generator: l.generator, legs: l.legs };
    this.refresh();
  }

  getLoadout(): Loadout {
    return { ...this.loadout };
  }

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
  }

  setPointerLockError(msg: string | null): void {
    if (msg) {
      this.errorMsg.textContent = msg;
      this.errorBox.classList.add('show');
      this.errorBox.scrollIntoView({ block: 'nearest' });
    } else {
      this.errorMsg.textContent = '';
      this.errorBox.classList.remove('show');
    }
  }

  private refresh(): void {
    const lo = this.loadout;
    for (const [key, b] of this.partButtons) {
      const [part, kind] = key.split(':') as [keyof Loadout, string];
      const on = lo[part] === kind;
      const cur = b.getAttribute('aria-pressed') === 'true';
      if (cur !== on) b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const fcs = FCS.kinds[lo.fcs];
    const gen = GENERATORS[lo.generator];
    const legs = LEGS[lo.legs];
    const st = computeEffectiveStats(lo);
    this.selectedText.textContent = `選択中: ${fcs.label}FCS ／ ${gen.label}ジェネレーター ／ ${legs.label}`;
    this.statCells.maxEn.textContent = `${st.maxEn} EN`;
    this.statCells.regen.innerHTML = '';
    this.statCells.regen.append(`${f2(st.regenPerSecond)} EN/秒 `, formula(`${gen.regen} × ${f2(legs.regenMul)}`));
    this.statCells.lock.innerHTML = '';
    this.statCells.lock.append(`${st.lockSeconds.toFixed(3)} 秒 `, formula(`${f2(fcs.lockSeconds)} ÷ ロック速度 ${f2(legs.lockSpeedMul)}`));
    this.statCells.radius.innerHTML = '';
    this.statCells.radius.append(`${f2(st.lockRadiusFactor)}D `, formula('D = 表示領域の幅と高さの小さい方'));
    const mul = st.horizontalSpeedMultiplier;
    this.statCells.speed.innerHTML = '';
    this.statCells.speed.append(
      `通常 ${(PLAYER.walkSpeed * mul).toFixed(1)} ／ グライド ${(PLAYER.glideGroundSpeed * mul).toFixed(1)} ／ 空中 ${(PLAYER.airSpeed * mul).toFixed(1)} ／ QB ${(PLAYER.qb.speed * mul).toFixed(1)} m/s `,
      formula(`基準 ${PLAYER.walkSpeed} / ${PLAYER.glideGroundSpeed} / ${PLAYER.airSpeed} / ${PLAYER.qb.speed} × 倍率 ${f2(mul)}`),
    );
  }
}

function formula(text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'formula';
  s.textContent = `（${text}）`;
  return s;
}
