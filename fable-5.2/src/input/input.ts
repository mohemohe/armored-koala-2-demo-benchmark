/**
 * Input layer — docs/SPEC.md §7.1 (key assignment), §7.2–7.4 (edge semantics of Q / Shift / Space), §9
 * (pointer lock, pause, "a key still held at resume must be released first", no duplicated listeners).
 *
 *   InputCore           pure key/button state machine (no DOM; unit-tested in tests/input.test.ts)
 *   RecenterEchoFilter  repairs the mouse movement of an emulated pointer lock (headless / injected input)
 *   InputManager        DOM listeners (registered exactly once) + pointer lock + the per-frame hand-over to the Sim
 *   installUnloadGuard  beforeunload confirmation while a sortie is in progress (Left Ctrl + W)
 *   requestPointerLock  promise wrapper with Japanese failure messages (POINTER_LOCK_MESSAGES)
 *
 * Semantics
 *  - Keys are identified by `KeyboardEvent.code` (layout independent).
 *  - Level inputs (WASD, Space, Left Ctrl, left mouse button) mirror the keys that are logically held.
 *  - Edge inputs (Q, Shift, Space, 1/2/3) are produced only by a real released → pressed transition: a
 *    keydown for a key that is already believed to be down (OS auto-repeat with or without `event.repeat`)
 *    never produces a second edge. Edges are stored until the next `apply()` / `flush()`, which hands each
 *    of them to the simulation exactly once; there the flag stays set until a simulation tick consumes it.
 *  - Every press reaches at least one simulation tick, whatever the frame rate. A rendered frame does not
 *    always run a tick (the simulation steps at 120 Hz: on a 240 Hz display every second frame runs none, at
 *    360 Hz two of three), and a press can be over before the next frame even starts. The edge flags survive
 *    that by themselves (see above). The two LEVEL inputs whose press must not be lost — the trigger (one
 *    click = one shot) and the brake (a tap of Left Ctrl switches the glide off) — are latched: a press keeps
 *    the level up, also after the release, until a frame that ran at least one tick has passed with it.
 *    `apply()` learns that from `sim.time` (see InputCore.flush).
 *  - While inactive (garage, pause, results) nothing is logically held and no edge is recorded, but the
 *    physical state of the keys is still tracked, so that a key held across a pause is known to be down.
 *  - A key that is physically down when it could not have been pressed "for the game" — held across a
 *    pause / resume, or first seen through an auto-repeat keydown (held since before the window got the
 *    focus) — is blocked until its keyup arrives.
 *  - The left mouse button and mouse movement count only while the pointer is locked to the game canvas,
 *    so the click on "出撃" / "再開" (made while the pointer is still free) can never fire a weapon.
 *  - The second click of a DOUBLE click on such a button arrives after the lock was acquired. It belongs to
 *    the button, not to the trigger: the first left press under a new lock that continues an earlier click
 *    series (`MouseEvent.detail` ≥ 2) fires nothing — unless it stays down for FOLLOW_UP_HOLD_SECONDS, which
 *    is a trigger pull and not a click (a player who resumes and immediately holds the fire button).
 *  - Key state is derived from the keydown / keyup of the key itself only (never guessed from the modifier
 *    flags or `buttons` of other events, which are stale on browser-generated and injected events).
 *  - Mouse look: CAMERA.mouseSensitivity rad per CSS pixel of movementX / movementY; mouse right turns right
 *    (negative yaw), mouse up looks up (positive pitch).
 */
import { CAMERA, WEAPON_ORDER } from '../config';
import type { Sim } from '../sim/sim';
import type { InputState, Weapon } from '../sim/types';

/** Pseudo key code of the left mouse button inside InputCore. */
export const MOUSE_FIRE = 'Mouse0';

const WEAPON_BY_CODE: Readonly<Record<string, Weapon>> = {
  Digit1: WEAPON_ORDER[0],
  Digit2: WEAPON_ORDER[1],
  Digit3: WEAPON_ORDER[2],
  Numpad1: WEAPON_ORDER[0],
  Numpad2: WEAPON_ORDER[1],
  Numpad3: WEAPON_ORDER[2],
};

/** Every code the game reacts to (preventDefault is applied to these while a sortie is active). */
export const GAME_CODES: ReadonlySet<string> = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'KeyQ',
  ...Object.keys(WEAPON_BY_CODE),
  MOUSE_FIRE,
]);

