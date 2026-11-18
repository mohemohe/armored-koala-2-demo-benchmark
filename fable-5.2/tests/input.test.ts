/**
 * Input layer (src/input/input.ts) and the controls help text (src/ui/help.ts) — pure logic only.
 *
 * InputCore is tested directly; InputManager is tested against a minimal fake window / document /
 * element (plain listener maps), which is enough to exercise listener registration, pointer-lock gating
 * and the hand-over to the simulation without a browser.
 */
import { describe, expect, it } from 'vitest';
import { CAMERA, CONTROLS_REQUIRED, PLAYER, WEAPONS } from '../src/config';
import { Rng } from '../src/core/rng';
import { InputCore, InputManager, MOUSE_FIRE, RecenterEchoFilter } from '../src/input/input';
import { Sim as RealSim, type Sim } from '../src/sim/sim';
import type { InputState } from '../src/sim/types';
import { makeTestStage } from '../src/stage/testStages';
import { audioStatusText, controlsHelpHtml } from '../src/ui/help';
// (source text of the HUD: the help quotes its marker labels, see the controlsHelpHtml tests)
import hudSource from '../src/ui/hud.ts?raw';
// (source text of the app: the help describes how it treats the M key)
import appSource from '../src/app.ts?raw';

function blankInput(): InputState {
  return { moveX: 0, moveZ: 0, jump: false, brake: false, fire: false, qbPressed: false, glideTogglePressed: false, jumpPressed: false, weaponSelect: null };
}

/** What the simulation does at the start of its next sub-step: read and clear the edges. */
function consumeEdges(input: InputState): { qb: boolean; glide: boolean; jump: boolean; weapon: string | null } {
  const out = { qb: input.qbPressed, glide: input.glideTogglePressed, jump: input.jumpPressed, weapon: input.weaponSelect };
  input.qbPressed = false;
  input.glideTogglePressed = false;
  input.jumpPressed = false;
  input.weaponSelect = null;
  return out;
}

describe('InputCore', () => {
  it('ignores everything while inactive', () => {
    const core = new InputCore();
    const input = blankInput();
    core.press('KeyW');
    core.press('KeyQ');
    core.press(MOUSE_FIRE);
    core.addLook(10, 10);
    core.flush(input);
    expect(input).toEqual(blankInput());
    expect(core.pendingLookX).toBe(0);
  });

  it('mirrors held level keys and normalises opposite keys', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    core.press('KeyW');
    core.press('KeyD');
    core.press('Space');
    core.press('ControlLeft');
    core.press(MOUSE_FIRE);
    core.flush(input);
    expect([input.moveX, input.moveZ, input.jump, input.brake, input.fire]).toEqual([1, 1, true, true, true]);
    core.press('KeyS');
    core.press('KeyA');
    core.flush(input);
    expect([input.moveX, input.moveZ]).toEqual([0, 0]);
    core.release('KeyW');
    core.release('KeyD');
    core.release('ControlLeft');
    core.release(MOUSE_FIRE);
    core.flush(input);
    expect([input.moveX, input.moveZ, input.brake, input.fire, input.jump]).toEqual([-1, -1, false, false, true]);
  });

  it('Right Ctrl is not the brake; either Shift toggles the glide', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    core.press('ControlRight');
    core.flush(input);
    expect(input.brake).toBe(false);
    core.press('ShiftRight');
    core.flush(input);
    expect(consumeEdges(input).glide).toBe(true);
    core.release('ShiftRight');
    core.press('ShiftLeft');
    core.flush(input);
    expect(consumeEdges(input).glide).toBe(true);
  });

  it('produces exactly one QB edge for a key held for 5 seconds with OS auto-repeat', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    let qb = 0;
    core.press('KeyQ', false);
    for (let frame = 0; frame < 300; frame++) {
      // auto-repeat: with the repeat flag, and (on platforms that do not set it) without
      core.press('KeyQ', frame % 2 === 0);
      core.flush(input);
      if (consumeEdges(input).qb) qb++;
    }
    expect(qb).toBe(1);
    core.release('KeyQ');
    core.press('KeyQ');
    core.flush(input);
    expect(consumeEdges(input).qb).toBe(true);
  });

  it('delivers each edge once and keeps an edge the simulation has not consumed yet', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    core.press('KeyQ');
    core.press('ShiftLeft');
    core.press('Space');
    core.press('Digit2');
    core.press('Digit3');
    core.flush(input);
    expect([input.qbPressed, input.glideTogglePressed, input.jumpPressed, input.weaponSelect]).toEqual([true, true, true, 'missile']);
    // no tick ran: the flags are still set and a second flush must not clear or duplicate them
    core.flush(input);
    expect([input.qbPressed, input.glideTogglePressed, input.jumpPressed, input.weaponSelect]).toEqual([true, true, true, 'missile']);
    consumeEdges(input);
    core.flush(input);
    expect([input.qbPressed, input.glideTogglePressed, input.jumpPressed, input.weaponSelect]).toEqual([false, false, false, null]);
  });

  it('maps 1 / 2 / 3 to the three weapons', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    const seen: Array<string | null> = [];
    for (const code of ['Digit1', 'Digit2', 'Digit3']) {
      core.press(code);
      core.flush(input);
      seen.push(consumeEdges(input).weapon);
      core.release(code);
    }
    expect(seen).toEqual(['machinegun', 'beam', 'missile']);
  });

  it('a tap of Space shorter than a frame still yields the jump edge; a short click still fires once', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    core.press('Space');
    core.release('Space');
    core.press(MOUSE_FIRE);
    core.release(MOUSE_FIRE);
    core.flush(input);
    expect(input.jumpPressed).toBe(true);
    expect(input.jump).toBe(false);
    expect(input.fire).toBe(true);
    consumeEdges(input);
    core.flush(input);
    expect(input.fire).toBe(false);
    expect(input.jumpPressed).toBe(false);
  });

  it('setActive(false) drops held keys, pending edges and mouse movement', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    core.press('KeyW');
    core.press('KeyQ');
    core.press(MOUSE_FIRE);
    core.addLook(30, -12);
    core.setActive(false);
    core.flush(input);
    expect(input).toEqual(blankInput());
    expect([core.pendingLookX, core.pendingLookY]).toEqual([0, 0]);
  });

  it('a key held across pause and resume does not count until it was released (Q, W, fire)', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    core.press('KeyQ');
    core.press('KeyW');
    core.press(MOUSE_FIRE);
    core.flush(input);
    consumeEdges(input);
    // pause: keys stay physically down
    core.setActive(false);
    core.press('KeyQ', true);
    // resume
    core.setActive(true);
    core.requireRelease();
    for (let i = 0; i < 20; i++) core.press('KeyQ', true); // auto-repeat continues after the resume
    core.press('KeyW', true);
    core.flush(input);
    expect(input).toEqual(blankInput());
    expect(core.isBlocked('KeyQ')).toBe(true);
    // release, then a fresh press counts
    core.release('KeyQ');
    core.release('KeyW');
    core.release(MOUSE_FIRE);
    core.press('KeyQ');
    core.press('KeyW');
    core.press(MOUSE_FIRE);
    core.flush(input);
    expect([input.qbPressed, input.moveZ, input.fire]).toEqual([true, 1, true]);
  });

  it('requireRelease() blocks keys that were pressed while active (restart without a pause)', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    core.press('Space');
    core.press('KeyQ');
    core.requireRelease();
    core.flush(input);
    expect(input).toEqual(blankInput());
    core.press('Space', true);
    core.flush(input);
    expect(input.jump).toBe(false);
    core.release('Space');
    core.press('Space');
    core.flush(input);
    expect([input.jump, input.jumpPressed]).toEqual([true, true]);
  });

  it('a repeat keydown for a key never seen going down is blocked until its keyup (held since before focus)', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    core.releaseAll(); // window blur: physical state unknown
    core.press('KeyQ', true);
    core.press('KeyD', true);
    core.flush(input);
    expect(input).toEqual(blankInput());
    core.press('KeyQ', false); // some platforms: repeats without the flag
    core.flush(input);
    expect(input.qbPressed).toBe(false);
    core.release('KeyQ');
    core.press('KeyQ', false);
    core.flush(input);
    expect(input.qbPressed).toBe(true);
  });

  it('releaseAll() (blur) clears held keys; a genuinely new press afterwards counts', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    core.press('KeyW');
    core.press(MOUSE_FIRE);
    core.releaseAll();
    core.flush(input);
    expect(input).toEqual(blankInput());
    core.press('KeyW', false); // keyup was lost while unfocused; this is a real new press
    core.flush(input);
    expect(input.moveZ).toBe(1);
  });

  it('an ineligible press (mouse button without pointer lock) is tracked physically but never fires', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    core.press(MOUSE_FIRE, false, false);
    core.flush(input);
    expect(input.fire).toBe(false);
    expect(core.isPhysicallyDown(MOUSE_FIRE)).toBe(true);
    // lock acquired while the button is still down: a second mousedown cannot happen, nothing fires
    core.flush(input);
    expect(input.fire).toBe(false);
    core.release(MOUSE_FIRE);
    core.press(MOUSE_FIRE, false, true);
    core.flush(input);
    expect(input.fire).toBe(true);
  });

  it('rejects non-finite and absurd mouse deltas', () => {
    const core = new InputCore();
    core.setActive(true);
    core.addLook(Number.NaN, 1);
    core.addLook(1, Number.POSITIVE_INFINITY);
    core.addLook(50000, 0);
    expect([core.pendingLookX, core.pendingLookY]).toEqual([0, 0]);
    core.addLook(3, -4);
    core.addLook(2, 1);
    expect([core.pendingLookX, core.pendingLookY]).toEqual([5, -3]);
  });
});

