/**
 * Route guidance ("次の進行方向", docs/SPEC.md §2.1 / §8) derived from the validated recommended route
 * `stage.route`.
 *
 * DERIVED STATE ONLY. Nothing in the simulation reads `sim.guide`; this module never touches `sim.rng`, never
 * emits events and never writes anything but `sim.guide`. It only asks the world read-only questions
 * (segmentBlocked / probeGround). A sortie with guidance switched off (`sim.guide.enabled = false`) is
 * bit-identical to one with guidance on (tests/guide.test.ts).
 *
 * How it works
 *  1. Static route data (per stage, cached): the waypoints, the leg through which each barrier / the final gate
 *     is crossed, the FIRING POSITION of each control turret (first place on the route, after the previous
 *     barrier, from which the turret has been in view of the hull, the camera pivot and the muzzle for 3 m, or
 *     the end of that first stretch when it is shorter) and the out-and-back spurs of the polyline
 *     (… A, B, A …: a short detour into a room to shoot a turret).
 *  2. Effective polyline (rebuilt only when a barrier opens): the route from the start up to the first closed
 *     barrier, with the GOAL as an explicit vertex — the firing position of that barrier's control turret, or the
 *     last waypoint (exit zone) once everything is open. Spurs that are not needed (their turret is dead, or it
 *     can already be seen from before the spur) are cut out; a spur that holds the goal turns around at the goal.
 *     Everything behind the closed barrier is absent, so neither the progress nor the hint can ever lie there.
 *  3. Progress = the leg of that polyline nearest to the player. Legs are measured "as drawn" (a climb rises at
 *     its lower end, then flies level; a drop walks level, then falls), vertical distance counts double (other
 *     storeys are other parts of the route). Every tick only the legs around the current one are examined
 *     (continuity: the progress of a player in a walled gallery beside the route follows him along). A few times
 *     per second all legs are examined, and the tracked leg is given up only for a clearly nearer leg that the
 *     player can SEE or stands on — never for one behind a wall or on another storey. Legs in a sector that is
 *     not the player's own count as farther away (stage.connections). After a jump in position there is no
 *     history: the nearest leg wins, a visible one preferred.
 *  4. Hint, evaluated while the player stands on something (in the air the hint is kept):
 *       a. the farthest of the next few vertices (<= 60 m of route) the player can head for in a straight line:
 *          level → clear at body height, clear at knee height on a track as wide as the hull, floor all the way;
 *          lower → walk level and fall, or a clear straight line; higher → rise on the spot, then fly level, and
 *          only from near the take-off of that climb;
 *       b. off the route: else the farthest point of the route ahead (8 m grid) that passes the same test;
 *       c. else the next vertex that is not reached yet (within 5 m).
 *     Past the goal (the player walked on to the closed door) the same search runs backwards and leads back to
 *     the firing position.
 *
 * Cost: a handful of point–segment distances per tick; the line-of-sight work runs every HINT_PERIOD ticks, the
 * full search every GLOBAL_PERIOD ticks. No allocation after createGuideState().
 */
import { CAMERA, FCS_RANGE, PLAYER } from '../config';
import type { V3 } from '../core/vec';
import type { Sim } from './sim';
import type { Box, StageDef } from './types';

export type RouteLegKind = 'walk' | 'climb' | 'drop';

/** What the HUD needs to show the way. One object per Sim, updated in place (do not keep copies of `position`). */
export interface RouteHint {
  /**
   * Index into `stage.route` of the waypoint the hint stands on. For a point inside a leg (a firing position, a
   * point of the route offered to a player who left it): the end of that leg in the direction of travel.
   */
  index: number;
  /** Point to head for: a standable point of the route (player hit-box centre). */
  position: V3;
  /**
   * How to get there from where the player is now: 'climb' = it is more than 1 m above the player (jump, then hold
   * Space to fly), 'drop' = it is more than 3 m below (walk off the edge), otherwise 'walk'.
   * While the player is in the air the height is judged against the span between the floor it last stood on
   * and where it is now (see `rise`): a jump or a flight above a level stretch of the route is not a "drop".
   */
  kind: RouteLegKind;
  /**
   * Height still to gain (> 0) or to lose (< 0) to reach `position`, in metres. On the ground: position.y −
   * player.pos.y. In the air: position.y − the nearest height of the span [floor last stood on … current
   * height] — 0 while the hint's height lies inside that span.
   */
  rise: number;
  /** Straight-line distance from the player's centre to `position` (m). */
  distance: number;
  /** Route metres from the player's progress to the current goal (firing position of the next control turret, or the exit). */
  remainingMeters: number;
  /** Distance (m) from the player to the nearest point of the open part of the route (large: the player left the route). */
  offRouteMeters: number;
  /** The stage's note for waypoint `index` (free text for humans) or null. */
  note: string | null;
  /**
   * Non-null when `position` IS the current goal in front of a closed barrier (the firing position of its control
   * turret, or the final gate itself): the route ends there until the barrier opens.
   */
  blockedByBarrierId: string | null;
  /** With blockedByBarrierId: the control turret to destroy (null for a final gate without a single turret). */
  controlEnemyId: string | null;
  /**
   * With blockedByBarrierId: that turret is within FCS range and in view of the player right now (free lines
   * from the hit-box centre, the camera pivot and the muzzle of a mech facing it).
   */
  controlVisible: boolean;
  /** True when the goal lies behind the player's progress (the player went past the firing position). */
  backtrack: boolean;
  /** First sector on the way to the goal that is not the player's current sector; null when there is none. */
  nextSectorId: string | null;
}

/** Per-sortie guidance state (`sim.guide`). Only the documented fields are meant for readers. */
export interface GuideState {
  /** Set to false to switch guidance off (updateGuide does nothing, getRouteHint returns null). No gameplay effect. */
  enabled: boolean;
  /** Metres along `stage.route` (measured as drawn) of the route point matched to the player. */
  progress: number;
  /** Distance (m) from the player's centre to that point. */
  offRoute: number;
  /** Number of barriers / gates on the route that were open when the effective polyline was last built. */
  phase: number;
  hint: RouteHint;
  /** True when `hint` holds a usable value. */
  hasHint: boolean;

  // ── internal ──
  route: RouteData | null;
  /** Effective polyline: vertices, per-vertex route index, raw route metres at the start of each leg, lengths. */
  ex: Float64Array;
  ey: Float64Array;
  ez: Float64Array;
  eWp: Int32Array;
  eInserted: Uint8Array;
  eRaw: Float64Array;
  eLen: Float64Array;
  eCum: Float64Array;
  eKind: Uint8Array;
  eCount: number;
  /** Vertex that is the current goal. */
  goalVertex: number;
  /** Index into route.gates of the first closed gate, -1 when everything is open. */
  limitGate: number;
  phaseKey: number;
  leg: number;
  t: number;
  /** Vertex the hint stands on, or -1 when it is a point inside a leg; hintS = its effective route metres. */
  hintVertex: number;
  hintS: number;
  holdCount: number;
  ticks: number;
  lastGlobalTick: number;
  lastHintTick: number;
  lastX: number;
  lastY: number;
  lastZ: number;
  /** Height of the player's centre when it last stood on a floor (NaN before the first update). */
  groundY: number;
}

