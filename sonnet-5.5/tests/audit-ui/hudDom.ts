/**
 * 実 DOM の HUD を読み取る (ブラウザ内で評価)。表示されている文字・位置・形を返す。
 */
import type { Page } from 'playwright';

export interface HudDom {
  viewport: { w: number; h: number };
  hudHidden: boolean;
  weapons: { sel: boolean; empty: boolean; key: string; name: string; ammo: string; sub: string }[];
  en: { text: string; fillPct: string; low: boolean };
  hp: { text: string; fillPct: string };
  move: { mode: string; vert: string; qb: string; qbData: string; cd: string };
  mission: { sector: string; visited: string; ctl: string; pipsOn: number; barriers: { text: string; open: boolean }[]; gate: string; gateOpen: boolean; next: string; nextSub: string; msgs: string[] };
  fcs: { state: string; phase: string; id: string; aim: string; aimNoSol: boolean };
  notices: { cls: string; text: string }[];
  reticle: { cls: string; label: string; aimLabel: string; r: number; cx: number; cy: number; bbox: { l: number; t: number; w: number; h: number }; progDash: string; progOpacity: number };
  markers: { cls: string; kind: string; tx: number; ty: number; text: string; off: boolean; shapeVisible: boolean; arrowVisible: boolean; solvedVisible: boolean | null; noneVisible: boolean | null; rect: { l: number; t: number; w: number; h: number } }[];
  wedges: number;
  flashOpacity: number;
  panels: { name: string; l: number; t: number; r: number; b: number }[];
}

