/**
 * Enemy AI: guard robots and fixed turrets — perception, memory, alert sharing, movement, burst
 * scheduling with telegraph, predictive aim (docs/SPEC.md §2.3; docs/ARCHITECTURE.md §4 "enemies.ts").
 *
 * TIME MODEL
 *   `updateEnemies` runs at the END of every sub-step (sim.time = t1): perception, memory, alert
 *   sharing, the attack schedule (telegraph + shots due at t1) and the guards' movement decisions.
 *   `moveEnemies` then executes those decisions over the next sub-step. Every discrete instant of the
 *   attack schedule (telegraph start, each shot of a burst, the end of the memory) is reported through
 *   `enemiesNextEventTime`, so the scheduler ends a sub-step exactly there: shots happen at their exact
 *   times, not "on the next frame". Everything is in simulation time — a paused game advances nothing.
 *
 * PERCEPTION (every sub-step, every living non-passive enemy)
 *   hasLos = |enemy centre → player centre| <= range (90 m guard / 120 m turret)
 *            AND no stage box between enemyMuzzle() and the player's centre.
 *   Nothing else is consulted: not the camera, not the player's facing, not who fired first, not the HP.
 *   This is the ONLY way an enemy learns where the player is by itself. A hit by the player makes an enemy
 *   alert for the memory time (it knows it is under fire and a guard starts looking around its post), but it
 *   tells it no position: an enemy that is out of range or has no line of sight still does not know where
 *   the player is, whoever fired first.
 *
 * ATTACK SCHEDULE (independent per enemy; absolute times)
 *   first own sighting at t      → nextBurstReadyAt = t + firstShotDelay (0.50 / 0.70 s)
 *   burst start                  = max(nextBurstReadyAt, tNow + telegraph)   (whenever one is scheduled)
 *   telegraph window             = [burstStart − telegraph, burstStart)      ('enemy-telegraph' at its start)
 *   at the burst start           → nextBurstReadyAt = burstStart + burstPeriod (1.20 / 1.60 s)
 *   shot k of a burst            at burstStart + k · burstInterval (0.12 / 0.25 s), k < burstCount (3 / 2);
 *                                  fired only if hasLos at that instant, otherwise skipped (never counted)
 *   LOS lost before the start    → the scheduled burst is cancelled, nextBurstReadyAt is kept
 *   LOS lost during a burst      → the remaining shots are still attempted at their times (and skipped
 *                                  while hidden); nothing is scheduled afterwards
 *   re-exposure                  → burst start = max(nextBurstReadyAt, tNow + telegraph): the initial
 *                                  delay is NOT applied again. Only after the memory expired (8 s without
 *                                  any confirmation) does a sighting count as the first one again.
 *   The telegraph is inside the first delay and inside the period — it is never added on top.
 *
 * AIM (at the instant of each shot, from what the enemy sees at that instant)
 *   lead = solveLinearIntercept(muzzle, player.pos, player.vel, bulletSpeed, 1.2); without a solution the
 *   lead time is min(1.2, distance / bulletSpeed). A uniformly distributed angular error of at most 0.5°
 *   (two numbers from sim.rng) is applied, then the bullet flies straight (no gravity, no guidance).
 *
 * MEMORY / SHARING
 *   While seeing, lastKnownPlayerPos / lastKnownAt follow the player. After that the position is frozen
 *   (the hidden player is never looked at) and forgotten ENEMY_AI.memorySeconds after the last
 *   confirmation. A guard that sees the player reports that position (at most every 0.5 s) to every other
 *   living enemy — guard or turret — that is connected to it by at most ENEMY_AI.shareDistance of WALKABLE
 *   path: for a guard the path between the two, for a turret the path to the walkable spot at its foot plus
 *   the open hop from there to the turret (so a turret on a pedestal in the guard's room is told; one on a
 *   deck of its own, behind a wall or on another storey is not). A receiver is alerted and remembers the
 *   position; a guard walks there, a turret turns its barrel there; either can only shoot with its own line
 *   of sight, and its first own sighting still gets the full initial delay. Reports are not relayed.
 *
 * GUARD MOVEMENT (NavGrid only: never through solids or closed barriers, never off a ledge)
 *   seeing, distance > 55 m      approach at 8 m/s: along the path to the player; without any route to the
 *                                player's floor (a guard on a gallery, the player below) along its own floor
 *                                to the nearest spot within 55 m that still sees the player, or else to the
 *                                spot with a view that is nearest to the player; only when no spot is
 *                                nearer than where it stands does it strafe out there
 *   seeing, 25 – 55 m            strafe at 6 m/s on the circle around the player. The guard runs along
 *                                one side until, strafeLookAhead further on, the way stops being walkable,
 *                                free of other enemies or in view of the player (or a random change of side
 *                                is due) and then turns to the other side. A leg lasts at least
 *                                strafeMinLegSeconds: a guard that reaches the end of its side sooner stands
 *                                there, firing, for the rest of that time before it turns, a voluntary change
 *                                needs a full leg of room on the other side, and a fresh start takes the side
 *                                with more room — a guard never reverses again within a fraction of a second
 *                                (a lead-corrected shot needs about half a second to arrive at 50 m).
 *                                Strafing needs room: left run + right run ≥ strafeMinSpan. Where the circle
 *                                has none (a ledge that faces the player, a catwalk across the line of sight)
 *                                it sweeps a straight line within 30° of "sideways" instead, under the same
 *                                leg rule; where nothing offers the room (it sees the player through a narrow
 *                                gap) it stands and keeps firing instead of shuffling on the spot
 *   seeing, 15 – 25 m            back off diagonally at 6 m/s (lateral + away), pure strafe / pure retreat
 *                                when that is not possible; after a change of side it keeps to the new side
 *                                for sideLockSeconds (no zig-zag in a narrow view)
 *   seeing, < 15 m               retreat at 8 m/s (straight away, else the free bearing with the largest
 *                                away component, down to sliding sideways along a wall)
 *   seeing, no free bearing      stand and keep firing
 *   alert, not seeing            walk the path to the last known position at 8 m/s (starts on the very
 *                                next sub-step), then search around it at 6 m/s until the memory expires;
 *                                without a route to it: walk to the nearest spot of its own floor (by path)
 *                                that overlooks the position within its range, else to the spot of its
 *                                floor nearest to the position, else look around where it stands
 *   alert, no known position     (hit by the player without perceiving it) search around its own post
 *   not alert                    stand still
 *
 * OTHER ENEMIES IN THE WAY
 *   Guards keep ENEMY_TUNING.separationMargin between their hit spheres and those of all other enemies.
 *   Living turrets are static obstacles of the NavGrid (never planned through). Against another guard a
 *   step that would come too close is replaced by a tangential slide when the contact is glancing, and
 *   otherwise shortened so that the guard stops exactly at the separation distance (it never side-steps
 *   back and forth). A path follower that is held up like this re-plans AROUND the enemies near it
 *   (NavGrid avoidance); if there is no way round, an approach is dropped for a strafe and a chase waits
 *   and finally ends where the guard stands. As a last safeguard a guard whose direction reversed three
 *   times within oscillationWindow stands still for oscillationHold instead of trembling.
 *
 * Passive enemies (isolated-test targets) have no AI at all; dead enemies keep zero velocity.
 */
import { ENEMIES, ENEMY_AI, TIME_EPS } from '../config';
import { clone, copy, distance, distanceSq, set, v3, yawFromDir, type V3 } from '../core/vec';
import { solveLinearIntercept } from './ballistics';
import { VANTAGE_NONE, type NavDisc, type NavVantageOptions } from './nav';
import { spawnEnemyBullet } from './projectiles';
import type { Sim } from './sim';
import type { Box, EnemyState, StageDef } from './types';

// ───────────────────────────── tuning (behaviour that the spec leaves open) ─────────────────────────────

/** AI parameters that are not requirement numbers (those live in ENEMIES / ENEMY_AI of src/config.ts). */
export const ENEMY_TUNING = {
  /** A seeing guard reports the player's position at most this often (s). */
  shareInterval: 0.5,
  /** Free space kept between the hit spheres of a moving guard and any other enemy (m). */
  separationMargin: 0.4,
  /** A direction move (strafe / adjust / retreat) is re-validated this often (s): the allowed decision lag. */
  dirCheckInterval: ENEMY_AI.maxDecisionDelay,
  /** Look-ahead of a direction move (m) and the free run it needs to be chosen (m). */
  probeDistance: 2.5,
  minRun: 0.75,
  /** A strafe / back-off bearing is only taken if the player is still visible this far along it (m). */
  losLookAhead: 1,
  /**
   * Strafing needs room: the run to the left plus the run to the right that is walkable, free of other
   * enemies and keeps the line of sight (measured in steps of strafeRunStep along the circle around the
   * player) must add up to strafeMinSpan metres, and a side is only taken while it offers strafeMinLeg.
   * With less the guard stands and fires: a shorter sweep does not change the firing line, it only makes
   * the guard shuffle on the spot. The guard turns strafeLookAhead before the end of a side, so a sweep is
   * at least strafeMinSpan − 2 · strafeLookAhead long (2.5 m).
   *
   * A leg — the time between two changes of direction — lasts at least strafeMinLegSeconds. Where the room
   * is shorter than that (less than strafeMinLegSeconds × 6 m/s = 9 m) the guard runs to the end of its side
   * at the full strafe speed, stands there and fires for the rest of the leg time, and only then runs back:
   * the firing line still changes, but the guard does not flip its velocity every 0.4 s (which no
   * constant-velocity lead can follow: a machine-gun bullet needs 0.53 s for 52 m). A voluntary change of
   * side needs a full leg of room (9 m) on the other side and comes no sooner than strafeTurnGap seconds
   * after a turn; a guard that starts (or starts again after standing) takes the side with more room.
   */
  strafeMinSpan: 3.5,
  strafeMinLeg: 1.5,
  strafeLookAhead: 0.5,
  strafeRunStep: 0.25,
  strafeMinLegSeconds: 1.5,
  strafeTurnGap: 1.5,
  /**
   * Where the circle around the player offers no such room (a ledge that faces the player, a catwalk across
   * the line of sight) the guard sweeps a straight line instead: the most lateral of the lines at lineAngles
   * degrees from the bearing towards the player (all within 30° of "sideways") whose free, visible run —
   * both ways, up to lineReach metres each, in steps of lineStep — is at least strafeMinSpan long. The
   * search is repeated every lineRetry seconds while the guard has to stand. Lines that mostly lead towards
   * or away from the player are not taken: that would not be lateral movement.
   */
  lineAngles: [90, 75, 105, 60, 120],
  lineReach: 8,
  lineStep: 0.5,
  lineRetry: 0.5,
  /**
   * Back-off (15 – 25 m) and retreat (< 15 m): after the guard changed to the other side it keeps to that
   * side (or backs straight off, or stands) for this long (s) — no zig-zag in a narrow view.
   */
  sideLockSeconds: 0.5,
  /** A strafe side on which the guard was held up is left alone for this long (s). */
  strafeBlockedSeconds: 0.5,
  /** A direction move that makes less than half its speed for this long changes side (s). */
  dirStuckSeconds: 0.1,
  /** Voluntary strafe side change: uniformly distributed delay (s). */
  strafeSwitchMin: 1.6,
  strafeSwitchMax: 4.2,
  /** 15 – 25 m band: speed (m/s) and the bearing of the diagonal relative to the player (degrees from "towards"). */
  adjustSpeed: 6,
  adjustBearingDeg: 127,
  /** Approach: the path is re-planned when it is this old (s) and the player moved this far from its goal (m). */
  replanInterval: 0.4,
  replanGoalShift: 2,
  /**
   * Minimum time between two path searches of one guard (s), and the pause after a failed one. Both stay
   * below ENEMY_AI.reacquireStartSeconds, so a guard that lost sight is under way well within 0.5 s.
   */
  planMinGap: 0.1,
  planRetry: 0.4,
  /** A path follower that makes less than half its speed for this long re-plans (s). */
  pathStuckSeconds: 0.25,
  /** A new report within this distance of the current chase goal does not restart the chase (m). */
  sameGoalDistance: 0.5,
  /** Blocked by another enemy this close to the end of the chase path counts as arrived (m). */
  crowdArriveDistance: 6,
  /**
   * A path follower held up by other enemies plans around those within detourScan metres; the detour may be
   * detourFactor × the rest of the blocked path + detourExtra metres long. avoidSlack (m) is added to the
   * separation distance for planning (and for the turret obstacles of the NavGrid).
   */
  detourScan: 25,
  detourFactor: 2,
  detourExtra: 60,
  avoidSlack: 0.1,
  /** Held up with no way round for this long: a chase ends where the guard stands (s). */
  blockedGiveUp: 1.5,
  /** Held up with no way round while approaching: strafe, and try the approach again after this time (s). */
  approachBlockedRetry: 1,
  /** Searching around the last known position: radius (m), speed (m/s), longest leg (s). */
  searchRadius: 12,
  searchSpeed: 6,
  searchRepick: 5,
  /**
   * No route to the player's floor / to the last known position: the guard's own region is explored up to
   * vantageMaxCost metres of path for a spot with a clear line to the target.
   * Seeing (approach): a spot within approachWithin of the player; else the visible spot nearest to the player
   * if that is at least approachMinGain nearer than the guard stands; a failed search is repeated after
   * approachVantageRetry seconds (the guard strafes meanwhile).
   * Not seeing (chase): a spot within chaseWithin of the last known position (inside the guard's range);
   * else the spot nearest to that position if it is at least chaseMinGain nearer.
   */
  vantageMaxCost: 120,
  approachWithin: ENEMIES.guard.approachBeyond - 1,
  approachMinGain: 1,
  approachVantageRetry: 1,
  chaseWithin: ENEMIES.guard.range - 2,
  chaseMinGain: 2,
  /** Three direction reversals within oscillationWindow seconds: stand still for oscillationHold seconds. */
  oscillationWindow: 0.5,
  oscillationHold: 0.5,
  /**
   * Alert sharing with a turret: its foot is a walkable spot within this horizontal distance (m) that the
   * turret is "at" (open air level with the turret out to the spot and down to it: no wall, no floor between).
   */
  turretAccessRadius: 6,
  /** Largest vertical speed of the hit-sphere centre when the floor height changes (m/s). */
  yRate: 3,
} as const;