// ───────────────────────────── tuning ─────────────────────────────
/** Weight of vertical distance when matching the player to the route. */
const VERTICAL_WEIGHT = 2;
/** A leg whose ends differ by more than this in height is a climb / drop (the floors of a level are flat). */
const LEVEL_EPS = 0.5;
/** Look-ahead window along the route (m) and the most vertices examined in it. */
const LOOK_AHEAD = 60;
const MAX_CANDIDATES = 8;
/** A vertex this close (horizontally / vertically) counts as reached: the hint moves on to the next one. */
const REACH_H = 5;
const REACH_V = 2.5;
/** Hint thresholds relative to the player: above → climb, below → drop (a plain jump tops out at 2.8 m). */
const CLIMB_RISE = 1;
const DROP_FALL = 3;
/** A higher vertex may be headed for from this far beyond the drawn length of its climb / when it ends no climb. */
const CLIMB_EXTRA = 6;
const CLIMB_FREE = 16;
/** Ticks between hint evaluations / full progress searches (120 Hz ticks). */
const HINT_PERIOD = 12;
const GLOBAL_PERIOD = 30;
const GLOBAL_MIN_GAP = 6;
/** A local match worse than this (weighted metres) asks for a full search. */
const OFF_ROUTE = 8;
/** Full search: a leg that cannot be seen from the player is treated as this much farther away. */
const LOS_PENALTY = 25;
/** … and the full search only overrides the tracked leg when it is better by this much. */
const SWITCH_MARGIN = 3;
const GLOBAL_BEST = 6;
/** Full search: a leg this near (weighted m) may be taken without being seen (the player stands on it). */
const ON_ROUTE = 6;
/** Full search: legs that lie entirely in a sector connected to / unrelated to the player's sector count as farther away. */
const SECTOR_NEAR = 8;
const SECTOR_FAR = 60;
/** Hint evaluations for which a farther hint is kept although a nearer one would be chosen now. */
const HOLD_EVALS = 3;
/** Spacing (route metres) of the points inside legs that are tried when no vertex can be headed for. */
const POINT_STEP = 8;
const POINT_NEAR = 2;
/** Firing positions: sampling step, range, and how long the turret must have been in view (m). */
const FIRE_STEP = 1;
const FIRE_RANGE = FCS_RANGE - 10;
const FIRE_MARGIN = 3;
const FIRE_GLIMPSE = 1;
/** Straight-walk test: knee height below the centre, half width of the track, floor sample spacing. */
const KNEE_DROP = 1.4;
const TRACK_HALF = 1.1;
const FLOOR_STEP = 3;
const TELEPORT = 3;

const WALK = 0;
const CLIMB = 1;
const DROP = 2;

// ───────────────────────────── static route data ─────────────────────────────
interface Gate {
  /** BarrierDef.id or FinalGateDef.id. */
  id: string;
  isFinal: boolean;
  controlEnemyId: string | null;
  /** Leg (waypoint crossLeg → crossLeg + 1) whose drawn path passes through the barrier box. */
  crossLeg: number;
  /** Firing position: on leg fireLeg at parameter fireT (0 = exactly waypoint fireLeg). */
  fireLeg: number;
  fireT: number;
  /** True when the turret can really be seen from the firing position (false: fallback = the door). */
  fireSeen: boolean;
  tx: number;
  ty: number;
  tz: number;
}

interface Spur {
  from: number;
  apex: number;
  to: number;
  /** Index into gates of the barrier this spur serves (first barrier crossed after it); gates.length when none. */
  gate: number;
}

interface RouteData {
  source: StageDef['route'];
  n: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** Drawn length of leg i and cumulative drawn length at waypoint i. */
  len: Float64Array;
  cum: Float64Array;
  sector: string[];
  note: Array<string | null>;
  gates: Gate[];
  spurs: Spur[];
  /** spurFrom[i] = index into spurs of the spur starting at waypoint i, else -1. */
  spurFrom: Int32Array;
  /** Sector graph: index of each sector id, sector index of each waypoint (-1 = none), and the relation
   *  of two sectors (0 = same, 1 = connected according to stage.connections, 2 = neither). */
  sectorIndex: Map<string, number>;
  sectorCount: number;
  wpSector: Int16Array;
  sectorRel: Uint8Array;
}

const cache = new WeakMap<StageDef, { source: StageDef['route']; data: RouteData | null }>();

// Scratch (module-private, single-threaded; nothing is kept between calls). The hot path never passes a
// floating-point number to or from a function that is not inlined: V8 would box it (16 bytes of garbage
// each), and a module-level `let` holding a double is boxed on every write as well. Positions therefore live
// in the slots of B, results in M.
const sA: V3 = { x: 0, y: 0, z: 0 };
const sB: V3 = { x: 0, y: 0, z: 0 };
const sC: V3 = { x: 0, y: 0, z: 0 };
/** Half extents of the thin box that looks for floor just below the feet. */
const FLOOR_HALF: V3 = { x: 0.3, y: 0.5, z: 0.3 };
/** Vector slots (x, y, z): the player, the target, the nearest route point, two temporaries. */
const B = new Float64Array(15);
const P = 0;
const W = 3;
const Q = 6;
const T1 = 9;
const T2 = 12;
/** End points of the segment handed to segDist(). */
const SEG = new Float64Array(6);
/** Scalar results / arguments. */
const M = new Float64Array(8);
const M_T = 0; // parameter of the nearest point
const M_D2 = 1; // weighted squared distance (segDist)
const M_D = 2; // weighted distance (legDistance)
const M_LOCAL = 3; // weighted distance of the tracked leg (trackLocal)
const M_NX = 4; // horizontal normal of the line of travel
const M_NZ = 5;
const M_S = 6; // route metres handed to pointOnRoute
const gLeg = new Int32Array(GLOBAL_BEST);
const gDist = new Float64Array(GLOBAL_BEST);

/**
 * True when a mech standing at slot P and facing `target` has it within `range` and in view along the three
 * lines the FCS needs: from the hit-box centre, from the camera pivot and from the muzzle.
 */
function inView(sim: Sim, target: V3, range: number): boolean {
  const px = B[P];
  const py = B[P + 1];
  const pz = B[P + 2];
  const dx = target.x - px;
  const dy = target.y - py;
  const dz = target.z - pz;
  if (dx * dx + dy * dy + dz * dz > range * range) return false;
  const world = sim.world;
  sA.x = px;
  sA.y = py;
  sA.z = pz;
  if (world.segmentBlocked(sA, target)) return false;
  sA.y = py + CAMERA.pivotUp;
  if (world.segmentBlocked(sA, target)) return false;
  let fx = dx;
  let fz = dz;
  const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl < 1e-9) {
    fx = 0;
    fz = -1;
  } else {
    fx /= fl;
    fz /= fl;
  }
  const m = PLAYER.muzzleLocal;
  // right = (cos yaw, 0, -sin yaw) with forward = (-sin yaw, 0, -cos yaw)  →  right = (-fz, 0, fx)
  sA.x = px - fz * m.right + fx * m.forward;
  sA.y = py + m.up;
  sA.z = pz + fx * m.right + fz * m.forward;
  return !world.segmentBlocked(sA, target);
}