/**
 * Non-game keys whose browser default would take the keyboard away from the game in the middle of a sortie
 * (focus traversal, the browser menu on Alt, Firefox quick find, history navigation). Suppressed while active.
 */
const SUPPRESSED_CODES: ReadonlySet<string> = new Set(['Tab', 'AltLeft', 'AltRight', 'Slash', 'Quote', 'Backspace']);

/** Largest |movement| of a single mouse event that is believed (larger values are pointer-lock glitches). */
const MAX_MOUSE_STEP = 2000;

/**
 * Game seconds the follow-up press of a click series that began on a start / resume button has to stay down
 * before it counts as the trigger (see InputManager.onMouseDown). The second click of a double click is
 * shorter than this; a deliberate trigger pull right after "再開" only starts firing this much later.
 */
export const FOLLOW_UP_HOLD_SECONDS = 0.2;

// ───────────────────────────── pure state machine ─────────────────────────────
export class InputCore {
  private active = false;
  /** Keys/buttons believed to be physically down (tracked even while inactive). */
  private readonly physical = new Set<string>();
  /** Physically down keys that must be released before they count again. Always a subset of `physical`. */
  private readonly blocked = new Set<string>();
  /** Keys/buttons that count as held for the game. Always empty while inactive. */
  private readonly held = new Set<string>();

  private qbEdge = false;
  private glideEdge = false;
  private jumpEdge = false;
  private weaponEdge: Weapon | null = null;
  /**
   * Press latches of the trigger and of the brake: the button / key went down and no simulation tick has run
   * with that press yet, so the level stays up even if it has been released again (a click or a tap shorter
   * than one frame, or one that only frames without a tick got to see).
   */
  private firePulse = false;
  private brakePulse = false;
  /** The latch has been written into the InputState by a flush (it ends with the next flush after a tick). */
  private fireDelivered = false;
  private brakeDelivered = false;
  private lookX = 0;
  private lookY = 0;

  get isActive(): boolean {
    return this.active;
  }

  /** false: every logically held key/button and every pending edge is dropped, and presses stop counting. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (!active) this.dropLogical();
  }

  /** Whatever is physically down right now is ignored until it has been released once. */
  requireRelease(): void {
    for (const code of this.physical) this.blocked.add(code);
    this.dropLogical();
  }

  /** requireRelease() for a single key/button. */
  requireReleaseOf(code: string): void {
    if (this.physical.has(code)) this.blocked.add(code);
    this.held.delete(code);
    if (code === MOUSE_FIRE) this.firePulse = this.fireDelivered = false;
    else if (code === 'ControlLeft') this.brakePulse = this.brakeDelivered = false;
  }

  /** Focus loss: nothing is known to be down any more (keyups may never arrive). */
  releaseAll(): void {
    this.physical.clear();
    this.blocked.clear();
    this.dropLogical();
  }

  private dropLogical(): void {
    this.held.clear();
    this.qbEdge = false;
    this.glideEdge = false;
    this.jumpEdge = false;
    this.weaponEdge = null;
    this.firePulse = this.fireDelivered = false;
    this.brakePulse = this.brakeDelivered = false;
    this.lookX = 0;
    this.lookY = 0;
  }

  /**
   * A key or button went down.
   * @param repeat   `KeyboardEvent.repeat`
   * @param eligible false when the press must not count for the game even while active (mouse button
   *                 without pointer lock); the physical state is still tracked.
   * @returns true when the press was accepted as a new logical press.
   */
  press(code: string, repeat = false, eligible = true): boolean {
    const wasDown = this.physical.has(code);
    this.physical.add(code);
    if (wasDown) return false; // auto-repeat or a duplicated keydown: not a released → pressed transition
    if (repeat) {
      // First seen through an auto-repeat: the key has been held since before we could observe it.
      this.blocked.add(code);
      return false;
    }
    if (!this.active || !eligible || !GAME_CODES.has(code)) return false;
    this.held.add(code);
    switch (code) {
      case 'KeyQ':
        this.qbEdge = true;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.glideEdge = true;
        break;
      case 'Space':
        this.jumpEdge = true;
        break;
      case MOUSE_FIRE:
        // (a new press starts a new latch: it must not end together with an earlier one that is being simulated)
        this.firePulse = true;
        this.fireDelivered = false;
        break;
      case 'ControlLeft':
        this.brakePulse = true;
        this.brakeDelivered = false;
        break;
      default: {
        const w = WEAPON_BY_CODE[code];
        if (w !== undefined) this.weaponEdge = w;
      }
    }
    return true;
  }