describe('RecenterEchoFilter (emulated pointer lock: headless browsers / injected input)', () => {
  /** Feeds movements (all at time `t`) and returns the total movement that would be applied. */
  const feed = (f: RecenterEchoFilter, moves: Array<[number, number]>, t = 5000, applied = true): [number, number] => {
    let x = 0;
    let y = 0;
    for (const [mx, my] of moves) {
      f.process(mx, my, t, applied);
      x += f.dx;
      y += f.dy;
    }
    return [x, y];
  };
  /** A filter after a click at (x, y) at t = 1000 ms that acquired the lock at t = 1005 ms. */
  const clicked = (x: number, y: number): RecenterEchoFilter => {
    const f = new RecenterEchoFilter();
    f.noteFreeMove(x, y, 10, 10, 990);
    f.noteFreeButton(x, y, 1000);
    f.noteFreeButton(x, y, 1000);
    f.lockAcquired(1005);
    return f;
  };

  it('drops the echo of the click that acquired the lock (seen while locked)', () => {
    const f = clicked(715, 658); // the 出撃 button
    expect(feed(f, [[-715, -658]], 1012)).toEqual([0, 0]);
    expect(f.emulated).toBe(false); // a candidate only
    // fire: the lone echoes of button down / up at the same injected position
    expect(feed(f, [[-715, -658], [-715, -658]])).toEqual([0, 0]);
    expect(f.emulated).toBe(true);
  });

  it('recognises the echo of the lock click when it arrives just before the lock is reported', () => {
    const f = new RecenterEchoFilter();
    f.noteFreeMove(640, 432, 340, 132, 990);
    f.noteFreeButton(640, 432, 1000);
    f.noteFreeButton(640, 432, 1000);
    f.noteFreeMove(0, 0, -640, -432, 1010); // the echo: the free pointer "jumps" to (0, 0)
    f.lockAcquired(1015);
    // the remembered position is still the click position: fire → lone echoes dropped
    expect(feed(f, [[-640, -432], [-640, -432]])).toEqual([0, 0]);
    expect(f.emulated).toBe(true);
  });

  it('lock acquired from the keyboard: the echo negates the last pointer position', () => {
    // echo delivered as a locked move before the lock is reported
    let f = new RecenterEchoFilter();
    f.noteFreeMove(500, 300, 500, 300, 700);
    f.process(-500, -300, 1442, false);
    expect([f.dx, f.dy]).toEqual([0, 0]);
    f.lockAcquired(1442);
    expect(feed(f, [[-500, -300], [-500, -300]])).toEqual([0, 0]); // fire
    expect(f.emulated).toBe(true);
    // echo delivered as a free move to (0, 0) before the lock is reported
    f = new RecenterEchoFilter();
    f.noteFreeMove(500, 300, 500, 300, 700);
    f.noteFreeMove(0, 0, -500, -300, 1440);
    f.lockAcquired(1900); // reported late by a busy main thread
    expect(feed(f, [[-500, -300], [-500, -300]])).toEqual([0, 0]);
    expect(f.emulated).toBe(true);
    // a free move into the corner that is NOT followed by a lock means nothing
    f = new RecenterEchoFilter();
    f.noteFreeMove(500, 300, 500, 300, 700);
    f.noteFreeMove(0, 0, -500, -300, 1440);
    f.noteFreeMove(640, 432, 640, 432, 9000);
    f.noteFreeButton(640, 432, 9100);
    f.lockAcquired(9110);
    expect(feed(f, [[-500, -300], [300, 0], [-300, 0]], 12000)).toEqual([-500, -300]);
    expect(f.emulated).toBe(false);
  });

  it('turns "jump to Q + echo" into the relative movement Q − previous position', () => {
    const f = clicked(640, 432);
    expect(feed(f, [[-640, -432]], 1012)).toEqual([0, 0]); // lock echo → candidate
    // injected move to (600, 400): the pair as a whole is a movement of (−40, −32)
    expect(feed(f, [[600, 400], [-600, -400]])).toEqual([-40, -32]);
    expect(f.emulated).toBe(true);
    // button down / up at the same position: lone echoes
    expect(feed(f, [[-600, -400], [-600, -400]])).toEqual([0, 0]);
    // from now on every move is converted directly, also in several steps
    f.process(650, 350, 6000);
    expect([f.dx, f.dy]).toEqual([50, -50]);
    f.process(-650, -350, 6001);
    expect([f.dx, f.dy]).toEqual([0, 0]);
    expect(feed(f, [[700, 300], [-700, -300], [740, 340], [-740, -340]])).toEqual([90, -10]);
    expect(feed(f, [[-740, -340], [-740, -340]])).toEqual([0, 0]); // fire again
    // an injected position near the origin works as well
    expect(feed(f, [[10, 5], [-10, -5]])).toEqual([-730, -335]);
  });

  it('a jump that was not applied (game inactive) is not applied later through its echo', () => {
    const f = clicked(640, 432);
    feed(f, [[-640, -432]], 1012);
    f.process(600, 400, 5000, false); // arrives while paused: discarded by the caller
    f.process(-600, -400, 5001, true);
    expect([f.dx, f.dy]).toEqual([0, 0]);
    // the position is known nevertheless: the next injected move is relative to it
    expect(feed(f, [[700, 400], [-700, -400]])).toEqual([100, 0]);
  });

  it('re-lock: the new click position is the new origin', () => {
    const f = clicked(640, 432);
    feed(f, [[-640, -432]], 1012);
    feed(f, [[900, 100], [-900, -100], [-900, -100]]);
    expect(f.emulated).toBe(true);
    f.lockLost();
    f.noteFreeButton(900, 100, 8000); // button release after the lock was lost
    f.noteFreeMove(640, 300, -260, 200, 9000); // pointer moved to the 再開 button
    f.noteFreeButton(640, 300, 9010);
    f.noteFreeButton(640, 300, 9010);
    f.noteFreeMove(0, 0, -640, -300, 9020); // echo of the click, seen just before the lock is reported
    f.lockAcquired(9025);
    expect(feed(f, [[-640, -300]], 9030)).toEqual([0, 0]);
    expect(feed(f, [[740, 300], [-740, -300]], 9500)).toEqual([100, 0]);
  });

  it('a real pointer lock: nothing is ever changed, whatever the movements are', () => {
    const f = clicked(640, 360);
    const rng = new Rng(12345);
    let inX = 0;
    let inY = 0;
    let outX = 0;
    let outY = 0;
    let t = 4000; // (inside the first 1.5 s after the click only the exact negated click position is special)
    const one = (mx: number, my: number): void => {
      if (mx === 0 && my === 0) return;
      t += 8;
      inX += mx;
      inY += my;
      f.process(mx, my, t);
      outX += f.dx;
      outY += f.dy;
    };
    // exact reversals (also repeated, also large), the exact negated click position, positions as movements
    for (const [x, y] of [[3, -2], [-3, 2], [-3, 2], [40, 0], [-40, 0], [-40, 0], [0, 150], [0, -150], [0, -150]]) one(x, y);
    for (const [x, y] of [[300, 0], [-300, 0], [-300, 0], [260, 10], [5, 0], [-260, -10], [-640, -360], [640, 360], [-640, -360], [-640, -360]]) one(x, y);
    // long random sessions: slow tracking, fast flicks with reversals, shaking
    for (let i = 0; i < 200000; i++) {
      const mode = i % 3;
      const amp = mode === 0 ? 6 : mode === 1 ? 300 : 60;
      const dir = Math.floor(i / 7) % 2 === 0 ? 1 : -1;
      one(Math.round(dir * rng.next() * amp + (rng.next() - 0.5) * 6), Math.round((rng.next() - 0.5) * amp * 0.3));
    }
    expect(f.emulated).toBe(false);
    expect([outX, outY]).toEqual([inX, inY]);
  });

  it('a real pointer lock driven by a script (exact reversals) is not mistaken for an emulation', () => {
    // relative movements as a real lock reports them: look right 300 px and back, twice, right after the click
    const f = clicked(640, 432);
    expect(feed(f, [[300, 0], [-300, 0], [300, 0], [-300, 0]], 1100)).toEqual([0, 0]);
    expect(f.emulated).toBe(false);
    f.process(300, 0, 1200);
    expect([f.dx, f.dy]).toEqual([300, 0]);
    // parking the pointer at (0, 0) right after the click loses that one move, nothing else
    f.process(-940, -432, 1300);
    expect([f.dx, f.dy]).toEqual([-940, -432]);
    const g = clicked(640, 432);
    expect(feed(g, [[-640, -432]], 1100)).toEqual([0, 0]);
    expect(feed(g, [[120, 40], [-80, 10], [150, 0], [-150, 0]], 1500)).toEqual([40, 50]);
    expect(g.emulated).toBe(false);
  });
});