// ───────────────────────────── private per-enemy state ─────────────────────────────

export type GuardMode = 'idle' | 'approach' | 'strafe' | 'adjust' | 'retreat' | 'chase' | 'search' | 'hold';
type PathPurpose = 'none' | 'approach' | 'chase' | 'search';

const AI_TAG = 'ak2-enemy-ai';

const MOVE_NONE = 0;
/** Follow `path` from `pathIdx`. */
const MOVE_PATH = 1;
/** Run along (dirX, dirZ); with orbitR > 0 on the circle of that radius around the perceived player. */
const MOVE_DIR = 2;
/** Straight hop from a spawn point outside the walkable area to `hop` (the nearest node). */
const MOVE_HOP = 3;

const GRID_UNKNOWN = 0;
const GRID_ON = 1;
const GRID_OFF = 2;
const GRID_NONE = 3;

const STUCK_NONE = 0;
const STUCK_NAV = 1;
const STUCK_ENEMY = 2;

/** "Never yet" for the clocks added to the AI state after the first version: finite, far before any sortie time. */
const LONG_AGO = -1e6;

/** Module-private state stored in `enemy.ai` (read it through `getEnemyAi` in tests / debug views). */
export interface EnemyAi {
  tag: typeof AI_TAG;

  // ── awareness and attack schedule (guards and turrets) ──
  /** True once the first-sighting delay of the current awareness period has been applied. */
  engaged: boolean;
  /** Time of the first own sighting of the current awareness period. */
  firstSightAt: number | null;
  /** Time the current uninterrupted line of sight began (null while there is none). */
  losSince: number | null;
  /** LOS gained / lost in the current update (set by the perception pass). */
  acquired: boolean;
  lost: boolean;
  /** The awareness (alert, last known position) ends at this time unless it is confirmed again. */
  alertUntil: number;
  /** burstStartAt of the burst whose telegraph event has been emitted. */
  telegraphFor: number | null;
  /** Earliest time of this guard's next alert report. */
  nextShareAt: number;

  // ── guard navigation ──
  mode: GuardMode;
  moveKind: number;
  speed: number;
  /** Unit XZ direction of a direction move. */
  dirX: number;
  dirZ: number;
  /** Direction move: bearing relative to "towards the player" (radians). */
  dirAngle: number;
  /** Unit XZ bearing towards the perceived player and its horizontal distance (0 = straight move). */
  bearX: number;
  bearZ: number;
  orbitR: number;
  path: V3[] | null;
  pathIdx: number;
  pathFor: PathPurpose;
  /** Player position the approach path was planned for. */
  approachGoal: V3;
  /** Last known position the chase path was planned for. */
  chaseGoal: V3;
  chaseValid: boolean;
  /** The chase goal was reached (or is unreachable and its neighbourhood was reached): searching. */
  arrived: boolean;
  /** The chase goal changed and the path has not been re-planned for it yet. */
  chaseStale: boolean;
  /** The last plan for the current chase goal found neither a route nor a vantage point. */
  chaseFailed: boolean;
  /** The path ends at a spot chosen for its view of the target (vantage search), not at the target. */
  pathVantage: boolean;
  plannedAt: number;
  /** Earliest time of the next path search. */
  planOkAt: number;
  /** Earliest time of the next vantage search for an approach (after one that found nothing). */
  vantageOkAt: number;
  strafeSign: 1 | -1;
  /** NaN until the first direction move. */
  strafeSwitchAt: number;
  /** The strafe side (±1) on which the guard was held up, and until when it counts as blocked. */
  blockedSide: number;
  blockedUntil: number;
  /**
   * Straight-line strafe: active, the unit XZ direction being walked, the largest distance to the player it
   * may reach, the next search; the smallest distance to the player since this strafe began.
   */
  lineOn: boolean;
  lineX: number;
  lineZ: number;
  lineMaxD: number;
  lineCheckAt: number;
  strafeBaseD: number;
  /** Strafe: the time the current leg began (start or turn), and until when the guard stands out a short leg. */
  legStartAt: number;
  holdUntil: number;
  /** Back-off / retreat: no change to the other side before this time. */
  sideLockUntil: number;
  dirCheckAt: number;
  /** Time the guard has been making less than half of its intended speed. */
  stuckFor: number;
  stuckBy: number;
  /** Where on the NavGrid the guard is (GRID_*), its standing height there, the node an off-grid guard hops to. */
  gridState: number;
  navY: number;
  hop: V3;
  searchAnchor: V3 | null;
  searchRepickAt: number;
  /** Direction watch: the last horizontal step, the times of the two latest reversals, the stand-still it ordered. */
  lastDx: number;
  lastDz: number;
  rev0: number;
  rev1: number;
  oscUntil: number;
  /** Diagnostics: how often the direction watch had to step in. */
  oscCount: number;

  // ── turrets ──
  /** This turret is registered as a static obstacle of the NavGrid. */
  navObstacle: boolean;
  /** Walkable spot at the foot of this turret (alert sharing), the open hop from it, the nav state it was found for. */
  access: V3 | null;
  accessHop: number;
  accessFor: number;
}

function createAi(): EnemyAi {
  return {
    tag: AI_TAG,
    engaged: false,
    firstSightAt: null,
    losSince: null,
    acquired: false,
    lost: false,
    alertUntil: -Infinity,
    telegraphFor: null,
    nextShareAt: -Infinity,
    mode: 'idle',
    moveKind: MOVE_NONE,
    speed: 0,
    dirX: 0,
    dirZ: 0,
    dirAngle: 0,
    bearX: 0,
    bearZ: 0,
    orbitR: 0,
    path: null,
    pathIdx: 0,
    pathFor: 'none',
    approachGoal: v3(),
    chaseGoal: v3(),
    chaseValid: false,
    arrived: false,
    chaseStale: false,
    chaseFailed: false,
    pathVantage: false,
    plannedAt: -Infinity,
    planOkAt: -Infinity,
    vantageOkAt: 0,
    strafeSign: 1,
    strafeSwitchAt: Number.NaN,
    blockedSide: 0,
    blockedUntil: 0,
    lineOn: false,
    lineX: 0,
    lineZ: 0,
    lineMaxD: 0,
    lineCheckAt: 0,
    strafeBaseD: 0,
    legStartAt: LONG_AGO,
    holdUntil: 0,
    sideLockUntil: 0,
    dirCheckAt: -Infinity,
    stuckFor: 0,
    stuckBy: STUCK_NONE,
    gridState: GRID_UNKNOWN,
    navY: Number.NaN,
    hop: v3(),
    searchAnchor: null,
    searchRepickAt: -Infinity,
    lastDx: 0,
    lastDz: 0,
    rev0: LONG_AGO,
    rev1: LONG_AGO,
    oscUntil: 0,
    oscCount: 0,
    navObstacle: false,
    access: null,
    accessHop: 0,
    accessFor: -1,
  };
}

function aiOf(e: EnemyState): EnemyAi {
  const ai = e.ai as unknown as EnemyAi;
  if (ai.tag === AI_TAG) return ai;
  const fresh = createAi();
  e.ai = fresh as unknown as Record<string, unknown>;
  return fresh;
}

/** The module-private AI state of an enemy (tests, debug overlays). Treat it as read-only. */
export function getEnemyAi(enemy: EnemyState): Readonly<EnemyAi> {
  return aiOf(enemy);
}

// ───────────────────────────── module scratch (the simulation is single-threaded) ─────────────────────────────

const G = ENEMIES.guard;
const JITTER_MAX = (ENEMY_AI.aimJitterDeg * Math.PI) / 180;
const ADJUST_BEARING = (ENEMY_TUNING.adjustBearingDeg * Math.PI) / 180;
const HALF_PI = Math.PI / 2;
/** Slack when comparing a walked distance with the intended one (m). */
const REACH_EPS = 1e-9;
const AGENT_HALF: V3 = { x: G.radius, y: G.radius, z: G.radius };

const sMuzzle = v3();
const sLead = v3();
const sShot = v3();
const sFrom = v3();
const sCur = v3();
const sTgt = v3();
const sOut = v3();
const sAlt = v3();
const sProbe = v3();
const sEye = v3();
const sPick = v3();
const sNavA = v3();
const sNavB = v3();
const sStep = v3();
const sSpot = v3();

/** Spheres handed to the NavGrid when a guard plans around the enemies near it (reused). */
const avoidDiscs: NavDisc[] = [];
const APPROACH_VANTAGE: NavVantageOptions = {
  eyeUp: G.muzzleUp,
  within: ENEMY_TUNING.approachWithin,
  maxCost: ENEMY_TUNING.vantageMaxCost,
  fallback: 'visible',
  minGain: ENEMY_TUNING.approachMinGain,
};
const CHASE_VANTAGE: NavVantageOptions = {
  eyeUp: G.muzzleUp,
  within: ENEMY_TUNING.chaseWithin,
  maxCost: ENEMY_TUNING.vantageMaxCost,
  fallback: 'nearest',
  minGain: ENEMY_TUNING.chaseMinGain,
};

/** Candidate bearings of a direction move: angle relative to "towards the player" and the side it commits to. */
const candAngle = new Float64Array(12);
const candSide = new Int8Array(12);
/** Retreat fan: offsets from "straight away" (degrees), tried on the preferred side first. */
const RETREAT_OFFSETS = [30, 60, 80, 90].map((d) => (d * Math.PI) / 180);

// ───────────────────────────── creation ─────────────────────────────