  /** A key or button went up. */
  release(code: string): void {
    this.physical.delete(code);
    this.blocked.delete(code);
    this.held.delete(code);
  }

  /**
   * A key/button that is physically down but did not count when it went down (press() with `eligible`
   * false) starts counting as held from now on. No edge is produced. Does nothing while inactive, for a
   * blocked key and for a key that is not down.
   * @returns true when the key counts as held afterwards.
   */
  accept(code: string): boolean {
    if (!this.active || !GAME_CODES.has(code) || !this.physical.has(code) || this.blocked.has(code)) return false;
    this.held.add(code);
    return true;
  }

  /** Accumulates mouse movement in CSS pixels (ignored while inactive). */
  addLook(dx: number, dy: number): void {
    if (!this.active) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (Math.abs(dx) > MAX_MOUSE_STEP || Math.abs(dy) > MAX_MOUSE_STEP) return;
    this.lookX += dx;
    this.lookY += dy;
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }
  isPhysicallyDown(code: string): boolean {
    return this.physical.has(code);
  }
  isBlocked(code: string): boolean {
    return this.blocked.has(code);
  }

  /**
   * Copies the held state into `input` and moves the pending edges into it (each edge exactly once; an edge
   * flag the simulation has not consumed yet is left untouched). Does not allocate.
   *
   * @param simAdvanced whether the simulation has run at least one tick since the previous flush. A latched
   *   press of the trigger / the brake that an earlier flush already wrote into `input` ends only then: it
   *   has been simulated. With `false` (the frame in between ran no tick) it stays up. The default suits a
   *   caller that runs the simulation after every flush.
   */
  flush(input: InputState, simAdvanced = true): void {
    if (simAdvanced) {
      if (this.fireDelivered) this.firePulse = this.fireDelivered = false;
      if (this.brakeDelivered) this.brakePulse = this.brakeDelivered = false;
    }
    const h = this.held;
    input.moveX = (h.has('KeyD') ? 1 : 0) - (h.has('KeyA') ? 1 : 0);
    input.moveZ = (h.has('KeyW') ? 1 : 0) - (h.has('KeyS') ? 1 : 0);
    input.jump = h.has('Space');
    input.brake = h.has('ControlLeft') || this.brakePulse;
    input.fire = h.has(MOUSE_FIRE) || this.firePulse;
    this.brakeDelivered = this.brakePulse;
    this.fireDelivered = this.firePulse;
    if (this.qbEdge) input.qbPressed = true;
    if (this.glideEdge) input.glideTogglePressed = true;
    if (this.jumpEdge) input.jumpPressed = true;
    if (this.weaponEdge !== null) input.weaponSelect = this.weaponEdge;
    this.qbEdge = false;
    this.glideEdge = false;
    this.jumpEdge = false;
    this.weaponEdge = null;
  }

  /** Mouse movement accumulated since the last clearLook(). */
  get pendingLookX(): number {
    return this.lookX;
  }
  get pendingLookY(): number {
    return this.lookY;
  }
  clearLook(): void {
    this.lookX = 0;
    this.lookY = 0;
  }
}

// ───────────────────────────── emulated pointer lock ─────────────────────────────
/** Smallest movement (|dx| + |dy|, CSS px) that can be the echo of the click that acquired the lock. */
const ECHO_MIN = 16;
/**
 * Later patterns are only examined for movements of at least this size (|dx| + |dy|, CSS px, in ONE event):
 * a hand cannot reverse such a move exactly, to the pixel, within the next event.
 */
const ECHO_STRONG = 200;
/**
 * The echo of the lock click belongs to the click / the lock acquisition if their event timestamps are
 * within this time (ms). Generous, because a `pointerlockchange` event is stamped when a busy main thread
 * gets round to it, while mouse events are stamped when they happen.
 * A browser under load (software rendering) produces the echo up to a few seconds late, so the time is not
 * the only criterion: the FIRST movement after a lock acquisition counts as its echo whenever it arrives
 * (see isLockEcho), and an echo seen before the lock is reported counts until the pointer does something else.
 */
const ECHO_WINDOW_MS = 1500;