function drawnLength(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dy = by - ay;
  const hd = Math.hypot(bx - ax, bz - az);
  return Math.abs(dy) > LEVEL_EPS ? hd + Math.abs(dy) : Math.hypot(hd, dy);
}

/** Segment a→b against a box (slab test). */
function segmentHitsBox(ax: number, ay: number, az: number, bx: number, by: number, bz: number, box: Box, pad: V3): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 3; k++) {
    const a = k === 0 ? ax : k === 1 ? ay : az;
    const b = k === 0 ? bx : k === 1 ? by : bz;
    const lo = (k === 0 ? box.min.x - pad.x : k === 1 ? box.min.y - pad.y : box.min.z - pad.z);
    const hi = (k === 0 ? box.max.x + pad.x : k === 1 ? box.max.y + pad.y : box.max.z + pad.z);
    const d = b - a;
    if (Math.abs(d) < 1e-12) {
      if (a < lo || a > hi) return false;
      continue;
    }
    let u0 = (lo - a) / d;
    let u1 = (hi - a) / d;
    if (u0 > u1) {
      const s = u0;
      u0 = u1;
      u1 = s;
    }
    if (u0 > t0) t0 = u0;
    if (u1 < t1) t1 = u1;
    if (t0 > t1) return false;
  }
  return true;
}

/** True when the drawn path of leg a→b passes through the box. */
function drawnLegHitsBox(ax: number, ay: number, az: number, bx: number, by: number, bz: number, box: Box): boolean {
  const pad = PLAYER.half;
  const dy = by - ay;
  if (Math.abs(dy) <= LEVEL_EPS) return segmentHitsBox(ax, ay, az, bx, by, bz, box, pad);
  if (dy > 0) return segmentHitsBox(ax, ay, az, ax, by, az, box, pad) || segmentHitsBox(ax, by, az, bx, by, bz, box, pad);
  return segmentHitsBox(ax, ay, az, bx, ay, bz, box, pad) || segmentHitsBox(bx, ay, bz, bx, by, bz, box, pad);
}

function buildRouteData(sim: Sim): RouteData | null {
  const stage = sim.stage;
  const route = stage.route;
  const n = route ? route.length : 0;
  if (n < 2) return null;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const sector: string[] = [];
  const note: Array<string | null> = [];
  for (let i = 0; i < n; i++) {
    const p = route[i].position;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
    x[i] = p.x;
    y[i] = p.y;
    z[i] = p.z;
    sector.push(route[i].sectorId ?? '');
    note.push(route[i].note ?? null);
  }
  const len = new Float64Array(n);
  const cum = new Float64Array(n);
  for (let i = 0; i + 1 < n; i++) {
    len[i] = drawnLength(x[i], y[i], z[i], x[i + 1], y[i + 1], z[i + 1]);
    cum[i + 1] = cum[i] + len[i];
  }

  // out-and-back spurs: … A, B, A …
  const spurs: Spur[] = [];
  const spurFrom = new Int32Array(n).fill(-1);
  const same = (i: number, j: number): boolean => Math.abs(x[i] - x[j]) < 0.05 && Math.abs(y[i] - y[j]) < 0.05 && Math.abs(z[i] - z[j]) < 0.05;
  for (let j = 1; j + 1 < n; j++) {
    if (!same(j - 1, j + 1)) continue;
    let m = 1;
    while (j - m - 1 >= 0 && j + m + 1 < n && same(j - m - 1, j + m + 1)) m++;
    spurFrom[j - m] = spurs.length;
    spurs.push({ from: j - m, apex: j, to: j + m, gate: 0 });
    j += m;
  }
  const inSecondHalf = (leg: number): boolean => {
    for (const s of spurs) if (leg >= s.apex && leg < s.to) return true;
    return false;
  };

  // barriers and the final gate, in the order the route crosses them
  const gates: Gate[] = [];
  const addGate = (id: string, box: Box, controlEnemyId: string | null, isFinal: boolean): void => {
    for (let i = 0; i + 1 < n; i++) {
      if (!drawnLegHitsBox(x[i], y[i], z[i], x[i + 1], y[i + 1], z[i + 1], box)) continue;
      let tx = NaN;
      let ty = NaN;
      let tz = NaN;
      let ctl: string | null = null;
      if (controlEnemyId !== null) {
        const def = stage.enemies.find((e) => e.id === controlEnemyId);
        if (def) {
          ctl = def.id;
          tx = def.position.x;
          ty = def.position.y;
          tz = def.position.z;
        }
      }
      gates.push({ id, isFinal, controlEnemyId: ctl, crossLeg: i, fireLeg: i, fireT: 0, fireSeen: false, tx, ty, tz });
      return;
    }
  };
  for (const b of stage.barriers) addGate(b.id, b.box, b.controlEnemyId, false);
  if (stage.finalGate) addGate(stage.finalGate.id, stage.finalGate.box, null, true);
  gates.sort((a, b) => a.crossLeg - b.crossLeg);
  for (const s of spurs) {
    let g = gates.length;
    for (let k = 0; k < gates.length; k++) {
      if (gates[k].crossLeg >= s.to) {
        g = k;
        break;
      }
    }
    s.gate = g;
  }

  // firing positions: the first place on the walkable route after the previous barrier from which the turret
  // is in view (see the file header)
  const target: V3 = { x: 0, y: 0, z: 0 };
  const sees = (px: number, py: number, pz: number): boolean => {
    B[P] = px;
    B[P + 1] = py;
    B[P + 2] = pz;
    return inView(sim, target, FIRE_RANGE);
  };
  for (let g = 0; g < gates.length; g++) {
    const gate = gates[g];
    if (gate.controlEnemyId === null) continue;
    target.x = gate.tx;
    target.y = gate.ty;
    target.z = gate.tz;
    const first = g === 0 ? 0 : gates[g - 1].crossLeg + 1;
    // The first stretch of at least FIRE_GLIMPSE m with the turret in view decides: the firing position is
    // FIRE_MARGIN m into it, or its last sample when it is shorter (e.g. it ends at a balcony edge). A single
    // sample with a view is only used when there is nothing better.
    let runStart = NaN; // route metres where the current run of visible samples began
    let done = false;
    let curLeg = -1; // last visible sample of the current run
    let curT = 0;
    let curS = 0;
    let oneLeg = -1; // first isolated sample with a view
    let oneT = 0;
    const endRun = (): void => {
      if (Number.isNaN(runStart)) return;
      if (curS - runStart >= FIRE_GLIMPSE - 1e-9) done = true;
      else if (oneLeg < 0) {
        oneLeg = curLeg;
        oneT = curT;
      }
      runStart = NaN;
    };
    for (let i = first; i < gate.crossLeg && !done; i++) {
      if (Math.abs(y[i + 1] - y[i]) > LEVEL_EPS || inSecondHalf(i) || !(len[i] > 1e-6)) {
        endRun();
        continue;
      }
      const steps = Math.max(1, Math.ceil(len[i] / FIRE_STEP));
      for (let k = 0; k <= steps && !done; k++) {
        const t = k / steps;
        const s = cum[i] + t * len[i];
        if (sees(x[i] + (x[i + 1] - x[i]) * t, y[i] + (y[i + 1] - y[i]) * t, z[i] + (z[i + 1] - z[i]) * t)) {
          if (Number.isNaN(runStart)) runStart = s;
          curLeg = i;
          curT = t;
          curS = s;
          if (s - runStart >= FIRE_MARGIN) done = true;
        } else endRun();
      }
    }
    if (!done) {
      endRun();
      if (!done) {
        curLeg = oneLeg;
        curT = oneT;
      }
    }
    if (curLeg >= 0) {
      gate.fireLeg = curLeg;
      gate.fireT = curT;
      gate.fireSeen = true;
      // snap to a waypoint when (almost) on it: no tiny legs
      if (gate.fireT * len[curLeg] < 0.5) gate.fireT = 0;
      else if ((1 - gate.fireT) * len[curLeg] < 0.5) {
        gate.fireLeg = curLeg + 1;
        gate.fireT = 0;
      }
    }
  }
  // sector graph (for the plausibility of a match: walls separate sectors)
  const sectorIndex = new Map<string, number>();
  stage.sectors.forEach((sec, i) => sectorIndex.set(sec.id, i));
  const sectorCount = stage.sectors.length;
  const sectorRel = new Uint8Array(sectorCount * sectorCount).fill(2);
  for (let i = 0; i < sectorCount; i++) sectorRel[i * sectorCount + i] = 0;
  for (const c of stage.connections) {
    const a = sectorIndex.get(c.a);
    const b = sectorIndex.get(c.b);
    if (a === undefined || b === undefined || a === b) continue;
    sectorRel[a * sectorCount + b] = 1;
    sectorRel[b * sectorCount + a] = 1;
  }
  const wpSector = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    wpSector[i] = sectorIndex.get(sector[i]) ?? -1;
    // sectors of consecutive waypoints are connected by the route itself
    const a = wpSector[i];
    const b = i > 0 ? wpSector[i - 1] : -1;
    if (a >= 0 && b >= 0 && a !== b) {
      sectorRel[a * sectorCount + b] = 1;
      sectorRel[b * sectorCount + a] = 1;
    }
  }
  return { source: route, n, x, y, z, len, cum, sector, note, gates, spurs, spurFrom, sectorIndex, sectorCount, wpSector, sectorRel };
}