/**
 * Number of opened barriers (final gate included) for which the NavGrid's region labels are known to be
 * current. Labelling a large grid takes a few frames' worth of time, so it is done at moments where a
 * hitch does not matter (sortie start, the sub-step in which a barrier opened) instead of in the middle
 * of the next fight, when a guard first asks for a path.
 */
const navRegionsFor = new WeakMap<Sim, number>();

function openBarrierCount(sim: Sim): number {
  return sim.objective.openBarrierIds.length + (sim.objective.gateOpen ? 1 : 0);
}

function refreshNavRegions(sim: Sim, list: EnemyState[]): void {
  navRegionsFor.set(sim, openBarrierCount(sim));
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind === 'guard' && !e.passive && e.alive) {
      sim.nav.connected(e.pos, e.pos);
      return;
    }
  }
}

/** Changes whenever the walkable area changed (a barrier opened, a turret obstacle went): cache stamp. */
function navStamp(sim: Sim): number {
  return openBarrierCount(sim) * 64 + sim.nav.obstacleCount;
}

/**
 * Brings the static obstacles of the NavGrid in line with the living fixed turrets (see the header: a
 * turret is never walked through). Nothing is registered on a stage without AI guards — nobody would use
 * the grid. Passive / scripted test targets may move and are left to the separation rule of moveGuard.
 */
function registerObstacles(sim: Sim, list: EnemyState[]): void {
  const nav = sim.nav;
  let guards = false;
  for (let i = 0; i < list.length && !guards; i++) guards = list[i].kind === 'guard' && !list[i].passive;
  const wanted = new Set<number>();
  if (guards) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.kind !== 'turret' || e.passive || e.scriptedVel !== null || !e.alive) continue;
      wanted.add(e.index);
      aiOf(e).navObstacle = true;
      if (!nav.hasObstacle(e.index)) nav.setObstacle(e.index, e.pos, G.radius + e.radius + ENEMY_TUNING.separationMargin + ENEMY_TUNING.avoidSlack);
    }
  }
  if (nav.obstacleCount !== wanted.size) {
    for (const key of nav.obstacleKeys()) if (!wanted.has(key)) nav.setObstacle(key, null);
  }
}

/** Fresh enemies from the stage definition (same ids / order on every sortie). */
export function createEnemies(sim: Sim): EnemyState[] {
  const list = buildEnemies(sim);
  registerObstacles(sim, list);
  refreshNavRegions(sim, list);
  return list;
}

function buildEnemies(sim: Sim): EnemyState[] {
  return sim.stage.enemies.map((def, index) => {
    const cfg = ENEMIES[def.kind];
    const hp = def.test?.hp ?? cfg.hp;
    const e: EnemyState = {
      def,
      id: def.id,
      index,
      kind: def.kind,
      isGateControl: def.isGateControl,
      sectorId: def.sectorId,
      pos: clone(def.position),
      prevPos: clone(def.position),
      vel: v3(),
      radius: def.test?.radius ?? cfg.radius,
      hp,
      maxHp: hp,
      alive: true,
      destroyedAt: null,
      yaw: def.yaw ?? 0,
      aimDir: v3(-Math.sin(def.yaw ?? 0), 0, -Math.cos(def.yaw ?? 0)),
      alert: false,
      hasLos: false,
      lastKnownPlayerPos: null,
      lastKnownAt: null,
      losLostAt: null,
      nextBurstReadyAt: -Infinity,
      burstStartAt: null,
      burstShotsDone: 0,
      telegraphStartAt: null,
      shotsFired: 0,
      lastShotAt: null,
      passive: def.test?.passive ?? false,
      scriptedVel: def.test?.velocity ? clone(def.test.velocity) : null,
      ai: createAi() as unknown as Record<string, unknown>,
    };
    return e;
  });
}

/** World-space muzzle (= eye) of an enemy: hit-sphere centre + (0, muzzleUp, 0). */
export function enemyMuzzle(enemy: EnemyState, out: V3): V3 {
  return set(out, enemy.pos.x, enemy.pos.y + ENEMIES[enemy.kind].muzzleUp, enemy.pos.z);
}

/**
 * Progress through the telegraph window of the announced burst at `time` (renderer / HUD helper):
 * 0 when no telegraph is running, otherwise a value in (0, 1] that reaches 1 at the burst start.
 * (telegraphStartAt is already set while the window still lies ahead — it only counts once `time` is in it.)
 */
export function telegraphProgress(enemy: EnemyState, time: number): number {
  const a = enemy.telegraphStartAt;
  const b = enemy.burstStartAt;
  if (!enemy.alive || a === null || b === null || !(b > a) || !(time >= a)) return 0;
  const p = (time - a) / (b - a);
  return p >= 1 ? 1 : p > 1e-3 ? p : 1e-3;
}

// ───────────────────────────── movement (executes the decisions of updateEnemies) ─────────────────────────────

/**
 * Moves every living enemy from sim.time by `h`: sets prevPos, then pos and the ACTUAL velocity
 * (displacement / h). Guards follow walkable paths; turrets and dead enemies have zero velocity;
 * scripted test targets move at their constant velocity.
 */
export function moveEnemies(sim: Sim, h: number): void {
  for (const e of sim.enemies) {
    set(e.prevPos, e.pos.x, e.pos.y, e.pos.z);
    if (!e.alive) {
      set(e.vel, 0, 0, 0);
      continue;
    }
    if (e.scriptedVel) {
      e.pos.x += e.scriptedVel.x * h;
      e.pos.y += e.scriptedVel.y * h;
      e.pos.z += e.scriptedVel.z * h;
      set(e.vel, e.scriptedVel.x, e.scriptedVel.y, e.scriptedVel.z);
    } else if (e.kind === 'guard' && !e.passive && h > 0 && Number.isFinite(h)) {
      moveGuard(sim, e, aiOf(e), h);
    } else {
      set(e.vel, 0, 0, 0);
    }
  }
}

/** Guard position as the NavGrid sees it: (x, standing height of its level, z). */
function navPoint(e: EnemyState, ai: EnemyAi, out: V3): V3 {
  return set(out, e.pos.x, ai.navY === ai.navY ? ai.navY : e.pos.y, e.pos.z);
}

/**
 * First living enemy that a move of `e` from (fx, fz) to (tx, tz) would bring closer than the separation
 * distance, or null. A move that does not shorten the distance to an enemy is never a conflict with it,
 * so two enemies that are already too close (stage placement) can always part.
 */
function moveConflict(sim: Sim, e: EnemyState, fx: number, fz: number, tx: number, tz: number): EnemyState | null {
  const list = sim.enemies;
  const y = e.pos.y;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === e || !o.alive) continue;
    const min = e.radius + o.radius + ENEMY_TUNING.separationMargin;
    const dy = y - o.pos.y;
    let dx = tx - o.pos.x;
    let dz = tz - o.pos.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!(d2 < min * min)) continue;
    dx = fx - o.pos.x;
    dz = fz - o.pos.z;
    if (d2 >= dx * dx + dy * dy + dz * dz) continue;
    return o;
  }
  return null;
}

/**
 * The step from → to (same level) runs into enemy `o` at a glancing angle: replaces it by a step of the same
 * length along the tangent of `o` if that is walkable and free. Writes the new end point to `to`; returns
 * false when the contact is (almost) head-on or there is no such step. The tangent always has a component
 * along the intended step, so sliding never turns a guard back.
 */
function slideAround(sim: Sim, e: EnemyState, from: V3, to: V3, o: EnemyState): boolean {
  const sx = to.x - from.x;
  const sz = to.z - from.z;
  const sl = Math.hypot(sx, sz);
  let nx = o.pos.x - from.x;
  let nz = o.pos.z - from.z;
  const nl = Math.hypot(nx, nz);
  if (!(sl > 1e-12) || !(nl > 1e-9)) return false;
  nx /= nl;
  nz /= nl;
  const along = sx * nx + sz * nz;
  let tx = sx - along * nx;
  let tz = sz - along * nz;
  const tl = Math.hypot(tx, tz);
  if (tl < 0.25 * sl) return false;
  tx *= sl / tl;
  tz *= sl / tl;
  set(sTgt, from.x + tx, from.y, from.z + tz);
  const reach = sim.nav.walkableReach(from, sTgt, sAlt);
  if (reach >= sl - REACH_EPS && moveConflict(sim, e, from.x, from.z, sAlt.x, sAlt.z) === null) {
    copy(to, sAlt);
    return true;
  }
  return false;
}

/**
 * The step from → to would come too close to another enemy and cannot slide past it: shortens it along its
 * own line to the point where the nearest enemy in the way is exactly at the separation distance. Writes
 * that point to `to` and returns true, or returns false when the guard cannot advance at all.
 */
function clipToSeparation(sim: Sim, e: EnemyState, from: V3, to: V3): boolean {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const a = dx * dx + dz * dz;
  if (!(a > 1e-18)) return false;
  let f = 1;
  const list = sim.enemies;
  const y = e.pos.y;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === e || !o.alive) continue;
    const min = e.radius + o.radius + ENEMY_TUNING.separationMargin;
    const rx = from.x - o.pos.x;
    const rz = from.z - o.pos.z;
    const dy = y - o.pos.y;
    const b = rx * dx + rz * dz;
    if (b >= 0) continue; // not getting nearer to this one
    const c = rx * rx + rz * rz + dy * dy - min * min;
    if (c <= 0) return false; // already at (or inside) the distance and heading in
    const disc = b * b - a * c;
    if (disc <= 0) continue; // the line never reaches the distance
    const hit = (-b - Math.sqrt(disc)) / a;
    if (hit < f) f = hit;
  }
  // Stop a hair short, so that rounding cannot put the guard inside the distance.
  f -= 1e-9 / Math.sqrt(a);
  if (!(f > 1e-6)) return false;
  set(sTgt, from.x + dx * f, from.y, from.z + dz * f);
  const reach = sim.nav.walkableReach(from, sTgt, sAlt);
  if (!(reach > 1e-9) || moveConflict(sim, e, from.x, from.z, sAlt.x, sAlt.z) !== null) return false;
  copy(to, sAlt);
  return true;
}

/** Vertical follow-up of the standing height (floors are flat almost everywhere: usually a no-op). */
function settleY(e: EnemyState, ai: EnemyAi, h: number): void {
  const target = ai.navY;
  if (target !== target) return;
  const dy = target - e.pos.y;
  const max = ENEMY_TUNING.yRate * h;
  if (dy > max) e.pos.y += max;
  else if (dy < -max) e.pos.y -= max;
  else e.pos.y = target;
}

const sectorBoxes = new WeakMap<StageDef, Map<string, Box[]>>();

/** The sector a guard is in: it keeps its sector while it is inside its bounds, otherwise the one it entered. */
function trackSector(sim: Sim, e: EnemyState): void {
  let map = sectorBoxes.get(sim.stage);
  if (!map) {
    map = new Map();
    for (const sec of sim.stage.sectors) map.set(sec.id, sec.bounds);
    sectorBoxes.set(sim.stage, map);
  }
  const p = e.pos;
  const own = map.get(e.sectorId);
  if (own) {
    for (let i = 0; i < own.length; i++) {
      const b = own[i];
      if (p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z) return;
    }
  }
  const id = sim.world.sectorAt(p);
  if (id !== null) e.sectorId = id;
}

/**
 * End of a guard's sub-step: actual velocity, sector, the "held up" clock (less than half of the intended
 * step) and the direction watch.
 */