/**
 * Repairs the mouse movement reported under an EMULATED pointer lock (headless browsers and other setups
 * in which an automation tool injects the input). A real pointer lock reports relative motion. The
 * emulation instead reports every injected mouse event at viewport position Q as
 *     a move by exactly +Q (the absolute position, not a delta), immediately followed by
 *     an "echo" of exactly −Q (the browser putting its pointer back),
 * and a button press / release at Q — including the click that acquired the lock — as a lone echo of −Q.
 * Taken literally, lone echoes swing the view by hundreds of pixels at the start of a sortie and on every
 * shot, and moving the pointer has no lasting effect at all.
 *
 * Stages (they only ever advance):
 *   0  normal. Every movement passes through unchanged. The ONLY thing looked for is the signature of an
 *      emulated lock at the moment it is acquired: a move that negates, to the pixel, the position of the
 *      pointer when the lock was requested, within ECHO_WINDOW_MS of the click / of the lock. It is dropped
 *      (so the view does not swing at the start of a sortie) and the filter becomes a
 *   1  candidate. Movements still pass through unchanged, except the next large pixel-exact pattern,
 *      which confirms the emulation: a lone echo of the injected pointer position (dropped), or a jump
 *      immediately followed by its exact negation (turned into the relative movement Q − previous position).
 *   2  emulated. Every move is converted directly: jump Q → Q − previous position, echo → nothing.
 * With a real pointer lock stage 0 never ends (a hand would have to produce the exact vector from the
 * clicked button to the viewport origin in one event, a few milliseconds after the click), so real input
 * is passed through unchanged and without delay. Only real (trusted) events are examined; mouse events
 * created by scripts are never touched.
 */
export class RecenterEchoFilter {
  /** Movement to apply for the event passed to the last process() call. */
  dx = 0;
  dy = 0;

  private stage: 0 | 1 | 2 = 0;
  /** Injected pointer position: the last position seen while the pointer was free, later the last jump. */
  private ghostX = 0;
  private ghostY = 0;
  /** Timestamps (ms) of the last button event with a free pointer and of the last lock acquisition. */
  private buttonAt = -1e12;
  private lockAt = -1e12;
  /** Between lockAcquired() and lockLost(). */
  private lockOpen = false;
  /** Timestamp of a free move that looked like the echo of a lock that had not been reported yet. */
  private preEchoAt = -1e12;
  /** That free move is still the last thing the free pointer did (no later move / button event). */
  private preEchoPending = false;
  /** Non-zero locked movements seen since the last lockAcquired(). */
  private movesSinceLock = 0;
  /** Large move that has not been followed by anything yet (candidate for a jump + echo pair). */
  private jumpX = 0;
  private jumpY = 0;
  private hasJump = false;
  private jumpApplied = false;

  /** True once the pointer lock is known to be emulated (never the case with a real pointer lock). */
  get emulated(): boolean {
    return this.stage === 2;
  }

  /** A real mouse button event at client position (x, y) while the pointer was NOT locked. */
  noteFreeButton(x: number, y: number, time: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.ghostX = x;
    this.ghostY = y;
    this.buttonAt = time;
    this.preEchoPending = false;
  }