function routeDataFor(sim: Sim): RouteData | null {
  const hit = cache.get(sim.stage);
  if (hit && hit.source === sim.stage.route) return hit.data;
  const data = buildRouteData(sim);
  cache.set(sim.stage, { source: sim.stage.route, data });
  return data;
}

// ───────────────────────────── effective polyline ─────────────────────────────
function gateOpen(sim: Sim, g: Gate): boolean {
  return g.isFinal ? sim.objective.gateOpen : sim.objective.openBarrierIds.includes(g.id);
}

function phaseKeyOf(sim: Sim): number {
  return sim.objective.openBarrierIds.length * 2 + (sim.objective.gateOpen ? 1 : 0);
}

function pushVertex(G: GuideState, x: number, y: number, z: number, wp: number, raw: number, inserted: boolean): number {
  const k = G.eCount++;
  G.ex[k] = x;
  G.ey[k] = y;
  G.ez[k] = z;
  G.eWp[k] = wp;
  G.eRaw[k] = raw;
  G.eInserted[k] = inserted ? 1 : 0;
  return k;
}

/** Rebuilds the effective polyline for the current objective state. */
function rebuild(sim: Sim, G: GuideState): void {
  const R = G.route as RouteData;
  G.phaseKey = phaseKeyOf(sim);
  let L = -1;
  let open = 0;
  for (let g = 0; g < R.gates.length; g++) {
    if (gateOpen(sim, R.gates[g])) open++;
    else if (L < 0) L = g;
  }
  G.limitGate = L;
  G.phase = open;
  const end = L >= 0 ? Math.min(R.n - 1, R.gates[L].crossLeg + 1) : R.n - 1;
  let goalLeg = R.n - 1;
  let goalT = 0;
  if (L >= 0) {
    goalLeg = R.gates[L].fireLeg;
    goalT = R.gates[L].fireT;
  }
  G.eCount = 0;
  G.goalVertex = -1;
  let i = 0;
  while (i <= end) {
    const k = pushVertex(G, R.x[i], R.y[i], R.z[i], i, R.cum[i], false);
    const si = R.spurFrom[i];
    const spur = si >= 0 ? R.spurs[si] : null;
    // a spur starting here is kept only when it holds the goal (strictly inside, or at its apex)
    if (spur !== null && spur.to <= end) {
      const holdsGoal = L >= 0 && spur.gate === L && ((goalLeg > spur.from && goalLeg <= spur.apex && (goalLeg < spur.apex || goalT === 0)) || (goalLeg === spur.from && goalT > 0));
      if (!holdsGoal) {
        if (goalLeg === i && goalT === 0) G.goalVertex = k;
        G.eRaw[k] = R.cum[spur.to];
        i = spur.to + 1;
        continue;
      }
    }
    if (goalLeg === i && goalT === 0) {
      G.goalVertex = k;
      // goal on a waypoint strictly inside the first half of a spur: turn around here
      const sp = enclosingSpur(R, i);
      if (sp !== null && i > sp.from && i < sp.apex) {
        const mirror = 2 * sp.apex - i;
        G.eRaw[k] = R.cum[mirror];
        i = mirror + 1;
        continue;
      }
    } else if (goalLeg === i && goalT > 0 && i < end) {
      const t = goalT;
      const gx = R.x[i] + (R.x[i + 1] - R.x[i]) * t;
      const gy = R.y[i] + (R.y[i + 1] - R.y[i]) * t;
      const gz = R.z[i] + (R.z[i + 1] - R.z[i]) * t;
      const kg = pushVertex(G, gx, gy, gz, i + 1, R.cum[i] + t * R.len[i], true);
      G.goalVertex = kg;
      const sp = enclosingSpur(R, i);
      if (sp !== null && i >= sp.from && i < sp.apex) {
        // inside the first half of a spur: continue from the mirror point on the way out
        const mLeg = 2 * sp.apex - 1 - i;
        G.eRaw[kg] = R.cum[mLeg] + (1 - t) * R.len[mLeg];
        i = mLeg + 1;
        continue;
      }
    }
    i++;
  }
  if (G.goalVertex < 0) G.goalVertex = G.eCount - 1;
  const m = G.eCount;
  G.eCum[0] = 0;
  for (let k = 0; k + 1 < m; k++) {
    const dy = G.ey[k + 1] - G.ey[k];
    G.eKind[k] = Math.abs(dy) <= LEVEL_EPS ? WALK : dy > 0 ? CLIMB : DROP;
    G.eLen[k] = drawnLength(G.ex[k], G.ey[k], G.ez[k], G.ex[k + 1], G.ey[k + 1], G.ez[k + 1]);
    G.eCum[k + 1] = G.eCum[k] + G.eLen[k];
  }
  if (m >= 2) {
    G.eLen[m - 1] = 0;
    G.eKind[m - 1] = WALK;
  }
  if (G.leg > m - 2) G.leg = Math.max(0, m - 2);
  G.hintVertex = -1;
  G.hasHint = false;
  G.holdCount = 0;
}

