/**
 * キーボード・マウス入力。エッジ（離された状態から押された瞬間）を検出し、
 * OS のキーリピートでは再発動しない。ポインターロック中のみ視点・射撃を受け付ける。
 */
import type { InputFrame, Weapon } from './types';
import { emptyInput } from './types';

export class InputManager {
  private readonly held = new Set<string>();
  private qEdge = false;
  private shiftEdge = false;
  private spaceEdge = false;
  private weaponEdge: Weapon | null = null;
  private lookX = 0;
  private lookY = 0;
  private fireHeld = false;
  private enabled = false;
  private attached = false;
  /** false にするとポインターロックなしでも視点・射撃を受け付ける（開発用フック専用） */
  requireLock = true;
  private readonly lockElement: HTMLElement;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    const code = e.code;
    if (this.isGameKey(code)) e.preventDefault();
    if (e.repeat) return; // OS キーリピートは無視（エッジにも押下集合にも影響させない）
    const wasHeld = this.held.has(code);
    this.held.add(code);
    if (wasHeld) return;
    switch (code) {
      case 'KeyQ':
        this.qEdge = true;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.shiftEdge = true;
        break;
      case 'Space':
        this.spaceEdge = true;
        break;
      case 'Digit1':
      case 'Numpad1':
        this.weaponEdge = 'machinegun';
        break;
      case 'Digit2':
      case 'Numpad2':
        this.weaponEdge = 'beam';
        break;
      case 'Digit3':
      case 'Numpad3':
        this.weaponEdge = 'missile';
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
    if (this.enabled && this.isGameKey(e.code)) e.preventDefault();
  };

  /** 射撃ボタンか。macOS では Ctrl＋左クリックが副ボタン（button=2, ctrlKey）として届くため、ブレーキ中の射撃もこれで受ける */
  private isFireButton(e: MouseEvent): boolean {
    return e.button === 0 || (e.button === 2 && e.ctrlKey);
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled || !this.isLocked()) return;
    if (this.isFireButton(e)) {
      this.fireHeld = true;
      e.preventDefault();
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (this.isFireButton(e) || e.button === 0 || e.button === 2) this.fireHeld = false;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled || !this.isLocked()) return;
    this.lookX += e.movementX;
    this.lookY += e.movementY;
  };

  private readonly onContextMenu = (e: Event): void => {
    if (this.enabled) e.preventDefault();
  };

  constructor(lockElement: HTMLElement) {
    this.lockElement = lockElement;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('contextmenu', this.onContextMenu);
  }

  isLocked(): boolean {
    return !this.requireLock || document.pointerLockElement === this.lockElement;
  }

  /** 指定キーが押下中か（HUD 表示用） */
  isHeld(code: string): boolean {
    return this.enabled && this.held.has(code);
  }

  /** プレイ中のみ有効化。無効化時は全入力状態を解除する */
  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) this.clear();
  }

  /** 全ての押下状態・エッジ・蓄積を解除（一時停止・復帰時）。復帰後は押し直しが必要 */
  clear(): void {
    this.held.clear();
    this.qEdge = false;
    this.shiftEdge = false;
    this.spaceEdge = false;
    this.weaponEdge = null;
    this.lookX = 0;
    this.lookY = 0;
    this.fireHeld = false;
  }

  /** 1フレーム分の入力を取り出す（エッジと視点移動量は消費される） */
  poll(): InputFrame {
    const f = emptyInput();
    if (!this.enabled) return f;
    const held = this.held;
    let fwd = 0;
    let right = 0;
    if (held.has('KeyW')) fwd += 1;
    if (held.has('KeyS')) fwd -= 1;
    if (held.has('KeyD')) right += 1;
    if (held.has('KeyA')) right -= 1;
    f.moveForward = fwd;
    f.moveRight = right;
    f.qbPressed = this.qEdge;
    f.shiftPressed = this.shiftEdge;
    f.spacePressed = this.spaceEdge;
    f.spaceDown = held.has('Space');
    f.ctrlDown = held.has('ControlLeft');
    f.fireDown = this.fireHeld && this.isLocked();
    f.weaponSelect = this.weaponEdge;
    f.lookDeltaX = this.lookX;
    f.lookDeltaY = this.lookY;
    this.qEdge = false;
    this.shiftEdge = false;
    this.spaceEdge = false;
    this.weaponEdge = null;
    this.lookX = 0;
    this.lookY = 0;
    return f;
  }

  private isGameKey(code: string): boolean {
    switch (code) {
      case 'KeyW':
      case 'KeyA':
      case 'KeyS':
      case 'KeyD':
      case 'KeyQ':
      case 'ShiftLeft':
      case 'ShiftRight':
      case 'Space':
      case 'ControlLeft':
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
      case 'Tab':
        return true;
      default:
        return false;
    }
  }
}