function finishMove(sim: Sim, e: EnemyState, ai: EnemyAi, h: number, intended: number, by: number): void {
  settleY(e, ai, h);
  const dx = e.pos.x - e.prevPos.x;
  const dy = e.pos.y - e.prevPos.y;
  const dz = e.pos.z - e.prevPos.z;
  set(e.vel, dx / h, dy / h, dz / h);
  const moved = Math.hypot(dx, dz);
  if (intended > 0 && moved < 0.5 * intended) {
    ai.stuckFor += h;
    if (by !== STUCK_NONE) ai.stuckBy = by;
  } else {
    ai.stuckFor = 0;
    ai.stuckBy = STUCK_NONE;
  }
  if (!(moved > 1e-9)) return;
  trackSector(sim, e);
  // Direction watch: a guard that turned round three times within the window is trembling, not moving.
  const last = Math.hypot(ai.lastDx, ai.lastDz);
  if (last > 0 && dx * ai.lastDx + dz * ai.lastDz < -0.5 * moved * last) {
    const now = sim.time + h;
    if (now - ai.rev1 <= ENEMY_TUNING.oscillationWindow) {
      ai.oscUntil = now + ENEMY_TUNING.oscillationHold;
      ai.oscCount++;
      ai.rev0 = LONG_AGO;
      ai.rev1 = LONG_AGO;
    } else {
      ai.rev1 = ai.rev0;
      ai.rev0 = now;
    }
  }
  ai.lastDx = dx;
  ai.lastDz = dz;
}

function moveGuard(sim: Sim, e: EnemyState, ai: EnemyAi, h: number): void {
  const step = ai.speed * h;
  if (ai.moveKind === MOVE_NONE || !(step > 0) || !Number.isFinite(step)) {
    finishMove(sim, e, ai, h, 0, STUCK_NONE);
    return;
  }
  if (sim.time < ai.oscUntil - TIME_EPS) {
    // Ordered to stand by the direction watch; the decision code sees a guard that is held up.
    finishMove(sim, e, ai, h, step, ai.stuckBy);
    return;
  }
  if (ai.moveKind === MOVE_HOP) {
    hopToGrid(sim, e, ai, h, step);
    return;
  }
  const nav = sim.nav;
  const from = navPoint(e, ai, sFrom);
  let by = STUCK_NONE;
  let idx = ai.pathIdx;
  copy(sCur, from);

  if (ai.moveKind === MOVE_PATH) {
    const path = ai.path;
    if (!path) {
      finishMove(sim, e, ai, h, 0, STUCK_NONE);
      return;
    }
    let remaining = step;
    while (remaining > 1e-12 && idx < path.length) {
      const wp = path[idx];
      const dx = wp.x - sCur.x;
      const dz = wp.z - sCur.z;
      const dist = Math.hypot(dx, dz);
      if (!(dist > 1e-9)) {
        idx++;
        continue;
      }
      const whole = dist <= remaining;
      const take = whole ? dist : remaining;
      if (whole) set(sTgt, wp.x, sCur.y, wp.z);
      else set(sTgt, sCur.x + (dx / dist) * take, sCur.y, sCur.z + (dz / dist) * take);
      const reach = nav.walkableReach(sCur, sTgt, sOut);
      if (reach < take - REACH_EPS) {
        if (reach > 0) copy(sCur, sOut);
        by = STUCK_NAV;
        break;
      }
      copy(sCur, sOut);
      remaining -= take;
      if (whole) idx++;
    }
  } else {
    let ux = ai.dirX;
    let uz = ai.dirZ;
    if (ai.orbitR > 1) {
      // Chord of the circle around the perceived player: keeps the distance instead of spiralling out.
      const phi = Math.min(0.5, step / (2 * ai.orbitR));
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      ux = ai.dirX * c + ai.bearX * s;
      uz = ai.dirZ * c + ai.bearZ * s;
    }
    set(sTgt, from.x + ux * step, from.y, from.z + uz * step);
    const reach = nav.walkableReach(from, sTgt, sOut);
    if (reach < step - REACH_EPS) by = STUCK_NAV;
    if (reach > 0) copy(sCur, sOut);
  }

  // Never into another enemy: slide past a glancing contact, otherwise stop at the separation distance.
  const other = moveConflict(sim, e, from.x, from.z, sCur.x, sCur.z);
  if (other !== null) {
    by = STUCK_ENEMY;
    idx = ai.pathIdx;
    copy(sStep, sCur);
    if (slideAround(sim, e, from, sStep, other) || clipToSeparation(sim, e, from, sStep)) copy(sCur, sStep);
    else copy(sCur, from);
  }

  if (Number.isFinite(sCur.x) && Number.isFinite(sCur.y) && Number.isFinite(sCur.z)) {
    e.pos.x = sCur.x;
    e.pos.z = sCur.z;
    ai.navY = sCur.y;
    ai.pathIdx = idx;
  }
  finishMove(sim, e, ai, h, step, by);
}

/** A guard that was placed outside the walkable area walks straight to the nearest node (collision-checked). */
function hopToGrid(sim: Sim, e: EnemyState, ai: EnemyAi, h: number, step: number): void {
  const dx = ai.hop.x - e.pos.x;
  const dz = ai.hop.z - e.pos.z;
  const dist = Math.hypot(dx, dz);
  let by = STUCK_NONE;
  if (dist <= step) {
    set(sCur, ai.hop.x, ai.hop.y, ai.hop.z);
  } else {
    const f = step / dist;
    set(sCur, e.pos.x + dx * f, e.pos.y + (ai.hop.y - e.pos.y) * f, e.pos.z + dz * f);
  }
  if (sim.world.overlapsBox(sCur, AGENT_HALF)) {
    by = STUCK_NAV;
  } else if (moveConflict(sim, e, e.pos.x, e.pos.z, sCur.x, sCur.z) !== null) {
    by = STUCK_ENEMY;
  } else if (Number.isFinite(sCur.x) && Number.isFinite(sCur.y) && Number.isFinite(sCur.z)) {
    e.pos.x = sCur.x;
    e.pos.y = sCur.y;
    e.pos.z = sCur.z;
    if (dist <= step) {
      ai.gridState = GRID_ON;
      ai.navY = ai.hop.y;
      ai.moveKind = MOVE_NONE;
    }
  }
  finishMove(sim, e, ai, h, Math.min(step, dist), by);
}

// ───────────────────────────── perception, memory, sharing ─────────────────────────────

function becomeAlert(sim: Sim, e: EnemyState): void {
  if (e.alert) return;
  e.alert = true;
  sim.emit({ type: 'enemy-alerted', enemyId: e.id });
}

function remember(e: EnemyState, ai: EnemyAi, pos: V3, t: number): void {
  if (e.lastKnownPlayerPos) copy(e.lastKnownPlayerPos, pos);
  else e.lastKnownPlayerPos = clone(pos);
  e.lastKnownAt = t;
  ai.alertUntil = t + ENEMY_AI.memorySeconds;
}

function cancelBurst(e: EnemyState, ai: EnemyAi): void {
  e.burstStartAt = null;
  e.burstShotsDone = 0;
  e.telegraphStartAt = null;
  ai.telegraphFor = null;
}

function halt(ai: EnemyAi, mode: GuardMode): void {
  ai.mode = mode;
  ai.moveKind = MOVE_NONE;
  ai.speed = 0;
  ai.orbitR = 0;
  ai.path = null;
  ai.pathFor = 'none';
  ai.pathVantage = false;
}

/** The memory ran out: back to the unaware state (the next sighting is a first sighting again). */
function forget(e: EnemyState, ai: EnemyAi): void {
  e.alert = false;
  e.lastKnownPlayerPos = null;
  e.lastKnownAt = null;
  e.losLostAt = null;
  ai.engaged = false;
  ai.firstSightAt = null;
  ai.losSince = null;
  cancelBurst(e, ai);
  halt(ai, 'idle');
  ai.chaseValid = false;
  ai.arrived = false;
  ai.chaseStale = false;
  ai.chaseFailed = false;
  ai.searchAnchor = null;
  ai.stuckFor = 0;
  ai.stuckBy = STUCK_NONE;
  set(e.aimDir, -Math.sin(e.yaw), 0, -Math.cos(e.yaw));
}

function perceive(sim: Sim, e: EnemyState, ai: EnemyAi, t: number): void {
  const range = ENEMIES[e.kind].range;
  const p = sim.player.pos;
  const had = e.hasLos;
  let sees = false;
  // NaN-safe: a comparison with NaN is false. The raycast is skipped for everything out of range.
  if (distanceSq(e.pos, p) <= range * range) {
    sees = !sim.world.segmentBlocked(enemyMuzzle(e, sMuzzle), p);
  }
  e.hasLos = sees;
  ai.acquired = sees && !had;
  ai.lost = had && !sees;
  if (sees) {
    becomeAlert(sim, e);
    remember(e, ai, p, t);
    e.losLostAt = null;
    if (ai.acquired) ai.losSince = t;
  } else {
    if (ai.lost) {
      e.losLostAt = t;
      ai.losSince = null;
    }
    if (e.alert && t >= ai.alertUntil - TIME_EPS) forget(e, ai);
  }
}

/**
 * The open way from turret `r` to the standing spot `p` near it: level with the turret out to the point
 * above (or beside) `p`, then straight down (or up) to it. Returns its length, or Infinity when a wall or a
 * floor is in the way — a turret behind a wall, or on another storey, is not "at" that spot.
 */
function turretHop(sim: Sim, r: EnemyState, p: V3): number {
  set(sAlt, p.x, r.pos.y, p.z);
  if (sim.world.segmentBlocked(r.pos, sAlt) || sim.world.segmentBlocked(sAlt, p)) return Infinity;
  return Math.hypot(p.x - r.pos.x, p.z - r.pos.z) + Math.abs(p.y - r.pos.y);
}

/**
 * Walkable path length from guard position `a` (a NavGrid point) to turret `r`, for alert sharing: the path
 * to a standing spot at the turret's foot plus the open hop from there to the turret (turretHop). The foot is
 * the walkable spot nearest to the point of the turret's keep-out sphere that faces the guard — so across
 * open floor the result is the straight distance, and a turret on a pedestal is reached from the floor
 * around it; failing that, the walkable spot nearest to the turret within turretAccessRadius (cached until
 * the walkable area changes). Infinity when the turret has no such spot or the spot is no part of the
 * guard's passages (a turret on a deck of its own, behind a wall, on another storey: not "connected by a
 * passage"), or when the way is longer than `max`.
 */
function turretPathDistance(sim: Sim, a: V3, g: EnemyState, r: EnemyState, rai: EnemyAi, max: number): number {
  const nav = sim.nav;
  const keep = G.radius + r.radius + ENEMY_TUNING.separationMargin + ENEMY_TUNING.avoidSlack;
  const dx = g.pos.x - r.pos.x;
  const dz = g.pos.z - r.pos.z;
  const dl = Math.hypot(dx, dz);
  let best = Infinity;
  if (dl > 1e-6) {
    set(sTgt, r.pos.x + (dx / dl) * (keep + 0.5), r.pos.y, r.pos.z + (dz / dl) * (keep + 0.5));
    const p = nav.nearestWalkable(sTgt, 2, sPick);
    if (p) {
      const hop = turretHop(sim, r, p);
      if (hop <= max) best = nav.pathDistance(a, p, max - hop) + hop;
    }
  }
  if (best <= max) return best;
  const stamp = navStamp(sim);
  if (rai.accessFor !== stamp) {
    rai.accessFor = stamp;
    rai.access = null;
    const p = nav.nearestWalkable(r.pos, ENEMY_TUNING.turretAccessRadius, sPick);
    if (p) {
      const hop = turretHop(sim, r, p);
      if (hop < Infinity) {
        rai.access = clone(p);
        rai.accessHop = hop;
      }
    }
  }
  if (rai.access === null || !(rai.accessHop <= max)) return Infinity;
  return nav.pathDistance(a, rai.access, max - rai.accessHop) + rai.accessHop;
}

/**
 * Guard `g` sees the player: tell every other living enemy that is connected to it by at most the share
 * distance of walkable path (a turret: path to its foot + the open hop up to it).
 */
