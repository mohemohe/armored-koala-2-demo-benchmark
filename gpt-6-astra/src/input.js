const PREVENT_DEFAULT_CODES = new Set(['Space', 'Tab', 'ShiftLeft', 'ControlLeft', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);
const WEAPON_CODES = Object.freeze({ Digit1: 'machinegun', Digit2: 'beam', Digit3: 'missile' });

// DOM-independent production keyboard adapter. Root owns event listeners,
// pointer lock and pause transitions; tests can pass the same keyboard events.
export class InputController {
  constructor() {
    this.keys = new Set();
    this.blockedUntilRelease = new Set();
    this.edges = { q: false, shift: false, jump: false };
    this.fireHeld = false;
    this.spaceStartedAt = null;
  }

  handleKeyDown(event, state, elapsed) {
    if (state !== 'playing') {
      if (event.code === 'KeyQ') this.blockedUntilRelease.add(event.code);
      return null;
    }
    if (PREVENT_DEFAULT_CODES.has(event.code)) event.preventDefault?.();
    if (event.repeat || this.blockedUntilRelease.has(event.code) || this.keys.has(event.code)) return null;
    this.keys.add(event.code);
    if (event.code === 'KeyQ') this.edges.q = true;
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') this.edges.shift = true;
    if (event.code === 'Space') {
      this.edges.jump = true;
      this.spaceStartedAt = elapsed;
    }
    return WEAPON_CODES[event.code] || null;
  }

  handleKeyUp(event) {
    this.keys.delete(event.code);
    this.blockedUntilRelease.delete(event.code);
    if (event.code === 'Space') this.spaceStartedAt = null;
  }

  clear() {
    // Pausing consumes inputs but does not manufacture a new physical press.
    for (const key of this.keys) this.blockedUntilRelease.add(key);
    this.keys.clear();
    this.edges.q = this.edges.shift = this.edges.jump = false;
    this.fireHeld = false;
    this.spaceStartedAt = null;
  }

  movementInput(yaw, elapsed) {
    const input = {
      forward: Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS')),
      right: Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA')),
      yaw,
      qPressed: this.edges.q,
      shiftPressed: this.edges.shift,
      jumpPressed: this.edges.jump,
      spaceHeld: this.keys.has('Space'),
      spaceHeldSeconds: this.spaceStartedAt === null ? 0 : Math.max(0, elapsed - this.spaceStartedAt),
      brake: this.keys.has('ControlLeft'),
      fire: this.fireHeld,
    };
    this.edges.q = this.edges.shift = this.edges.jump = false;
    return input;
  }
}
