/** Enemy creation, AI decisions/firing, movement and enemy bullets. OWNER: enemy agent. SPEC §2.1, §2.3 */
import { ENEMIES, PLAYER, SIM } from '../config';
import { solveConstantSpeedIntercept } from './ballistics';
import { damagePlayer, pushEvent } from './combat';
import { DEG2RAD, clamp, clone, cross, distance, normalize, scale, sub } from './math';
import { NAV, getNav } from './nav';
import type { Nav, NavPath, PathJob } from './nav';
import type { Rng } from './rng';
import type { EnemyBullet, EnemyState, GameState, IWorld, RayHit, StageDef, V3 } from './types';

/** time comparison tolerance (docs/ARCH.md §3) */
const EPS = 1e-9;
/** enemies farther than sensorRange + this (and not alert) skip the line-of-sight test (they cannot attack anyway) */
const PERCEPTION_MARGIN = 1;
/** nodes the nav flood-fill from the guard spawns may create per tick (only while Game.warmup() has not done it before the sortie) */
const WARM_CELLS_PER_TICK = 256;
/** path planning work (nav work units: 1 = one A* node expansion, docs in nav.ts) all guards together may spend per tick. One search can
 *  take up to ~8500 expansions (2-6 ms); a search that does not fit is continued on the following ticks (see Planner), so one tick
 *  never carries more than about this much: 4000 units are 1-1.5 ms (a 120 Hz tick has 8.3 ms). Measured on the worst case (all 30
 *  guards asking for a search that covers their whole region at once): tick p99 1.4 ms / max 1.7 ms, and every guard has its path
 *  after 0.34 s at the latest (2500: 1.1 / 1.4 ms and 0.54 s; 6000: 2.0 / 2.6 ms and 0.23 s), well inside the 0.5 s reaction of
 *  SPEC 2.3, during which a guard follows its old path or steers toward the goal by itself */
export const PLAN_WORK_PER_TICK = 4000;
/** a followed path is replanned after this long / when its goal has moved this far */
const PATH_REPLAN_SECONDS = 1;
const PATH_GOAL_DRIFT = 6;
const PLAN_MIN_GAP = 0.25;
/** the last search found nothing better than standing here (no route / goal unreachable): searching the whole reachable region is
 *  costly, so ask less often */
const PLAN_BACKOFF = 1.5;
/** A* expansion cap of the AI's queries (~15k nodes = about 60 000 m^2 around the guard); an exhausted search still yields a partial path */
const PLAN_MAX_EXPANSIONS = 15000;
/** heuristic weight of the AI's queries (fewer expansions, paths at most ~25 % longer before smoothing) */
const PLAN_WEIGHT = 1.25;
const WAYPOINT_RADIUS = 0.4;
/** a waypoint this close is always reached (larger than one tick of the fastest walk, 8 m/s * dt = 0.067 m: no overshooting past it) */
const WAYPOINT_EXACT = 0.15;
/** a guard that reached the last known position (or its post) stops within this horizontal distance */
const ARRIVE_RADIUS = 1.5;
const HOME_RADIUS = 0.6;
/** while LOS is held a guard re-shares the sighting at most this often */
const SHARE_INTERVAL = 1;
/** strafe direction flips after 1.2 .. 2.5 s */
const STRAFE_FLIP_MIN = 1.2;
const STRAFE_FLIP_SPAN = 1.3;
/** a guard that was commanded to move but made < 30 % of the speed for this long re-plans / flips */
const STUCK_SECONDS = 0.4;
/** vertical slew of the hit-center when the floor height changes (steps) [m/s] */
const Y_SLEW = 8;
/** local steering: probe distance = max(min, speed * seconds); tried heading offsets [rad] */
const STEER_LOOK_MIN = 2.5;
const STEER_LOOK_SECONDS = 0.4;
const STEER_ANGLES: readonly number[] = [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6];
/** while heading for a goal without a path, deviate at most this far from the direct line [rad] */
const STEER_GOAL_MAX_ANGLE = 0.9;
/** a guard that reached the remembered position without sight sweeps sideways across it, this far to each side [m] */
const SEARCH_SWEEP_RADIUS = 5;
/** ...and looks around for this long on arrival and at each end of the sweep (shorter than the 0.5 s reaction time: never a freeze) */
const SEARCH_PAUSE_SECONDS = 0.3;
/** a guard spawned closer than its body clearance to a wall is moved at most this far to the nearest spot it can walk from */
const SPAWN_FIX_DISTANCE = 6;
/** guards closer than this (horizontally) push each other apart while moving */
const SEPARATION_RADIUS = 2.6;
const SEPARATION_GAIN = 0.6;
/** patrol walking speed = strafe speed * this */
const PATROL_SPEED_FACTOR = 0.5;

type AiMode = 'idle' | 'patrol' | 'return' | 'chase' | 'strafe' | 'retreat' | 'search';

/** module-private per-enemy AI bookkeeping (stored in EnemyState.internal.ai) */
export interface EnemyAI {
  /** false when no floor could be found under the spawn: the guard then behaves like a turret */
  movable: boolean;
  /** spawn hit-center */
  home: V3;
  /** feet-level height of the floor under the enemy (guards) */
  floorY: number;
  patrol: V3[] | null;
  patrolIdx: number;
  // awareness
  /** player hit-center at the last confirmation (own line of sight, or a shared sighting) */
  lastKnownPos: V3 | null;
  lastSeenAt: number;
  prevLos: boolean;
  lastShareAt: number;
  // attack schedule (game time). nextBurstAt is never reset by an occlusion.
  nextBurstAt: number | null;
  /** scheduled start of the burst in progress (null when none) */
  burstStart: number | null;
  burstShot: number;
  telegraphSent: boolean;
  // movement
  cmdVx: number;
  cmdVz: number;
  blockedTime: number;
  strafeSign: 1 | -1;
  strafeFlipAt: number;
  path: V3[] | null;
  pathIdx: number;
  pathGoal: V3 | null;
  pathAt: number;
  nextPlanAt: number;
  mode: AiMode;
  /** sweep across the remembered position after arriving there without sight (null when not sweeping): centre, unit axis, arrival direction, current side */
  sweep: { cx: number; cz: number; ax: number; az: number; ux: number; uz: number; sign: 1 | -1; resumeAt: number } | null;
}