  /**
   * A real mouse move with movement (mx, my) ≠ 0 to client position (x, y) while the pointer was NOT locked.
   * The echo of the click that acquires the lock can arrive just before the lock is reported: it shows up as
   * a jump from the click position to (0, 0) and must not replace the remembered position.
   */
  noteFreeMove(x: number, y: number, mx: number, my: number, time: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x === 0 && y === 0 && this.negatesGhost(mx, my)) {
      this.preEchoAt = time; // counts only if a lock acquisition follows (see lockAcquired)
      this.preEchoPending = true;
      return;
    }
    this.ghostX = x;
    this.ghostY = y;
    this.preEchoPending = false;
  }

  /** The pointer lock was acquired (timestamp of the pointerlockchange event). */
  lockAcquired(time: number): void {
    this.lockOpen = true;
    this.lockAt = time;
    this.hasJump = false;
    this.movesSinceLock = 0;
    // (a busy main thread can report the lock long after the echo: the echo also counts while it still is
    //  the last thing the free pointer did)
    if (this.stage === 0 && (this.preEchoPending || Math.abs(time - this.preEchoAt) <= ECHO_WINDOW_MS)) this.stage = 1;
    this.preEchoPending = false;
  }

  /** The pointer lock was lost. */
  lockLost(): void {
    this.lockOpen = false;
    this.lockAt = -1e12;
    this.preEchoAt = -1e12;
    this.preEchoPending = false;
    this.hasJump = false;
  }

  private negatesGhost(mx: number, my: number): boolean {
    return mx === -this.ghostX && my === -this.ghostY && Math.abs(mx) + Math.abs(my) >= ECHO_MIN;
  }

  /**
   * The echo of the event that led into the lock: negates the pointer position, at the time of the lock —
   * or, however late, as the very first movement after the lock was acquired (a loaded browser delivers the
   * echo seconds after the click; a hand cannot open with exactly that vector either).
   */
  private isLockEcho(mx: number, my: number, time: number, firstSinceLock: boolean): boolean {
    return (
      this.negatesGhost(mx, my) &&
      // (a locked move before lockAcquired(): the lock exists but has not been reported yet)
      (!this.lockOpen || firstSinceLock || Math.abs(time - this.buttonAt) <= ECHO_WINDOW_MS || Math.abs(time - this.lockAt) <= ECHO_WINDOW_MS)
    );
  }

  /**
   * Feeds the non-zero movement of a real pointer-locked mousemove and leaves the movement to apply in
   * `dx` / `dy`. `applied` says whether the caller will apply it (false while the game is not active); the
   * state is tracked either way.
   */
  process(mx: number, my: number, time: number, applied = true): void {
    this.dx = mx;
    this.dy = my;
    const firstSinceLock = this.lockOpen && this.movesSinceLock === 0;
    this.movesSinceLock++;
    if (this.stage === 2) {
      if (mx <= 0 && my <= 0) {
        this.dx = 0; // echo
        this.dy = 0;
      } else if (mx >= 0 && my >= 0) {
        this.dx = mx - this.ghostX; // absolute position → relative movement
        this.dy = my - this.ghostY;
        this.ghostX = mx;
        this.ghostY = my;
      }
      // mixed signs are not explained by the emulation: ordinary relative movement, passed on as it is
      return;
    }
    if (this.stage === 0) {
      if (this.isLockEcho(mx, my, time, firstSinceLock)) {
        this.stage = 1;
        this.dx = 0;
        this.dy = 0;
      }
      return;
    }
    // stage 1: the next large pixel-exact pattern confirms the emulation
    if (Math.abs(mx) + Math.abs(my) < ECHO_STRONG) {
      this.hasJump = false; // a pair is a jump immediately followed by its echo
      return;
    }
    if (this.hasJump && mx === -this.jumpX && my === -this.jumpY) {
      // jump + echo: the injected pointer went from the ghost position to the jump position.
      // Total wanted: jump − ghost if both halves are applied, nothing otherwise.
      this.stage = 2;
      const both = this.jumpApplied && applied;
      this.dx = (both ? this.jumpX - this.ghostX : 0) - (this.jumpApplied ? this.jumpX : 0);
      this.dy = (both ? this.jumpY - this.ghostY : 0) - (this.jumpApplied ? this.jumpY : 0);
      this.ghostX = this.jumpX;
      this.ghostY = this.jumpY;
      this.hasJump = false;
      return;
    }
    if (mx === -this.ghostX && my === -this.ghostY) {
      this.stage = 2;
      this.dx = 0; // lone echo (button event at the injected position, or the click of a new lock)
      this.dy = 0;
      return;
    }
    // candidate for a jump: an absolute viewport position has no negative component
    this.hasJump = mx >= 0 && my >= 0;
    this.jumpX = mx;
    this.jumpY = my;
    this.jumpApplied = applied;
  }
}

// ───────────────────────────── unload guard ─────────────────────────────
const unloadPredicates = new Set<() => boolean>();
let unloadHandlerInstalled = false;

function onBeforeUnload(e: BeforeUnloadEvent): void {
  for (const isPlaying of unloadPredicates) {
    let playing = false;
    try {
      playing = isPlaying();
    } catch {
      playing = false;
    }
    if (playing) {
      e.preventDefault();
      // Legacy way of requesting the confirmation dialog.
      e.returnValue = '';
      return;
    }
  }
}

/**
 * Left Ctrl is the brake and W is "forward", and a page cannot cancel the browser's Ctrl+W ("close tab").
 * This registers ONE `beforeunload` confirmation that is shown while `isPlaying()` returns true, so the
 * combination does not silently close the tab in the middle of a sortie.
 * Calling it again adds another predicate to the same single listener. Returns a function that removes it.
 */
