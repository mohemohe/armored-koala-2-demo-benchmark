export class InputController {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set(); this.presses = new Set();
    this.mouseDown = false; this.lookX = 0; this.lookY = 0; this.lookIgnoreUntil = 0; this.ignoreNextLook = false;
    this.onEscape = null; this.onPause = null;
    this.bound = [];
    this.listen(window, 'keydown', e => {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Digit1', 'Digit2', 'Digit3'].includes(e.code)) e.preventDefault();
      if (e.code === 'Escape') { this.onEscape?.(); return; }
      if (!e.repeat && !this.keys.has(e.code)) this.presses.add(e.code);
      this.keys.add(e.code);
    });
    this.listen(window, 'keyup', e => { this.keys.delete(e.code); });
    this.listen(canvas, 'mousedown', e => { if (e.button === 0 && document.pointerLockElement === canvas) this.mouseDown = true; });
    this.listen(window, 'mouseup', e => { if (e.button === 0) this.mouseDown = false; });
    this.listen(window, 'mousemove', e => {
      if (document.pointerLockElement !== canvas) return;
      if (this.ignoreNextLook) { this.ignoreNextLook = false; return; }
      if (performance.now() >= this.lookIgnoreUntil) { this.lookX += e.movementX; this.lookY += e.movementY; }
    });
    this.listen(canvas, 'contextmenu', e => e.preventDefault());
    this.listen(window, 'blur', () => { this.clear(); this.onPause?.(); });
    this.listen(document, 'visibilitychange', () => { if (document.hidden) { this.clear(); this.onPause?.(); } });
  }
  listen(target, type, fn) { target.addEventListener(type, fn); this.bound.push([target, type, fn]); }
  down(code) { return this.keys.has(code); }
  consumePress(code) { const yes = this.presses.has(code); this.presses.delete(code); return yes; }
  consumeLook() { const result = [this.lookX, this.lookY]; this.lookX = 0; this.lookY = 0; return result; }
  suppressInitialLook() { this.lookIgnoreUntil = performance.now() + 150; this.ignoreNextLook = true; this.lookX = 0; this.lookY = 0; }
  clear() { this.keys.clear(); this.presses.clear(); this.mouseDown = false; this.lookX = 0; this.lookY = 0; }
  dispose() { for (const [t, type, fn] of this.bound) t.removeEventListener(type, fn); this.bound.length = 0; }
}
