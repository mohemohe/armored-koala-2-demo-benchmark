/**
 * Visual / behaviour harness for src/ui/garage.ts, src/ui/menus.ts, src/ui/help.ts and src/input/input.ts.
 *
 *   /dev/ui.html?view=garage|help|pause|pausehelp|cleared|failed|fell|plerror|input
 *               &fcs=wide|medium|narrow  &gen=capacity|balanced|recovery  &legs=biped|quadruped
 *               &notice=1                garage: show a pointer-lock failure notice
 *               &bg=dark|mid|bright      placeholder backdrop brightness (readability check)
 *
 * The backdrop is a 2D-canvas placeholder for the 3D scene (hangar floor + a crude mech silhouette that
 * follows the selected legs through onChange), so the "transparent centre" of the garage can be judged.
 * view=input mounts an InputManager on the canvas with a fake Sim that records what apply() delivers
 * (click "LOCK + START" for a real pointer lock; the probe text shows levels, consumed edges and the view).
 *
 * window.__ui    = { garage, menus, log, stats() }      log = callback names in call order
 * window.__input = { mgr, sim, edges, frames, lock(), resume(), pause(), attachTwice() }   (view=input)
 */
import { CAMERA, DEFAULT_LOADOUT, TOTAL_ENEMIES } from '../src/config';
import { InputManager, POINTER_LOCK_MESSAGES } from '../src/input/input';
import type { Sim } from '../src/sim/sim';
import type { FcsId, GeneratorId, InputState, LegsId, Loadout } from '../src/sim/types';
import { GarageUi } from '../src/ui/garage';
import { Menus, type ResultInfo } from '../src/ui/menus';

const q = new URLSearchParams(location.search);
const pick = <T extends string>(key: string, allowed: readonly T[], d: T): T => {
  const v = q.get(key);
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : d;
};
const view = pick('view', ['garage', 'help', 'pause', 'pausehelp', 'cleared', 'failed', 'fell', 'plerror', 'input'] as const, 'garage');
const bg = pick('bg', ['dark', 'mid', 'bright'] as const, 'mid');
const loadout: Loadout = {
  fcs: pick<FcsId>('fcs', ['wide', 'medium', 'narrow'], DEFAULT_LOADOUT.fcs),
  generator: pick<GeneratorId>('gen', ['capacity', 'balanced', 'recovery'], DEFAULT_LOADOUT.generator),
  legs: pick<LegsId>('legs', ['biped', 'quadruped'], DEFAULT_LOADOUT.legs),
};

const canvas = document.getElementById('backdrop') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;
const log: string[] = [];
let currentLegs: LegsId = loadout.legs;

