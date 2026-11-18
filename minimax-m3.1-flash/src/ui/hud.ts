import type { WeaponId } from '../core/config';
import type { LockState, SolutionStatus } from '../game/types';
import type { Vec3Tuple } from '../game/types';

export interface HudDamageMark {
  angle: number;
  life: number;
}

export interface HudModel {
  weapon: WeaponId;
  weaponLabel: string;
  ammo: number;
  ammoLabel: string;
  beamEnCost: number;
  en: number;
  maxEn: number;
  hp: number;
  maxHp: number;
  horizontalMode: 'walk' | 'glide' | 'quickboost';
  verticalMode: 'grounded' | 'rising' | 'flying' | 'falling';
  glideEnabled: boolean;
  qbReady: boolean;
  qbCooldown: number;
  qbCost: number;
  lockState: LockState;
  lockProgress: number;
  lockRadiusPx: number;
  lockTargetLabel: string | null;
  solutionStatus: SolutionStatus;
  aimPointScreen: { x: number; y: number } | null;
  targetPointScreen: { x: number; y: number } | null;
  targetOffscreen: boolean;
  sectorName: string;
  objectiveText: string;
  controlsDestroyed: number;
  controlsRequired: number;
  barrierText: string;
  gateOpen: boolean;
  elapsed: number;
  fps: number;
  telegraphActive: boolean;
  damageMarks: HudDamageMark[];
  notices: { text: string; until: number }[];
  lockSeconds: number;
  regenPerSecond: number;
  speedMultiplier: number;
  maxEnEffective: number;
}

const WEAPON_JP: Record<WeaponId, string> = {
  machinegun: 'MACHINEGUN',
  beam: 'BEAM',
  missile: 'HAND MISSILE'
};

export class Hud {
  root: HTMLDivElement;
  private el: Record<string, HTMLElement> = {};
  private fcsSvg: SVGSVGElement;
  private lockArc: SVGCircleElement;
  private lockRing: SVGCircleElement;
  private notices: { text: string; until: number }[] = [];
  private now = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.className = 'hidden';
    parent.appendChild(this.root);
    this.root.innerHTML = `
      <div class="hud-panel hud-tc" id="p-objective">
        <div class="hud-label">SECTOR / OBJECTIVE</div>
        <div class="hud-value small" id="v-sector">-</div>
        <div id="v-objective" style="color:var(--ak2-dim);font-size:12px;margin-top:2px">-</div>
        <div style="margin-top:6px;font-size:12px">
          <span class="chip" id="v-controls">CONTROL TURRETS 0/6</span>
          <span class="chip" id="v-gate">EVAC GATE CLOSED</span>
        </div>
        <div id="v-barriers" style="color:var(--ak2-dim);font-size:11px;margin-top:3px">-</div>
      </div>

      <div class="hud-panel hud-tl">
        <div class="hud-label">WEAPON</div>
        <div class="hud-value small" id="v-weapon">MACHINEGUN</div>
        <div style="font-size:12px;color:var(--ak2-dim">AMMO <b id="v-ammo" style="color:#eaf6ff">300</b></div>
        <div id="v-weapon-cost" style="font-size:11px;color:var(--ak2-dim);margin-top:2px">EN cost 0 / shot</div>
        <div style="margin-top:5px">
          <span class="chip" id="c-1">1 MG</span><span class="chip" id="c-2">2 BEAM</span><span class="chip" id="c-3">3 MSL</span>
        </div>
      </div>

      <div class="hud-panel hud-tr">
        <div class="hud-label">ENERGY</div>
        <div class="hud-value" id="v-en">120</div>
        <div style="font-size:11px;color:var(--ak2-dim)">MAX <span id="v-maxen">120</span> / REGEN <span id="v-regen">15.0</span> EN/s</div>
        <div class="bar en" id="b-en"><i style="width:100%"></i></div>
      </div>

      <div class="hud-panel hud-bl">
        <div class="hud-label">ARMOR</div>
        <div class="hud-value" id="v-hp">1000</div>
        <div style="font-size:11px;color:var(--ak2-dim)">MAX <span id="v-maxhp">1000</span></div>
        <div class="bar hp" id="b-hp"><i style="width:100%"></i></div>
      </div>

      <div class="hud-panel hud-bc">
        <div>
          <span class="chip" id="v-mode">WALK</span>
          <span class="chip" id="v-vmode">GROUNDED</span>
          <span class="chip" id="v-qb">QB READY</span>
        </div>
        <div id="v-qbinfo" style="font-size:11px;color:var(--ak2-dim);margin-top:3px">Q: single 36 EN / auto-glide after 0.75 s / glide is free</div>
      </div>

      <div id="fcs-layer">
        <svg id="fcs-svg" width="10" height="10">
          <circle id="fcs-ring" cx="0" cy="0" r="10" fill="none" stroke="rgba(70,215,255,0.35)" stroke-width="1.5"></circle>
          <circle id="fcs-arc" cx="0" cy="0" r="10" fill="none" stroke="#46d7ff" stroke-width="3"
                  stroke-dasharray="0 1000" transform="rotate(-90)"></circle>
          <text id="fcs-text" x="0" y="-18" text-anchor="middle" fill="#8ea4b3" font-size="11">NO LOCK</text>
        </svg>
        <div class="reticle"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="marker target hidden" id="m-target"><div class="marker-label" id="m-target-label"></div></div>
        <div class="marker aim hidden" id="m-aim"><div class="marker-label" id="m-aim-label"></div></div>
        <div id="damage-layer"></div>
        <div id="dmg-flash"></div>
        <div id="telegraph-warn" class="hidden">ENEMY FIRING SOLUTION - INCOMING</div>
        <div id="log"></div>
      </div>
    `;