function shareSighting(sim: Sim, g: EnemyState, t: number): void {
  const known = g.lastKnownPlayerPos;
  if (!known) return;
  const max = ENEMY_AI.shareDistance;
  const list = sim.enemies;
  const a = navPoint(g, aiOf(g), sNavA);
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r === g || !r.alive || r.passive || r.hasLos) continue;
    // The walkable distance is never shorter than the straight line.
    if (!(distanceSq(g.pos, r.pos) <= max * max)) continue;
    const rai = aiOf(r);
    if (r.kind === 'guard') {
      if (!(sim.nav.pathDistance(a, navPoint(r, rai, sNavB), max) <= max)) continue;
    } else if (!(turretPathDistance(sim, a, g, r, rai, max) <= max)) {
      continue;
    }
    becomeAlert(sim, r);
    remember(r, rai, known, t);
  }
}

// ───────────────────────────── attack schedule and aim ─────────────────────────────

function scheduleBurst(e: EnemyState, ai: EnemyAi, telegraph: number, t: number): void {
  const earliest = t + telegraph;
  const start = e.nextBurstReadyAt > earliest ? e.nextBurstReadyAt : earliest;
  e.burstStartAt = start;
  e.burstShotsDone = 0;
  e.telegraphStartAt = start - telegraph;
  ai.telegraphFor = null;
}

/**
 * Unit direction from `muzzle` to where the player will be when a bullet of `speed` gets there, assuming
 * the player keeps its current velocity (lead time capped at ENEMY_AI.maxPredictSeconds). Uses only the
 * player's current position and velocity. Returns false (out untouched) for a degenerate geometry.
 */
function leadDirection(sim: Sim, muzzle: V3, speed: number, out: V3): boolean {
  const p = sim.player.pos;
  const v = sim.player.vel;
  const cap = ENEMY_AI.maxPredictSeconds;
  const sol = solveLinearIntercept(muzzle, p, v, speed, cap);
  if (sol) {
    copy(out, sol.dir);
    return true;
  }
  const lead = Math.min(cap, distance(muzzle, p) / speed);
  let ax = p.x + v.x * lead - muzzle.x;
  let ay = p.y + v.y * lead - muzzle.y;
  let az = p.z + v.z * lead - muzzle.z;
  let len = Math.sqrt(ax * ax + ay * ay + az * az);
  if (!(len > 1e-9) || !Number.isFinite(len)) {
    // No usable lead point: straight at the current position.
    ax = p.x - muzzle.x;
    ay = p.y - muzzle.y;
    az = p.z - muzzle.z;
    len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (!(len > 1e-9) || !Number.isFinite(len)) return false;
  }
  set(out, ax / len, ay / len, az / len);
  return true;
}

/** Tilts unit `dir` by a random angle of at most JITTER_MAX (uniform over the cone's cross-section). */
function jitter(sim: Sim, dir: V3, out: V3): V3 {
  const theta = JITTER_MAX * Math.sqrt(sim.rng.next());
  const phi = 2 * Math.PI * sim.rng.next();
  // u ⟂ dir, w = dir × u
  let ux: number;
  let uy: number;
  let uz: number;
  if (Math.abs(dir.y) < 0.9) {
    const l = Math.hypot(dir.x, dir.z);
    ux = -dir.z / l;
    uy = 0;
    uz = dir.x / l;
  } else {
    const l = Math.hypot(dir.y, dir.z);
    ux = 0;
    uy = dir.z / l;
    uz = -dir.y / l;
  }
  const wx = dir.y * uz - dir.z * uy;
  const wy = dir.z * ux - dir.x * uz;
  const wz = dir.x * uy - dir.y * ux;
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const a = Math.cos(phi) * st;
  const b = Math.sin(phi) * st;
  const x = dir.x * ct + ux * a + wx * b;
  const y = dir.y * ct + uy * a + wy * b;
  const z = dir.z * ct + uz * a + wz * b;
  const len = Math.sqrt(x * x + y * y + z * z);
  if (!(len > 0) || !Number.isFinite(len)) return copy(out, dir);
  return set(out, x / len, y / len, z / len);
}

/** One bullet at the current instant (the caller has verified the line of sight). */
function fireShot(sim: Sim, e: EnemyState, t: number): void {
  const cfg = ENEMIES[e.kind];
  const muzzle = enemyMuzzle(e, sMuzzle);
  if (!leadDirection(sim, muzzle, cfg.bulletSpeed, sLead)) copy(sLead, e.aimDir);
  jitter(sim, sLead, sShot);
  const bullet = spawnEnemyBullet(sim, e, muzzle, sShot);
  if (!bullet.alive) return;
  e.shotsFired++;
  e.lastShotAt = t;
  sim.emit({ type: 'enemy-shot', enemyId: e.id, kind: e.kind, muzzle: clone(muzzle), dir: clone(sShot) });
}

function updateAttack(sim: Sim, e: EnemyState, ai: EnemyAi, t: number): void {
  const cfg = ENEMIES[e.kind];
  if (e.hasLos) {
    if (!ai.engaged) {
      // First own sighting of this awareness period: the weapon is ready firstShotDelay later.
      ai.engaged = true;
      ai.firstSightAt = t;
      const first = t + cfg.firstShotDelay;
      if (!(e.nextBurstReadyAt >= first)) e.nextBurstReadyAt = first;
    }
    // Seeing and nothing announced (first sighting, re-exposure): announce the next burst. A burst that
    // began before a short occlusion simply continues.
    if (e.burstStartAt === null) scheduleBurst(e, ai, cfg.telegraph, t);
  } else if (e.burstStartAt !== null && e.burstShotsDone === 0) {
    // Announced but not begun: cancelled. nextBurstReadyAt stays, so the delay is not served again.
    cancelBurst(e, ai);
  }

  if (
    e.burstStartAt !== null &&
    e.burstShotsDone === 0 &&
    e.telegraphStartAt !== null &&
    ai.telegraphFor !== e.burstStartAt &&
    t >= e.telegraphStartAt - TIME_EPS
  ) {
    ai.telegraphFor = e.burstStartAt;
    const left = e.burstStartAt - t;
    if (left > TIME_EPS) sim.emit({ type: 'enemy-telegraph', enemyId: e.id, duration: left });
  }

  while (e.burstStartAt !== null) {
    const due = e.burstStartAt + e.burstShotsDone * cfg.burstInterval;
    if (due > t + TIME_EPS) break;
    if (e.burstShotsDone === 0) {
      // The burst begins: the period runs from here, the telegraph window is over.
      e.nextBurstReadyAt = e.burstStartAt + cfg.burstPeriod;
      e.telegraphStartAt = null;
    }
    if (e.hasLos) fireShot(sim, e, t);
    e.burstShotsDone++;
    if (e.burstShotsDone >= cfg.burstCount) {
      if (e.hasLos) scheduleBurst(e, ai, cfg.telegraph, t);
      else cancelBurst(e, ai);
    }
  }
}

// ───────────────────────────── guard decisions ─────────────────────────────

/** Finds out where the guard stands on the NavGrid (once, when it first has to move). */
function locate(sim: Sim, e: EnemyState, ai: EnemyAi): void {
  const p = sim.nav.nearestWalkable(e.pos, 3, sPick);
  if (!p) {
    ai.gridState = GRID_NONE;
    return;
  }
  if (p.x === e.pos.x && p.z === e.pos.z) {
    ai.gridState = GRID_ON;
    ai.navY = p.y;
  } else {
    ai.gridState = GRID_OFF;
    copy(ai.hop, p);
  }
}

/** Installs `path` as the guard's current plan. */
function adoptPath(ai: EnemyAi, path: V3[], purpose: PathPurpose, vantage: boolean, t: number): void {
  ai.path = path;
  ai.pathIdx = 0;
  ai.pathFor = purpose;
  ai.pathVantage = vantage;
  ai.plannedAt = t;
  ai.planOkAt = t + ENEMY_TUNING.planMinGap;
  ai.stuckFor = 0;
  ai.stuckBy = STUCK_NONE;
}

/** True while the guard has way points of its current path left. */
function pathLeft(ai: EnemyAi): boolean {
  return ai.path !== null && ai.pathIdx < ai.path.length;
}

/** Plans a path to `target` (snapping to the nearest reachable standing spot). Honours the search throttle. */
function planPath(sim: Sim, e: EnemyState, ai: EnemyAi, target: V3, purpose: PathPurpose, t: number): boolean {
  const nav = sim.nav;
  const from = navPoint(e, ai, sFrom);
  ai.plannedAt = t;
  let path = nav.findPath(from, target, 4);
  // No standing spot near the target (the search itself did not run): look further out.
  if (!path && nav.lastExpansions === 0) path = nav.findPath(from, target, 12);
  if (!path && nav.lastExpansions === 0) path = nav.findPath(from, target, 30);
  if (!path) {
    ai.planOkAt = t + ENEMY_TUNING.planRetry;
    return false;
  }
  adoptPath(ai, path, purpose, false, t);
  return true;
}

/**
 * No route to `target` (it is on a floor this guard cannot reach): plans a path along the guard's own floor
 * to the spot the vantage search of the NavGrid picks for looking at `target` (see ENEMY_TUNING.vantage…).
 */
function planVantage(sim: Sim, e: EnemyState, ai: EnemyAi, target: V3, opts: NavVantageOptions, purpose: PathPurpose, t: number): boolean {
  const nav = sim.nav;
  const from = navPoint(e, ai, sFrom);
  if (nav.findVantage(from, target, opts, sSpot) === VANTAGE_NONE) return false;
  const path = nav.findPath(from, sSpot, 1);
  if (!path) return false;
  adoptPath(ai, path, purpose, true, t);
  return true;
}

/**
 * The path is blocked by other enemies: plans a new one to the same end that keeps the separation distance
 * from every enemy near the guard (the turrets are obstacles of the NavGrid already). False when there is no
 * way round within the detour budget.
 */
function planDetour(sim: Sim, e: EnemyState, ai: EnemyAi, t: number): boolean {
  const path = ai.path;
  ai.plannedAt = t;
  ai.planOkAt = t + ENEMY_TUNING.planRetry;
  if (!path || ai.pathIdx >= path.length) return false;
  const list = sim.enemies;
  const scan = ENEMY_TUNING.detourScan;
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === e || !o.alive || !(distanceSq(o.pos, e.pos) <= scan * scan)) continue;
    if (n === avoidDiscs.length) avoidDiscs.push({ x: 0, y: 0, z: 0, r: 0 });
    const d = avoidDiscs[n++];
    d.x = o.pos.x;
    d.y = o.pos.y;
    d.z = o.pos.z;
    d.r = e.radius + o.radius + ENEMY_TUNING.separationMargin + ENEMY_TUNING.avoidSlack;
  }
  if (n === 0) return false;
  const from = navPoint(e, ai, sFrom);
  let rest = 0;
  let px = from.x;
  let pz = from.z;
  for (let k = ai.pathIdx; k < path.length; k++) {
    rest += Math.hypot(path[k].x - px, path[k].z - pz);
    px = path[k].x;
    pz = path[k].z;
  }
  const end = path[path.length - 1];
  const detour = sim.nav.findPath(from, end, 1, {
    avoid: avoidDiscs,
    avoidCount: n,
    maxLength: rest * ENEMY_TUNING.detourFactor + ENEMY_TUNING.detourExtra,
  });
  if (!detour) return false;
  adoptPath(ai, detour, ai.pathFor, ai.pathVantage, t);
  return true;
}

function followPath(ai: EnemyAi, mode: GuardMode, speed: number): void {
  ai.mode = mode;
  ai.moveKind = MOVE_PATH;
  ai.speed = speed;
  ai.orbitR = 0;
}

/**
 * Seeing the player beyond 55 m: close in along a path — to the player, or (no route to the player's floor)
 * along the guard's own floor to a spot with a view that is nearer. False when there is nothing nearer to go
 * to right now (the caller strafes).
 */