// ───────────────────────── placeholder backdrop ─────────────────────────
let previewRect: () => { x: number; y: number; width: number; height: number } | null = () => null;
function drawBackdrop(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const c = canvas.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tone = bg === 'dark' ? 0.55 : bg === 'bright' ? 1.6 : 1;
  const col = (r: number, g: number, b: number): string =>
    `rgb(${Math.min(255, Math.round(r * tone))},${Math.min(255, Math.round(g * tone))},${Math.min(255, Math.round(b * tone))})`;
  const sky = c.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, col(38, 44, 52));
  sky.addColorStop(0.62, col(74, 82, 92));
  sky.addColorStop(0.63, col(58, 64, 72));
  sky.addColorStop(1, col(34, 38, 44));
  c.fillStyle = sky;
  c.fillRect(0, 0, w, h);
  // floor grid
  const hy = h * 0.63;
  c.strokeStyle = col(96, 104, 114);
  c.lineWidth = 1;
  for (let i = -14; i <= 14; i++) {
    c.beginPath();
    c.moveTo(w / 2 + i * w * 0.02, hy);
    c.lineTo(w / 2 + i * w * 0.14, h);
    c.stroke();
  }
  for (let i = 1; i <= 7; i++) {
    const y = hy + ((h - hy) * i * i) / 49;
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(w, y);
    c.stroke();
  }
  // warm lamps
  for (const x of [0.2, 0.5, 0.8]) {
    const g = c.createRadialGradient(w * x, 0, 0, w * x, 0, h * 0.5);
    g.addColorStop(0, 'rgba(255,190,110,0.28)');
    g.addColorStop(1, 'rgba(255,190,110,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  }
  // crude mech silhouette (placeholder for the real 3D preview)
  const pr = previewRect();
  const u = pr ? pr.height / 500 : h / 720;
  const cx = pr ? pr.x + pr.width / 2 : w / 2;
  const base = pr ? pr.y + pr.height - 6 : h * 0.8;
  if (pr && q.get('rect') === '1') {
    c.strokeStyle = '#ff40ff';
    c.setLineDash([6, 4]);
    c.strokeRect(pr.x + 0.5, pr.y + 0.5, pr.width - 1, pr.height - 1);
    c.setLineDash([]);
  }
  const box = (x: number, y: number, bw: number, bh: number, fill: string): void => {
    c.fillStyle = fill;
    c.fillRect(cx + x * u - (bw * u) / 2, base - y * u - bh * u, bw * u, bh * u);
  };
  const light = col(143, 153, 166);
  const dark = col(86, 97, 110);
  if (currentLegs === 'biped') {
    box(-52, 0, 44, 190, dark);
    box(52, 0, 44, 190, dark);
    box(-52, 0, 62, 26, light);
    box(52, 0, 62, 26, light);
  } else {
    for (const x of [-120, -52, 52, 120]) {
      box(x, 0, 38, 120, dark);
      box(x, 0, 54, 22, light);
    }
    box(0, 110, 290, 34, dark);
  }
  box(0, currentLegs === 'biped' ? 180 : 140, 150, 60, dark);
  box(0, currentLegs === 'biped' ? 232 : 192, 210, 130, light);
  box(-140, currentLegs === 'biped' ? 232 : 192, 54, 150, dark);
  box(140, currentLegs === 'biped' ? 232 : 192, 54, 150, dark);
  const headY = base - (currentLegs === 'biped' ? 362 : 322) * u - 62 * u;
  c.fillStyle = dark;
  for (const s of [-1, 1]) {
    c.beginPath();
    c.arc(cx + s * 92 * u, headY - 36 * u, 44 * u, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = '#d8d2c8';
  for (const s of [-1, 1]) {
    c.beginPath();
    c.arc(cx + s * 92 * u, headY - 36 * u, 26 * u, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = light;
  c.beginPath();
  c.ellipse(cx, headY, 82 * u, 62 * u, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#0a0c0e';
  c.beginPath();
  c.ellipse(cx, headY + 8 * u, 20 * u, 34 * u, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#63e6f2';
  c.fillRect(cx - 52 * u, headY - 22 * u, 24 * u, 12 * u);
  c.fillRect(cx + 28 * u, headY - 22 * u, 24 * u, 12 * u);
}
window.addEventListener('resize', drawBackdrop);

// ───────────────────────── garage + menus ─────────────────────────
const garage = new GarageUi(uiRoot, {
  initial: loadout,
  onChange(l) {
    log.push(`change:${l.fcs}/${l.generator}/${l.legs}`);
    currentLegs = l.legs;
    drawBackdrop();
  },
  onSortie(l) {
    log.push(`sortie:${l.fcs}/${l.generator}/${l.legs}`);
  },
});
const menus = new Menus(uiRoot, {
  onResume() {
    log.push('resume');
  },
  onRestart() {
    log.push('restart');
  },
  onGarage() {
    log.push('garage');
  },
});

const result = (failReason: ResultInfo['failReason']): ResultInfo => ({
  elapsedSeconds: failReason ? 431.27 : 842.63,
  hp: failReason === 'destroyed' ? 0 : failReason === 'fell' ? 318 : 412.5,
  controlsDestroyed: failReason ? 3 : 6,
  enemiesDestroyed: failReason ? 17 : 34,
  totalEnemies: TOTAL_ENEMIES,
  failReason,
  loadout: garage.getLoadout(),
});

switch (view) {
  case 'garage':
    garage.show();
    if (q.get('notice') === '1') {
      garage.setNotice('ポインターロックを取得できませんでした。' + POINTER_LOCK_MESSAGES.rejected + ' もう一度「出撃」を押してください。');
    }
    break;
  case 'help':
    garage.show();
    garage.openHelp();
    break;
  case 'pause':
    menus.showPause();
    break;
  case 'pausehelp':
    menus.showPause();
    (uiRoot.querySelector('.menu-pause [data-act="help"]') as HTMLButtonElement).click();
    break;
  case 'cleared':
    menus.showResult('cleared', result(null));
    break;
  case 'failed':
    menus.showResult('failed', result('destroyed'));
    break;
  case 'fell':
    menus.showResult('failed', result('fell'));
    break;
  case 'plerror':
    menus.showPointerLockError(POINTER_LOCK_MESSAGES.rejected);
    break;
  case 'input':
    break;
}

/** Text of the garage's stats panel, for --eval checks. */
function stats(): Record<string, string> {
  const out: Record<string, string> = {};
  uiRoot.querySelectorAll('.gar-stat').forEach((r) => {
    out[(r.querySelector('.k') as HTMLElement).textContent ?? ''] = ((r.querySelector('.v') as HTMLElement).textContent ?? '').trim();
  });
  out['脚部倍率'] = (uiRoot.querySelector('.gar-speed-h b') as HTMLElement).textContent ?? '';
  uiRoot.querySelectorAll('.gar-speed').forEach((r) => {
    out[(r.querySelector('.k') as HTMLElement).textContent ?? ''] = (r.querySelector('.v') as HTMLElement).textContent ?? '';
  });
  out.selected = Array.from(uiRoot.querySelectorAll('.gar-opt.is-selected .gar-opt-label'))
    .map((e) => e.textContent)
    .join(' / ');
  return out;
}
if (view === 'garage' || view === 'help') previewRect = () => garage.getPreviewRect();
drawBackdrop();
(window as unknown as { __ui: unknown }).__ui = { garage, menus, log, stats };

// ───────────────────────── input harness ─────────────────────────
if (view === 'input') {
  const input: InputState = { moveX: 0, moveZ: 0, jump: false, brake: false, fire: false, qbPressed: false, glideTogglePressed: false, jumpPressed: false, weaponSelect: null };
  const look = { yaw: 0, pitch: 0 };
  const fakeSim = {
    input,
    applyLook(dYaw: number, dPitch: number) {
      look.yaw += dYaw;
      look.pitch += dPitch;
    },
  };
  const sim = fakeSim as unknown as Sim;
  const mgr = new InputManager(canvas);
  mgr.attach();
  const edges = { qb: 0, glide: 0, jump: 0, weapon: [] as string[], fireFrames: 0 };
  let frames = 0;

  const probe = document.createElement('div');
  probe.id = 'probe';
  document.body.appendChild(probe);
  const btn = document.createElement('button');
  btn.id = 'lock-btn';
  btn.textContent = 'LOCK + START';
  document.body.appendChild(btn);

  const api = {
    mgr,
    sim: fakeSim,
    look,
    edges,
    get frames() {
      return frames;
    },
    lastError: '' as string,
    /** Like the app's sortie / resume: request the lock from a user gesture, then activate. */
    async lock(): Promise<boolean> {
      try {
        await mgr.requestPointerLock();
        mgr.setActive(true);
        mgr.requireRelease();
        btn.style.display = 'none';
        return true;
      } catch (e) {
        api.lastError = e instanceof Error ? e.message : String(e);
        return false;
      }
    },
    pause(): void {
      mgr.setActive(false);
    },
    resume(): void {
      mgr.setActive(true);
      mgr.requireRelease();
    },
    attachTwice(): void {
      mgr.attach();
      mgr.attach();
    },
    reset(): void {
      edges.qb = edges.glide = edges.jump = edges.fireFrames = 0;
      edges.weapon.length = 0;
      look.yaw = look.pitch = 0;
    },
  };
  btn.addEventListener('click', () => {
    void api.lock();
  });
  document.addEventListener('pointerlockchange', () => {
    if (!mgr.pointerLocked) {
      mgr.setActive(false);
      btn.style.display = '';
    }
  });

  const frame = (): void => {
    frames++;
    mgr.apply(sim);
    // what the simulation does at the start of its next sub-step: consume the edges
    if (input.qbPressed) edges.qb++;
    if (input.glideTogglePressed) edges.glide++;
    if (input.jumpPressed) edges.jump++;
    if (input.weaponSelect) edges.weapon.push(input.weaponSelect);
    if (input.fire) edges.fireFrames++;
    input.qbPressed = input.glideTogglePressed = input.jumpPressed = false;
    input.weaponSelect = null;
    probe.textContent =
      `active ${mgr.isActive}  locked ${mgr.pointerLocked}\n` +
      `move ${input.moveX},${input.moveZ}  jump ${input.jump}  brake ${input.brake}  fire ${input.fire}\n` +
      `edges  QB ${edges.qb}  glide ${edges.glide}  jump ${edges.jump}  weapon [${edges.weapon.join(',')}]  fireFrames ${edges.fireFrames}\n` +
      `look  yaw ${(look.yaw / CAMERA.mouseSensitivity).toFixed(1)} px  pitch ${(look.pitch / CAMERA.mouseSensitivity).toFixed(1)} px`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (window as unknown as { __input: unknown }).__input = api;
}