function enclosingSpur(R: RouteData, leg: number): Spur | null {
  for (let k = 0; k < R.spurs.length; k++) {
    const s = R.spurs[k];
    if (leg >= s.from && leg < s.to) return s;
  }
  return null;
}

// ───────────────────────────── progress matching ─────────────────────────────
/**
 * Weighted squared distance from the player (slot P) to the segment in SEG; leaves it in M[M_D2], the parameter
 * in M[M_T] and the nearest point in slot Q.
 */
function segDist(): void {
  const ax = SEG[0];
  const ay = SEG[1];
  const az = SEG[2];
  const ux = SEG[3] - ax;
  const vy = SEG[4] - ay;
  const uz = SEG[5] - az;
  const uy = vy * VERTICAL_WEIGHT;
  const wx = B[P] - ax;
  const wy = (B[P + 1] - ay) * VERTICAL_WEIGHT;
  const wz = B[P + 2] - az;
  const uu = ux * ux + uy * uy + uz * uz;
  let t = uu > 1e-12 ? (wx * ux + wy * uy + wz * uz) / uu : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  M[M_T] = t;
  B[Q] = ax + ux * t;
  B[Q + 1] = ay + vy * t;
  B[Q + 2] = az + uz * t;
  const dx = wx - ux * t;
  const dy = wy - uy * t;
  const dz = wz - uz * t;
  M[M_D2] = dx * dx + dy * dy + dz * dz;
}

/**
 * Weighted distance from the player (slot P) to the drawn path of effective leg k → M[M_D]; the parameter
 * (0..1 of the drawn length) → M[M_T]; the nearest point → slot Q.
 */
function legDistance(G: GuideState, k: number): void {
  const ax = G.ex[k];
  const ay = G.ey[k];
  const az = G.ez[k];
  const bx = G.ex[k + 1];
  const by = G.ey[k + 1];
  const bz = G.ez[k + 1];
  const kind = G.eKind[k];
  SEG[0] = ax;
  SEG[1] = ay;
  SEG[2] = az;
  if (kind === WALK) {
    SEG[3] = bx;
    SEG[4] = by;
    SEG[5] = bz;
    segDist();
    M[M_D] = Math.sqrt(M[M_D2]);
    return;
  }
  const total = G.eLen[k];
  const vert = Math.abs(by - ay);
  // corner of the drawn path: above the lower end (climb) / level with the upper end above the far end (drop)
  const cx = kind === CLIMB ? ax : bx;
  const cy = kind === CLIMB ? by : ay;
  const cz = kind === CLIMB ? az : bz;
  const first = kind === CLIMB ? vert : total - vert;
  SEG[3] = cx;
  SEG[4] = cy;
  SEG[5] = cz;
  segDist();
  const d1 = M[M_D2];
  const t1 = M[M_T];
  const q1x = B[Q];
  const q1y = B[Q + 1];
  const q1z = B[Q + 2];
  SEG[0] = cx;
  SEG[1] = cy;
  SEG[2] = cz;
  SEG[3] = bx;
  SEG[4] = by;
  SEG[5] = bz;
  segDist();
  if (d1 <= M[M_D2]) {
    M[M_T] = total > 1e-9 ? (t1 * first) / total : 0;
    B[Q] = q1x;
    B[Q + 1] = q1y;
    B[Q + 2] = q1z;
    M[M_D] = Math.sqrt(d1);
    return;
  }
  M[M_T] = total > 1e-9 ? (first + M[M_T] * (total - first)) / total : 0;
  M[M_D] = Math.sqrt(M[M_D2]);
}