function thinkApproach(sim: Sim, e: EnemyState, ai: EnemyAi, t: number): boolean {
  const p = sim.player.pos;
  const usable = ai.pathFor === 'approach' && pathLeft(ai);
  const stale =
    usable &&
    t - ai.plannedAt >= ENEMY_TUNING.replanInterval &&
    Math.hypot(ai.approachGoal.x - p.x, ai.approachGoal.z - p.z) > ENEMY_TUNING.replanGoalShift;
  const stuck = usable && ai.stuckFor >= ENEMY_TUNING.pathStuckSeconds;
  if ((!usable || stale || stuck) && t >= ai.planOkAt - TIME_EPS) {
    if (stuck && ai.stuckBy === STUCK_ENEMY) {
      // Another enemy stands in the way: go round it, or give the approach up for now and strafe.
      if (!planDetour(sim, e, ai, t)) {
        ai.path = null;
        ai.pathFor = 'none';
        ai.planOkAt = t + ENEMY_TUNING.approachBlockedRetry;
      }
    } else if (planPath(sim, e, ai, p, 'approach', t)) {
      copy(ai.approachGoal, p);
    } else if (t >= ai.vantageOkAt - TIME_EPS && planVantage(sim, e, ai, p, APPROACH_VANTAGE, 'approach', t)) {
      copy(ai.approachGoal, p);
    } else {
      if (t >= ai.vantageOkAt - TIME_EPS) ai.vantageOkAt = t + ENEMY_TUNING.approachVantageRetry;
      if (!usable) ai.pathFor = 'none';
    }
  }
  if (ai.pathFor === 'approach' && pathLeft(ai)) {
    followPath(ai, 'approach', G.approachSpeed);
    return true;
  }
  return false;
}

/**
 * True when the guard can run ≥ minRun along (ux, uz) without coming too close to another enemy and
 * (optionally) still sees the player a little way along it.
 */
function probe(sim: Sim, e: EnemyState, ai: EnemyAi, ux: number, uz: number, needLos: boolean): boolean {
  const from = navPoint(e, ai, sFrom);
  const len = ENEMY_TUNING.probeDistance;
  set(sTgt, from.x + ux * len, from.y, from.z + uz * len);
  const reach = sim.nav.walkableReach(from, sTgt, sProbe);
  if (reach < ENEMY_TUNING.minRun) return false;
  const run = ENEMY_TUNING.minRun;
  if (moveConflict(sim, e, from.x, from.z, from.x + ux * run, from.z + uz * run) !== null) return false;
  if (needLos) {
    const ahead = Math.min(reach, ENEMY_TUNING.losLookAhead);
    set(sEye, from.x + ux * ahead, sProbe.y + G.muzzleUp, from.z + uz * ahead);
    if (sim.world.segmentBlocked(sEye, sim.player.pos)) return false;
  }
  return true;
}

/**
 * How far (up to `maxLen`, in steps of strafeRunStep) the guard can strafe towards `side` on the circle around
 * the player: every step walkable, no other enemy closer than the separation distance, the player in plain
 * view from each point. (bx, bz) is the unit bearing towards the player, `r` the horizontal distance.
 */
function strafeRun(sim: Sim, e: EnemyState, ai: EnemyAi, bx: number, bz: number, r: number, side: number, maxLen: number): number {
  const nav = sim.nav;
  const p = sim.player.pos;
  const stepLen = ENEMY_TUNING.strafeRunStep;
  const steps = Math.round(maxLen / stepLen);
  // Tangent of the strafe towards `side` (the bearing turned by side · 90°).
  const tx = -bz * side;
  const tz = bx * side;
  const from = navPoint(e, ai, sFrom);
  const x0 = from.x;
  const z0 = from.z;
  copy(sNavA, from);
  let run = 0;
  for (let k = 1; k <= steps; k++) {
    const a = k * stepLen;
    let x: number;
    let z: number;
    if (r > 1) {
      // Point of the circle (centre: player, radius r) after an arc of length a.
      const ang = a / r;
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      x = p.x + r * (-bx * c + tx * sn);
      z = p.z + r * (-bz * c + tz * sn);
    } else {
      x = x0 + tx * a;
      z = z0 + tz * a;
    }
    set(sTgt, x, sNavA.y, z);
    const want = Math.hypot(x - sNavA.x, z - sNavA.z);
    if (nav.walkableReach(sNavA, sTgt, sProbe) < want - REACH_EPS) break;
    if (moveConflict(sim, e, x0, z0, x, z) !== null) break;
    set(sEye, x, sProbe.y + G.muzzleUp, z);
    if (sim.world.segmentBlocked(sEye, p)) break;
    copy(sNavA, sProbe);
    run = a;
  }
  return run;
}

/**
 * How far (up to `maxLen`, in steps of `stepLen`) the guard can run straight along the unit direction
 * (ux, uz): every step walkable, no other enemy closer than the separation distance, the player in plain
 * view from each point and no farther than `dMax` / no nearer than `dMin` (3D, from the standing centre).
 */
function lineRun(sim: Sim, e: EnemyState, ai: EnemyAi, ux: number, uz: number, maxLen: number, stepLen: number, dMin: number, dMax: number): number {
  const nav = sim.nav;
  const p = sim.player.pos;
  const steps = Math.round(maxLen / stepLen);
  const from = navPoint(e, ai, sFrom);
  const x0 = from.x;
  const z0 = from.z;
  copy(sNavA, from);
  let run = 0;
  for (let k = 1; k <= steps; k++) {
    const a = k * stepLen;
    const x = x0 + ux * a;
    const z = z0 + uz * a;
    set(sTgt, x, sNavA.y, z);
    if (nav.walkableReach(sNavA, sTgt, sProbe) < stepLen - REACH_EPS) break;
    const dx = x - p.x;
    const dy = sProbe.y - p.y;
    const dz = z - p.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > dMax * dMax || d2 < dMin * dMin) break;
    if (moveConflict(sim, e, x0, z0, x, z) !== null) break;
    set(sEye, x, sProbe.y + G.muzzleUp, z);
    if (sim.world.segmentBlocked(sEye, p)) break;
    copy(sNavA, sProbe);
    run = a;
  }
  return run;
}

/** Sets the guard strafing towards `side` (pure lateral move on the circle around the player). */
function strafeTowards(ai: EnemyAi, side: number): void {
  ai.strafeSign = side > 0 ? 1 : -1;
  ai.dirAngle = ai.strafeSign * HALF_PI;
  ai.moveKind = MOVE_DIR;
  ai.speed = G.strafeSpeed;
  ai.lineOn = false;
}

/** Sets the guard strafing along the straight line (ux, uz). */
function strafeAlong(ai: EnemyAi, ux: number, uz: number): void {
  ai.lineOn = true;
  ai.lineX = ux;
  ai.lineZ = uz;
  ai.moveKind = MOVE_DIR;
  ai.speed = G.strafeSpeed;
}

/** No voluntary change of side right after a turn or a start. */
function deferSwitch(ai: EnemyAi, t: number): void {
  const gap = t + ENEMY_TUNING.strafeTurnGap;
  if (ai.strafeSwitchAt < gap) ai.strafeSwitchAt = gap;
}

/**
 * Largest distance to the player a straight-line strafe may reach. Inside the 55 m band: the band itself (a
 * straight line drifts outwards, and one step beyond 55 m would send the guard back to "approach"). Beyond
 * it (nothing nearer can be reached): 0.3 m more than the nearest the guard has been since this strafe began.
 */
function lineBandMax(base: number): number {
  return base > G.approachBeyond ? base + 0.3 : G.approachBeyond;
}
const LINE_BAND_MIN = G.strafeMin + 0.5;

/**
 * Looks for a straight line to sweep (see ENEMY_TUNING.lineAngles) and starts along it. False when no line
 * offers the room.
 */
function startLine(sim: Sim, e: EnemyState, ai: EnemyAi, t: number, bx: number, bz: number): boolean {
  const reach = ENEMY_TUNING.lineReach;
  const step = ENEMY_TUNING.lineStep;
  const d = distance(e.pos, sim.player.pos);
  const dMax = lineBandMax(ai.strafeBaseD);
  const dMin = Math.min(LINE_BAND_MIN, d);
  const angles = ENEMY_TUNING.lineAngles;
  let bestLat = 0;
  let bestX = 0;
  let bestZ = 0;
  for (let k = 0; k < angles.length; k++) {
    const ang = (angles[k] * Math.PI) / 180;
    const sn = Math.sin(ang);
    // Even a full-length sweep along this line would not beat the best one so far.
    if (2 * reach * sn <= bestLat) continue;
    const c = Math.cos(ang);
    const ux = bx * c - bz * sn;
    const uz = bx * sn + bz * c;
    const fwd = lineRun(sim, e, ai, ux, uz, reach, step, dMin, dMax);
    const back = lineRun(sim, e, ai, -ux, -uz, reach, step, dMin, dMax);
    const span = fwd + back;
    const lat = span * sn;
    if (span < ENEMY_TUNING.strafeMinSpan || lat <= bestLat) continue;
    bestLat = lat;
    // Start towards the longer end.
    const dir = fwd >= back ? 1 : -1;
    bestX = ux * dir;
    bestZ = uz * dir;
  }
  if (!(bestLat > 0)) return false;
  ai.lineMaxD = dMax;
  strafeAlong(ai, bestX, bestZ);
  ai.legStartAt = t;
  deferSwitch(ai, t);
  return true;
}

/** Room (m) a full strafe leg needs: strafeMinLegSeconds at the strafe speed. */
const STRAFE_LONG_RUN = ENEMY_TUNING.strafeMinLegSeconds * G.strafeSpeed;

/** The guard stands (and keeps firing); the strafe decision is taken again on the next check. */
function standStrafe(ai: EnemyAi): void {
  ai.moveKind = MOVE_NONE;
  ai.speed = 0;
  ai.lineOn = false;
}

/**
 * The leg in use cannot go on. True when it began less than strafeMinLegSeconds ago: the guard then stands
 * where it is until that time is over (no second change of direction within a fraction of a second). With
 * `keepLine` the straight line it was sweeping is kept, so that it turns back along the same line afterwards.
 */
function holdShortLeg(ai: EnemyAi, t: number, keepLine = false): boolean {
  const until = ai.legStartAt + ENEMY_TUNING.strafeMinLegSeconds;
  if (!(t < until - TIME_EPS)) return false;
  ai.holdUntil = until;
  ai.moveKind = MOVE_NONE;
  ai.speed = 0;
  if (!keepLine) ai.lineOn = false;
  return true;
}

/**
 * The strafe decision (25 – 55 m, and beyond 55 m when nothing nearer can be reached). While the side in
 * use offers the look-ahead and no change of side is due, the guard simply carries on. Otherwise both sides
 * of the circle around the player are measured (up to a full leg, STRAFE_LONG_RUN). With strafeMinSpan of
 * room in total: a guard whose side has ended first stands out the rest of strafeMinLegSeconds (holdShortLeg)
 * and then starts towards the side with more room; a voluntary change in mid-run is taken only with a full
 * leg of room on the other side. Without that room it sweeps a straight line if there is one (startLine, same
 * leg rule), and otherwise stands and fires.
 */