export async function readHud(page: Page): Promise<HudDom> {
  return page.evaluate(() => {
    const q = (sel: string): Element | null => document.querySelector(sel);
    const txt = (sel: string): string => (q(sel)?.textContent ?? '').trim();
    const rectOf = (e: Element): { l: number; t: number; w: number; h: number } => {
      const r = e.getBoundingClientRect();
      return { l: r.left, t: r.top, w: r.width, h: r.height };
    };
    const hud = q('#hud') as HTMLElement;
    const weapons = Array.from(document.querySelectorAll('.hud-wrow')).map((row) => ({
      sel: row.classList.contains('sel'),
      empty: row.classList.contains('empty'),
      key: row.querySelector('.hud-wkey')?.textContent ?? '',
      name: row.querySelector('.hud-wname')?.textContent ?? '',
      ammo: row.querySelector('.hud-wammo')?.textContent ?? '',
      sub: row.querySelector('.hud-wsub')?.textContent ?? '',
    }));
    const rows = (panel: string): Element[] => Array.from(document.querySelectorAll(`${panel} .hud-row`));
    const rowVal = (panel: string, key: string): string => {
      const r = rows(panel).find((x) => x.querySelector('.hud-k')?.textContent === key);
      if (!r) return '';
      return Array.from(r.children)
        .filter((c) => !c.classList.contains('hud-k'))
        .map((c) => c.textContent ?? '')
        .join(' ')
        .trim();
    };
    const modeEl = q('.hud-mode') as HTMLElement | null;
    const qbEl = q('.hud-qb') as HTMLElement | null;
    const ret = q('.hud-reticle') as SVGGElement;
    const base = q('.ret-base') as SVGCircleElement;
    const br = base.getBoundingClientRect();
    const markers = Array.from(document.querySelectorAll('.hud-mk'))
      .filter((g) => (g as SVGElement).style.display !== 'none')
      .map((g) => {
        const gg = g as SVGGElement;
        const shape = gg.querySelector('.hud-mk-shape') as SVGElement;
        const arrow = gg.querySelector('.hud-mk-arrow') as SVGElement;
        const solved = gg.querySelector('.hud-aim-solved') as SVGElement | null;
        const none = gg.querySelector('.hud-aim-none') as SVGElement | null;
        const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(gg.getAttribute('transform') ?? '');
        return {
          cls: gg.getAttribute('class') ?? '',
          kind: (/hud-mk-(\w+)/.exec(gg.getAttribute('class') ?? '') ?? [])[1] ?? '',
          tx: m ? Number(m[1]) : NaN,
          ty: m ? Number(m[2]) : NaN,
          text: gg.querySelector('.hud-lbl')?.textContent ?? '',
          off: (gg.getAttribute('class') ?? '').split(' ').includes('off'),
          shapeVisible: shape.style.display !== 'none',
          arrowVisible: arrow.style.display !== 'none',
          solvedVisible: solved ? solved.style.display !== 'none' : null,
          noneVisible: none ? none.style.display !== 'none' : null,
          rect: rectOf(gg),
        };
      });
    const prog = q('.ret-prog') as SVGCircleElement;
    const panelNames: [string, string][] = [
      ['mission', '.hud-mission'],
      ['next', '.hud-next'],
      ['fcs', '.hud-fcs'],
      ['weapons', '.hud-weapons'],
      ['right(EN/move)', '.hud-right'],
      ['hp', '.hud-hp'],
    ];
    const panels = panelNames.map(([name, sel]) => {
      const r = (q(sel) as HTMLElement).getBoundingClientRect();
      return { name, l: r.left, t: r.top, r: r.right, b: r.bottom };
    });
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      hudHidden: Boolean(hud.hidden),
      weapons,
      en: { text: txt('.hud-num'), fillPct: (q('.hud-bar-en .hud-fill') as HTMLElement).style.width, low: q('.hud-bar-en')!.classList.contains('low') },
      hp: { text: txt('.hud-hp .hud-v'), fillPct: (q('.hud-bar-hp .hud-fill') as HTMLElement).style.width },
      move: { mode: txt('.hud-mode'), vert: txt('.hud-move .hud-dim'), qb: txt('.hud-qb'), qbData: qbEl?.getAttribute('data-qb') ?? '', cd: rowVal('.hud-move', '次のQBまで') },
      mission: {
        sector: txt('.hud-sector'),
        visited: txt('.hud-mission .hud-dim'),
        ctl: rowVal('.hud-mission', '制御砲台').split(' ')[0] ?? '',
        pipsOn: document.querySelectorAll('.hud-pip.on').length,
        barriers: Array.from(document.querySelectorAll('.hud-chip')).map((c) => ({ text: c.textContent ?? '', open: c.classList.contains('open') })),
        gate: txt('.hud-gate'),
        gateOpen: q('.hud-gate')!.classList.contains('open'),
        next: txt('.hud-next-main'),
        nextSub: txt('.hud-next-sub'),
        msgs: Array.from(document.querySelectorAll('.hud-msg')).map((m) => m.textContent ?? ''),
      },
      fcs: {
        state: txt('.hud-fcs-state'),
        phase: q('.hud-fcs-state')?.getAttribute('data-phase') ?? '',
        id: rowVal('.hud-fcs', 'LOCK ID'),
        aim: rowVal('.hud-fcs', '補正'),
        aimNoSol: Array.from(document.querySelectorAll('.hud-fcs .hud-v')).some((e) => e.classList.contains('nosol')),
      },
      notices: Array.from(document.querySelectorAll('.hud-notice')).map((n) => ({ cls: n.className, text: n.textContent ?? '' })),
      reticle: {
        cls: ret.getAttribute('class') ?? '',
        label: q('.ret-label')?.textContent ?? '',
        aimLabel: q('.ret-aim')?.textContent ?? '',
        r: Number(base.getAttribute('r')),
        cx: br.left + br.width / 2,
        cy: br.top + br.height / 2,
        bbox: { l: br.left, t: br.top, w: br.width, h: br.height },
        progDash: prog.getAttribute('stroke-dasharray') ?? '',
        progOpacity: Number(getComputedStyle(prog).opacity),
      },
      markers,
      wedges: Array.from(document.querySelectorAll('.hud-wedge')).filter((w) => (w as SVGElement).style.display !== 'none').length,
      flashOpacity: Number((q('.hud-flash') as HTMLElement).style.opacity || 0),
      panels,
    };
  });
}

export function overlaps(a: { l: number; t: number; r: number; b: number }, b: { l: number; t: number; r: number; b: number }): boolean {
  return a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
}