export function installUnloadGuard(isPlaying: () => boolean): () => void {
  unloadPredicates.add(isPlaying);
  if (!unloadHandlerInstalled && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload);
    unloadHandlerInstalled = true;
  }
  return () => {
    unloadPredicates.delete(isPlaying);
  };
}

// ───────────────────────────── pointer lock helper ─────────────────────────────
/** Japanese explanations for the three ways a pointer-lock request can fail (shown by the menus / garage). */
export const POINTER_LOCK_MESSAGES = {
  unsupported: 'このブラウザーはポインターロック（マウスカーソルの固定）に対応していません。',
  rejected: 'ブラウザーがマウスカーソルの固定を許可しませんでした（Esc で解除した直後は 1〜2 秒ほど取得できません）。',
  timeout: 'ブラウザーから応答がありませんでした。ゲーム画面のウィンドウを選択してから、もう一度お試しください。',
} as const;

/**
 * Requests the pointer lock for `element`. MUST be called from a user gesture (click / key press).
 * Resolves once the pointer is really locked to the element; rejects with an Error whose message is a
 * Japanese explanation (see POINTER_LOCK_MESSAGES). Its temporary listeners are always removed again.
 */
export function requestPointerLock(element: HTMLElement, timeoutMs = 2500): Promise<void> {
  const doc = element.ownerDocument;
  if (doc.pointerLockElement === element) return Promise.resolve();
  if (typeof element.requestPointerLock !== 'function') return Promise.reject(new Error(POINTER_LOCK_MESSAGES.unsupported));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      doc.removeEventListener('pointerlockchange', onChange);
      doc.removeEventListener('pointerlockerror', onError);
      if (timer !== null) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const onChange = (): void => {
      if (doc.pointerLockElement === element) settle(null);
    };
    const onError = (): void => settle(new Error(POINTER_LOCK_MESSAGES.rejected));
    doc.addEventListener('pointerlockchange', onChange);
    doc.addEventListener('pointerlockerror', onError);
    timer = setTimeout(() => settle(new Error(POINTER_LOCK_MESSAGES.timeout)), timeoutMs);
    try {
      // Newer browsers return a promise, older ones return undefined and only fire the events.
      const result = element.requestPointerLock() as unknown;
      if (result !== null && typeof result === 'object' && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).then(onChange, onError);
      }
    } catch {
      settle(new Error(POINTER_LOCK_MESSAGES.rejected));
    }
  });
}

// ───────────────────────────── DOM layer ─────────────────────────────
export interface InputManagerOptions {
  /**
   * true (default): the left mouse button and mouse movement count only while the pointer is locked to the
   * element. false is meant for dev harnesses that drive the game without pointer lock.
   */
  mouseRequiresLock?: boolean;
}

export class InputManager {
  /** The pure state machine (exposed for diagnostics and tests). */
  readonly core = new InputCore();
  private readonly element: HTMLElement;
  private readonly doc: Document;
  private readonly win: Window;
  private readonly mouseRequiresLock: boolean;
  private attached = false;
  private readonly echo = new RecenterEchoFilter();
  private removeUnloadGuard: (() => void) | null = null;
  /**
   * True from the acquisition of the pointer lock until the first left press under it. The lock is acquired
   * by a click on "出撃" / "再開" / "再出撃"; only that first press can be the second click of a double click
   * on the button.
   */
  private awaitingFirstPress = false;
  /** The follow-up press of the button's click series is down and has not been accepted as the trigger. */
  private followUpDown = false;
  /** Game time at which apply() first saw that press (null: not seen by a frame yet). */
  private followUpSince: number | null = null;
  /** `sim.time` at the previous apply(): unchanged at the next one = the frame in between ran no tick. */
  private appliedAt: number | null = null;

  /** @param pointerLockElement the game canvas */
  constructor(pointerLockElement: HTMLElement, options: InputManagerOptions = {}) {
    this.element = pointerLockElement;
    this.doc = pointerLockElement.ownerDocument;
    this.win = this.doc.defaultView ?? window;
    this.mouseRequiresLock = options.mouseRequiresLock !== false;
  }

