/**
 * Player weapons: switching, fire timing, ammo / EN accounting and shot records
 * (docs/SPEC.md §3, §4.1, §4.2, §6, §10; docs/ARCHITECTURE.md §4 "weapons.ts").
 *
 * Timing
 *   `processPlayerFire` runs at the END of a sub-step, i.e. at the current sim.time, after the mech, the
 *   enemies, the camera and the lock have been brought to that same instant. While the trigger is held the
 *   selected weapon fires as soon as `sim.time >= nextFireAt[weapon]`; `weaponsNextEventTime` makes the
 *   scheduler end a sub-step exactly at that time, so the interval between consecutive shots is exactly the
 *   weapon's interval (not "the next tick after it"). `nextFireAt` is kept per weapon and is only ever
 *   written by a shot that really happened: switching weapons, releasing the trigger or a refused shot never
 *   touch it.
 *
 * One shot
 *   re-validate the lock against the current state → fire-control solution from the same-time muzzle /
 *   target centre / actual target velocity (`computeFireSolution`), or the free-fire aim when there is no
 *   complete lock → spawn the bullet / missile or cast the beam along exactly that direction from the muzzle
 *   → pay ammo / EN → append a ShotRecord → emit events. The HUD markers, the gun model (sim.aim) and the
 *   projectile therefore all come from the same computation.
 *
 * Player projectiles never inherit the mech velocity: a bullet leaves with 100 m/s × launchDir and a missile
 * with 45 m/s × launchDir in the world frame, whatever the mech is doing (§4.1).
 *
 * A refused shot (missile without a complete lock, beam below 8 EN, empty magazine) consumes nothing, leaves
 * every timer alone, records nothing and only emits a (throttled) 'fire-rejected' event.
 */
import { RECENT_SHOTS_MAX, TICK, TIME_EPS, WEAPONS, WEAPON_ORDER } from '../config';
import { clone, v3, type V3 } from '../core/vec';
import { computeFireSolution, computeFreeAim, inactiveSolution, lockCompletionTime, revalidateLock } from './fcs';
import { castBeam, spawnMachinegunBullet, spawnMissile } from './projectiles';
import type { Sim } from './sim';
import type { FireRejectReason, FireSolution, PlayerState, Weapon } from './types';

const MG = WEAPONS.machinegun;
const BEAM = WEAPONS.beam;
const MISSILE = WEAPONS.missile;

/**
 * Minimum time between two identical 'fire-rejected' events while the trigger stays held (seconds).
 * Feedback cadence only — it has no influence on when a weapon may fire.
 */
export const FIRE_REJECT_EVENT_INTERVAL = 0.5;

/** Module-private per-sortie state (a new PlayerState is created on every reset). */
interface WeaponsPrivate {
  rejectWeapon: Weapon | null;
  rejectReason: FireRejectReason | null;
  rejectAt: number;
}
const PRIVATE = new WeakMap<PlayerState, WeaponsPrivate>();
function privateOf(p: PlayerState): WeaponsPrivate {
  let s = PRIVATE.get(p);
  if (!s) {
    s = { rejectWeapon: null, rejectReason: null, rejectAt: 0 };
    PRIVATE.set(p, s);
  }
  return s;
}

const sFreePoint = v3();
const sFreeDir = v3();

function isWeapon(w: unknown): w is Weapon {
  return typeof w === 'string' && (WEAPON_ORDER as readonly string[]).includes(w);
}

/** Consumes input.weaponSelect (edge). Never resets ammo, EN, nextFireAt or the FCS lock. */
export function applyWeaponSwitch(sim: Sim): void {
  const sel = sim.input.weaponSelect;
  sim.input.weaponSelect = null;
  if (sim.status !== 'playing' || !isWeapon(sel)) return;
  const p = sim.player;
  if (sel === p.weapon) return;
  p.weapon = sel;
  sim.emit({ type: 'weapon-switched', weapon: sel });
}

/**
 * True when a sub-step has to end at time `t`: it is strictly in the future and does not coincide with the
 * end of the running tick. The tick end is a sub-step boundary anyway, and everything that is due within
 * the time tolerance is handled there — cutting a second sub-step one rounding error before it would only
 * produce a degenerate step.
 */
function needsOwnSubstep(sim: Sim, t: number): boolean {
  if (!(t > sim.time + TIME_EPS) || !Number.isFinite(t)) return false;
  const tickEnd = (sim.tickIndex + 1) * TICK;
  return Math.abs(t - tickEnd) > 0.5 * TIME_EPS;
}

/**
 * Strictly-future time of the next scheduled shot while the trigger is held
 * (player.nextFireAt[weapon] when it is later than sim.time), otherwise Infinity.
 *
 * A weapon switch that is still pending as an input edge is taken into account (the shot that becomes due
 * belongs to the weapon selected by then). The completion time of a running lock acquisition is reported
 * as well, so that the lock completes — and a held missile trigger fires — exactly `lockSeconds` after the
 * acquisition began. Times that coincide with the end of the running tick are not reported (see
 * needsOwnSubstep): the tick boundary already is the event.
 */
