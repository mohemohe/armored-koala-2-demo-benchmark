import * as THREE from 'three';
import {
  FCS_LIST,
  GENERATOR_LIST,
  LEG_LIST,
  WEAPON_LIST,
  type FcsId,
  type GeneratorId,
  type LegId,
  type WeaponId
} from '../core/config';
import { buildMech } from '../game/models';

export interface GarageChoice {
  fcs: FcsId;
  generator: GeneratorId;
  legs: LegId;
  weapon: WeaponId;
}

export interface GarageCallbacks {
  onChange(choice: GarageChoice): void;
  onStart(): void;
  onShowHelp(): void;
}

export class Garage {
  readonly root: HTMLDivElement;
  choice: GarageChoice = { fcs: 'medium', generator: 'balanced', legs: 'biped', weapon: 'machinegun' };
  private preview: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 1.5, 0.1, 60);
  private mech: THREE.Object3D | null = null;
  private angle = 0;
  private raf = 0;
  private statEl!: HTMLElement;
  private errEl!: HTMLElement;
  private startBtn!: HTMLButtonElement;

  constructor(parent: HTMLElement, private cb: GarageCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'overlay';
    parent.appendChild(this.root);
    this.root.innerHTML = `
      <div class="overlay-inner">
        <h1 class="title">ARMORED KOALA 2</h1>
        <div class="subtitle">DECOMMISSIONED FACTORY ESCAPE - AK2 DEMO / HANGAR</div>
        <div class="columns">
          <div>
            <div class="card">
              <h3>FCS - FIRE CONTROL SYSTEM</h3>
              <div id="opt-fcs"></div>
            </div>
            <div class="card">
              <h3>GENERATOR - POWER UNIT</h3>
              <div id="opt-gen"></div>
            </div>
            <div class="card">
              <h3>LEGS - LOCOMOTION</h3>
              <div id="opt-legs"></div>
            </div>
            <div class="card">
              <h3>PRIMARY WEAPON</h3>
              <div id="opt-weapon"></div>
            </div>
          </div>
          <div>
            <div id="garage-preview"><canvas id="preview-canvas"></canvas><div class="preview-cap" id="preview-cap">LIVE PREVIEW - koala head visible from the front</div></div>
            <div class="card" style="margin-top:12px">
              <h3>SORTIE SPECS (leg modifiers applied)</h3>
              <div class="stat-grid" id="stats"></div>
            </div>
            <div class="card">
              <h3>CONTROLS</h3>
              <div style="font-size:12px;line-height:1.7">
                <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move /
                <kbd>Space</kbd> jump, hold 0.20 s to fly /
                <kbd>Shift</kbd> toggle glide (0 EN) /
                <kbd>Ctrl</kbd> brake /
                <kbd>Q</kbd> quick boost (one shot, 36 EN, auto-glide after) /
                <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> weapon /
                <kbd>LMB</kbd> fire / <kbd>Esc</kbd> pause
              </div>
              <div style="font-size:12px;color:var(--ak2-dim);margin-top:6px">
                Keep the target hit-box inside the central FCS circle and the fire control system
                compensates both the lead angle and bullet drop by itself - you never have to aim the
                crosshair at the corrected marker manually.
              </div>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;margin-top:6px">
          <button class="btn" id="btn-start">SORTIE</button>
          <button class="btn ghost" id="btn-help">CONTROLS</button>
          <span class="err" id="err"></span>
        </div>
      </div>
    `;

    this.preview = this.root.querySelector('#preview-canvas') as HTMLCanvasElement;
    this.statEl = this.root.querySelector('#stats') as HTMLElement;
    this.errEl = this.root.querySelector('#err') as HTMLElement;
    this.startBtn = this.root.querySelector('#btn-start') as HTMLButtonElement;

    this.buildOptions('opt-fcs', FCS_LIST.map((f) => ({ id: f.id as string, name: f.label, desc: f.pros + ' / ' + f.cons })), (id) => {
      this.choice.fcs = id as FcsId;
      this.refresh();
    });
    this.buildOptions(
      'opt-gen',
      GENERATOR_LIST.map((g) => ({ id: g.id as string, name: g.label, desc: g.pros + ' / ' + g.cons })),
      (id) => {
        this.choice.generator = id as GeneratorId;
        this.refresh();
      }
    );
    this.buildOptions(
      'opt-legs',
      LEG_LIST.map((l) => ({ id: l.id as string, name: l.label, desc: l.pros + ' / ' + l.cons })),
      (id) => {
        this.choice.legs = id as LegId;
        this.refresh();
      }
    );
    this.buildOptions(
      'opt-weapon',
      WEAPON_LIST.map((w) => ({ id: w.id as string, name: `${w.label} [${w.key}]`, desc: w.desc })),
      (id) => {
        this.choice.weapon = id as WeaponId;
        this.refresh();
      }
    );

    this.startBtn.addEventListener('click', () => {
      this.errEl.textContent = '';
      this.cb.onStart();
    });
    (this.root.querySelector('#btn-help') as HTMLButtonElement).addEventListener('click', () => this.cb.onShowHelp());

    this.refresh();
    this.initPreview();
  }

  private buildOptions(
    containerId: string,
    options: { id: string; name: string; desc: string }[],
    onPick: (id: string) => void
  ): void {
    const c = this.root.querySelector('#' + containerId) as HTMLElement;
    c.innerHTML = '';
    for (const o of options) {
      const b = document.createElement('button');
      b.className = 'opt';
      b.dataset.id = o.id;
      b.innerHTML = `<span class="tag"></span><span class="name">${o.name}</span><div class="desc">${o.desc}</div>`;
      b.addEventListener('click', () => onPick(o.id));
      c.appendChild(b);
    }
  }

  private refresh(): void {
    const mark = (containerId: string, current: string) => {
      const c = this.root.querySelector('#' + containerId) as HTMLElement;
      c.querySelectorAll('.opt').forEach((el) => {
        const e = el as HTMLElement;
        const sel = e.dataset.id === current;
        e.classList.toggle('sel', sel);
        const tag = e.querySelector('.tag') as HTMLElement;
        tag.textContent = sel ? '&lt; SELECTED' : '';
      });
    };
    mark('opt-fcs', this.choice.fcs);
    mark('opt-gen', this.choice.generator);
    mark('opt-legs', this.choice.legs);
    mark('opt-weapon', this.choice.weapon);

    const fcs = FCS_LIST.find((f) => f.id === this.choice.fcs)!;
    const gen = GENERATOR_LIST.find((g) => g.id === this.choice.generator)!;
    const leg = LEG_LIST.find((l) => l.id === this.choice.legs)!;
    const weapon = WEAPON_LIST.find((w) => w.id === this.choice.weapon)!;
    const maxEn = gen.maxEn;
    const regen = gen.regenPerSecond * leg.regenMultiplier;
    const lockSeconds = fcs.baseLockSeconds / leg.lockSpeedMultiplier;
    const speed = 10 * leg.speedMultiplier;
    this.statEl.innerHTML = `
      <div>Max EN <b>${maxEn}</b></div>
      <div>EN recharge <b>${regen.toFixed(2)} EN/s</b></div>
      <div>Lock time <b>${lockSeconds.toFixed(3)} s</b></div>
      <div>Walk speed <b>${speed.toFixed(1)} m/s</b></div>
      <div>Glide speed <b>${(22 * leg.speedMultiplier).toFixed(1)} m/s</b></div>
      <div>Air speed <b>${(16 * leg.speedMultiplier).toFixed(1)} m/s</b></div>
      <div>FCS circle radius <b>${(fcs.radiusFactor * 100).toFixed(0)}% of short screen edge</b></div>
      <div>Legs <b>${leg.label} (${leg.legCount})</b></div>
      <div>Primary weapon <b>${weapon.label}</b></div>
      <div>Weapon stats <b>${weapon.damage} dmg / ${weapon.interval.toFixed(2)} s</b></div>
      <div>Ammunition <b>${weapon.ammoLabel}</b></div>
    `;
    this.cb.onChange({ ...this.choice });
    this.rebuildMech();
  }

  private initPreview(): void {
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.preview, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setClearColor(0x070a0e, 1);
      const hemi = new THREE.HemisphereLight(0xc8e0f5, 0x1b2026, 1.5);
      this.scene.add(hemi);
      const key = new THREE.DirectionalLight(0xffffff, 2.4);
      key.position.set(2.4, 3.6, 3.4);
      this.scene.add(key);
      const fill = new THREE.DirectionalLight(0x66c8ff, 1.0);
      fill.position.set(-2.6, 1.4, 1.6);
      this.scene.add(fill);
      const back = new THREE.DirectionalLight(0xffa54d, 0.7);
      back.position.set(0.5, 1.0, -3);
      this.scene.add(back);
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(5, 40),
        new THREE.MeshStandardMaterial({ color: 0x121820, roughness: 0.95 })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.02;
      this.scene.add(floor);
      this.camera.position.set(0, 1.95, 7.0);
      this.camera.lookAt(0, 1.5, 0);
      this.rebuildMech();
      this.loop();
    } catch (err) {
      console.warn('garage preview unavailable', err);
    }
  }

  private rebuildMech(): void {
    if (!this.renderer) return;
    if (this.mech) this.scene.remove(this.mech);
    const rig = buildMech(this.choice.legs);
    rig.root.position.set(0, 0, 0);
    this.scene.add(rig.root);
    this.mech = rig.root;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.renderer) return;
    this.angle += 0.008;
    if (this.mech) this.mech.rotation.y = Math.sin(this.angle) * 0.42;
    const w = this.preview.clientWidth || 400;
    const h = this.preview.clientHeight || 260;
    if (this.preview.width !== w || this.preview.height !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
  };

  show(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  setError(msg: string): void {
    this.errEl.textContent = msg;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }
}
