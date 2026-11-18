import type { WeaponId } from '../core/config';

export class Input {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private releasedThisFrame = new Set<string>();
  mouseDown = false;
  mouseDx = 0;
  mouseDy = 0;
  wheel = 0;
  pointerLocked = false;
  /** seconds the space bar has been held */
  spaceHeld = 0;
  private spaceWasDown = false;

  constructor(private target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', this.onWheel, { passive: true });
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Tab') e.preventDefault();
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (e.repeat) {
      this.down.add(e.code);
      return;
    }
    this.down.add(e.code);
    this.pressedThisFrame.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
    this.releasedThisFrame.add(e.code);
  };

  private onBlur = () => {
    this.down.clear();
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mouseDown = false;
    this.spaceHeld = 0;
    this.spaceWasDown = false;
  };

  private onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.target;
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) this.mouseDown = true;
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouseDown = false;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.mouseDx += e.movementX;
    this.mouseDy += e.movementY;
  };

  private onWheel = (e: WheelEvent) => {
    this.wheel += Math.sign(e.deltaY);
  };

  requestPointerLock(): void {
    const el = this.target as HTMLElement & { requestPointerLock?: () => void };
    if (el.requestPointerLock) {
      const p = el.requestPointerLock();
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => {
          /* user gesture requirement - reported by the HUD */
        });
      }
    }
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  wasReleased(code: string): boolean {
    return this.releasedThisFrame.has(code);
  }

  /** call at the end of every rendered frame */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.wheel = 0;
  }

  /** call when the simulation is paused to drop every pending edge */
  resetEdges(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mouseDown = false;
    this.spaceHeld = 0;
    this.spaceWasDown = false;
  }

  updateSpaceHold(dt: number): void {
    if (this.isDown('Space')) {
      if (!this.spaceWasDown) this.spaceHeld = 0;
      this.spaceHeld += dt;
      this.spaceWasDown = true;
    } else {
      this.spaceHeld = 0;
      this.spaceWasDown = false;
    }
  }

  get moveX(): number {
    let x = 0;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) x += 1;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) x -= 1;
    return x;
  }

  get moveZ(): number {
    let z = 0;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) z += 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) z -= 1;
    return z;
  }

  get brake(): boolean {
    return this.isDown('ControlLeft') || this.isDown('ControlRight');
  }

  get jumpEdge(): boolean {
    return this.pressedThisFrame.has('Space');
  }

  get glideEdge(): boolean {
    return this.pressedThisFrame.has('ShiftLeft') || this.pressedThisFrame.has('ShiftRight');
  }

  get qbEdge(): boolean {
    return this.pressedThisFrame.has('KeyQ');
  }

  /* ---- one-shot edges: a key press must only be acted on once ---- */

  consumeGlideEdge(): boolean {
    if (this.pressedThisFrame.has('ShiftLeft')) {
      this.pressedThisFrame.delete('ShiftLeft');
      return true;
    }
    if (this.pressedThisFrame.has('ShiftRight')) {
      this.pressedThisFrame.delete('ShiftRight');
      return true;
    }
    return false;
  }

  consumeJumpEdge(): boolean {
    if (!this.pressedThisFrame.has('Space')) return false;
    this.pressedThisFrame.delete('Space');
    return true;
  }

  consumeQbEdge(): boolean {
    if (!this.pressedThisFrame.has('KeyQ')) return false;
    this.pressedThisFrame.delete('KeyQ');
    return true;
  }

  get pauseEdge(): boolean {
    return this.pressedThisFrame.has('Escape');
  }

  weaponRequest(): WeaponId | null {
    if (this.pressedThisFrame.has('Digit1')) return 'machinegun';
    if (this.pressedThisFrame.has('Digit2')) return 'beam';
    if (this.pressedThisFrame.has('Digit3')) return 'missile';
    return null;
  }
}