export function weaponsNextEventTime(sim: Sim): number {
  let best = Infinity;
  const lockAt = lockCompletionTime(sim);
  if (needsOwnSubstep(sim, lockAt)) best = lockAt;
  if (sim.input.fire) {
    const sel = sim.input.weaponSelect;
    const w = isWeapon(sel) ? sel : sim.player.weapon;
    const t = sim.player.nextFireAt[w];
    if (t < best && needsOwnSubstep(sim, t)) best = t;
  }
  return best;
}

/**
 * EN the beam will need at time `t1` (end of the sub-step about to be simulated) if a beam shot is due
 * then and affordable now; 0 otherwise. The flight thrust of that sub-step may only use en - reserve
 * (EN priority: QB → beam → flight).
 */
export function beamEnReserve(sim: Sim, t1: number): number {
  const p = sim.player;
  if (!sim.input.fire || p.weapon !== 'beam') return 0;
  if (!(p.nextFireAt.beam <= t1 + TIME_EPS)) return 0;
  return p.en >= BEAM.enCost ? BEAM.enCost : 0;
}

/** Emits 'fire-rejected' at most once per FIRE_REJECT_EVENT_INTERVAL for the same weapon and reason. */
function reject(sim: Sim, weapon: Weapon, reason: FireRejectReason): void {
  const st = privateOf(sim.player);
  if (
    st.rejectWeapon === weapon &&
    st.rejectReason === reason &&
    sim.time < st.rejectAt + FIRE_REJECT_EVENT_INTERVAL - TIME_EPS
  ) {
    return;
  }
  st.rejectWeapon = weapon;
  st.rejectReason = reason;
  st.rejectAt = sim.time;
  sim.emit({ type: 'fire-rejected', weapon, reason });
}

function clearReject(p: PlayerState): void {
  const st = PRIVATE.get(p);
  if (st) {
    st.rejectWeapon = null;
    st.rejectReason = null;
  }
}

/**
 * Solution and launch direction of the shot being fired now. With a complete, still valid lock this is the
 * FCS solution ('solved', or 'no_solution' = direct aim at the current centre); otherwise the free-fire
 * direction towards the camera-centre aim point with an 'inactive' solution. `outDir` receives a unit vector.
 */
function aimForShot(sim: Sim, weapon: Weapon, locked: boolean, outDir: V3): FireSolution {
  if (locked) {
    const sol = computeFireSolution(sim, weapon);
    if (sol.status !== 'inactive' && sol.launchDir) {
      outDir.x = sol.launchDir.x;
      outDir.y = sol.launchDir.y;
      outDir.z = sol.launchDir.z;
      return sol;
    }
  }
  computeFreeAim(sim, sFreePoint, sFreeDir);
  outDir.x = sFreeDir.x;
  outDir.y = sFreeDir.y;
  outDir.z = sFreeDir.z;
  return inactiveSolution(weapon);
}

/** Appends the record of a shot that really happened (copies only) and keeps the newest RECENT_SHOTS_MAX. */
function recordShot(
  sim: Sim,
  weapon: Weapon,
  sol: FireSolution,
  muzzle: V3,
  dir: V3,
  initialVelocity: V3 | null,
  gravity: number,
): void {
  const locked = sol.status !== 'inactive';
  const solved = sol.status === 'solved';
  sim.shots.push({
    id: sim.nextShotId++,
    firedAt: sim.time,
    weapon,
    targetId: locked ? sol.targetId : null,
    solutionStatus: sol.status,
    muzzle: clone(muzzle),
    targetPosAtFire: locked && sol.targetPos ? clone(sol.targetPos) : null,
    targetVelAtFire: locked && sol.targetVel ? clone(sol.targetVel) : null,
    launchDir: clone(dir),
    initialVelocity: initialVelocity ? clone(initialVelocity) : null,
    accelerationAtFire: v3(0, gravity > 0 ? -gravity : 0, 0),
    flightSeconds: solved ? sol.flightSeconds : null,
    intercept: solved && sol.intercept ? clone(sol.intercept) : null,
  });
  const extra = sim.shots.length - RECENT_SHOTS_MAX;
  if (extra > 0) sim.shots.splice(0, extra);
}

const sDir = v3();