  /** Registers the listeners. Idempotent: they exist exactly once however often this is called. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const w = this.win;
    const d = this.doc;
    w.addEventListener('keydown', this.onKeyDown, true);
    w.addEventListener('keyup', this.onKeyUp, true);
    w.addEventListener('mousedown', this.onMouseDown, true);
    w.addEventListener('mouseup', this.onMouseUp, true);
    w.addEventListener('mousemove', this.onMouseMove, true);
    w.addEventListener('contextmenu', this.onContextMenu, true);
    w.addEventListener('blur', this.onBlur);
    d.addEventListener('visibilitychange', this.onVisibility);
    d.addEventListener('pointerlockchange', this.onLockChange);
    this.removeUnloadGuard = installUnloadGuard(this.isActiveForUnload);
  }

  /** Removes every listener registered by attach() and drops all state. Idempotent. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const w = this.win;
    const d = this.doc;
    w.removeEventListener('keydown', this.onKeyDown, true);
    w.removeEventListener('keyup', this.onKeyUp, true);
    w.removeEventListener('mousedown', this.onMouseDown, true);
    w.removeEventListener('mouseup', this.onMouseUp, true);
    w.removeEventListener('mousemove', this.onMouseMove, true);
    w.removeEventListener('contextmenu', this.onContextMenu, true);
    w.removeEventListener('blur', this.onBlur);
    d.removeEventListener('visibilitychange', this.onVisibility);
    d.removeEventListener('pointerlockchange', this.onLockChange);
    if (this.removeUnloadGuard) this.removeUnloadGuard();
    this.removeUnloadGuard = null;
    this.core.releaseAll();
    this.awaitingFirstPress = false;
    this.followUpDown = false;
  }

  get isAttached(): boolean {
    return this.attached;
  }
  get isActive(): boolean {
    return this.core.isActive;
  }
  /** True while the pointer is locked to the element given to the constructor. */
  get pointerLocked(): boolean {
    return this.doc.pointerLockElement === this.element;
  }

  /** false: all held keys/buttons and pending edges are dropped and events are ignored. */
  setActive(active: boolean): void {
    this.core.setActive(active);
    if (!active) this.followUpDown = false;
  }

  /** Keys/buttons physically held right now are ignored until released (call on sortie start / resume). */
  requireRelease(): void {
    this.core.requireRelease();
    this.followUpDown = false;
  }

  /**
   * Once per frame while playing, BEFORE `sim.advance()`: copies the held state and the pending edges into
   * `sim.input` and feeds the accumulated mouse movement to `sim.applyLook` (CAMERA.mouseSensitivity rad per
   * CSS px; mouse right turns right = negative yaw, mouse up looks up = positive pitch). Does not allocate.
   *
   * A frame does not always run a simulation tick (displays faster than 120 Hz). Whether the frame since the
   * previous call did is read from `sim.time`; a click or a brake tap that was handed over but not simulated
   * yet stays in force (see InputCore.flush). Edge flags stay in `sim.input` until a tick consumes them.
   */
  apply(sim: Sim): void {
    const core = this.core;
    const now = sim.time;
    // (a simulation object without a clock — unit tests — counts as "advanced": the latch lasts one call)
    const simAdvanced = !(typeof now === 'number' && now === this.appliedAt);
    this.appliedAt = typeof now === 'number' ? now : null;
    if (this.followUpDown) this.judgeFollowUp(now);
    core.flush(sim.input, simAdvanced);
    const dx = core.pendingLookX;
    const dy = core.pendingLookY;
    if (dx !== 0 || dy !== 0) {
      core.clearLook();
      sim.applyLook(-dx * CAMERA.mouseSensitivity, -dy * CAMERA.mouseSensitivity);
    }
  }

  /**
   * The follow-up press of a double click on a start / resume button is still down: once it has been down
   * for FOLLOW_UP_HOLD_SECONDS of game time it is a trigger pull after all and starts to count as held.
   * Game time (not wall-clock time), so the rule is the same at any frame rate.
   */
  private judgeFollowUp(now: number): void {
    const core = this.core;
    if (!core.isActive || !core.isPhysicallyDown(MOUSE_FIRE) || core.isBlocked(MOUSE_FIRE)) {
      this.followUpDown = false;
    } else if (this.followUpSince === null || now < this.followUpSince) {
      this.followUpSince = now;
    } else if (now - this.followUpSince >= FOLLOW_UP_HOLD_SECONDS - 1e-9) {
      this.followUpDown = false;
      core.accept(MOUSE_FIRE);
    }
  }

  /** Requests the pointer lock for the canvas (call from a user gesture). See requestPointerLock(). */
  requestPointerLock(timeoutMs?: number): Promise<void> {
    return requestPointerLock(this.element, timeoutMs);
  }

  /** Releases the pointer lock if this element holds it. */
  exitPointerLock(): void {
    if (this.pointerLocked && typeof this.doc.exitPointerLock === 'function') this.doc.exitPointerLock();
  }