function decideStrafe(sim: Sim, e: EnemyState, ai: EnemyAi, t: number, bx: number, bz: number, r: number, entered: boolean, stuck: boolean): void {
  const look = ENEMY_TUNING.strafeLookAhead;
  const span = ENEMY_TUNING.strafeMinSpan;
  const leg = ENEMY_TUNING.strafeMinLeg;
  const long = STRAFE_LONG_RUN;
  const s = ai.strafeSign;
  if (entered) ai.holdUntil = 0;
  const moving = !entered && ai.moveKind === MOVE_DIR;
  if (!moving && ai.holdUntil > 0) {
    // Standing out the rest of a short leg.
    if (t < ai.holdUntil - TIME_EPS) return;
    ai.holdUntil = 0;
    if (ai.lineOn) {
      // It stood at the end of a straight line: back along the same line if that is still worth it.
      const dMin = Math.min(LINE_BAND_MIN, distance(e.pos, sim.player.pos));
      if (lineRun(sim, e, ai, -ai.lineX, -ai.lineZ, leg, ENEMY_TUNING.lineStep, dMin, ai.lineMaxD) >= leg) {
        strafeAlong(ai, -ai.lineX, -ai.lineZ);
        ai.legStartAt = t;
        deferSwitch(ai, t);
        return;
      }
      ai.lineOn = false;
    }
  }
  const onLine = moving && ai.lineOn;
  const running = moving && !ai.lineOn && Math.abs(Math.abs(ai.dirAngle) - HALF_PI) < 1e-9;
  let change = false;
  if (stuck) {
    // Held up on this side although it measured free: leave it alone for a while.
    if (running) {
      ai.blockedSide = s;
      ai.blockedUntil = t + ENEMY_TUNING.strafeBlockedSeconds;
    }
    ai.stuckFor = 0;
    ai.stuckBy = STUCK_NONE;
  } else if (t >= ai.strafeSwitchAt - TIME_EPS) {
    change = true;
    ai.strafeSwitchAt = t + sim.rng.range(ENEMY_TUNING.strafeSwitchMin, ENEMY_TUNING.strafeSwitchMax);
  }
  if (running && !stuck && !change && strafeRun(sim, e, ai, bx, bz, r, s, look) >= look) return; // carry on
  if (onLine) {
    const step = ENEMY_TUNING.lineStep;
    const dMin = Math.min(LINE_BAND_MIN, distance(e.pos, sim.player.pos));
    const ahead = stuck ? 0 : lineRun(sim, e, ai, ai.lineX, ai.lineZ, look, step, dMin, ai.lineMaxD);
    if (ahead >= look) {
      if (!change) return; // carry on
      // A change is due: turn only with a full leg of room behind, else carry on.
      const need = Math.min(long, ENEMY_TUNING.lineReach);
      if (lineRun(sim, e, ai, -ai.lineX, -ai.lineZ, need, step, dMin, ai.lineMaxD) >= need) {
        strafeAlong(ai, -ai.lineX, -ai.lineZ);
        ai.legStartAt = t;
        deferSwitch(ai, t);
      }
      return;
    }
    // The leg has ended: stand out the rest of a short one, then turn if the way back is worth it.
    if (holdShortLeg(ai, t, true)) return;
    if (lineRun(sim, e, ai, -ai.lineX, -ai.lineZ, leg, step, dMin, ai.lineMaxD) >= leg) {
      strafeAlong(ai, -ai.lineX, -ai.lineZ);
      ai.legStartAt = t;
      deferSwitch(ai, t);
      return;
    }
  }
  const blocked = t < ai.blockedUntil - TIME_EPS ? ai.blockedSide : 0;
  const own = blocked === s ? 0 : strafeRun(sim, e, ai, bx, bz, r, s, long);
  const other = blocked === -s ? 0 : strafeRun(sim, e, ai, bx, bz, r, -s, long);
  if (own + other < span) {
    // No room on the circle: a straight line, or stand and fire.
    if (running && holdShortLeg(ai, t)) return;
    if (t >= ai.lineCheckAt - TIME_EPS && startLine(sim, e, ai, t, bx, bz)) return;
    if (t >= ai.lineCheckAt - TIME_EPS) ai.lineCheckAt = t + ENEMY_TUNING.lineRetry;
    standStrafe(ai);
    return;
  }
  let side: number = s;
  if (change && running && own >= look) {
    // Voluntary change in mid-run: only with a full leg of room on the other side.
    if (other >= long) side = -s;
  } else if (running) {
    // The side in use has ended (or held the guard up): stand out the rest of a short leg, then turn.
    if (holdShortLeg(ai, t)) return;
    if (other >= leg || own < look) side = -s;
  } else if (own < long && other > own) {
    // Starting (again): the side with more room; its own side when that offers a full leg.
    side = -s;
  }
  if (side !== s || !running) {
    ai.legStartAt = t;
    deferSwitch(ai, t);
  }
  strafeTowards(ai, side);
}

/**
 * Seeing the player within 55 m: a direction move relative to the bearing towards the player —
 * strafe (25–55 m), diagonal back-off (15–25 m) or retreat (< 15 m). Stands still when no bearing is free.
 */
function thinkDirection(sim: Sim, e: EnemyState, ai: EnemyAi, t: number, kind: 'strafe' | 'adjust' | 'retreat'): void {
  const p = sim.player.pos;
  let bx = p.x - e.pos.x;
  let bz = p.z - e.pos.z;
  const bl = Math.hypot(bx, bz);
  if (bl > 1e-6) {
    bx /= bl;
    bz /= bl;
  } else {
    bx = -Math.sin(e.yaw);
    bz = -Math.cos(e.yaw);
  }
  const entered = ai.mode !== kind;
  if (entered) {
    ai.mode = kind;
    ai.path = null;
    ai.pathFor = 'none';
    ai.pathVantage = false;
    ai.stuckFor = 0;
    ai.stuckBy = STUCK_NONE;
  }
  if (ai.strafeSwitchAt !== ai.strafeSwitchAt) {
    // First direction move of this guard: random side, random time of the first voluntary change.
    ai.strafeSign = sim.rng.sign();
    ai.strafeSwitchAt = t + sim.rng.range(ENEMY_TUNING.strafeSwitchMin, ENEMY_TUNING.strafeSwitchMax);
  }
  const stuck = ai.moveKind === MOVE_DIR && ai.stuckFor >= ENEMY_TUNING.dirStuckSeconds;
  if (entered || stuck || t >= ai.dirCheckAt - TIME_EPS) {
    ai.dirCheckAt = t + ENEMY_TUNING.dirCheckInterval;
    if (kind === 'strafe') {
      // Reference distance of a strafe beyond the band: the nearest the guard has been; it follows the
      // player when the player moves off (more than the 0.3 m a straight sweep may drift outwards).
      const d = distance(e.pos, p);
      if (entered || d < ai.strafeBaseD || d > ai.strafeBaseD + 1) ai.strafeBaseD = d;
      decideStrafe(sim, e, ai, t, bx, bz, bl, entered, stuck);
    } else {
      // The bearing in use made no headway although it probed free (a corner): take the other side and leave
      // that bearing out this time.
      const avoid = stuck ? ai.dirAngle : Number.NaN;
      const lock = t + ENEMY_TUNING.sideLockSeconds;
      if (stuck) {
        ai.strafeSign = ai.strafeSign === 1 ? -1 : 1;
        ai.sideLockUntil = lock;
        ai.stuckFor = 0;
        ai.stuckBy = STUCK_NONE;
      } else if (t >= ai.strafeSwitchAt - TIME_EPS) {
        ai.strafeSwitchAt = t + sim.rng.range(ENEMY_TUNING.strafeSwitchMin, ENEMY_TUNING.strafeSwitchMax);
        if (t >= ai.sideLockUntil - TIME_EPS) {
          ai.strafeSign = ai.strafeSign === 1 ? -1 : 1;
          ai.sideLockUntil = lock;
        }
      }
      const s = ai.strafeSign;
      // The other side is only open again some time after the last change of side.
      const oneSided = t < ai.sideLockUntil - TIME_EPS;
      let n = 0;
      if (kind === 'adjust') {
        candAngle[n] = s * ADJUST_BEARING;
        candSide[n++] = s;
        candAngle[n] = -s * ADJUST_BEARING;
        candSide[n++] = -s;
        candAngle[n] = s * HALF_PI;
        candSide[n++] = s;
        candAngle[n] = -s * HALF_PI;
        candSide[n++] = -s;
        candAngle[n] = Math.PI;
        candSide[n++] = 0;
      } else {
        // Straight away first, then the free bearing with the largest away component (down to pure sideways,
        // which slides along a wall behind the guard).
        candAngle[n] = Math.PI;
        candSide[n++] = 0;
        for (let k = 0; k < RETREAT_OFFSETS.length; k++) {
          candAngle[n] = s * (Math.PI - RETREAT_OFFSETS[k]);
          candSide[n++] = s;
          candAngle[n] = -s * (Math.PI - RETREAT_OFFSETS[k]);
          candSide[n++] = -s;
        }
      }
      // Bearings that keep the line of sight first; a retreat may also break it.
      let chosen = -1;
      const passes = kind === 'retreat' ? 2 : 1;
      for (let pass = 0; pass < passes && chosen < 0; pass++) {
        for (let k = 0; k < n; k++) {
          if (candAngle[k] === avoid || (oneSided && candSide[k] === -s)) continue;
          const c = Math.cos(candAngle[k]);
          const sn = Math.sin(candAngle[k]);
          if (probe(sim, e, ai, bx * c - bz * sn, bx * sn + bz * c, pass === 0)) {
            chosen = k;
            break;
          }
        }
      }
      if (chosen < 0) {
        ai.moveKind = MOVE_NONE;
        ai.speed = 0;
      } else {
        ai.moveKind = MOVE_DIR;
        ai.lineOn = false;
        ai.dirAngle = candAngle[chosen];
        if (candSide[chosen] === -s) {
          ai.strafeSign = s === 1 ? -1 : 1;
          ai.sideLockUntil = lock;
        }
        ai.speed = kind === 'adjust' ? ENEMY_TUNING.adjustSpeed : G.retreatSpeed;
      }
    }
  }
  if (ai.moveKind === MOVE_DIR && kind === 'strafe' && ai.lineOn) {
    // Straight-line strafe: a fixed direction in the world.
    ai.dirX = ai.lineX;
    ai.dirZ = ai.lineZ;
    ai.orbitR = 0;
  } else if (ai.moveKind === MOVE_DIR) {
    const c = Math.cos(ai.dirAngle);
    const sn = Math.sin(ai.dirAngle);
    ai.dirX = bx * c - bz * sn;
    ai.dirZ = bx * sn + bz * c;
    ai.bearX = bx;
    ai.bearZ = bz;
    // Only the pure strafe follows the circle around the player.
    ai.orbitR = kind === 'strafe' && Math.abs(Math.abs(ai.dirAngle) - HALF_PI) < 1e-9 ? bl : 0;
  } else {
    ai.orbitR = 0;
  }
}

/** Alert without a line of sight and without anywhere to go: look around `searchAnchor`. */
function thinkSearch(sim: Sim, e: EnemyState, ai: EnemyAi, t: number): void {
  if (ai.mode !== 'search') {
    ai.mode = 'search';
    ai.searchRepickAt = -Infinity;
    if (ai.pathFor !== 'search') {
      ai.path = null;
      ai.pathFor = 'none';
      ai.pathVantage = false;
    }
  }
  if (!ai.searchAnchor) ai.searchAnchor = clone(navPoint(e, ai, sFrom));
  const walking = ai.pathFor === 'search' && pathLeft(ai);
  const repick = !walking || t >= ai.searchRepickAt - TIME_EPS || ai.stuckFor >= ENEMY_TUNING.pathStuckSeconds;
  if (repick && t >= ai.planOkAt - TIME_EPS) {
    const spot = sim.nav.randomWalkableNear(ai.searchAnchor, ENEMY_TUNING.searchRadius, sim.rng, sPick);
    const path = spot ? sim.nav.findPath(navPoint(e, ai, sFrom), spot, 1) : null;
    if (path) {
      adoptPath(ai, path, 'search', false, t);
      ai.searchRepickAt = t + ENEMY_TUNING.searchRepick;
    } else {
      ai.plannedAt = t;
      ai.planOkAt = t + ENEMY_TUNING.planRetry;
      if (!walking) {
        ai.path = null;
        ai.pathFor = 'none';
      }
    }
  }
  if (ai.pathFor === 'search' && pathLeft(ai)) {
    followPath(ai, 'search', ENEMY_TUNING.searchSpeed);
  } else {
    ai.moveKind = MOVE_NONE;
    ai.speed = 0;
    ai.orbitR = 0;
  }
}

/** The chase is over (goal reached, crowded by other guards, or nowhere to go): look around from here. */
function arrive(sim: Sim, e: EnemyState, ai: EnemyAi, t: number): void {
  ai.arrived = true;
  ai.searchAnchor = clone(navPoint(e, ai, sFrom));
  thinkSearch(sim, e, ai, t);
}