function fireMachinegun(sim: Sim, p: PlayerState, locked: boolean): void {
  if (!(p.ammo.machinegun >= 1)) {
    reject(sim, 'machinegun', 'no-ammo');
    return;
  }
  const sol = aimForShot(sim, 'machinegun', locked, sDir);
  // World-frame muzzle velocity: exactly speed × launch direction. The mech velocity is neither added to
  // the bullet nor subtracted in the aim computation.
  const proj = spawnMachinegunBullet(sim, p.muzzle, v3(sDir.x * MG.speed, sDir.y * MG.speed, sDir.z * MG.speed));
  if (!proj.alive) return; // non-finite launch state: no shot happened, nothing is consumed

  p.ammo.machinegun -= 1;
  p.nextFireAt.machinegun = sim.time + MG.interval;
  sim.fireControl = sol;
  recordShot(sim, 'machinegun', sol, proj.origin, sDir, proj.v0, MG.gravity);
  sim.emit({
    type: 'player-shot',
    weapon: 'machinegun',
    muzzle: clone(proj.origin),
    dir: clone(sDir),
    projectileId: proj.id,
    locked: sol.status !== 'inactive',
  });
  clearReject(p);
}

function fireBeam(sim: Sim, p: PlayerState, locked: boolean): void {
  if (!(p.en >= BEAM.enCost)) {
    reject(sim, 'beam', 'no-en');
    return;
  }
  const sol = aimForShot(sim, 'beam', locked, sDir);
  const muzzle = clone(p.muzzle);
  const res = castBeam(sim, muzzle, sDir);

  // The cost is paid at the instant of the shot; this is an actual EN expenditure (regen delay restarts).
  p.en = Math.max(0, p.en - BEAM.enCost);
  p.lastEnSpentAt = sim.time;
  p.nextFireAt.beam = sim.time + BEAM.interval;
  sim.fireControl = sol;
  recordShot(sim, 'beam', sol, muzzle, sDir, null, 0);
  sim.emit({
    type: 'player-shot',
    weapon: 'beam',
    muzzle: clone(muzzle),
    dir: clone(sDir),
    projectileId: null,
    locked: sol.status !== 'inactive',
  });
  sim.emit({
    type: 'beam',
    from: clone(muzzle),
    to: clone(res.end),
    hit: res.enemy ? 'enemy' : res.hitWorld ? 'world' : 'none',
    enemyId: res.enemy ? res.enemy.id : null,
  });
  // Exactly one damage application per shot: the first real hit on the ray within the beam range.
  if (res.enemy) {
    sim.damageEnemy(res.enemy, BEAM.damage, res.end);
    // A target destroyed by this very shot loses its lock (and its solution) at once.
    if (!res.enemy.alive && !revalidateLock(sim) && sim.lock.targetId == null) {
      sim.fireControl = inactiveSolution('beam');
    }
  }
  clearReject(p);
}

function fireMissile(sim: Sim, p: PlayerState, locked: boolean): void {
  if (!(p.ammo.missile >= 1)) {
    reject(sim, 'missile', 'no-ammo');
    return;
  }
  // No lock, lock still acquiring, or target no longer valid: nothing is spawned, nothing is consumed.
  if (!locked) {
    reject(sim, 'missile', 'no-lock');
    return;
  }
  const sol = computeFireSolution(sim, 'missile');
  if (sol.status === 'inactive' || !sol.launchDir || sol.targetId == null) {
    reject(sim, 'missile', 'no-lock');
    return;
  }
  // 'no_solution' still fires (straight at the current position): only lock and ammo gate the launch.
  const proj = spawnMissile(sim, p.muzzle, sol.launchDir, sol.targetId);
  if (!proj.alive) return;

  p.ammo.missile -= 1;
  p.nextFireAt.missile = sim.time + MISSILE.interval;
  sim.fireControl = sol;
  recordShot(sim, 'missile', sol, proj.origin, sol.launchDir, proj.v0, 0);
  sim.emit({
    type: 'player-shot',
    weapon: 'missile',
    muzzle: clone(proj.origin),
    dir: clone(sol.launchDir),
    projectileId: proj.id,
    locked: true,
  });
  clearReject(p);
}

/**
 * Fires the selected weapon at the current sim.time when the trigger is held and the weapon is ready:
 * re-validates the lock, computes the solution from the same-time state, spawns the projectile / casts
 * the beam, pays ammo / EN, records the shot, emits events (or a 'fire-rejected' event).
 */
export function processPlayerFire(sim: Sim): void {
  if (sim.status !== 'playing') return;
  const p = sim.player;
  if (!sim.input.fire) {
    // Trigger released: the next press reports a refusal immediately again.
    clearReject(p);
    return;
  }
  const weapon = p.weapon;
  // Still inside the weapon's own interval (kept across weapon switches): simply not ready yet.
  if (sim.time < p.nextFireAt[weapon] - TIME_EPS) return;

  // The lock conditions are checked against the state of this very instant; an invalid target is dropped
  // here and none of its numbers are used below.
  const locked = revalidateLock(sim);
  // A target that just failed the check takes its solution with it (no stale numbers, even for a moment).
  if (!locked && sim.fireControl.status !== 'inactive') sim.fireControl = inactiveSolution(weapon);
  if (weapon === 'machinegun') fireMachinegun(sim, p, locked);
  else if (weapon === 'beam') fireBeam(sim, p, locked);
  else fireMissile(sim, p, locked);
}