/** Makes leg k the matched leg (progress, distance from the route). */
function setMatch(G: GuideState, k: number): void {
  legDistance(G, k);
  G.leg = k;
  G.t = M[M_T];
  G.progress = G.eRaw[k] + M[M_T] * G.eLen[k];
  const dx = B[P] - B[Q];
  const dy = B[P + 1] - B[Q + 1];
  const dz = B[P + 2] - B[Q + 2];
  G.offRoute = Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** True when the straight line between two scratch slots is blocked by the stage. */
function blocked(sim: Sim, a: number, b: number): boolean {
  sA.x = B[a];
  sA.y = B[a + 1];
  sA.z = B[a + 2];
  sB.x = B[b];
  sB.y = B[b + 1];
  sB.z = B[b + 2];
  return sim.world.segmentBlocked(sA, sB);
}

/**
 * Tracks the progress around the current leg; the weighted distance of the match → M[M_LOCAL].
 * Ties: legs before the goal win (the progress moves on at a corner); legs past the goal must be strictly nearer.
 */
function trackLocal(G: GuideState): void {
  const m = G.eCount;
  const goal = G.goalVertex;
  const lo = Math.max(0, G.leg - 1);
  const hi = Math.min(m - 2, G.leg + 2);
  let best = -1;
  let bestD = Infinity;
  for (let k = lo; k <= hi; k++) {
    legDistance(G, k);
    const d = M[M_D];
    if (best < 0 || (k < goal ? d <= bestD + 1e-9 : d < bestD - 1e-9)) {
      best = k;
      bestD = d;
    }
  }
  setMatch(G, best);
  M[M_LOCAL] = bestD;
}

/** Extra distance (m) for a leg that lies entirely outside the player's sector `ps` (-1 = unknown: none). */
function sectorPenalty(R: RouteData, G: GuideState, k: number, ps: number): number {
  if (ps < 0) return 0;
  const a = R.wpSector[G.eWp[k]];
  const b = R.wpSector[G.eWp[k + 1]];
  if (a < 0 && b < 0) return 0;
  const ra = a < 0 ? 2 : R.sectorRel[ps * R.sectorCount + a];
  const rb = b < 0 ? 2 : R.sectorRel[ps * R.sectorCount + b];
  const r = ra < rb ? ra : rb;
  return r === 0 ? 0 : r === 1 ? SECTOR_NEAR : SECTOR_FAR;
}

/**
 * Examines every leg. `fresh` (first update, the player was moved, the polyline was rebuilt): takes the nearest
 * leg, preferring one whose nearest point the player can see. Otherwise the tracked leg (distance in
 * M[M_LOCAL]) is only given up for a clearly better leg that the player can see or stands on — never for one
 * behind a wall or on another storey.
 */
function searchGlobal(sim: Sim, G: GuideState, fresh: boolean): void {
  const R = G.route as RouteData;
  const m = G.eCount;
  const goal = G.goalVertex;
  const cur = sim.currentSectorId;
  const ps = cur === null ? -1 : (R.sectorIndex.get(cur) ?? -1);
  const localD = M[M_LOCAL];
  let cnt = 0;
  for (let k = 0; k + 1 < m; k++) {
    legDistance(G, k);
    const d = M[M_D] + sectorPenalty(R, G, k, ps);
    // insertion into the GLOBAL_BEST nearest (ascending; ties as in trackLocal)
    let pos = cnt;
    while (pos > 0 && (k < goal ? d <= gDist[pos - 1] + 1e-9 : d < gDist[pos - 1] - 1e-9)) pos--;
    if (pos >= GLOBAL_BEST) continue;
    const last = Math.min(cnt, GLOBAL_BEST - 1);
    for (let j = last; j > pos; j--) {
      gLeg[j] = gLeg[j - 1];
      gDist[j] = gDist[j - 1];
    }
    gLeg[pos] = k;
    gDist[pos] = d;
    if (cnt < GLOBAL_BEST) cnt++;
  }
  if (cnt === 0) return;
  // nearest leg that is seen (or stood on) within LOS_PENALTY of the nearest one
  let pick = -1;
  let score = gDist[0] + LOS_PENALTY;
  for (let j = 0; j < cnt; j++) {
    if (gDist[j] >= score) break;
    legDistance(G, gLeg[j]);
    if (M[M_D] <= ON_ROUTE || !blocked(sim, P, Q)) {
      pick = gLeg[j];
      score = gDist[j];
      break;
    }
  }
  if (fresh) {
    setMatch(G, pick >= 0 ? pick : gLeg[0]);
    return;
  }
  if (pick < 0 || pick === G.leg) {
    setMatch(G, G.leg);
    return;
  }
  legDistance(G, G.leg);
  const localScore = localD + sectorPenalty(R, G, G.leg, ps) + (localD <= ON_ROUTE || !blocked(sim, P, Q) ? 0 : LOS_PENALTY);
  setMatch(G, score + SWITCH_MARGIN < localScore ? pick : G.leg);
}

// ───────────────────────────── hint ─────────────────────────────
function reached(G: GuideState, j: number): boolean {
  const dx = G.ex[j] - B[P];
  const dz = G.ez[j] - B[P + 2];
  return dx * dx + dz * dz <= REACH_H * REACH_H && Math.abs(G.ey[j] - B[P + 1]) <= REACH_V;
}

/**
 * Three parallel clear lines between two scratch slots: the centre and both sides of a track as wide as the
 * hull (the horizontal unit normal of the line of travel is in M[M_NX], M[M_NZ]).
 */
function track(sim: Sim, a: number, b: number): boolean {
  if (blocked(sim, a, b)) return false;
  const ox = M[M_NX] * TRACK_HALF;
  const oz = M[M_NZ] * TRACK_HALF;
  for (let side = -1; side <= 1; side += 2) {
    sA.x = B[a] + ox * side;
    sA.y = B[a + 1];
    sA.z = B[a + 2] + oz * side;
    sB.x = B[b] + ox * side;
    sB.y = B[b + 1];
    sB.z = B[b + 2] + oz * side;
    if (sim.world.segmentBlocked(sA, sB)) return false;
  }
  return true;
}

/**
 * Can the player (slot P) head for the point in slot W in a straight line? `climbLeg` = effective leg whose
 * climb ends at that point (a point above the player may then be approached from the length of that climb plus
 * CLIMB_EXTRA), or -1 (CLIMB_FREE).
 */
function canHeadTo(sim: Sim, G: GuideState, climbLeg: number): boolean {
  const px = B[P];
  const py = B[P + 1];
  const pz = B[P + 2];
  const wx = B[W];
  const wy = B[W + 1];
  const wz = B[W + 2];
  const dx = wx - px;
  const dz = wz - pz;
  const hd = Math.sqrt(dx * dx + dz * dz);
  const dy = wy - py;
  // horizontal unit normal of the line of travel (for the hull-wide track)
  const nx = hd > 1e-6 ? -dz / hd : 0;
  const nz = hd > 1e-6 ? dx / hd : 0;
  M[M_NX] = nx;
  M[M_NZ] = nz;
  if (dy > CLIMB_RISE) {
    // rise on the spot, then fly level
    const limit = climbLeg >= 0 ? G.eLen[climbLeg] - Math.abs(G.ey[climbLeg + 1] - G.ey[climbLeg]) + CLIMB_EXTRA : CLIMB_FREE;
    if (hd > limit) return false;
    const top = wy + 0.2;
    B[T1] = px;
    B[T1 + 1] = top;
    B[T1 + 2] = pz;
    B[T2] = wx;
    B[T2 + 1] = top;
    B[T2 + 2] = wz;
    return !blocked(sim, P, T1) && track(sim, T1, T2);
  }
  if (dy < -CLIMB_RISE) {
    // walk level and fall at the far end, or a clear straight line — both with room for the hull
    B[T1] = wx;
    B[T1 + 1] = py;
    B[T1 + 2] = wz;
    if (track(sim, P, T1) && !blocked(sim, T1, W)) return true;
    return track(sim, P, W);
  }
  // level: clear at body height, clear at knee height on a track as wide as the hull, floor all the way
  if (blocked(sim, P, W)) return false;
  B[T1] = px;
  B[T1 + 1] = py - KNEE_DROP;
  B[T1 + 2] = pz;
  B[T2] = wx;
  B[T2 + 1] = wy - KNEE_DROP;
  B[T2 + 2] = wz;
  if (!track(sim, T1, T2)) return false;
  const steps = Math.ceil(hd / FLOOR_STEP);
  const world = sim.world;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const cx = px + dx * t;
    const cy = py + dy * t - PLAYER.half.y - FLOOR_HALF.y - 0.05; // a thin box just below the feet
    const cz = pz + dz * t;
    for (let side = -1; side <= 1; side++) {
      sC.x = cx + nx * side;
      sC.y = cy;
      sC.z = cz + nz * side;
      if (!world.overlapsBox(sC, FLOOR_HALF)) return false;
    }
  }
  return true;
}

/** Vertex j as a target: a higher vertex only from near the take-off of the climb that ends there. */
function canHeadForVertex(sim: Sim, G: GuideState, j: number, step: number): boolean {
  const leg = step > 0 ? j - 1 : j;
  const endsClimb = leg >= 0 && leg < G.eCount - 1 && G.eKind[leg] === (step > 0 ? CLIMB : DROP);
  B[W] = G.ex[j];
  B[W + 1] = G.ey[j];
  B[W + 2] = G.ez[j];
  return canHeadTo(sim, G, endsClimb ? leg : -1);
}

