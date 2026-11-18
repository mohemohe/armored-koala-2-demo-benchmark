/**
 * 格納庫UI。3Dビュー(コアラ機体)は renderer が canvas に描く。ここは左右のパネルだけを重ねる。
 * 実効値は garageLogic.garageSummary (computeEffectiveStats + config) から。
 */
import { DEFAULT_LOADOUT } from '../config';
import type { FcsId, GeneratorId, LegsId } from '../config';
import type { Loadout } from '../sim/types';
import { fcsCards, fmtNum, garageSummary, generatorCards, legsCards } from './garageLogic';
import type { PartCard } from './garageLogic';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface GarageOptions {
  loadout: Loadout;
  onChange(loadout: Loadout): void;
  onSortie(): void;
  onHelp(): void;
}

interface CardGroup {
  cards: Map<string, HTMLButtonElement>;
}

export class Garage {
  private root: HTMLElement;
  private loadout: Loadout;
  private groups: { fcs: CardGroup; generator: CardGroup; legs: CardGroup };
  private stats: Record<string, HTMLElement> = {};
  private selectedTxt: HTMLElement;
  private sortieBtn: HTMLButtonElement;
  private status: HTMLElement;

  constructor(root: HTMLElement, private opts: GarageOptions) {
    this.root = root;
    root.classList.add('garage');
    this.loadout = { ...(opts.loadout ?? DEFAULT_LOADOUT) };

    const title = el('header', 'gar-title');
    title.appendChild(el('div', 'gar-logo', 'ARMORED KOALA 2'));
    title.appendChild(el('div', 'gar-sub', 'DEMO  /  格納庫 HANGAR'));

    const left = el('aside', 'gar-side gar-left');
    const fcs = this.buildGroup('FCS (射撃管制)', 'fcs', fcsCards(), (id) => this.select({ fcs: id as FcsId }));
    const gen = this.buildGroup('ジェネレーター', 'generator', generatorCards(), (id) => this.select({ generator: id as GeneratorId }));
    const legs = this.buildGroup('脚部', 'legs', legsCards(), (id) => this.select({ legs: id as LegsId }));
    left.append(fcs.section, legs.section);

    const right = el('aside', 'gar-side gar-right');
    right.append(gen.section, this.buildStats());
    this.groups = { fcs: fcs.group, generator: gen.group, legs: legs.group };

    const bottom = el('footer', 'gar-bottom');
    this.selectedTxt = el('div', 'gar-selected');
    const buttons = el('div', 'gar-buttons');
    const helpBtn = el('button', 'btn', '操作方法を確認');
    helpBtn.type = 'button';
    helpBtn.addEventListener('click', () => this.opts.onHelp());
    this.sortieBtn = el('button', 'btn btn-primary btn-big', '出撃');
    this.sortieBtn.type = 'button';
    this.sortieBtn.addEventListener('click', () => this.opts.onSortie());
    buttons.append(helpBtn, this.sortieBtn);
    this.status = el('div', 'gar-status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.textContent = '出撃するとマウスをロックして開始します (Escで一時停止)。出撃後は構成を変更できません。';
    bottom.append(this.selectedTxt, buttons, this.status);

    root.append(title, left, right, bottom);
    this.refresh();
  }

  private buildGroup(
    heading: string,
    key: string,
    cards: PartCard[],
    onPick: (id: string) => void,
  ): { section: HTMLElement; group: CardGroup } {
    const section = el('section', 'gar-sec');
    section.appendChild(el('h2', 'gar-h', heading));
    const list = el('div', 'gar-cards');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', heading);
    const group: CardGroup = { cards: new Map() };
    for (const c of cards) {
      const b = el('button', 'card');
      b.type = 'button';
      b.dataset.part = `${key}:${c.id}`;
      b.setAttribute('role', 'radio');
      const name = el('div', 'card-name', c.name);
      const spec = el('div', 'card-spec', c.spec);
      const pro = el('div', 'card-line');
      pro.append(el('span', 'tag pro', '長所'), document.createTextNode(c.pros));
      const con = el('div', 'card-line');
      con.append(el('span', 'tag con', '短所'), document.createTextNode(c.cons));
      b.append(name, spec, pro, con);
      b.addEventListener('click', () => onPick(c.id));
      list.appendChild(b);
      group.cards.set(c.id, b);
    }
    section.appendChild(list);
    return { section, group };
  }

  private buildStats(): HTMLElement {
    const sec = el('section', 'gar-sec gar-stats');
    sec.appendChild(el('h2', 'gar-h', '実効性能 (脚部補正後)'));
    const dl = el('dl', 'stat-grid');
    const rows: [string, string][] = [
      ['maxEn', '最大EN'],
      ['regen', 'EN回復率'],
      ['lock', 'ロック所要時間'],
      ['radius', 'ロック領域'],
      ['walk', '歩行速度'],
      ['glide', 'グライド速度(地上)'],
      ['air', '空中水平速度'],
      ['qb', 'QB速度'],
    ];
    for (const [k, label] of rows) {
      dl.appendChild(el('dt', 'stat-k', label));
      const dd = el('dd', 'stat-v');
      dl.appendChild(dd);
      this.stats[k] = dd;
    }
    sec.appendChild(dl);
    return sec;
  }

  private select(patch: Partial<Loadout>): void {
    const next = { ...this.loadout, ...patch };
    if (next.fcs === this.loadout.fcs && next.generator === this.loadout.generator && next.legs === this.loadout.legs) return;
    this.loadout = next;
    this.refresh();
    this.opts.onChange({ ...this.loadout });
  }

  private refresh(): void {
    const sel: Record<'fcs' | 'generator' | 'legs', string> = {
      fcs: this.loadout.fcs,
      generator: this.loadout.generator,
      legs: this.loadout.legs,
    };
    for (const k of ['fcs', 'generator', 'legs'] as const) {
      for (const [id, btn] of this.groups[k].cards) {
        const on = id === sel[k];
        btn.classList.toggle('selected', on);
        btn.setAttribute('aria-checked', String(on));
      }
    }
    const s = garageSummary(this.loadout);
    this.stats.maxEn.textContent = `${s.maxEn}`;
    this.stats.regen.textContent = `${fmtNum(s.regenPerSecond)} EN/秒`;
    this.stats.lock.textContent = `${fmtNum(s.lockSeconds)}秒`;
    this.stats.radius.textContent = `半径 ${fmtNum(s.lockRadiusRatio)}D`;
    this.stats.walk.textContent = `${fmtNum(s.speeds.walk)} m/s`;
    this.stats.glide.textContent = `${fmtNum(s.speeds.glide)} m/s`;
    this.stats.air.textContent = `${fmtNum(s.speeds.air)} m/s`;
    this.stats.qb.textContent = `${fmtNum(s.speeds.qb)} m/s`;
    this.selectedTxt.textContent = `選択中: ${s.fcsName} / ${s.generatorName} / ${s.legsName}`;
  }

  getLoadout(): Loadout {
    return { ...this.loadout };
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  /** ポインターロック要求中の表示 */
  setPending(pending: boolean): void {
    this.sortieBtn.disabled = pending;
    this.status.textContent = pending
      ? 'ポインターロックを取得しています...'
      : '出撃するとマウスをロックして開始します (Escで一時停止)。出撃後は構成を変更できません。';
  }

  focusSortie(): void {
    this.sortieBtn.focus();
  }
}