export type PointerLockResult = { ok: true } | { ok: false; message: string };

/**
 * ユーザー操作を起点にポインターロックを要求する。成功/失敗を Promise で返す。
 * 失敗時は説明文を返す（呼び出し側が再試行手段を表示する）。
 */
export function requestPointerLock(element: HTMLElement): Promise<PointerLockResult> {
  return new Promise((resolve) => {
    if (document.pointerLockElement === element) {
      resolve({ ok: true });
      return;
    }
    let settled = false;
    const cleanup = (): void => {
      document.removeEventListener('pointerlockchange', onChange);
      document.removeEventListener('pointerlockerror', onErrorEvent);
    };
    const onChange = (): void => {
      if (settled) return;
      if (document.pointerLockElement === element) {
        settled = true;
        cleanup();
        resolve({ ok: true });
      }
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, message: 'ポインターロックの取得に失敗しました。ブラウザーの設定やフォーカスを確認し、もう一度ボタンを押してください。' });
    };
    document.addEventListener('pointerlockchange', onChange);
    // Promise を返す実装では結果を Promise で判定する（unadjustedMovement 未対応時の pointerlockerror で
    // 代替要求の前に失敗扱いにしないため）。Promise を返さない古い実装だけ error イベントを使う
    let usePromise = false;
    const onErrorEvent = (): void => {
      if (!usePromise) onError();
    };
    document.addEventListener('pointerlockerror', onErrorEvent);
    type LockFn = (options?: { unadjustedMovement?: boolean }) => Promise<void> | undefined;
    const el = element as HTMLElement & { requestPointerLock: LockFn };
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const name = err instanceof Error ? err.name : String(err);
      resolve({
        ok: false,
        message:
          name === 'SecurityError'
            ? 'ポインターロックが拒否されました（直前の解除から時間を置く必要があります）。1〜2秒待ってから再試行してください。'
            : `ポインターロックの取得に失敗しました（${name}）。もう一度ボタンを押してください。`,
      });
    };
    const succeed = (): void => {
      if (!settled && document.pointerLockElement === element) {
        settled = true;
        cleanup();
        resolve({ ok: true });
      }
    };
    try {
      // まず生のマウス移動量（unadjustedMovement）で要求し、未対応なら通常の要求へ切り替える
      const first = el.requestPointerLock({ unadjustedMovement: true });
      if (first && typeof first.then === 'function') {
        usePromise = true;
        first.then(succeed, (err: unknown) => {
          if (settled) return;
          const name = err instanceof Error ? err.name : '';
          if (name === 'NotSupportedError' || name === 'TypeError') {
            try {
              const second = el.requestPointerLock();
              if (second && typeof second.then === 'function') second.then(succeed, fail);
            } catch (e2) {
              fail(e2);
            }
          } else {
            fail(err);
          }
        });
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ ok: false, message: `ポインターロックを要求できませんでした（${err instanceof Error ? err.message : String(err)}）。` });
      }
    }
    // タイムアウト（環境によってはイベントが来ない）
    setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      if (document.pointerLockElement === element) resolve({ ok: true });
      else resolve({ ok: false, message: 'ポインターロックの応答がありません。ウィンドウをクリックしてから再試行してください。' });
    }, 1500);
  });
}