/**
 * Finds the leg that holds effective route metre M[M_S] (searching from leg `from` in direction `step`) when
 * it is a level leg; leaves the point in slot W and returns the leg, or -1 (inside a climb / drop, out of range).
 */
function pointOnRoute(G: GuideState, from: number, step: number): number {
  const sAbs = M[M_S];
  const m = G.eCount;
  for (let k = from; k >= 0 && k < m - 1; k += step) {
    const s0 = G.eCum[k];
    const s1 = G.eCum[k + 1];
    if (sAbs < s0 - 1e-9 || sAbs > s1 + 1e-9) continue;
    if (G.eKind[k] !== WALK || !(G.eLen[k] > 1e-6)) return -1;
    const t = (sAbs - s0) / G.eLen[k];
    B[W] = G.ex[k] + (G.ex[k + 1] - G.ex[k]) * t;
    B[W + 1] = G.ey[k] + (G.ey[k + 1] - G.ey[k]) * t;
    B[W + 2] = G.ez[k] + (G.ez[k + 1] - G.ez[k]) * t;
    return k;
  }
  return -1;
}

function evaluateHint(sim: Sim, G: GuideState): void {
  const R = G.route as RouteData;
  const a = G.leg;
  const gi = G.goalVertex;
  const s = G.eCum[a] + G.t * G.eLen[a];
  const goalS = G.eCum[gi];
  const forward = a < gi;
  const step = forward ? 1 : -1;
  const h = G.hint;
  // vertices in travel order: first … last (towards the goal)
  let first = forward ? a + 1 : a;
  while (first !== gi && reached(G, first)) first += step;
  let last = first;
  let count = 1;
  while (last !== gi && count < MAX_CANDIDATES) {
    const nxt = last + step;
    if (Math.abs(G.eCum[nxt] - s) > LOOK_AHEAD) break;
    last = nxt;
    count++;
  }
  // the hint chosen earlier, if it still lies between the player and the goal and was not reached
  const prevS = G.hintS;
  const prevVertex = G.hintVertex;
  let prevOk = G.hasHint && (prevS - s) * step > 0 && (goalS - prevS) * step >= 0;
  if (prevOk) {
    if (prevVertex >= 0) prevOk = (prevVertex - first) * step >= 0 && (last - prevVertex) * step >= 0;
    else {
      const ddx = h.position.x - B[P];
      const ddz = h.position.z - B[P + 2];
      prevOk = Math.abs(prevS - s) <= LOOK_AHEAD + POINT_STEP && ddx * ddx + ddz * ddz > REACH_H * REACH_H;
    }
  }
  // new choice: vertex pickV, or a point inside leg pickLeg (kept in slot W)
  let pickV = -1;
  let pickLeg = -1;
  let pickS = 0;
  let keep = false;
  if (!sim.player.grounded) {
    // in the air the hint is kept (a climb in progress, a jump); it only moves on once it is reached
    if (prevOk) keep = true;
    else pickV = first;
  } else {
    // a. the farthest vertex the player can head for
    for (let j = last; ; j -= step) {
      if (canHeadForVertex(sim, G, j, step)) {
        pickV = j;
        break;
      }
      if (j === first) break;
    }
    // b. off the route: else the farthest point of the route ahead (every POINT_STEP m, down to the matched
    //    point itself). On the route the next vertex is the better target even around a corner.
    if (pickV < 0 && G.offRoute > REACH_H) {
      const span = Math.min(LOOK_AHEAD, Math.abs(G.eCum[last] - s));
      for (let k = Math.floor(span / POINT_STEP); k >= 0; k--) {
        // points sit on a fixed grid of route metres so that the hint does not creep with the player
        // (k = 0: the grid point next to the matched point, i.e. the way straight back to the route)
        const grid = k === 0 ? POINT_NEAR : POINT_STEP;
        let sp = forward ? Math.floor((s + k * POINT_STEP) / grid) * grid : Math.ceil((s - k * POINT_STEP) / grid) * grid;
        if (k === 0) sp = forward ? Math.ceil(s / grid) * grid : Math.floor(s / grid) * grid;
        if ((goalS - sp) * step < 0) sp = goalS;
        if ((sp - s) * step < 0) continue;
        M[M_S] = sp;
        const leg = pointOnRoute(G, a, step);
        if (leg < 0) continue;
        const ddx = B[W] - B[P];
        const ddz = B[W + 2] - B[P + 2];
        if (ddx * ddx + ddz * ddz <= REACH_H * REACH_H) continue;
        if (canHeadTo(sim, G, -1)) {
          pickLeg = leg;
          pickS = sp;
          break;
        }
      }
    }
    // c. else the next vertex that is not reached yet (stable, and it stays ahead of a player who follows a
    //    parallel passage: a gallery, a side tunnel, another storey)
    if (pickV < 0 && pickLeg < 0) pickV = first;
    if (pickV >= 0) pickS = G.eCum[pickV];
    // a farther hint chosen a moment ago is not dropped at once (strafing in and out of sight)
    if (prevOk && (prevS - pickS) * step > 0.5) {
      if (++G.holdCount <= HOLD_EVALS) keep = true;
      else G.holdCount = 0;
    } else G.holdCount = 0;
  }
  if (!keep) {
    if (pickV >= 0) {
      G.hintVertex = pickV;
      G.hintS = G.eCum[pickV];
      h.index = G.eWp[pickV];
      h.position.x = G.ex[pickV];
      h.position.y = G.ey[pickV];
      h.position.z = G.ez[pickV];
      h.note = G.eInserted[pickV] ? null : R.note[h.index];
    } else {
      G.hintVertex = -1;
      G.hintS = pickS;
      h.index = G.eWp[forward ? pickLeg + 1 : pickLeg];
      h.position.x = B[W];
      h.position.y = B[W + 1];
      h.position.z = B[W + 2];
      h.note = null;
    }
  }
  const gate = G.limitGate >= 0 ? R.gates[G.limitGate] : null;
  if (gate !== null && G.hintVertex === gi) {
    h.blockedByBarrierId = gate.id;
    h.controlEnemyId = gate.controlEnemyId;
    h.controlVisible = false;
    if (gate.controlEnemyId !== null) {
      const e = sim.enemyById.get(gate.controlEnemyId);
      if (e && e.alive) h.controlVisible = inView(sim, e.pos, FCS_RANGE);
    }
  } else {
    h.blockedByBarrierId = null;
    h.controlEnemyId = null;
    h.controlVisible = false;
  }
  // next sector on the way to the goal
  const cur = sim.currentSectorId;
  h.nextSectorId = null;
  for (let j = forward ? a + 1 : a; ; j += step) {
    const sec = R.sector[G.eWp[j]];
    if (sec !== '' && sec !== cur) {
      h.nextSectorId = sec;
      break;
    }
    if (j === gi) break;
  }
  G.hasHint = true;
}