    const q = (id: string) => this.root.querySelector('#' + id) as HTMLElement;
    this.el = {
      sector: q('v-sector'),
      objective: q('v-objective'),
      controls: q('v-controls'),
      gate: q('v-gate'),
      barriers: q('v-barriers'),
      weapon: q('v-weapon'),
      ammo: q('v-ammo'),
      weaponCost: q('v-weapon-cost'),
      c1: q('c-1'),
      c2: q('c-2'),
      c3: q('c-3'),
      en: q('v-en'),
      maxen: q('v-maxen'),
      regen: q('v-regen'),
      ben: q('b-en'),
      hp: q('v-hp'),
      maxhp: q('v-maxhp'),
      bhp: q('b-hp'),
      mode: q('v-mode'),
      vmode: q('v-vmode'),
      qb: q('v-qb'),
      qbinfo: q('v-qbinfo'),
      target: q('m-target'),
      targetLabel: q('m-target-label'),
      aim: q('m-aim'),
      aimLabel: q('m-aim-label'),
      damage: q('damage-layer'),
      flash: q('dmg-flash'),
      telegraph: q('telegraph-warn'),
      log: q('log'),
      fcsText: q('fcs-text')
    };
    this.fcsSvg = this.root.querySelector('#fcs-svg') as SVGSVGElement;
    this.lockArc = this.root.querySelector('#fcs-arc') as SVGCircleElement;
    this.lockRing = this.root.querySelector('#fcs-ring') as SVGCircleElement;
  }

  show(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  clearNotices(): void {
    this.notices.length = 0;
  }

  notice(text: string): void {
    this.notices.push({ text, until: this.now + 1.6 });
    if (this.notices.length > 4) this.notices.shift();
  }

  update(m: HudModel, now: number): void {
    this.now = now;
    const e = this.el;
    e.sector.textContent = m.sectorName;
    e.objective.textContent = m.objectiveText;
    e.controls.textContent = `CONTROL TURRETS ${m.controlsDestroyed}/${m.controlsRequired}`;
    e.controls.className = 'chip' + (m.controlsDestroyed >= m.controlsRequired ? ' on' : '');
    e.gate.textContent = m.gateOpen ? 'EVAC GATE OPEN' : 'EVAC GATE CLOSED';
    e.gate.className = 'chip' + (m.gateOpen ? ' on' : ' warn');
    e.barriers.textContent = m.barrierText;

    e.weapon.textContent = WEAPON_JP[m.weapon];
    e.ammo.textContent = m.ammoLabel;
    e.weaponCost.textContent = m.weapon === 'beam' ? `${m.beamEnCost} EN / shot - UNLIMITED ROUNDS` : 'EN cost 0 / shot';
    e.c1.className = 'chip' + (m.weapon === 'machinegun' ? ' on' : '');
    e.c2.className = 'chip' + (m.weapon === 'beam' ? ' on' : '');
    e.c3.className = 'chip' + (m.weapon === 'missile' ? ' on' : '');

    e.en.textContent = Math.round(m.en).toString();
    e.maxen.textContent = m.maxEn.toString();
    e.regen.textContent = m.regenPerSecond.toFixed(2);
    (e.ben.firstElementChild as HTMLElement).style.width = `${(m.en / m.maxEn) * 100}%`;
    e.ben.classList.toggle('low', m.en / m.maxEn < 0.25);

    e.hp.textContent = Math.max(0, Math.round(m.hp)).toString();
    e.maxhp.textContent = m.maxHp.toString();
    (e.bhp.firstElementChild as HTMLElement).style.width = `${(m.hp / m.maxHp) * 100}%`;

    const modeText = m.horizontalMode === 'quickboost' ? 'QUICK BOOST' : m.horizontalMode === 'glide' ? 'GLIDE' : 'WALK';
    e.mode.textContent = modeText;
    e.mode.className = 'chip' + (m.horizontalMode !== 'walk' ? ' on' : '');
    const vtext = m.verticalMode === 'grounded' ? 'GROUNDED' : m.verticalMode === 'rising' ? 'RISING' : m.verticalMode === 'flying' ? 'FLYING' : 'FALLING';
    e.vmode.textContent = vtext;
    e.vmode.className = 'chip' + (m.verticalMode === 'flying' ? ' on' : '');
    e.qb.textContent = m.qbReady ? 'QB READY' : `QB ${m.qbCooldown.toFixed(1)}s`;
    e.qb.className = 'chip' + (m.qbReady ? ' on' : ' warn');
    e.qbinfo.textContent = `Q: single ${m.qbCost} EN / auto-glide after 0.75 s / glide costs 0 EN / brake: L Ctrl`;

    // FCS circle
    const r = m.lockRadiusPx;
    this.fcsSvg.setAttribute('width', String(r * 2 + 8));
    this.fcsSvg.setAttribute('height', String(r * 2 + 8));
    this.lockRing.setAttribute('r', String(r));
    this.lockArc.setAttribute('r', String(r));
    const circ = 2 * Math.PI * r;
    const prog = m.lockState === 'none' ? 0 : m.lockProgress;
    this.lockArc.setAttribute('stroke-dasharray', `${circ * prog} ${circ}`);
    this.lockArc.setAttribute('stroke', m.lockState === 'locked' ? '#ff5d52' : '#46d7ff');
    this.lockRing.setAttribute('stroke', m.lockState === 'locked' ? 'rgba(255,93,82,0.65)' : 'rgba(70,215,255,0.35)');
    const statusText =
      m.lockState === 'locked'
        ? `LOCK ${m.lockTargetLabel ?? ''}`
        : m.lockState === 'acquiring'
          ? `ACQUIRING ${Math.round(m.lockProgress * 100)}%`
          : 'NO LOCK';
    this.el.fcsText.textContent = statusText;
    this.el.fcsText.setAttribute('fill', m.lockState === 'locked' ? '#ff8a80' : '#8ea4b3');

    // target marker
    if (m.targetPointScreen) {
      e.target.classList.remove('hidden');
      e.target.style.left = `${m.targetPointScreen.x}px`;
      e.target.style.top = `${m.targetPointScreen.y}px`;
      e.target.className = 'marker target ' + (m.lockState === 'locked' ? 'locked' : m.lockState === 'acquiring' ? 'acquiring' : '');
      e.targetLabel.textContent = m.lockTargetLabel ?? '';
    } else {
      e.target.classList.add('hidden');
    }

    // correction aim marker
    if (m.aimPointScreen) {
      e.aim.classList.remove('hidden');
      e.aim.style.left = `${m.aimPointScreen.x}px`;
      e.aim.style.top = `${m.aimPointScreen.y}px`;
      e.aim.className = 'marker aim' + (m.solutionStatus === 'no_solution' ? ' nosol' : '');
      e.aimLabel.textContent =
        m.solutionStatus === 'solved' ? 'CORRECTED AIM' : m.solutionStatus === 'no_solution' ? 'NO SOLUTION' : 'FREE AIM';
    } else {
      e.aim.classList.add('hidden');
    }

    // damage flash + enemy telegraph warning
    (e.flash as HTMLElement).style.opacity = String(Math.min(0.55, m.damageMarks.length * 0.22));
    e.telegraph.classList.toggle('hidden', !m.telegraphActive);

    // damage direction markers
    e.damage.innerHTML = '';
    for (const d of m.damageMarks) {
      const a = document.createElement('div');
      a.className = 'dmg-arrow';
      a.style.transform = `rotate(${d.angle}rad) translateY(-150px)`;
      a.style.opacity = String(Math.max(0, Math.min(1, d.life)));
      e.damage.appendChild(a);
    }

    // notices
    e.log.innerHTML = '';
    for (const n of this.notices) {
      if (n.until > now) {
        const div = document.createElement('div');
        div.textContent = n.text;
        e.log.appendChild(div);
      }
    }
  }
}

export function weaponLabel(w: WeaponId): string {
  return WEAPON_JP[w];
}

export function tuple(v: Vec3Tuple | null): string {
  return v ? `[${v.map((x) => x.toFixed(2)).join(', ')}]` : 'null';
}