/** AI bookkeeping of an enemy (undefined before its first decision tick and for scripted dummies) */
export function getEnemyAI(e: EnemyState): EnemyAI | undefined {
  return e.internal.ai as EnemyAI | undefined;
}

export function createEnemies(stage: StageDef): EnemyState[] {
  return stage.enemies.map((sp) => {
    const cfg = ENEMIES[sp.kind];
    return {
      id: sp.id,
      kind: sp.kind,
      isGateControl: sp.isGateControl,
      controlIndex: sp.controlIndex,
      barrierId: sp.barrierId,
      sectorId: sp.sectorId,
      pos: clone(sp.pos),
      prevPos: clone(sp.pos),
      vel: { x: 0, y: 0, z: 0 },
      yaw: sp.yaw,
      hitRadius: cfg.hitRadius,
      maxHp: cfg.hp,
      hp: cfg.hp,
      alive: true,
      alert: false,
      hasLineOfSight: false,
      shotsFired: 0,
      lastShotAt: null,
      telegraph: 0,
      hitFlash: 0,
      scripted: false,
      internal: sp.patrol && sp.patrol.length > 0 ? { patrol: sp.patrol.map(clone) } : {},
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// navigation warm-up
// ---------------------------------------------------------------------------------------------------------------------
interface NavWarm {
  /** the guard spawns are queued for the flood-fill and the trial searches are listed */
  seeded: boolean;
  /** flood-fill finished */
  filled: boolean;
  /** trial searches still to run (results are thrown away) and the one in progress */
  trials: { from: V3; to: V3 }[];
  trialJob: PathJob | null;
  /** everything done */
  done: boolean;
}
const navWarm = new WeakMap<Nav, NavWarm>();
/** nodes one nav.warm() call creates while Game.warmup() spends its budget (a budget unit is about one node) */
const WARM_CHUNK = 1024;

/**
 * Build the guards' navigation grid before the sortie instead of during the first ticks of the game (Game.warmup): the nav is created,
 * the region around every guard spawn is flood-filled completely (~110 000 nodes on the real stage, about 100 ms in total: the lazy way
 * spends it as a 3-27 ms hitch on the first tick plus 256 nodes on each of the next ~190 ticks), then the searches the game asks for
 * first (a patrolling guard's walk to its first waypoint, planned by nearly every guard in the first ticks) are run once so that the
 * search code is compiled and the nodes around the goals exist before the first tick.
 * It only fills a cache that the game would have filled with the same content anyway (nodes depend on the static geometry only,
 * barriers are read at query time), so the game state and every decision after the sortie are identical with and without it.
 * Idempotent; `maxWork` bounds one call so a caller can spread the work over idle time. Returns true when everything is done.
 */
export function warmNavigation(world: IWorld, stage: StageDef, maxWork = Infinity): boolean {
  if (!stage.enemies.some((sp) => sp.kind === 'guard')) return true; // nothing plans paths
  const nav = getNav(world, stage);
  let w = navWarm.get(nav);
  if (!w) {
    w = { seeded: false, filled: false, trials: [], trialJob: null, done: false };
    navWarm.set(nav, w);
  }
  if (w.done) return true;
  if (!w.seeded) {
    w.seeded = true;
    for (const sp of stage.enemies) {
      if (sp.kind !== 'guard') continue;
      const spot = spawnSpot(nav, sp.pos);
      if (!spot) continue;
      nav.seed({ x: spot.x, y: spot.y, z: spot.z });
      // the walk to the first patrol waypoint the guard is not standing at (waypoints are resolved to floor points as createAI does)
      for (const wp of sp.patrol ?? []) {
        if (Math.hypot(wp.x - spot.x, wp.z - spot.z) < ARRIVE_RADIUS) continue;
        const f = nav.floorBelow(wp.x, wp.z, wp.y - ENEMIES.guard.centerHeight, 2) ?? nav.floorBelow(wp.x, wp.z, wp.y, 2);
        if (f !== null) w.trials.push({ from: { x: spot.x, y: spot.y, z: spot.z }, to: { x: wp.x, y: f, z: wp.z } });
        break;
      }
    }
  }
  let left = maxWork;
  while (!w.filled && left > 0) {
    const n = Math.min(left, WARM_CHUNK);
    if (nav.warm(n) === 0 || nav.stats().cells >= NAV.MAX_CELLS) w.filled = true;
    left -= n;
  }
  while (w.filled && left > 0 && (w.trialJob !== null || w.trials.length > 0)) {
    if (w.trialJob === null) {
      const t = w.trials.shift() as { from: V3; to: V3 };
      w.trialJob = nav.beginPath(t.from, t.to, { partial: true, maxExpansions: PLAN_MAX_EXPANSIONS, weight: PLAN_WEIGHT });
    }
    const job = w.trialJob;
    const before = job.work;
    const finished = job.step(left);
    left -= job.work - before;
    if (finished) w.trialJob = null;
  }
  w.done = w.filled && w.trialJob === null && w.trials.length === 0;
  return w.done;
}

/** Muzzle world position of an enemy (renderer uses the same function for muzzle flashes). */
export function enemyMuzzlePosition(e: EnemyState): V3 {
  return { x: e.pos.x, y: e.pos.y + 0.4, z: e.pos.z };
}

// ---------------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------------
const yawToward = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

interface Ctx {
  state: GameState;
  world: IWorld;
  nav: Nav | null;
  T: number;
  plans: Planner;
}

// ---------------------------------------------------------------------------------------------------------------------
// path planning (incremental)
// ---------------------------------------------------------------------------------------------------------------------
/** one guard's path search, waiting in the planner or running as a nav PathJob (started when it reaches the head of the queue) */
interface PlanRequest {
  e: EnemyState;
  ai: EnemyAI;
  /** feet point the guard asked a path to */
  goal: V3;
  job: PathJob | null;
}

/**
 * Guards ask for paths; the planner serves the requests first come first served, spending at most PLAN_WORK_PER_TICK nav work units per
 * tick. Every request runs as a nav PathJob, which yields the path findPath would (same search, nav.ts). A search that fits the budget
 * finishes inside the tick that asked for it, like a plain findPath; a big one (a goal nobody can reach makes the search cover the
 * guard's whole region: ~8500 nodes) is continued over the next ticks, while the guard keeps following its old path or steers toward the
 * goal on its own. Nothing here depends on real time, so the result is the same on every machine.
 * The queue and the jobs (which hold nav cells) are not part of the game state: they hang off it in a WeakMap, so a new state (retry)
 * starts empty and a state that is dumped / compared stays plain data.
 */
interface Planner {
  queue: PlanRequest[];
  /** work still available this tick */
  budget: number;
}
const planners = new WeakMap<GameState, Planner>();
/** the request a guard is waiting for (at most one) */
const requestOf = new WeakMap<EnemyAI, PlanRequest>();

function plannerOf(state: GameState): Planner {
  let pl = planners.get(state);
  if (!pl) {
    pl = { queue: [], budget: 0 };
    planners.set(state, pl);
  }
  return pl;
}

/** a guard has this path when the search finishes: same bookkeeping as a planning that returned at once */
function applyPlan(ai: EnemyAI, res: NavPath | null, T: number): void {
  if (res) {
    ai.path = res.points;
    ai.pathIdx = 0;
    ai.nextPlanAt = T + PLAN_MIN_GAP;
  } else {
    ai.path = null;
    ai.nextPlanAt = T + PLAN_BACKOFF;
  }
}

/** serve the queue until the tick's work budget is spent (a job in progress is continued first) */
function pumpPlans(ctx: Ctx): void {
  const pl = ctx.plans;
  const nav = ctx.nav;
  if (nav === null) return;
  while (pl.queue.length > 0 && pl.budget > 0) {
    const r = pl.queue[0];
    if (!r.e.alive) {
      pl.queue.shift();
      requestOf.delete(r.ai);
      continue;
    }
    if (r.job === null) r.job = nav.beginPath(feetOf(r.e, r.ai), r.goal, { partial: true, maxExpansions: PLAN_MAX_EXPANSIONS, weight: PLAN_WEIGHT });
    const before = r.job.work;
    const done = r.job.step(pl.budget);
    pl.budget -= r.job.work - before;
    if (!done) return;
    pl.queue.shift();
    requestOf.delete(r.ai);
    applyPlan(r.ai, r.job.result, ctx.T);
  }
}

function requestPlan(ctx: Ctx, e: EnemyState, ai: EnemyAI, goal: V3): void {
  const r: PlanRequest = { e, ai, goal: { x: goal.x, y: goal.y, z: goal.z }, job: null };
  requestOf.set(ai, r);
  ctx.plans.queue.push(r);
  pumpPlans(ctx); // a search that fits in what is left of this tick's budget is done before the guard moves
}

/** the guard drops its path for good (a shared sighting, stuck, the alert is over): a search that is running for the old goal is abandoned.
 *  One that has not started keeps its place in the queue and takes the guard's next goal (see chase) */
function cancelPlan(ctx: Ctx, ai: EnemyAI): void {
  const r = requestOf.get(ai);
  if (r === undefined || r.job === null) return;
  requestOf.delete(ai);
  const i = ctx.plans.queue.indexOf(r);
  if (i >= 0) ctx.plans.queue.splice(i, 1);
}

/** where a guard spawned at hit-center `pos` stands: the feet point (floor height), or null when there is no floor. A spawn that is
 *  tighter than the body clearance is moved to the nearest spot where the guard can stand and walk (`moved`). Pure nav queries */
function spawnSpot(nav: Nav, pos: V3): { x: number; y: number; z: number; moved: boolean } | null {
  const cfg = ENEMIES.guard;
  const floor = nav.floorBelow(pos.x, pos.z, pos.y - cfg.centerHeight, 6);
  if (floor !== null) return { x: pos.x, y: floor, z: pos.z, moved: false };
  const spot = nav.nearestFree(pos.x, pos.z, pos.y - cfg.centerHeight, SPAWN_FIX_DISTANCE);
  return spot ? { x: spot.x, y: spot.y, z: spot.z, moved: true } : null;
}

function createAI(state: GameState, e: EnemyState, nav: Nav | null): EnemyAI {
  const cfg = ENEMIES[e.kind];
  let floor: number | null = null;
  if (e.kind === 'guard' && nav) {
    const spot = spawnSpot(nav, e.pos);
    if (spot) {
      if (spot.moved) {
        e.pos = { x: spot.x, y: spot.y + cfg.centerHeight, z: spot.z };
        e.prevPos = clone(e.pos);
      }
      floor = spot.y;
      nav.seed({ x: e.pos.x, y: floor, z: e.pos.z });
    }
  }
  let patrol: V3[] | null = null;
  const raw = e.internal.patrol as V3[] | undefined;
  if (raw && nav && e.kind === 'guard') {
    patrol = [];
    for (const w of raw) {
      // waypoints are hit-center heights like the spawn position; tolerate feet-level ones too
      const f = nav.floorBelow(w.x, w.z, w.y - cfg.centerHeight, 2) ?? nav.floorBelow(w.x, w.z, w.y, 2);
      if (f !== null) patrol.push({ x: w.x, y: f, z: w.z });
    }
    if (patrol.length === 0) patrol = null;
  }
  const ai: EnemyAI = {
    movable: floor !== null,
    home: clone(e.pos),
    floorY: floor ?? e.pos.y - cfg.centerHeight,
    patrol,
    patrolIdx: 0,
    lastKnownPos: null,
    lastSeenAt: -Infinity,
    prevLos: false,
    lastShareAt: -Infinity,
    nextBurstAt: null,
    burstStart: null,
    burstShot: 0,
    telegraphSent: false,
    cmdVx: 0,
    cmdVz: 0,
    blockedTime: 0,
    strafeSign: 1,
    strafeFlipAt: Infinity,
    path: null,
    pathIdx: 0,
    pathGoal: null,
    pathAt: -Infinity,
    nextPlanAt: 0,
    mode: 'idle',
    sweep: null,
  };
  if (e.kind === 'guard') {
    ai.strafeSign = state.rng.next() < 0.5 ? 1 : -1;
    ai.strafeFlipAt = state.time + STRAFE_FLIP_MIN + STRAFE_FLIP_SPAN * state.rng.next();
  }
  e.internal.ai = ai;
  return ai;
}

/** random direction inside a cone of half angle `maxRad` around unit vector d (never exceeds maxRad) */
function jitterDirection(d: V3, maxRad: number, rng: Rng): V3 {
  const { azimuth, polar } = rng.cone(maxRad);
  if (!(polar > 0)) return d;
  const helper: V3 = Math.abs(d.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalize(cross(d, helper));
  const w = cross(d, u);
  const sp = Math.sin(polar);
  const cp = Math.cos(polar);
  const ca = Math.cos(azimuth);
  const sa = Math.sin(azimuth);
  return normalize({
    x: d.x * cp + (u.x * ca + w.x * sa) * sp,
    y: d.y * cp + (u.y * ca + w.y * sa) * sp,
    z: d.z * cp + (u.z * ca + w.z * sa) * sp,
  });
}

/** Spawn one enemy bullet at time T: intercept aim from the CURRENT player position/velocity (only called with line of sight). */
function fireShot(state: GameState, e: EnemyState, T: number): void {
  const cfg = ENEMIES[e.kind];
  const muzzle = enemyMuzzlePosition(e);
  const p = state.player;
  const sol = solveConstantSpeedIntercept(muzzle, p.pos, p.vel, cfg.bulletSpeed, ENEMIES.MAX_PREDICT_T);
  const aim = sol ? sol.direction : normalize(sub(p.pos, muzzle));
  const dir = jitterDirection(aim, ENEMIES.MAX_AIM_JITTER_DEG * DEG2RAD, state.rng);
  const bullet: EnemyBullet = {
    id: state.nextProjectileId++,
    ownerId: e.id,
    kind: e.kind,
    pos: clone(muzzle),
    prevPos: clone(muzzle),
    vel: scale(dir, cfg.bulletSpeed),
    age: 0,
    maxLife: cfg.bulletLife,
    damage: cfg.damage,
    radius: cfg.bulletRadius,
    alive: true,
  };
  state.enemyBullets.push(bullet);
  e.shotsFired += 1;
  e.lastShotAt = T;
  pushEvent(state, { type: 'enemyFire', time: T, id: e.id, kind: e.kind, origin: clone(muzzle), dir: clone(dir) });
}

/**
 * Attack schedule (SPEC §2.3). Everything is keyed on game time; nextBurstAt survives occlusions:
 *  - first line of sight at t0            -> nextBurstAt = t0 + firstAttackDelay
 *  - re-acquired line of sight at tr      -> nextBurstAt = max(nextBurstAt, tr + telegraph)  (the telegraph window is fully visible)
 *  - burst start = nextBurstAt; next burst = this start + burstPeriod (the telegraph lives INSIDE the period)
 *  - every shot is fired only if the muzzle has a valid line of sight at its fire time; losing it abandons the burst in progress
 */
function updateAttack(state: GameState, e: EnemyState, ai: EnemyAI, los: boolean, T: number): void {
  const cfg = ENEMIES[e.kind];
  if (!los) {
    ai.burstStart = null;
    ai.burstShot = 0;
    ai.telegraphSent = false;
    e.telegraph = 0;
    return;
  }
  if (!ai.prevLos) {
    if (ai.nextBurstAt === null) ai.nextBurstAt = T + cfg.firstAttackDelay;
    else ai.nextBurstAt = Math.max(ai.nextBurstAt, T + cfg.telegraph);
    ai.telegraphSent = false;
  }

  if (ai.burstStart === null && ai.nextBurstAt !== null && T + EPS >= ai.nextBurstAt) {
    ai.burstStart = ai.nextBurstAt;
    ai.nextBurstAt = ai.burstStart + cfg.burstPeriod;
    ai.burstShot = 0;
    ai.telegraphSent = false;
    e.telegraph = 0;
  }
  if (ai.burstStart !== null) {
    while (ai.burstShot < cfg.burstShots && T + EPS >= ai.burstStart + ai.burstShot * cfg.burstShotInterval) {
      fireShot(state, e, T);
      ai.burstShot += 1;
    }
    if (ai.burstShot >= cfg.burstShots) {
      ai.burstStart = null;
      ai.burstShot = 0;
    }
    e.telegraph = 0;
    return;
  }

  // telegraph window [nextBurstAt - telegraph, nextBurstAt]
  const tgStart = (ai.nextBurstAt as number) - cfg.telegraph;
  if (T + EPS >= tgStart) {
    e.telegraph = clamp((T - tgStart) / cfg.telegraph, 0, 1);
    if (!ai.telegraphSent) {
      ai.telegraphSent = true;
      pushEvent(state, { type: 'enemyTelegraph', time: T, id: e.id });
    }
  } else {
    e.telegraph = 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// guard movement decisions
// ---------------------------------------------------------------------------------------------------------------------
const feetOf = (e: EnemyState, ai: EnemyAI): V3 => ({ x: e.pos.x, y: ai.floorY, z: e.pos.z });

function stop(ai: EnemyAI): void {
  ai.cmdVx = 0;
  ai.cmdVz = 0;
}

/** command `speed` along heading (dx, dz) (need not be unit); tries nearby headings when the way is not free. */
function steer(ctx: Ctx, e: EnemyState, ai: EnemyAI, dx: number, dz: number, speed: number, prefer: 1 | -1, maxAngle = Infinity): boolean {
  const nav = ctx.nav as Nav;
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-9) || !(speed > 0)) {
    stop(ai);
    return false;
  }
  const ux = dx / len;
  const uz = dz / len;
  const look = Math.max(STEER_LOOK_MIN, speed * STEER_LOOK_SECONDS);
  const feet = feetOf(e, ai);
  for (const ang of STEER_ANGLES) {
    if (Math.abs(ang) > maxAngle) break;
    const a = ang * prefer;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const vx = ux * c - uz * s;
    const vz = ux * s + uz * c;
    if (nav.walkProbe(feet, feet.x + vx * look, feet.z + vz * look) !== null) {
      ai.cmdVx = vx * speed;
      ai.cmdVz = vz * speed;
      return true;
    }
  }
  stop(ai);
  return false;
}

/**
 * Step the path index past the waypoints the guard has reached. A waypoint counts as reached within WAYPOINT_EXACT, or within
 * WAYPOINT_RADIUS when the straight walk from here to the next waypoint is as clear as the planner demands (nav.canStep with the
 * planning clearance): the corner is cut only as far as that stays safe, so the guard never turns onto a leg it cannot walk from
 * its cut position (a wall corner or a rim within the body clearance) and creep along the obstacle for the rest of the leg.
 * The last waypoint is reached within WAYPOINT_RADIUS.
 */
function advanceWaypoints(nav: Nav, ai: EnemyAI, pts: V3[], feet: V3): void {
  while (ai.pathIdx < pts.length) {
    const w = pts[ai.pathIdx];
    const d = Math.hypot(w.x - feet.x, w.z - feet.z);
    if (d >= WAYPOINT_RADIUS) return;
    const next = ai.pathIdx + 1 < pts.length ? pts[ai.pathIdx + 1] : null;
    if (next !== null && d >= WAYPOINT_EXACT && !nav.canStep(feet, next)) return;
    ai.pathIdx++;
  }
}

/** walk the nav path to goal (feet point) at `speed`; plans (throttled) when there is no fresh path */
function chase(ctx: Ctx, e: EnemyState, ai: EnemyAI, goal: V3, speed: number): void {
  const nav = ctx.nav as Nav;
  const T = ctx.T;
  const feet = feetOf(e, ai);
  // a guard waits for at most one search, meanwhile it follows its old path (or steers on its own). One that has not started takes the
  // goal the guard has now and keeps its place in the queue: a fast-moving player must not send the guard to the back of the line again
  // and again (it would never get a path). One that has started finishes (a few ticks); the next request then sees the goal moved
  const pending = requestOf.get(ai);
  if (pending !== undefined) {
    if (pending.job === null) {
      pending.goal = { x: goal.x, y: goal.y, z: goal.z };
      ai.pathGoal = { x: goal.x, y: goal.y, z: goal.z };
    }
  } else {
    const stale =
      ai.path === null ||
      ai.pathIdx >= ai.path.length || // walked to the end (of a partial path): look again from here
      ai.pathGoal === null ||
      Math.hypot(goal.x - ai.pathGoal.x, goal.z - ai.pathGoal.z) > PATH_GOAL_DRIFT ||
      T - ai.pathAt >= PATH_REPLAN_SECONDS - EPS;
    if (stale && T + EPS >= ai.nextPlanAt) {
      ai.pathAt = T;
      ai.pathGoal = { x: goal.x, y: goal.y, z: goal.z };
      requestPlan(ctx, e, ai, goal);
    }
  }
  const pts = ai.path;
  if (pts) {
    advanceWaypoints(nav, ai, pts, feet);
    if (ai.pathIdx >= pts.length) {
      stop(ai); // reached the end of the path (goal, or the closest reachable point)
      return;
    }
    const w = pts[ai.pathIdx];
    const dx = w.x - feet.x;
    const dz = w.z - feet.z;
    const d = Math.hypot(dx, dz);
    ai.cmdVx = (dx / d) * speed;
    ai.cmdVz = (dz / d) * speed;
    return;
  }
  // no path (yet): head for the goal with local steering so the guard does not wait for the planner; only headings that make
  // progress toward the goal are tried, so it stops instead of sliding back and forth along a wall
  if (Math.hypot(goal.x - feet.x, goal.z - feet.z) > ARRIVE_RADIUS) steer(ctx, e, ai, goal.x - feet.x, goal.z - feet.z, speed, ai.strafeSign, STEER_GOAL_MAX_ANGLE);
  else stop(ai);
}

/** engaged guard (has line of sight): band behaviour of SPEC §2.3 */
function engage(ctx: Ctx, e: EnemyState, ai: EnemyAI): void {
  const cfg = ENEMIES.guard;
  const p = ctx.state.player.pos;
  const T = ctx.T;
  const dx = p.x - e.pos.x;
  const dy = p.y - e.pos.y;
  const dz = p.z - e.pos.z;
  const dh = Math.hypot(dx, dz);
  const d = Math.hypot(dh, dy);
  // unit horizontal direction toward the player (any axis when directly above/below)
  const ux = dh > 1e-6 ? dx / dh : 1;
  const uz = dh > 1e-6 ? dz / dh : 0;

  if (d > cfg.farDist) {
    ai.mode = 'chase';
    chase(ctx, e, ai, { x: p.x, y: p.y - PLAYER.HALF.y, z: p.z }, cfg.approachSpeed);
    return;
  }

  if (T + EPS >= ai.strafeFlipAt) {
    ai.strafeSign = ai.strafeSign === 1 ? -1 : 1;
    ai.strafeFlipAt = T + STRAFE_FLIP_MIN + STRAFE_FLIP_SPAN * ctx.state.rng.next();
  }
  const sign = ai.strafeSign;
  const tx = -uz * sign;
  const tz = ux * sign;

  if (d >= cfg.midDist) {
    // lateral move at strafeSpeed; drifting toward a band edge adds a small radial correction
    ai.mode = 'strafe';
    let bx = tx;
    let bz = tz;
    if (d > cfg.farDist - 5) {
      const w = (d - (cfg.farDist - 5)) / 5;
      bx += ux * w;
      bz += uz * w;
    } else if (d < cfg.midDist + 5) {
      const w = (cfg.midDist + 5 - d) / 5;
      bx -= ux * w;
      bz -= uz * w;
    }
    if (!steer(ctx, e, ai, bx, bz, cfg.strafeSpeed, sign)) {
      ai.strafeSign = sign === 1 ? -1 : 1; // blocked: switch side
      ai.strafeFlipAt = T + STRAFE_FLIP_MIN + STRAFE_FLIP_SPAN * ctx.state.rng.next();
    }
    return;
  }

  if (d >= cfg.nearDist) {
    // 15..25 m: blend from the 6 m/s strafe (at 25 m) to the 8 m/s retreat (at 15 m)
    ai.mode = 'retreat';
    const u = (cfg.midDist - d) / (cfg.midDist - cfg.nearDist);
    const vx = tx * cfg.strafeSpeed * (1 - u) - ux * cfg.retreatMaxSpeed * u;
    const vz = tz * cfg.strafeSpeed * (1 - u) - uz * cfg.retreatMaxSpeed * u;
    const sp = Math.min(cfg.retreatMaxSpeed, Math.hypot(vx, vz));
    if (!steer(ctx, e, ai, vx, vz, sp, sign)) {
      ai.strafeSign = sign === 1 ? -1 : 1;
    }
    return;
  }

  // < 15 m: back away at up to retreatMaxSpeed
  ai.mode = 'retreat';
  if (!steer(ctx, e, ai, -ux + tx * 0.3, -uz + tz * 0.3, cfg.retreatMaxSpeed, sign)) {
    ai.strafeSign = sign === 1 ? -1 : 1;
  }
}

/** unaware guard: walk the patrol loop, or return to / hold the post */
function idle(ctx: Ctx, e: EnemyState, ai: EnemyAI): void {
  const cfg = ENEMIES.guard;
  if (ai.patrol) {
    ai.mode = 'patrol';
    const w = ai.patrol[ai.patrolIdx % ai.patrol.length];
    if (Math.hypot(w.x - e.pos.x, w.z - e.pos.z) < ARRIVE_RADIUS) {
      ai.patrolIdx = (ai.patrolIdx + 1) % ai.patrol.length;
      stop(ai);
      return;
    }
    chase(ctx, e, ai, w, cfg.strafeSpeed * PATROL_SPEED_FACTOR);
    return;
  }
  const hx = ai.home.x - e.pos.x;
  const hz = ai.home.z - e.pos.z;
  if (Math.hypot(hx, hz) > HOME_RADIUS) {
    ai.mode = 'return';
    chase(ctx, e, ai, { x: ai.home.x, y: ai.home.y - cfg.centerHeight, z: ai.home.z }, cfg.strafeSpeed);
  } else {
    ai.mode = 'idle';
    stop(ai);
  }
}

/** keep the commanded speed but bend the heading away from guards that are too close (no stacking into one blob) */
function applySeparation(ctx: Ctx, e: EnemyState, ai: EnemyAI): void {
  const speed = Math.hypot(ai.cmdVx, ai.cmdVz);
  if (speed < 0.5) return;
  let px = 0;
  let pz = 0;
  for (const o of ctx.state.enemies) {
    if (o === e || o.kind !== 'guard' || !o.alive || o.scripted) continue;
    if (Math.abs(o.pos.y - e.pos.y) > 3) continue;
    const dx = e.pos.x - o.pos.x;
    const dz = e.pos.z - o.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= SEPARATION_RADIUS * SEPARATION_RADIUS) continue;
    if (d2 < 1e-8) {
      // exactly stacked: split by id so the two do not choose the same way
      const s = e.id < o.id ? 1 : -1;
      px += s;
      continue;
    }
    const d = Math.sqrt(d2);
    const w = 1 - d / SEPARATION_RADIUS;
    px += (dx / d) * w;
    pz += (dz / d) * w;
  }
  if (px === 0 && pz === 0) return;
  const hx = ai.cmdVx / speed + px * SEPARATION_GAIN;
  const hz = ai.cmdVz / speed + pz * SEPARATION_GAIN;
  const hl = Math.hypot(hx, hz);
  if (!(hl > 1e-9)) return;
  ai.cmdVx = (hx / hl) * speed;
  ai.cmdVz = (hz / hl) * speed;
}

function decideGuardMotion(ctx: Ctx, e: EnemyState, ai: EnemyAI, los: boolean): void {
  if (!ai.movable || ctx.nav === null) {
    stop(ai);
    return;
  }
  const T = ctx.T;
  if (ai.blockedTime > STUCK_SECONDS) {
    // commanded to move but pinned: drop the path and try the other side
    ai.blockedTime = 0;
    ai.path = null;
    ai.nextPlanAt = T;
    cancelPlan(ctx, ai);
    ai.strafeSign = ai.strafeSign === 1 ? -1 : 1;
  }
  if (los) {
    ai.sweep = null;
    engage(ctx, e, ai);
  } else if (e.alert && ai.lastKnownPos) {
    const lk = ai.lastKnownPos;
    ai.mode = 'search';
    const d = Math.hypot(lk.x - e.pos.x, lk.z - e.pos.z);
    // a sweep that has begun goes on while the guard is within its reach of the spot (it leaves the arrival radius at once)
    const sweeping = ai.sweep !== null && ai.sweep.cx === lk.x && ai.sweep.cz === lk.z && d <= ARRIVE_RADIUS + SEARCH_SWEEP_RADIUS + 1;
    if (d <= ARRIVE_RADIUS || sweeping) searchAround(ctx, e, ai, lk);
    else {
      ai.sweep = null;
      chase(ctx, e, ai, { x: lk.x, y: lk.y - PLAYER.HALF.y, z: lk.z }, ENEMIES.guard.approachSpeed);
    }
  } else {
    ai.sweep = null;
    idle(ctx, e, ai);
  }
  applySeparation(ctx, e, ai);
}

/**
 * Arrived at the remembered position without sight while the memory is still alive: do not stand there for the rest of it
 * (SPEC 2.3: keep trying to re-acquire the line of sight with sideways moves). Look around briefly, then sweep across the spot at
 * the strafe speed, perpendicular to the way the guard came in, SEARCH_SWEEP_RADIUS to each side, looking around again at each end.
 * The way is probed like any strafe (a blocked side is given up; when both sides are blocked - a corridor - the sweep runs along
 * the arrival axis); the guard only stands still when nothing around is walkable.
 */
function searchAround(ctx: Ctx, e: EnemyState, ai: EnemyAI, lk: V3): void {
  const T = ctx.T;
  let sw = ai.sweep;
  if (sw === null || sw.cx !== lk.x || sw.cz !== lk.z) {
    const dx = e.pos.x - lk.x;
    const dz = e.pos.z - lk.z;
    const d = Math.hypot(dx, dz);
    const ux = d > 1e-6 ? dx / d : 1;
    const uz = d > 1e-6 ? dz / d : 0;
    sw = { cx: lk.x, cz: lk.z, ax: -uz, az: ux, ux, uz, sign: ai.strafeSign, resumeAt: T + SEARCH_PAUSE_SECONDS };
    ai.sweep = sw;
  }
  if (T + EPS < sw.resumeAt) {
    stop(ai);
    return;
  }
  const off = (e.pos.x - sw.cx) * sw.ax + (e.pos.z - sw.cz) * sw.az;
  if (off * sw.sign > SEARCH_SWEEP_RADIUS) {
    // end of the sweep: look around, then head back across the spot
    sw.sign = sw.sign === 1 ? -1 : 1;
    sw.resumeAt = T + SEARCH_PAUSE_SECONDS;
    stop(ai);
    return;
  }
  const speed = ENEMIES.guard.strafeSpeed;
  for (const other of [false, true]) {
    const side = other ? (sw.sign === 1 ? -1 : 1) : sw.sign;
    if (!steer(ctx, e, ai, sw.ax * side, sw.az * side, speed, side, 0)) continue;
    sw.sign = side;
    return;
  }
  // both sides blocked (a corridor): sweep along the way the guard came in instead
  sw.ax = sw.ux;
  sw.az = sw.uz;
  stop(ai);
}

/** a guard has confirmed the player: hand the last confirmed position to guards linked by a walkable route of <= shareRadius */
function shareSighting(ctx: Ctx, sharer: EnemyState): void {
  const nav = ctx.nav;
  const sai = getEnemyAI(sharer);
  if (!nav || !sai || !sai.lastKnownPos) return;
  const cfg = ENEMIES.guard;
  const from = feetOf(sharer, sai);
  for (const o of ctx.state.enemies) {
    if (o === sharer || o.kind !== 'guard' || !o.alive || o.scripted || o.hasLineOfSight) continue;
    const oai = getEnemyAI(o);
    if (!oai || !oai.movable) continue;
    if (distance(o.pos, sharer.pos) > cfg.shareRadius) continue; // a route is never shorter than the straight line
    const len = nav.pathLength(from, feetOf(o, oai), cfg.shareRadius);
    if (len === null) continue;
    o.alert = true;
    oai.lastKnownPos = clone(sai.lastKnownPos);
    oai.lastSeenAt = ctx.T;
    oai.path = null;
    oai.nextPlanAt = ctx.T;
    cancelPlan(ctx, oai);
  }
}

/** Step A3 (state at T): LOS, awareness/memory/sharing, target selection, burst scheduling, spawn enemy bullets, set desired velocity. */
export function enemyDecisionStep(state: GameState, world: IWorld): void {
  const enemies = state.enemies;
  if (enemies.length === 0) return;
  const T = state.time;
  const player = state.player;

  let nav: Nav | null = null;
  for (const e of enemies) {
    if (e.kind === 'guard' && e.alive && !e.scripted) {
      nav = getNav(world, state.stage);
      break;
    }
  }
  if (nav) nav.warm(WARM_CELLS_PER_TICK);
  const plans = plannerOf(state);
  plans.budget = PLAN_WORK_PER_TICK;
  const ctx: Ctx = { state, world, nav, T, plans };
  pumpPlans(ctx); // continue the search that a previous tick could not finish
  const memory = ENEMIES.guard.memorySeconds;
  const sharers: EnemyState[] = [];

  for (const e of enemies) {
    if (e.scripted) {
      e.hasLineOfSight = false;
      e.telegraph = 0;
      continue;
    }
    if (!e.alive) continue;
    const cfg = ENEMIES[e.kind];
    const ai = getEnemyAI(e) ?? createAI(state, e, nav);

    // ---- perception: distance from the muzzle to the player hit-center + world occlusion. No camera, facing or player fire involved.
    let los = false;
    const cx = player.pos.x - e.pos.x;
    const cy = player.pos.y - e.pos.y;
    const cz = player.pos.z - e.pos.z;
    const reach = cfg.sensorRange + PERCEPTION_MARGIN;
    if (cx * cx + cy * cy + cz * cz <= reach * reach) {
      const muzzle = enemyMuzzlePosition(e);
      if (distance(muzzle, player.pos) <= cfg.sensorRange + EPS && !world.segmentBlocked(muzzle, player.pos)) los = true;
    }
    e.hasLineOfSight = los;

    // ---- awareness / memory (8 s). While occluded only lastKnownPos is used: the current position is never read.
    if (los) {
      ai.lastKnownPos = clone(player.pos);
      ai.lastSeenAt = T;
      e.alert = true;
      if (e.kind === 'guard' && (!ai.prevLos || T - ai.lastShareAt >= SHARE_INTERVAL - EPS)) {
        ai.lastShareAt = T;
        sharers.push(e);
      }
    } else if (e.alert && T - ai.lastSeenAt >= memory - EPS) {
      e.alert = false;
      ai.lastKnownPos = null;
      ai.path = null;
      ai.pathGoal = null;
      ai.nextPlanAt = T;
      cancelPlan(ctx, ai);
    }
    if (ai.prevLos && !los) {
      // line of sight lost (e.g. by strafing behind cover): try the other side next
      ai.strafeSign = ai.strafeSign === 1 ? -1 : 1;
    }

    // ---- attack schedule + shots
    updateAttack(state, e, ai, los, T);
    ai.prevLos = los;

    // ---- movement (guards) / facing
    if (e.kind === 'guard') decideGuardMotion(ctx, e, ai, los);
    if (los) e.yaw = yawToward(player.pos.x - e.pos.x, player.pos.z - e.pos.z);
    else if (ai.cmdVx !== 0 || ai.cmdVz !== 0) e.yaw = yawToward(ai.cmdVx, ai.cmdVz);
    else if (e.alert && ai.lastKnownPos) e.yaw = yawToward(ai.lastKnownPos.x - e.pos.x, ai.lastKnownPos.z - e.pos.z);
  }

  for (const s of sharers) shareSighting(ctx, s);
}

/** Step B2: integrate enemy motion T -> T+dt (scripted dummies: constant velocity; dead enemies never move). */
export function enemyIntegrate(state: GameState, world: IWorld): void {
  const dt = SIM.DT;
  let nav: Nav | null = null;
  for (const e of state.enemies) {
    if (!e.alive) {
      e.vel = { x: 0, y: 0, z: 0 };
      continue;
    }
    if (e.scripted) {
      // constant velocity; vel is the velocity actually used for the position update
      e.pos = { x: e.pos.x + e.vel.x * dt, y: e.pos.y + e.vel.y * dt, z: e.pos.z + e.vel.z * dt };
      continue;
    }
    if (e.kind === 'turret') {
      e.vel = { x: 0, y: 0, z: 0 };
      continue;
    }
    const ai = getEnemyAI(e);
    if (!ai || !ai.movable) {
      e.vel = { x: 0, y: 0, z: 0 };
      continue;
    }
    if (nav === null) nav = getNav(world, state.stage);

    const ox = e.pos.x;
    const oy = e.pos.y;
    const oz = e.pos.z;
    const vx = ai.cmdVx;
    const vz = ai.cmdVz;
    let nx = ox;
    let nz = oz;
    let nf = ai.floorY;
    if (vx !== 0 || vz !== 0) {
      let tx = ox + vx * dt;
      let tz = oz + vz * dt;
      let f = nav.floorAt(tx, tz, ai.floorY);
      if (f === null && vx !== 0 && vz !== 0) {
        // slide along the obstacle instead of pushing into it
        f = nav.floorAt(tx, oz, ai.floorY);
        if (f !== null) tz = oz;
        else {
          f = nav.floorAt(ox, tz, ai.floorY);
          if (f !== null) tx = ox;
        }
      }
      if (f !== null) {
        nx = tx;
        nz = tz;
        nf = f;
      }
    }
    ai.floorY = nf;
    const targetY = nf + ENEMIES.guard.centerHeight;
    const ny = Math.abs(targetY - oy) > 1e-9 ? oy + clamp(targetY - oy, -Y_SLEW * dt, Y_SLEW * dt) : oy;
    e.pos = { x: nx, y: ny, z: nz };
    e.vel = { x: (nx - ox) / dt, y: (ny - oy) / dt, z: (nz - oz) / dt };

    const want = Math.hypot(vx, vz);
    const got = Math.hypot(nx - ox, nz - oz) / dt;
    if (want > 0.5 && got < want * 0.3) ai.blockedTime += dt;
    else ai.blockedTime = 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// enemy bullets
// ---------------------------------------------------------------------------------------------------------------------
/**
 * Segment o + s*d (s in [0,1]) vs the box [lo, hi] (inclusive). Returns the entry parameter (0 when o is inside) or null.
 */
function segmentVsBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  hx: number, hy: number, hz: number,
): number | null {
  let tNear = 0;
  let tFar = 1;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const h = [hx, hy, hz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < -h[i] || o[i] > h[i]) return null;
    } else {
      let t1 = (-h[i] - o[i]) / d[i];
      let t2 = (h[i] - o[i]) / d[i];
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tNear) tNear = t1;
      if (t2 < tFar) tFar = t2;
      if (tNear > tFar) return null;
    }
  }
  return tNear;
}

/** Step B3 (enemy side): advance enemy bullets over [T, T+dt], swept vs world and the player's moving AABB. */
export function stepEnemyBullets(state: GameState, world: IWorld): void {
  const bullets = state.enemyBullets;
  if (bullets.length === 0) return;
  const dt = SIM.DT;
  const player = state.player;
  const pp = player.prevPos;
  const pdx = player.pos.x - pp.x;
  const pdy = player.pos.y - pp.y;
  const pdz = player.pos.z - pp.z;
  const H = PLAYER.HALF;

  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (!b.alive) continue;
    const remaining = b.maxLife - b.age;
    if (!(remaining > 0)) {
      b.alive = false; // lifetime exhausted
      continue;
    }
    const dtEff = Math.min(dt, remaining);
    const frac = dtEff / dt;
    const from = b.pos;
    const to: V3 = { x: from.x + b.vel.x * dtEff, y: from.y + b.vel.y * dtEff, z: from.z + b.vel.z * dtEff };
    const bdx = to.x - from.x;
    const bdy = to.y - from.y;
    const bdz = to.z - from.z;
    const len = Math.hypot(bdx, bdy, bdz);

    // world (static geometry): fraction of the segment travelled before contact
    let worldHit: RayHit | null = null;
    let sWorld = Infinity;
    if (len > 0) {
      worldHit = world.sweepSphere(from, to, b.radius);
      if (worldHit) sWorld = clamp(worldHit.t / len, 0, 1);
    }

    // player: motion relative to the player's AABB (which moved prevPos -> pos over the same interval)
    let sPlayer = Infinity;
    if (player.hp > 0) {
      const s = segmentVsBox(
        from.x - pp.x, from.y - pp.y, from.z - pp.z,
        bdx - pdx * frac, bdy - pdy * frac, bdz - pdz * frac,
        H.x + b.radius, H.y + b.radius, H.z + b.radius,
      );
      if (s !== null) sPlayer = s;
    }

    if (worldHit && sWorld <= sPlayer) {
      // stopped by wall / floor / equipment (the world wins ties: a wall in front of the player shields it)
      pushEvent(state, { type: 'hit', time: state.time, pos: worldHit.point, normal: worldHit.normal, on: 'world', weapon: 'enemy' });
      b.pos = { x: worldHit.point.x, y: worldHit.point.y, z: worldHit.point.z };
      b.prevPos = clone(from);
      b.age += dtEff;
      b.alive = false;
      continue;
    }
    if (sPlayer !== Infinity) {
      const hitPos: V3 = { x: from.x + bdx * sPlayer, y: from.y + bdy * sPlayer, z: from.z + bdz * sPlayer };
      // the shot came from where the bullet started its flight (straight line, no gravity)
      const origin: V3 = { x: from.x - b.vel.x * b.age, y: from.y - b.vel.y * b.age, z: from.z - b.vel.z * b.age };
      damagePlayer(state, b.damage, origin);
      pushEvent(state, { type: 'hit', time: state.time, pos: hitPos, normal: normalize({ x: -b.vel.x, y: -b.vel.y, z: -b.vel.z }), on: 'player', weapon: 'enemy' });
      b.pos = hitPos;
      b.prevPos = clone(from);
      b.age += dtEff;
      b.alive = false;
      continue;
    }

    b.prevPos = clone(from);
    b.pos = to;
    b.age += dtEff;
    if (b.age + EPS >= b.maxLife) b.alive = false; // the last interval was checked above, now it expires
  }

  // compact in place (the renderer may hold the array)
  let w = 0;
  for (let i = 0; i < bullets.length; i++) {
    if (bullets[i].alive) bullets[w++] = bullets[i];
  }
  bullets.length = w;
}