/** Per tick: the numbers that change with every step of the player. */
function refreshHint(sim: Sim, G: GuideState): void {
  const h = G.hint;
  const dx = h.position.x - B[P];
  const dy = h.position.y - B[P + 1];
  const dz = h.position.z - B[P + 2];
  h.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // Climb / drop: on the ground the plain height difference. In the air the mech is somewhere between the
  // floor it left and where it is going: only the part of the difference that lies outside that span is
  // still to be climbed or dropped. (Flying 4 m above a level route is no "▼ drop 4 m"; half-way up a climb
  // the rest of the climb is shown; falling towards a lower floor it stays a drop.)
  const py = B[P + 1];
  if (sim.player.grounded || !(G.groundY === G.groundY)) G.groundY = py;
  const lo = Math.min(G.groundY, py);
  const hi = Math.max(G.groundY, py);
  const rise = h.position.y > hi ? h.position.y - hi : h.position.y < lo ? h.position.y - lo : 0;
  h.rise = rise;
  h.kind = rise > CLIMB_RISE ? 'climb' : rise < -DROP_FALL ? 'drop' : 'walk';
  h.offRouteMeters = G.offRoute;
  const past = G.eCum[G.leg] + G.t * G.eLen[G.leg] - G.eCum[G.goalVertex];
  h.remainingMeters = Math.abs(past);
  h.backtrack = G.leg >= G.goalVertex && past > 2;
}

// ───────────────────────────── public API ─────────────────────────────
/** Fresh guidance state for a (re-)sortie. Called by Sim.reset() after the player and the barriers were reset. */
export function createGuideState(sim: Sim): GuideState {
  const route = routeDataFor(sim);
  const cap = route ? route.n + 2 : 1;
  const G: GuideState = {
    enabled: true,
    progress: 0,
    offRoute: 0,
    phase: 0,
    hint: {
      index: 0,
      position: { x: 0, y: 0, z: 0 },
      kind: 'walk',
      rise: 0,
      distance: 0,
      remainingMeters: 0,
      offRouteMeters: 0,
      note: null,
      blockedByBarrierId: null,
      controlEnemyId: null,
      controlVisible: false,
      backtrack: false,
      nextSectorId: null,
    },
    hasHint: false,
    route,
    ex: new Float64Array(cap),
    ey: new Float64Array(cap),
    ez: new Float64Array(cap),
    eWp: new Int32Array(cap),
    eInserted: new Uint8Array(cap),
    eRaw: new Float64Array(cap),
    eLen: new Float64Array(cap),
    eCum: new Float64Array(cap),
    eKind: new Uint8Array(cap),
    eCount: 0,
    goalVertex: 0,
    limitGate: -1,
    phaseKey: -1,
    leg: 0,
    t: 0,
    hintVertex: -1,
    hintS: 0,
    holdCount: 0,
    ticks: 0,
    lastGlobalTick: 0,
    lastHintTick: 0,
    lastX: NaN,
    lastY: NaN,
    lastZ: NaN,
    groundY: NaN,
  };
  if (route) {
    sim.guide = G;
    updateGuide(sim);
  }
  return G;
}

/**
 * Advances the guidance by one simulation tick (Sim.tick() calls it once, after the last sub-step).
 * Reads the player position, the objective state and the world; writes only `sim.guide`.
 */
export function updateGuide(sim: Sim): void {
  const G = sim.guide;
  if (!G || !G.enabled || G.route === null) return;
  const p = sim.player.pos;
  const px = p.x;
  const py = p.y;
  const pz = p.z;
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return;
  G.ticks++;
  let force = false;
  if (phaseKeyOf(sim) !== G.phaseKey) {
    rebuild(sim, G);
    force = true;
  }
  if (G.eCount < 2) {
    G.hasHint = false;
    return;
  }
  // a jump in position (first update, a re-sortie handled without a new state, a test moving the player)
  if (!(Math.abs(px - G.lastX) + Math.abs(py - G.lastY) + Math.abs(pz - G.lastZ) <= TELEPORT)) {
    force = true;
    G.hasHint = false;
    G.groundY = NaN;
  }
  G.lastX = px;
  G.lastY = py;
  G.lastZ = pz;
  B[P] = px;
  B[P + 1] = py;
  B[P + 2] = pz;

  const legBefore = G.leg;
  trackLocal(G);
  const sinceGlobal = G.ticks - G.lastGlobalTick;
  if (force || sinceGlobal >= GLOBAL_PERIOD || (M[M_LOCAL] > OFF_ROUTE && sinceGlobal >= GLOBAL_MIN_GAP)) {
    G.lastGlobalTick = G.ticks;
    searchGlobal(sim, G, force);
  }
  if (force || !G.hasHint || G.leg !== legBefore || G.ticks - G.lastHintTick >= HINT_PERIOD) {
    G.lastHintTick = G.ticks;
    evaluateHint(sim, G);
  }
  refreshHint(sim, G);
}

/** The current hint for the HUD (the same object every call, updated by updateGuide), or null when there is none. */
export function getRouteHint(sim: Sim): RouteHint | null {
  const G = sim.guide;
  return G && G.enabled && G.hasHint ? G.hint : null;
}

/** Read-only description of the route analysis (tests, tools, documentation). Allocates; not for per-frame use. */
export function describeGuide(sim: Sim): {
  waypoints: number;
  routeMeters: number;
  gates: Array<{ barrierId: string; controlEnemyId: string | null; crossLeg: number; fireLeg: number; fireT: number; fireMeters: number; firePosition: V3; fireSeen: boolean }>;
  spurs: Array<{ from: number; apex: number; to: number; barrierId: string | null }>;
  /** The effective polyline of the current objective state: route indices of its vertices and the goal's position in that list. */
  effective: { vertices: number[]; goal: number; goalPosition: V3 | null };
} | null {
  const G = sim.guide;
  const R = G ? G.route : null;
  if (!G || R === null) return null;
  const gates = R.gates.map((g) => {
    const i = g.fireLeg;
    const t = g.fireT;
    const j = Math.min(R.n - 1, i + 1);
    return {
      barrierId: g.id,
      controlEnemyId: g.controlEnemyId,
      crossLeg: g.crossLeg,
      fireLeg: g.fireLeg,
      fireT: g.fireT,
      fireMeters: R.cum[i] + t * R.len[i],
      firePosition: { x: R.x[i] + (R.x[j] - R.x[i]) * t, y: R.y[i] + (R.y[j] - R.y[i]) * t, z: R.z[i] + (R.z[j] - R.z[i]) * t },
      fireSeen: g.fireSeen,
    };
  });
  const spurs = R.spurs.map((s) => ({ from: s.from, apex: s.apex, to: s.to, barrierId: s.gate < R.gates.length ? R.gates[s.gate].id : null }));
  const vertices: number[] = [];
  for (let k = 0; k < G.eCount; k++) vertices.push(G.eWp[k]);
  const gi = G.goalVertex;
  return {
    waypoints: R.n,
    routeMeters: R.cum[R.n - 1],
    gates,
    spurs,
    effective: { vertices, goal: gi, goalPosition: G.eCount > 0 ? { x: G.ex[gi], y: G.ey[gi], z: G.ez[gi] } : null },
  };
}