// ───────────────────────── InputManager against a fake DOM ─────────────────────────
class FakeTarget {
  readonly listeners = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string, event: Record<string, unknown> = {}): { defaultPrevented: boolean } {
    const e = {
      type,
      cancelable: true,
      isTrusted: false,
      repeat: false,
      defaultPrevented: false,
      preventDefault(): void {
        e.defaultPrevented = true;
      },
      ...event,
    };
    for (const fn of Array.from(this.listeners.get(type) ?? [])) fn(e);
    return e;
  }
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

function makeEnv(): {
  win: FakeTarget;
  doc: FakeTarget & { pointerLockElement: unknown; visibilityState: string; defaultView: unknown };
  canvas: HTMLElement;
  mgr: InputManager;
  sim: Sim;
  input: InputState;
  look: { yaw: number; pitch: number };
} {
  const win = new FakeTarget();
  const doc = Object.assign(new FakeTarget(), { pointerLockElement: null as unknown, visibilityState: 'visible', defaultView: win as unknown });
  const canvas = { ownerDocument: doc } as unknown as HTMLElement;
  const input = blankInput();
  const look = { yaw: 0, pitch: 0 };
  const sim = {
    input,
    applyLook(dYaw: number, dPitch: number) {
      look.yaw += dYaw;
      look.pitch += dPitch;
    },
  } as unknown as Sim;
  const mgr = new InputManager(canvas);
  return { win, doc, canvas, mgr, sim, input, look };
}