  // ───────── listeners (arrow functions: one stable identity per instance) ─────────
  private readonly isActiveForUnload = (): boolean => this.core.isActive;

  // Key state is derived from keydown / keyup of the key itself only. The modifier flags (ctrlKey, shiftKey)
  // and `buttons` of other events are deliberately NOT used to "repair" it: browser-generated mouse moves
  // and events injected by automation tools often carry stale flags, which would drop a held brake or trigger.

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const code = e.code;
    this.core.press(code, e.repeat);
    // Space scrolling, Ctrl+S / Ctrl+D / Ctrl+A, Tab focus changes … (Ctrl+W cannot be cancelled by a page).
    if (this.core.isActive && (GAME_CODES.has(code) || SUPPRESSED_CODES.has(code)) && e.cancelable) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const code = e.code;
    this.core.release(code);
    if (this.core.isActive && (GAME_CODES.has(code) || SUPPRESSED_CODES.has(code)) && e.cancelable) e.preventDefault();
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    const locked = this.pointerLocked;
    if (!locked && e.isTrusted) this.echo.noteFreeButton(e.clientX, e.clientY, e.timeStamp);
    if (e.button === 0) {
      // A mouse button does not auto-repeat: a mousedown always is a new physical press, so a mouseup that
      // was lost (released outside the window) must not make this press look like a duplicate.
      this.core.release(MOUSE_FIRE);
      // The first press under a new lock that continues the click series of the button which acquired the
      // lock (detail ≥ 2: the second click of a double click on "出撃" / "再開" / "再出撃") is not a shot. It is
      // tracked as physically down and only becomes the trigger if it stays down (see judgeFollowUp).
      const followUp = locked && this.awaitingFirstPress && e.detail >= 2;
      if (locked) this.awaitingFirstPress = false;
      this.core.press(MOUSE_FIRE, false, (locked || !this.mouseRequiresLock) && !followUp);
      this.followUpDown = followUp && this.core.isActive;
      this.followUpSince = null;
    }
    if (this.core.isActive && locked && e.cancelable) e.preventDefault();
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (!this.pointerLocked && e.isTrusted) this.echo.noteFreeButton(e.clientX, e.clientY, e.timeStamp);
    if (e.button === 0) {
      this.core.release(MOUSE_FIRE);
      this.followUpDown = false;
    }
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    const core = this.core;
    const locked = this.pointerLocked;
    const mx = e.movementX;
    const my = e.movementY;
    if (!Number.isFinite(mx) || !Number.isFinite(my) || (mx === 0 && my === 0)) return;
    // (moves without movement were skipped above: once the browser has re-centred the pointer for the lock
    //  they report (0, 0) for a moment before the lock itself is reported)
    if (!locked && e.isTrusted) this.echo.noteFreeMove(e.clientX, e.clientY, mx, my, e.timeStamp);
    if (this.mouseRequiresLock && !locked) return;
    const active = core.isActive;
    if (locked && e.isTrusted) {
      // Repairs the movement of an emulated pointer lock; a real lock passes through unchanged. It sees
      // every locked move (also while inactive) so that its picture of the injected pointer stays right.
      this.echo.process(mx, my, e.timeStamp, active);
      if (active) core.addLook(this.echo.dx, this.echo.dy);
    } else if (active) {
      core.addLook(mx, my);
    }
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.core.isActive && e.cancelable) e.preventDefault();
  };

  private readonly onBlur = (): void => {
    this.core.releaseAll();
  };

  private readonly onVisibility = (): void => {
    if (this.doc.visibilityState === 'hidden') this.core.releaseAll();
  };

  private readonly onLockChange = (e: Event): void => {
    if (this.pointerLocked) this.echo.lockAcquired(e.timeStamp);
    else this.echo.lockLost();
    // (a button press cannot be the follow-up of a click that acquired a lock which no longer exists)
    this.awaitingFirstPress = this.pointerLocked;
    if (!this.pointerLocked) this.followUpDown = false;
    if (this.pointerLocked || !this.mouseRequiresLock) return;
    // Without the lock neither the fire button nor mouse movement may reach the game.
    this.core.clearLook();
    // A button that is still down stays ignored until it was released and pressed again.
    if (this.core.isHeld(MOUSE_FIRE)) this.core.requireReleaseOf(MOUSE_FIRE);
  };
}
