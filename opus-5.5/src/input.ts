// キーボード・マウス入力。押下エッジはOSのキーリピートを無視し、プレイ中の新しい押下だけを数える。
import type { WeaponId } from './config';
import type { StepInput } from './sim/game';

const GAME_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'KeyQ',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'Digit1',
  'Digit2',
  'Digit3',
]);

export class InputManager {
  /** 物理的に押されているキー（プレイ中に押されたもの） */
  private held = new Set<string>();
  private edgeSpace = false;
  private edgeQ = false;
  private edgeShift = false;
  private weaponSelect: WeaponId | null = null;
  fireHeld = false;
  private mdx = 0;
  private mdy = 0;
  /** true の間だけ入力を受け付ける（プレイ中かつポインターロック中） */
  enabled = false;
  onEscape: (() => void) | null = null;

  attach(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.enabled) this.onEscape?.();
        return;
      }
      if (this.enabled && (GAME_KEYS.has(e.code) || e.ctrlKey)) e.preventDefault();
      if (!this.enabled) return;
      if (e.repeat) {
        // リピートは保持状態の復元のみ（移動キー）。エッジは発生させない
        if (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD') this.held.add(e.code);
        return;
      }
      if (this.held.has(e.code)) return;
      this.held.add(e.code);
      switch (e.code) {
        case 'Space':
          this.edgeSpace = true;
          break;
        case 'KeyQ':
          this.edgeQ = true;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this.edgeShift = true;
          break;
        case 'Digit1':
          this.weaponSelect = 'machinegun';
          break;
        case 'Digit2':
          this.weaponSelect = 'beam';
          break;
        case 'Digit3':
          this.weaponSelect = 'missile';
          break;
      }
    });
    window.addEventListener('keyup', (e) => {
      this.held.delete(e.code);
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0) this.fireHeld = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      this.mdx += e.movementX || 0;
      this.mdy += e.movementY || 0;
    });
    window.addEventListener('contextmenu', (e) => {
      if (this.enabled) e.preventDefault();
    });
  }

  /** 一時停止時：全入力状態を解除 */
  clearAll() {
    this.held.clear();
    this.edgeSpace = this.edgeQ = this.edgeShift = false;
    this.weaponSelect = null;
    this.fireHeld = false;
    this.mdx = this.mdy = 0;
  }

  takeMouse(): [number, number] {
    const r: [number, number] = [this.mdx, this.mdy];
    this.mdx = this.mdy = 0;
    return r;
  }

  isHeld(code: string) {
    return this.held.has(code);
  }

  /** 1ステップ分の入力（エッジは最初のステップでのみ消費） */
  stepInput(): StepInput {
    const h = this.held;
    const inp: StepInput = {
      moveX: (h.has('KeyD') ? 1 : 0) - (h.has('KeyA') ? 1 : 0),
      moveZ: (h.has('KeyW') ? 1 : 0) - (h.has('KeyS') ? 1 : 0),
      yaw: 0,
      spaceHeld: h.has('Space'),
      spaceEdge: this.edgeSpace,
      qEdge: this.edgeQ,
      shiftEdge: this.edgeShift,
      ctrlHeld: h.has('ControlLeft'),
      fireHeld: this.fireHeld,
      weaponSelect: this.weaponSelect,
    };
    this.edgeSpace = this.edgeQ = this.edgeShift = false;
    this.weaponSelect = null;
    return inp;
  }
}