/** True when the end of the guard's vantage path still overlooks `target` within the guard's range. */
function vantageHolds(sim: Sim, ai: EnemyAi, target: V3): boolean {
  const path = ai.path;
  if (!ai.pathVantage || path === null || ai.pathIdx >= path.length) return false;
  const end = path[path.length - 1];
  const w = ENEMY_TUNING.chaseWithin;
  if (!(distanceSq(end, target) <= w * w)) return false;
  set(sEye, end.x, end.y + G.muzzleUp, end.z);
  return !sim.world.segmentBlocked(sEye, target);
}

/** Alert without a line of sight: go to the last known position (never the hidden current one). */
function thinkChase(sim: Sim, e: EnemyState, ai: EnemyAi, t: number, target: V3): void {
  if (!ai.chaseValid || distance(ai.chaseGoal, target) > ENEMY_TUNING.sameGoalDistance) {
    // A new last known position (own sighting just lost, or a report from another guard).
    copy(ai.chaseGoal, target);
    ai.chaseValid = true;
    ai.chaseFailed = false;
    const walking = pathLeft(ai) && (ai.pathFor === 'chase' || ai.pathFor === 'approach');
    const approachHolds =
      walking && ai.pathFor === 'approach' && Math.hypot(ai.approachGoal.x - target.x, ai.approachGoal.z - target.z) <= ENEMY_TUNING.replanGoalShift;
    if (approachHolds || (walking && vantageHolds(sim, ai, target))) {
      // The path in use leads to (a view of) this very position: it is the chase plan already. A guard that
      // loses sight half-way to a vantage point must not turn back for the view it just left.
      ai.pathFor = 'chase';
      ai.arrived = false;
      ai.chaseStale = false;
    } else {
      // A path to the previous position is followed until the new plan is in (the search throttle may hold
      // it back a moment); a guard that is looking around goes on doing so until then.
      ai.chaseStale = true;
    }
  }
  let walkable = pathLeft(ai) && (ai.pathFor === 'chase' || ai.pathFor === 'approach');
  if (!ai.chaseStale && !ai.arrived && ai.pathFor === 'chase' && ai.path !== null) {
    const path = ai.path;
    if (ai.pathIdx >= path.length) {
      // Reached the last known position (or the reachable spot nearest to it) without finding the player.
      arrive(sim, e, ai, t);
      return;
    }
    const end = path[path.length - 1];
    if (
      ai.stuckFor >= ENEMY_TUNING.pathStuckSeconds &&
      ai.stuckBy === STUCK_ENEMY &&
      Math.hypot(end.x - e.pos.x, end.z - e.pos.z) <= ENEMY_TUNING.crowdArriveDistance
    ) {
      // Other guards already stand at the spot.
      arrive(sim, e, ai, t);
      return;
    }
  }
  const stuck = walkable && ai.stuckFor >= ENEMY_TUNING.pathStuckSeconds;
  if ((ai.chaseStale || (!ai.arrived && (!walkable || stuck))) && t >= ai.planOkAt - TIME_EPS) {
    if (!ai.chaseStale && stuck && ai.stuckBy === STUCK_ENEMY) {
      // Another enemy stands in the way: go round it; with no way round wait a little, then give up here.
      if (!planDetour(sim, e, ai, t) && ai.stuckFor >= ENEMY_TUNING.blockedGiveUp) {
        arrive(sim, e, ai, t);
        return;
      }
    } else {
      const ok = planPath(sim, e, ai, target, 'chase', t) || planVantage(sim, e, ai, target, CHASE_VANTAGE, 'chase', t);
      ai.chaseStale = false;
      ai.chaseFailed = !ok;
      if (ok) {
        walkable = true;
        ai.arrived = false;
      } else if (!ai.arrived) {
        walkable = false;
        ai.path = null;
        ai.pathFor = 'none';
        ai.pathVantage = false;
      }
    }
  }
  if (ai.arrived) {
    thinkSearch(sim, e, ai, t);
  } else if (walkable) {
    followPath(ai, 'chase', G.approachSpeed);
  } else if (ai.chaseFailed) {
    // No route, no spot with a view, nothing nearer than here: look around from where it stands.
    arrive(sim, e, ai, t);
  } else if (ai.moveKind === MOVE_DIR) {
    // Sight lost in the middle of a strafe / retreat while the search throttle holds the plan back
    // (at most planMinGap): keep running straight on instead of stopping dead.
    ai.mode = 'chase';
    ai.orbitR = 0;
  } else {
    ai.mode = 'hold';
    ai.moveKind = MOVE_NONE;
    ai.speed = 0;
    ai.orbitR = 0;
  }
}

function thinkGuard(sim: Sim, e: EnemyState, ai: EnemyAi, t: number): void {
  if (!e.alert) {
    if (ai.mode !== 'idle' || ai.moveKind !== MOVE_NONE) halt(ai, 'idle');
    return;
  }
  if (ai.gridState === GRID_UNKNOWN) locate(sim, e, ai);
  if (ai.gridState === GRID_NONE) {
    halt(ai, 'hold');
    return;
  }
  if (ai.gridState === GRID_OFF) {
    // Placed outside the walkable area: first get onto it.
    ai.mode = 'approach';
    ai.moveKind = MOVE_HOP;
    ai.speed = G.approachSpeed;
    ai.orbitR = 0;
    return;
  }
  if (e.hasLos) {
    // The next loss of sight starts a new chase.
    ai.chaseValid = false;
    ai.arrived = false;
    ai.searchAnchor = null;
    const d = distance(e.pos, sim.player.pos);
    if (d > G.approachBeyond) {
      if (!thinkApproach(sim, e, ai, t)) thinkDirection(sim, e, ai, t, 'strafe');
    } else if (d >= G.strafeMin) {
      thinkDirection(sim, e, ai, t, 'strafe');
    } else if (d >= G.retreatBelow) {
      thinkDirection(sim, e, ai, t, 'adjust');
    } else {
      thinkDirection(sim, e, ai, t, 'retreat');
    }
  } else if (e.lastKnownPlayerPos) {
    thinkChase(sim, e, ai, t, e.lastKnownPlayerPos);
  } else {
    // Alerted by a hit without perceiving the player: look around where it stands.
    thinkSearch(sim, e, ai, t);
  }
}

/** Visual fields: body yaw and barrel direction. */
function face(sim: Sim, e: EnemyState): void {
  if (e.hasLos) {
    const p = sim.player.pos;
    const dx = p.x - e.pos.x;
    const dz = p.z - e.pos.z;
    if (dx * dx + dz * dz > 1e-12) e.yaw = yawFromDir(dx, dz);
    if (leadDirection(sim, enemyMuzzle(e, sMuzzle), ENEMIES[e.kind].bulletSpeed, sLead)) copy(e.aimDir, sLead);
    return;
  }
  if (!e.alert) return;
  const known = e.lastKnownPlayerPos;
  const moving = e.vel.x * e.vel.x + e.vel.z * e.vel.z > 0.04;
  if (moving) e.yaw = yawFromDir(e.vel.x, e.vel.z);
  if (known) {
    const m = enemyMuzzle(e, sMuzzle);
    const dx = known.x - m.x;
    const dy = known.y - m.y;
    const dz = known.z - m.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > 1e-6 && Number.isFinite(len)) set(e.aimDir, dx / len, dy / len, dz / len);
    if (!moving && dx * dx + dz * dz > 1e-12) e.yaw = yawFromDir(dx, dz);
  } else {
    set(e.aimDir, -Math.sin(e.yaw), 0, -Math.cos(e.yaw));
  }
}

// ───────────────────────────── public update ─────────────────────────────

/**
 * Perception and attacks at the current sim.time (end of a sub-step of length `h`): range + line of
 * sight, alert / memory / sharing, burst scheduling (telegraph included in the delays), per-shot muzzle
 * LOS check, predictive aim with jitter from sim.rng, bullet spawn, movement decisions for guards.
 */
export function updateEnemies(sim: Sim, _h: number): void {
  const t = sim.time;
  if (!Number.isFinite(t)) return;
  const list = sim.enemies;
  const n = list.length;
  if (navRegionsFor.get(sim) !== openBarrierCount(sim)) refreshNavRegions(sim, list);

  // 1. What every enemy sees right now; memory. A destroyed turret stops being an obstacle for the guards.
  for (let i = 0; i < n; i++) {
    const e = list[i];
    if (!e.alive) {
      if (e.kind === 'turret') {
        const ai = aiOf(e);
        if (ai.navObstacle) {
          ai.navObstacle = false;
          sim.nav.setObstacle(e.index, null);
          refreshNavRegions(sim, list);
        }
      }
      continue;
    }
    if (e.passive) continue;
    perceive(sim, e, aiOf(e), t);
  }

  // 2. Seeing guards report to the enemies near them (the receivers decide in pass 4 of this same update).
  for (let i = 0; i < n; i++) {
    const e = list[i];
    if (!e.alive || e.passive || e.kind !== 'guard' || !e.hasLos) continue;
    const ai = aiOf(e);
    if (t >= ai.nextShareAt - TIME_EPS) {
      ai.nextShareAt = t + ENEMY_TUNING.shareInterval;
      shareSighting(sim, e, t);
    }
  }

  // 3. Attack schedules: telegraphs and the shots due now (index order → deterministic rng use).
  for (let i = 0; i < n; i++) {
    const e = list[i];
    if (!e.alive || e.passive) continue;
    updateAttack(sim, e, aiOf(e), t);
  }

  // 4. Movement decisions for the next sub-step, facing.
  for (let i = 0; i < n; i++) {
    const e = list[i];
    if (!e.alive || e.passive) continue;
    if (e.kind === 'guard') thinkGuard(sim, e, aiOf(e), t);
    face(sim, e);
  }
}

/**
 * Earliest strictly-future time at which any enemy has a scheduled discrete event (telegraph start,
 * burst shot, end of the memory). Infinity when there is none.
 */
export function enemiesNextEventTime(sim: Sim): number {
  const now = sim.time + TIME_EPS;
  const list = sim.enemies;
  let best = Infinity;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e.alive || e.passive) continue;
    const ai = aiOf(e);
    const start = e.burstStartAt;
    if (start !== null) {
      if (e.burstShotsDone === 0 && e.telegraphStartAt !== null && ai.telegraphFor !== start) {
        const ts = e.telegraphStartAt;
        if (ts > now && ts < best) best = ts;
      }
      const due = start + e.burstShotsDone * ENEMIES[e.kind].burstInterval;
      if (due > now && due < best) best = due;
    }
    if (e.alert && !e.hasLos) {
      const end = ai.alertUntil;
      if (end > now && end < best) best = end;
    }
  }
  return best;
}

/**
 * Hook called by Sim.damageEnemy for a surviving enemy that was just hit by the player. The enemy becomes
 * alert for the memory time — it knows it is under fire — but a hit tells it nothing about where the player
 * is: positions come from perception only (range + line of sight, SPEC §2.3), whoever fired first. An enemy
 * that perceives the player knows the position anyway; one that does not (out of range, or no clear line)
 * is alert without a position — a guard looks around its post, a turret stays as it is — and calms down
 * ENEMY_AI.memorySeconds after the last hit. Being hit never lets it shoot.
 */
export function onEnemyDamaged(sim: Sim, enemy: EnemyState): void {
  if (!enemy.alive || enemy.passive) return;
  const t = sim.time;
  if (!Number.isFinite(t)) return;
  const ai = aiOf(enemy);
  // With a remembered position the memory keeps running from its last confirmation; without one the alert
  // lasts from this hit.
  if (!enemy.lastKnownPlayerPos) {
    const until = t + ENEMY_AI.memorySeconds;
    if (!(ai.alertUntil >= until)) ai.alertUntil = until;
  }
  becomeAlert(sim, enemy);
}