describe('InputManager', () => {
  it('attach() is idempotent and detach() removes every listener', () => {
    const { win, doc, mgr, sim, input } = makeEnv();
    mgr.attach();
    const n = win.count() + doc.count();
    expect(n).toBeGreaterThan(0);
    mgr.attach();
    mgr.attach();
    expect(win.count() + doc.count()).toBe(n);
    // one physical press → one edge although attach() was called three times
    mgr.setActive(true);
    win.emit('keydown', { code: 'KeyQ' });
    mgr.apply(sim);
    expect(consumeEdges(input).qb).toBe(true);
    mgr.apply(sim);
    expect(consumeEdges(input).qb).toBe(false);
    mgr.detach();
    mgr.detach();
    expect(win.count() + doc.count()).toBe(0);
  });

  it('prevents the default action of game keys only while active', () => {
    const { win, mgr } = makeEnv();
    mgr.attach();
    expect(win.emit('keydown', { code: 'Space' }).defaultPrevented).toBe(false);
    win.emit('keyup', { code: 'Space' });
    mgr.setActive(true);
    expect(win.emit('keydown', { code: 'Space' }).defaultPrevented).toBe(true);
    expect(win.emit('keydown', { code: 'KeyS', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(win.emit('keydown', { code: 'KeyP' }).defaultPrevented).toBe(false);
    expect(win.emit('keydown', { code: 'F5' }).defaultPrevented).toBe(false);
    expect(win.emit('contextmenu').defaultPrevented).toBe(true);
  });

  it('counts the fire button and mouse movement only while the pointer is locked to the canvas', () => {
    const { win, doc, canvas, mgr, sim, input, look } = makeEnv();
    mgr.attach();
    mgr.setActive(true);
    // the click on "出撃" / "再開": pointer not locked yet
    win.emit('mousedown', { button: 0 });
    win.emit('mousemove', { movementX: 40, movementY: 10, buttons: 1 });
    mgr.apply(sim);
    expect(input.fire).toBe(false);
    expect(look).toEqual({ yaw: 0, pitch: 0 });
    win.emit('mouseup', { button: 0 });
    // lock acquired
    doc.pointerLockElement = canvas;
    doc.emit('pointerlockchange');
    win.emit('mousemove', { movementX: 10, movementY: -5 });
    win.emit('mousemove', { movementX: 5, movementY: -5 });
    win.emit('mousedown', { button: 2 });
    mgr.apply(sim);
    expect(input.fire).toBe(false);
    // mouse right → turn right (negative yaw); mouse up → look up (positive pitch)
    expect(look.yaw).toBeCloseTo(-15 * CAMERA.mouseSensitivity, 12);
    expect(look.pitch).toBeCloseTo(10 * CAMERA.mouseSensitivity, 12);
    win.emit('mousedown', { button: 0 });
    mgr.apply(sim);
    expect(input.fire).toBe(true);
    // lock lost (Esc): no fire, no look, until the lock is back and the button was released
    doc.pointerLockElement = null;
    doc.emit('pointerlockchange');
    win.emit('mousemove', { movementX: 99, movementY: 99 });
    mgr.apply(sim);
    expect(input.fire).toBe(false);
    expect(look.yaw).toBeCloseTo(-15 * CAMERA.mouseSensitivity, 12);
  });

  it('the mouse button held while the lock is acquired does not fire until it is released and pressed again', () => {
    const { win, doc, canvas, mgr, sim, input } = makeEnv();
    mgr.attach();
    win.emit('mousedown', { button: 0 }); // start button pressed (pointer free, game inactive)
    doc.pointerLockElement = canvas;
    doc.emit('pointerlockchange');
    mgr.setActive(true);
    mgr.requireRelease();
    mgr.apply(sim);
    expect(input.fire).toBe(false);
    win.emit('mouseup', { button: 0 });
    mgr.apply(sim);
    expect(input.fire).toBe(false);
    win.emit('mousedown', { button: 0 });
    mgr.apply(sim);
    expect(input.fire).toBe(true);
  });

  it('window blur and a hidden tab clear the held keys', () => {
    const { win, doc, mgr, sim, input } = makeEnv();
    mgr.attach();
    mgr.setActive(true);
    win.emit('keydown', { code: 'KeyW' });
    win.emit('keydown', { code: 'ControlLeft' });
    mgr.apply(sim);
    expect([input.moveZ, input.brake]).toEqual([1, true]);
    win.emit('blur');
    mgr.apply(sim);
    expect([input.moveZ, input.brake]).toEqual([0, false]);
    win.emit('keydown', { code: 'KeyA' });
    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    mgr.apply(sim);
    expect(input.moveX).toBe(0);
  });

  it('Q held through pause → resume: repeats after the resume create neither an edge nor a held state', () => {
    const { win, mgr, sim, input } = makeEnv();
    mgr.attach();
    mgr.setActive(true);
    win.emit('keydown', { code: 'KeyQ' });
    win.emit('keydown', { code: 'Space' });
    mgr.apply(sim);
    expect(consumeEdges(input)).toMatchObject({ qb: true, jump: true });
    mgr.setActive(false); // pause
    win.emit('keydown', { code: 'KeyQ', repeat: true });
    mgr.setActive(true); // resume
    mgr.requireRelease();
    let edges = 0;
    for (let i = 0; i < 60; i++) {
      win.emit('keydown', { code: 'KeyQ', repeat: true });
      win.emit('keydown', { code: 'Space', repeat: true });
      mgr.apply(sim);
      const e = consumeEdges(input);
      if (e.qb || e.jump || input.jump) edges++;
    }
    expect(edges).toBe(0);
    win.emit('keyup', { code: 'KeyQ' });
    win.emit('keydown', { code: 'KeyQ' });
    mgr.apply(sim);
    expect(consumeEdges(input).qb).toBe(true);
  });

  it('never guesses key state from the modifier flags or `buttons` of other events', () => {
    const { win, doc, canvas, mgr, sim, input } = makeEnv();
    mgr.attach();
    doc.pointerLockElement = canvas;
    mgr.setActive(true);
    // automation tools and browser-generated mouse moves often carry stale flags
    win.emit('keydown', { code: 'ControlLeft', ctrlKey: false, isTrusted: true });
    win.emit('mousedown', { button: 0, buttons: 1, isTrusted: true });
    win.emit('keydown', { code: 'KeyW', ctrlKey: false, shiftKey: false, isTrusted: true });
    win.emit('mousemove', { movementX: 0, movementY: 0, buttons: 0, ctrlKey: false, isTrusted: true });
    mgr.apply(sim);
    expect([input.brake, input.fire, input.moveZ]).toEqual([true, true, 1]);
    win.emit('keyup', { code: 'ControlLeft' });
    win.emit('mouseup', { button: 0 });
    mgr.apply(sim);
    expect([input.brake, input.fire]).toEqual([false, false]);
  });

  it('a mousedown after a lost mouseup counts as a new press', () => {
    const { win, doc, canvas, mgr, sim, input } = makeEnv();
    mgr.attach();
    doc.pointerLockElement = canvas;
    mgr.setActive(true);
    win.emit('mousedown', { button: 0 });
    mgr.apply(sim);
    expect(input.fire).toBe(true);
    mgr.setActive(false); // pause; the mouseup happens outside the window and never arrives
    mgr.setActive(true);
    mgr.requireRelease();
    mgr.apply(sim);
    expect(input.fire).toBe(false);
    win.emit('mousedown', { button: 0 });
    mgr.apply(sim);
    expect(input.fire).toBe(true);
  });

  it('emulated pointer lock: the echo of the start click and of fire clicks does not swing the view', () => {
    const { win, doc, canvas, mgr, sim, input, look } = makeEnv();
    mgr.attach();
    // click on 出撃 at (715, 658) with the pointer still free
    win.emit('mousemove', { movementX: 715, movementY: 658, clientX: 715, clientY: 658, isTrusted: true, timeStamp: 990 });
    win.emit('mousedown', { button: 0, clientX: 715, clientY: 658, isTrusted: true, timeStamp: 1000 });
    win.emit('mouseup', { button: 0, clientX: 715, clientY: 658, isTrusted: true, timeStamp: 1000 });
    // the echo of the click may arrive before the lock is reported (as a jump of the free pointer to 0, 0) …
    win.emit('mousemove', { movementX: -715, movementY: -658, clientX: 0, clientY: 0, isTrusted: true, timeStamp: 1010 });
    win.emit('mousemove', { movementX: 0, movementY: 0, clientX: 0, clientY: 0, isTrusted: true, timeStamp: 1012 });
    // … and synthetic DOM events never say where the injected pointer is
    win.emit('mousemove', { movementX: 5, movementY: 5, clientX: 0, clientY: 0, isTrusted: false, timeStamp: 1013 });
    doc.pointerLockElement = canvas;
    doc.emit('pointerlockchange', { timeStamp: 1015 });
    mgr.setActive(true);
    mgr.requireRelease();
    const echo = { movementX: -715, movementY: -658, clientX: 0, clientY: 0, isTrusted: true, timeStamp: 1020 };
    win.emit('mousemove', echo); // … or after it
    win.emit('mousedown', { button: 0, clientX: 0, clientY: 0, isTrusted: true }); // fire
    win.emit('mousemove', echo);
    mgr.apply(sim);
    expect(input.fire).toBe(true);
    expect(look).toEqual({ yaw: 0, pitch: 0 });
    win.emit('mouseup', { button: 0, clientX: 0, clientY: 0, isTrusted: true });
    win.emit('mousemove', echo);
    // scripted DOM events (aiming by a test script) always arrive untouched
    win.emit('mousemove', { movementX: 40, movementY: -20, clientX: 0, clientY: 0 });
    mgr.apply(sim);
    expect(look.yaw).toBeCloseTo(-40 * CAMERA.mouseSensitivity, 12);
    expect(look.pitch).toBeCloseTo(20 * CAMERA.mouseSensitivity, 12);
    // an injected pointer move to (815, 598) = 100 px right, 60 px up of the click position
    win.emit('mousemove', { movementX: 815, movementY: 598, clientX: 0, clientY: 0, isTrusted: true, timeStamp: 3000 });
    win.emit('mousemove', { movementX: -815, movementY: -598, clientX: 0, clientY: 0, isTrusted: true, timeStamp: 3010 });
    mgr.apply(sim);
    expect(look.yaw).toBeCloseTo(-140 * CAMERA.mouseSensitivity, 12);
    expect(look.pitch).toBeCloseTo(80 * CAMERA.mouseSensitivity, 12);
  });

  it('a real pointer lock: large trusted movements and exact reversals pass through unchanged', () => {
    const { win, doc, canvas, mgr, sim, look } = makeEnv();
    mgr.attach();
    win.emit('mousedown', { button: 0, clientX: 640, clientY: 300, isTrusted: true, timeStamp: 1000 });
    win.emit('mouseup', { button: 0, clientX: 640, clientY: 300, isTrusted: true, timeStamp: 1080 });
    doc.pointerLockElement = canvas;
    doc.emit('pointerlockchange', { timeStamp: 1090 });
    mgr.setActive(true);
    let t = 5000;
    const move = (movementX: number, movementY: number): void => {
      win.emit('mousemove', { movementX, movementY, clientX: 640, clientY: 300, isTrusted: true, timeStamp: (t += 8) });
    };
    move(600, 400);
    move(-600, -400);
    move(-600, -400);
    move(-640, -300);
    mgr.apply(sim);
    expect(look.yaw).toBeCloseTo(1240 * CAMERA.mouseSensitivity, 12);
    expect(look.pitch).toBeCloseTo(700 * CAMERA.mouseSensitivity, 12);
  });
});

// ───────────────────────── press edges versus the frame rate (real Sim, the loop of App.frame) ─────────────────────────
/**
 * The 'playing' branch of App.frame — `input.apply(sim)` then `sim.advance(frame time)` — against the real
 * simulation on an empty test stage, with the InputManager fed through the fake DOM.
 * Above 120 Hz most rendered frames run NO simulation tick (240 Hz: every second frame, 360 Hz: two of three).
 */
function makeLoop(fps: number): {
  win: FakeTarget;
  sim: RealSim;
  mgr: InputManager;
  /** Runs `n` rendered frames. */
  frames(n: number): void;
  /** Runs rendered frames for `seconds` of frame time. */
  run(seconds: number): void;
  /** A key / the left button pressed and released again before the next rendered frame. */
  tap(code: string): void;
  down(code: string): void;
  up(code: string): void;
  counts: { frames: number; emptyFrames: number; jumps: number; glideOn: number; glideOff: number; qb: number; qbRejected: number; switches: number };
} {
  const win = new FakeTarget();
  const doc = Object.assign(new FakeTarget(), { pointerLockElement: null as unknown, visibilityState: 'visible', defaultView: win as unknown });
  const canvas = { ownerDocument: doc } as unknown as HTMLElement;
  doc.pointerLockElement = canvas;
  const sim = new RealSim(makeTestStage());
  const mgr = new InputManager(canvas);
  mgr.attach();
  mgr.setActive(true);
  const counts = { frames: 0, emptyFrames: 0, jumps: 0, glideOn: 0, glideOff: 0, qb: 0, qbRejected: 0, switches: 0 };
  const dt = 1 / fps;
  const frames = (n: number): void => {
    for (let i = 0; i < n; i++) {
      mgr.apply(sim);
      const ticks = sim.advance(dt);
      counts.frames++;
      if (ticks === 0) counts.emptyFrames++;
      for (const e of sim.drainEvents()) {
        if (e.type === 'jump') counts.jumps++;
        else if (e.type === 'glide' && !e.auto) e.enabled ? counts.glideOn++ : counts.glideOff++;
        else if (e.type === 'qb') counts.qb++;
        else if (e.type === 'qb-rejected') counts.qbRejected++;
        else if (e.type === 'weapon-switched') counts.switches++;
      }
    }
  };
  const down = (code: string): void => {
    if (code === MOUSE_FIRE) win.emit('mousedown', { button: 0 });
    else win.emit('keydown', { code });
  };
  const up = (code: string): void => {
    if (code === MOUSE_FIRE) win.emit('mouseup', { button: 0 });
    else win.emit('keyup', { code });
  };
  return {
    win,
    sim,
    mgr,
    frames,
    run: (seconds) => frames(Math.round(seconds * fps)),
    tap: (code) => {
      down(code);
      up(code);
    },
    down,
    up,
    counts,
  };
}

describe('press edges survive rendered frames that run no simulation tick', () => {
  const HIGH_RATES = [240, 360, 1000];
  /** Frames run before the press: covers every phase of the frame / tick pattern. */
  const PHASES = [0, 1, 2, 3, 4, 5, 6, 7];

  it('the loop really has empty frames above 120 Hz (and none at 30 / 60 / 120 Hz)', () => {
    for (const [fps, emptyShare] of [[30, 0], [60, 0], [120, 0], [240, 0.5], [360, 2 / 3], [1000, 0.88]] as const) {
      const loop = makeLoop(fps);
      loop.run(1);
      expect(loop.counts.emptyFrames / loop.counts.frames, `${fps} Hz`).toBeCloseTo(emptyShare, 2);
      expect(loop.sim.time, `${fps} Hz`).toBeCloseTo(1, 1);
    }
  });

  it('a click shorter than one frame fires exactly one shot (240 / 360 / 1000 Hz, every phase)', () => {
    for (const fps of HIGH_RATES) {
      for (const phase of PHASES) {
        const loop = makeLoop(fps);
        loop.frames(phase);
        loop.tap(MOUSE_FIRE);
        loop.run(0.5);
        expect(loop.sim.shots.length, `${fps} Hz, phase ${phase}`).toBe(1);
        expect(loop.sim.player.ammo.machinegun, `${fps} Hz, phase ${phase}`).toBe(WEAPONS.machinegun.ammo - 1);
        expect(loop.sim.input.fire).toBe(false);
      }
    }
  });

  it('a click seen as "down" only by a frame without a tick still fires exactly one shot', () => {
    for (const fps of HIGH_RATES) {
      for (const phase of PHASES) {
        const loop = makeLoop(fps);
        loop.frames(phase);
        loop.down(MOUSE_FIRE);
        loop.frames(1); // this frame sees the button down; at most phases it runs no tick
        loop.up(MOUSE_FIRE);
        loop.run(0.5);
        expect(loop.sim.shots.length, `${fps} Hz, phase ${phase}`).toBe(1);
      }
    }
  });

  it('three separate short clicks 0.15 s apart fire three shots; the trigger is not left on', () => {
    for (const fps of HIGH_RATES) {
      const loop = makeLoop(fps);
      for (let i = 0; i < 3; i++) {
        loop.tap(MOUSE_FIRE);
        loop.run(0.15);
      }
      loop.run(0.5);
      expect(loop.sim.shots.length, `${fps} Hz`).toBe(3);
      expect(loop.sim.input.fire).toBe(false);
    }
  });

  it('a click made right after the frame that simulated the previous click is not swallowed with it', () => {
    const loop = makeLoop(30);
    loop.tap(MOUSE_FIRE);
    loop.frames(1); // click 1: delivered and simulated (4 ticks)
    expect(loop.sim.shots.length).toBe(1);
    loop.tap(MOUSE_FIRE); // click 2 arrives before the frame that ends the latch of click 1
    loop.mgr.apply(loop.sim);
    expect(loop.sim.input.fire).toBe(true); // (whether it fires is the weapon's business: 0.10 s have not passed)
    loop.sim.advance(1 / 30);
    loop.mgr.apply(loop.sim);
    expect(loop.sim.input.fire).toBe(false);
    loop.run(0.5);
    expect(loop.sim.shots.length).toBe(1);
  });

  it('a Q tap shorter than one frame is exactly one quick boost — never two, never zero', () => {
    for (const fps of HIGH_RATES) {
      for (const phase of PHASES) {
        const loop = makeLoop(fps);
        const en0 = loop.sim.player.en;
        loop.frames(phase);
        loop.tap('KeyQ');
        loop.run(0.5);
        expect(loop.sim.player.qbSuccessfulCount, `${fps} Hz, phase ${phase}`).toBe(1);
        expect(loop.counts.qb).toBe(1);
        expect(loop.counts.qbRejected).toBe(0);
        expect(loop.sim.player.en, `${fps} Hz, phase ${phase}`).toBe(en0 - PLAYER.qbCost);
      }
    }
  });

  it('Q held for 3 s with auto-repeat at 240 / 360 Hz is still exactly one quick boost', () => {
    for (const fps of [240, 360]) {
      const loop = makeLoop(fps);
      loop.down('KeyQ');
      for (let i = 0; i < 3 * 30; i++) {
        loop.win.emit('keydown', { code: 'KeyQ', repeat: i % 2 === 0 });
        loop.frames(fps / 30);
      }
      expect(loop.sim.player.qbSuccessfulCount, `${fps} Hz`).toBe(1);
      loop.up('KeyQ');
      loop.tap('KeyQ'); // released and pressed again, 3 s later: the second boost
      loop.run(0.2);
      expect(loop.sim.player.qbSuccessfulCount, `${fps} Hz`).toBe(2);
    }
  });

  it('a Space tap shorter than one frame is exactly one jump; a Shift tap exactly one glide toggle; 1/2/3 switch the weapon', () => {
    for (const fps of HIGH_RATES) {
      for (const phase of PHASES) {
        const jump = makeLoop(fps);
        jump.frames(phase);
        jump.tap('Space');
        jump.frames(Math.ceil(fps / 120) + 1);
        expect(jump.sim.player.grounded, `jump ${fps} Hz, phase ${phase}`).toBe(false);
        expect(jump.sim.player.vel.y).toBeGreaterThan(PLAYER.jumpSpeed - 1);
        jump.run(1.5);
        expect(jump.counts.jumps, `jump ${fps} Hz, phase ${phase}`).toBe(1);
        expect(jump.sim.player.grounded).toBe(true);
        expect(jump.sim.player.en).toBe(jump.sim.stats.maxEn); // a tap never becomes a flight

        const glide = makeLoop(fps);
        glide.frames(phase);
        glide.tap('ShiftLeft');
        glide.run(0.3);
        expect([glide.counts.glideOn, glide.counts.glideOff], `glide ${fps} Hz, phase ${phase}`).toEqual([1, 0]);
        expect(glide.sim.player.glideEnabled).toBe(true);
        glide.tap('ShiftRight');
        glide.run(0.3);
        expect([glide.counts.glideOn, glide.counts.glideOff], `glide ${fps} Hz, phase ${phase}`).toEqual([1, 1]);
        expect(glide.sim.player.glideEnabled).toBe(false);

        const weapon = makeLoop(fps);
        weapon.frames(phase);
        weapon.tap('Digit2');
        weapon.run(0.1);
        expect(weapon.sim.player.weapon, `weapon ${fps} Hz, phase ${phase}`).toBe('beam');
        weapon.tap('Digit3');
        weapon.run(0.1);
        expect(weapon.sim.player.weapon).toBe('missile');
        weapon.tap('Digit1');
        weapon.run(0.1);
        expect(weapon.sim.player.weapon).toBe('machinegun');
        expect(weapon.counts.switches).toBe(3);
      }
    }
  });

  it('a Left Ctrl tap shorter than one frame still switches the glide off', () => {
    for (const fps of [30, 60, 240, 360]) {
      for (const phase of PHASES) {
        const loop = makeLoop(fps);
        loop.tap('ShiftLeft');
        loop.run(1);
        expect(loop.sim.player.glideEnabled, `${fps} Hz`).toBe(true);
        loop.frames(phase);
        loop.tap('ControlLeft');
        loop.run(0.1);
        expect(loop.sim.player.glideEnabled, `${fps} Hz, phase ${phase}`).toBe(false);
        expect(loop.sim.input.brake, `${fps} Hz, phase ${phase}`).toBe(false);
        loop.run(1);
        expect(Math.hypot(loop.sim.player.vel.x, loop.sim.player.vel.z), `${fps} Hz, phase ${phase}`).toBe(0);
      }
    }
  });

  it('a held trigger fires every 0.10 s at 30 / 60 / 120 / 240 / 360 Hz and stops with the release', () => {
    for (const fps of [30, 60, 120, 240, 360]) {
      const loop = makeLoop(fps);
      loop.frames(3);
      loop.down(MOUSE_FIRE);
      loop.run(1.05);
      loop.up(MOUSE_FIRE);
      const fired = loop.sim.shots.map((s) => s.firedAt);
      expect(fired.length, `${fps} Hz`).toBe(11);
      for (let i = 1; i < fired.length; i++) expect(fired[i] - fired[i - 1], `${fps} Hz, shot ${i}`).toBeCloseTo(WEAPONS.machinegun.interval, 9);
      loop.run(0.5);
      expect(loop.sim.shots.length, `${fps} Hz`).toBe(11);
      expect(loop.sim.player.ammo.machinegun).toBe(WEAPONS.machinegun.ammo - 11);
    }
  });

  it('no double action at 30 / 60 / 120 fps: one tap is one shot, one boost, one jump, one toggle, one switch', () => {
    for (const fps of [30, 60, 120]) {
      for (const phase of [0, 1, 2]) {
        const loop = makeLoop(fps);
        const en0 = loop.sim.player.en;
        loop.frames(phase);
        loop.tap(MOUSE_FIRE);
        loop.tap('ShiftLeft');
        loop.tap('Digit2');
        loop.frames(2);
        loop.tap('KeyQ');
        loop.run(1.2);
        loop.tap('Space');
        loop.run(1.5);
        const label = `${fps} fps, phase ${phase}`;
        // (the click was made with the machine gun selected in the same frame as the switch: the switch is
        //  applied first, so the one shot is a beam shot of 8 EN)
        expect(loop.sim.shots.length, label).toBe(1);
        expect(loop.sim.player.qbSuccessfulCount, label).toBe(1);
        expect(loop.counts.jumps, label).toBe(1);
        expect([loop.counts.glideOn, loop.counts.glideOff], label).toEqual([1, 0]);
        expect(loop.counts.switches, label).toBe(1);
        expect(loop.sim.player.weapon, label).toBe('beam');
        expect(en0 - PLAYER.qbCost - WEAPONS.beam.enCost, label).toBeLessThanOrEqual(loop.sim.player.en);
      }
    }
  });

  it('a press made just before a pause is dropped with the pause, not replayed after the resume', () => {
    for (const fps of [240, 360]) {
      const loop = makeLoop(fps);
      loop.frames(fps / 120); // … the last of these ran a tick, so the next frame runs none
      loop.tap('KeyQ');
      loop.tap(MOUSE_FIRE);
      loop.tap('Space');
      const t = loop.sim.time;
      loop.frames(1); // handed to sim.input, but no tick has run with it
      expect(loop.sim.time, `${fps} Hz`).toBe(t);
      expect([loop.sim.input.qbPressed, loop.sim.input.fire, loop.sim.input.jumpPressed], `${fps} Hz`).toEqual([true, true, true]);
      // App.pause(): input off, simulation input cleared; App.enterPlaying(): input on, release required
      loop.mgr.setActive(false);
      loop.sim.clearInput();
      loop.mgr.setActive(true);
      loop.mgr.requireRelease();
      loop.run(0.5);
      expect({ qb: loop.sim.player.qbSuccessfulCount, shots: loop.sim.shots.length, jumps: loop.counts.jumps }, `${fps} Hz`).toEqual({ qb: 0, shots: 0, jumps: 0 });
    }
  });

  it('InputCore.flush(input, false) keeps a latched press; the next flush after a tick ends it', () => {
    const core = new InputCore();
    const input = blankInput();
    core.setActive(true);
    core.press(MOUSE_FIRE);
    core.release(MOUSE_FIRE);
    core.press('ControlLeft');
    core.release('ControlLeft');
    core.flush(input, true); // delivered here …
    expect([input.fire, input.brake]).toEqual([true, true]);
    core.flush(input, false); // … but no tick has run with it yet
    core.flush(input, false);
    expect([input.fire, input.brake]).toEqual([true, true]);
    core.flush(input, true); // a tick ran since the previous flush: the press has been simulated
    expect([input.fire, input.brake]).toEqual([false, false]);
    // setActive(false) / requireRelease() drop a latched press that was never simulated
    core.press(MOUSE_FIRE);
    core.release(MOUSE_FIRE);
    core.requireRelease();
    core.flush(input, false);
    expect(input.fire).toBe(false);
    core.press(MOUSE_FIRE);
    core.release(MOUSE_FIRE);
    core.requireReleaseOf(MOUSE_FIRE);
    core.flush(input, false);
    expect(input.fire).toBe(false);
  });
});

// ───────────────────────── controls help: mandatory statements (SPEC §7.1, §8) ─────────────────────────
describe('controlsHelpHtml', () => {
  const html = controlsHelpHtml();
  const text = html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ');

  it('contains the full key table of §7.1', () => {
    for (const action of ['通常移動', '視点・照準', 'ジャンプ', 'グライドの手動切り替え', 'ブレーキ', '飛行', 'QB', '射撃', '武器切り替え', '一時停止']) {
      expect(html).toContain(`<th scope="row">${action}`);
    }
    for (const key of ['W', 'A', 'S', 'D', 'Space', 'Shift', '左Ctrl', 'Q', '1', '2', '3', 'Esc']) {
      expect(html).toContain(`<kbd>${key}</kbd>`);
    }
    expect(text).toContain('マウス移動');
    expect(text).toContain('マウス左ボタン');
  });

  it('states the mandatory points with the numbers from config', () => {
    expect(PLAYER.qbCost).toBe(36);
    expect(text).toContain(`Q は単発入力で、発動時に ${PLAYER.qbCost} EN を一括消費します（長押しでは連続発動しません`);
    expect(text).toContain('QB 後は自動でグライドへ移行します');
    expect(text).toContain('グライドの EN 消費は 0 です（EN が 0 でも使用でき、接地中は EN 回復も妨げません）');
    expect(text).toContain('停止するには 左Ctrl（ブレーキ）を押すか、Shift でグライドを解除します');
    expect(text).toContain(`飛行は Space を ${PLAYER.flyHoldSeconds.toFixed(2)} 秒以上長押し（${PLAYER.flyEnPerSecond} EN/秒）`);
    expect(text).toContain('対象を FCS 領域（中央の円）内に保てばロックが進み、ロック完了後は偏差（移動予測）と重力落下を自動補正します');
    expect(text).toContain('中央照準を補正マーカーへ手動で合わせる必要はありません');
    expect(text).toContain('ミサイルはロック完了時のみ発射可能です');
    expect(text).toContain(`ビームは 1 射 ${WEAPONS.beam.enCost} EN を消費します`);
    expect(text).toContain('Esc で一時停止します');
    expect(text).toContain(`制御砲台 ${CONTROLS_REQUIRED} 基をすべて破壊すると最終搬出ゲートが開きます。その先の脱出領域に入るとクリアです`);
  });

  it('explains the M key (sound on / off) and where the state is shown', () => {
    expect(html).toContain('<th scope="row">音声の ON / OFF');
    expect(html).toContain('<kbd>M</kbd>');
    expect(text).toContain('M で効果音の ON / OFF（ミュート）を切り替えます。どの画面でも有効です');
    expect(audioStatusText(false)).toBe('音声 ON [M]');
    expect(audioStatusText(true)).toBe('音声 OFF [M]');
    expect(text).toContain(`「${audioStatusText(false)}」または「${audioStatusText(true)}」`);
    // src/app.ts ignores M while Ctrl / Alt / Meta is down (Left Ctrl is the brake): the help says so
    expect(text).toContain('左Ctrl（ブレーキ）などの修飾キーを押している間は、M は反応しません');
    expect(appSource).toContain('!e.ctrlKey && !e.metaKey && !e.altKey');
  });

  it('explains the route marker and the objective marker with the words the HUD really shows', () => {
    expect(text).toContain('「目標」マーカー（中に点のある逆三角形のピン）は、次に破壊する制御砲台の位置です');
    expect(text).toContain('「進路」マーカー（線だけの二重の山形）は、そこへ向かう推奨経路の「次に向かう地点」です');
    // the labels quoted in the help are the labels of src/ui/hud.ts (kept in step by this test)
    const hud: string = hudSource;
    for (const label of ['進路 NEXT', '飛行 FLY', '降下 DROP', '射撃位置 FIRE POS', '戻る BACK', '合流 REJOIN', '脱出 EXIT', '残り ']) {
      expect(text, label).toContain(label);
      expect(hud, label).toContain(label);
    }
    expect(hud).toContain("'目標 ' + o.id");
    expect(hud).toContain("'進路'");
    expect(text).toContain(`制御砲台 ${CONTROLS_REQUIRED} 基をすべて破壊すると「脱出 EXIT」に変わり`);
  });

  it('states the flight details: hold time, cost, a new press from the ground, a hold carried over a ledge', () => {
    const hold = PLAYER.flyHoldSeconds.toFixed(2);
    expect([PLAYER.flyHoldSeconds, PLAYER.flyEnPerSecond, PLAYER.flyClimbSpeed, PLAYER.jumpSpeed]).toEqual([0.2, 20, 8, 10]);
    expect(text).toContain(`地上で Space を押すとまずジャンプし（上向き ${PLAYER.jumpSpeed} m/s）、そのまま押し続けると ${hold} 秒後から上昇速度 ${PLAYER.flyClimbSpeed} m/s の飛行に移ります`);
    expect(text).toContain(`空中で押し直した場合も、押してから ${hold} 秒後に飛行へ移ります`);
    expect(text).toContain('地上から飛び立つには新しい押下が必要です');
    expect(text).toContain('Space を押したまま足場の端から外へ出た場合は、空中に出た時点で（押し直さなくても）飛行に移ります');
  });

  it('is a single well-formed root fragment without script or external references', () => {
    expect(html.startsWith('<div class="ak2-help">')).toBe(true);
    expect(html.endsWith('</div>')).toBe(true);
    expect(html).not.toMatch(/<script|<img|<link|https?:|url\(/i);
    expect(html).not.toMatch(/undefined|NaN|Infinity/);
  });
});
