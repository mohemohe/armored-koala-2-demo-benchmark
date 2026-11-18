# AK2 DEMO — architecture and module contracts

The requirement document is `docs/SPEC.md` (authoritative, Japanese). This file fixes the design
decisions that are *not* in the spec so that independently written modules fit together.
Code contracts live in `src/sim/types.ts`, `src/config.ts` and the exported signatures of each module.

## 1. Environment

- Node/npm are provided by mise and are NOT on PATH by default. Start every shell command with
  `source /tmp/claude-0/-root-armored-koala-2-demo/c2ccd9e8-475a-4f33-a88a-1e483df88046/scratchpad/env.sh`
  which defines `x` (= `mise x node@26.13.1 npm@12.2.2 --`) and the browser environment variables. Examples:
  `source …/env.sh; x npx tsc --noEmit` · `x npx vitest run tests/foo.test.ts` · `x npx tsx tools/foo.ts`.
- Type check: `x npx tsc --noEmit` (TypeScript 7). Unit tests: vitest (Node environment, no DOM).
- Headless browser: `x node tools/shot.mjs <url> <out.png> [--size WxH] [--wait ms] [--click sel] [--keys Code:ms,…] [--after ms] [--eval js]`
  or your own playwright-core script using `launchBrowser()` / `openPage()` from `tools/browser.mjs`
  (Chromium with SwiftShader WebGL; pointer lock works after a real click). env.sh provides the extra shared
  libraries and fonts this machine lacks (`AK2_CHROME_LIBS`, `FONTCONFIG_FILE`); without it no text is rendered.
  SwiftShader is slow (a few fps at 1280x720): judge visuals from screenshots (open the PNG with the Read tool),
  never from frame rate. Put screenshots and scratch files under
  `/tmp/claude-0/-root-armored-koala-2-demo/c2ccd9e8-475a-4f33-a88a-1e483df88046/scratchpad/<your-area>/`, not in the repo.
- Dev server: `npx vite --port <your port> --strictPort` (several agents work concurrently: use the port given to you).
- Dependencies are pinned in package.json; do not add or upgrade dependencies. three.js is r187 (`three@0.187.0`).
- No external network resources at runtime (no CDN, fonts, images, models, audio files). All assets are procedural.

## 2. Conventions

- 1 unit = 1 m, seconds, radians. +Y is up. Gravity 18 m/s² along -Y.
- `pos` of the player and of every enemy is the **centre of its hit volume**. Player: AABB with half extents
  `PLAYER.half` = (1.3, 2.0, 1.3) (never rotates). Enemies: spheres (`ENEMIES.guard.radius` 1.2, `ENEMIES.turret.radius` 1.4).
  A player standing on a floor at y = 0 has `pos.y` ≈ 2.0. A guard on that floor has `pos.y` = 1.3, a turret 1.6.
- Orientation = three.js Euler 'YXZ': yaw 0 looks along -Z, positive yaw turns left; positive pitch looks up.
  forward = (-sin yaw · cos pitch, sin pitch, -cos yaw · cos pitch); horizontal right = (cos yaw, 0, -sin yaw).
  Helpers in `src/core/vec.ts`. Body yaw of the mech = camera yaw.
- Muzzle = `pos + right·0.9 + up·0.75 + forwardHorizontal·0.85` (`computeMuzzle`). It is independent of the aim
  direction (the weapon pivots about its muzzle) and always inside the player's collision box.
- Vectors are plain `{x,y,z}` (`V3`). **`src/sim`, `src/core`, `src/stage` must not import three.js** (they run in Node tests).
- Determinism: simulation code uses `sim.rng` only (never Math.random / Date / performance.now).
- All stage collision is axis-aligned boxes. Every solid blocks movement, bullets, beams, missiles and line of sight.

## 3. Time stepping (src/sim/sim.ts — already implemented, read it)

`Sim.advance(dt)` runs whole 1/120 s ticks; `Sim.runFor(seconds)` does the same without the frame cap (tests).
Inside a tick, sub-steps are cut at `nextEventTime()` so that discrete events happen exactly on a boundary.
Order inside one sub-step [t0, t1] (h = t1 - t0 ≤ 1/120):

1. edges at t0: `applyWeaponSwitch`, `applyPlayerInputEdges` (QB start pays 36 EN here)
2. `updatePlayer(sim, h, beamEnReserve(sim, t1))` — player moves t0→t1
3. `moveEnemies(sim, h)` — enemies move t0→t1
4. `advanceProjectiles(sim, t0, t1)` — swept tests against world, moving enemies, moving player
5. `sim.time = t1`
6. `updateCamera`, `updateLock(sim, h)`
7. `updateEnemies(sim, h)` — perception, schedules, enemy shots due at t1 (spawned at t1, age 0)
8. `processPlayerFire(sim)` — the player's shot at t1 from the t1 state
9. `refreshFireControl(sim)`
10. sector tracking, outcome (failure before clear)

During steps 1–4 `sim.time` is still t0. Modules report event times through `playerNextEventTime`,
`weaponsNextEventTime`, `enemiesNextEventTime` — **strictly future times only** (> sim.time + TIME_EPS) or Infinity.
An event that is already due is simply handled at the end of the current sub-step.
Compare times with `TIME_EPS` (1e-9). Pause = the app does not call `advance`; every timer is in sim time.

## 4. Module responsibilities and design decisions

### world.ts (implemented, brute force → to be accelerated)
Signatures are final. Needs a spatial index (uniform XZ grid) because the factory has thousands of boxes and
raycasts/sweeps run thousands of times per second. Semantics must stay identical (touching ≠ overlapping,
SKIN gap, per-axis contact normals, barriers toggled via `active`).

### ballistics.ts (pure maths)
- `solveGravityIntercept`: quartic `(a·a)t⁴ + 2(v·a)t³ + (v·v + 2 r·a − s²)t² + 2(r·v)t + r·r = 0` with `a = −0.5 g = (0, +gravity/2, 0)`.
  Must return the smallest root in (0, maxTime], including tangential double roots and a root exactly at maxTime.
  Suggested: isolate monotonic intervals via the critical points (roots of the cubic derivative, themselves found via
  the quadratic second derivative), bisection + Newton polish per interval, explicit double-root check at critical
  points (|f| ≤ tolerance), final residual verification ≤ 0.01 m computed from the *returned, normalised* direction.
  Never returns NaN/Infinity; returns null instead.
- `solveLinearIntercept`: quadratic, linear degenerate case, smallest positive root ≤ maxTime.
- `rotateTowards`, `sweepPointSphere`, `sweepPointBox` (relative-motion continuous tests; start-inside → 0).

### player.ts
- Horizontal modes: `quickboost` (impulse, velocity held, no steering/brake/glide toggle), `glide`
  (glideEnabled, target = glideDir × (grounded ? 22 : 16) × legs, accel limit (80−22)/0.6 or (80−16)/0.6 × legs),
  `walk` (target = inputDir × (grounded ? 10 : 16) × legs, limit 120 × legs; brake: target 0, glide off, WASD ignored).
- Exact integration inside a sub-step: the velocity moves towards the target at the accel limit; when the target is
  reached after τ < h use `disp = (v0+vT)/2·τ + vT·(h−τ)`, otherwise `disp = (v0+v1)/2·h` (trapezoid). This gives exactly
  42.6 m / 34.08 m in 0.75 s for a flat-ground QB. Vertical: `Δy = vy·h − 9h²`, `vy −= 18h` (exact).
- QB: edge only; conditions = not braking, ≥ 1.00 s since the previous QB start, EN ≥ 36. Sets horizontal velocity to
  dir × 80 × legs (dir = WASD in the camera-horizontal frame, else camera forward), keeps vy, pays 36 EN at once,
  `lastEnSpentAt = qbLastStartedAt = sim.time`. Impulse lasts 0.15 s (`playerNextEventTime` reports its end). At the end
  glide is forced on and `glideDir` = direction of the actual horizontal velocity (qbDir if it is ~0); the velocity is
  inherited untouched. Collisions remove velocity components permanently (never re-added from qbDir).
  Failed presses change nothing (no EN, no cooldown, no queue) and emit `qb-rejected`.
- Glide costs 0 EN in every situation. Shift edge toggles it (ignored during the impulse). ON: glideDir = input dir or
  camera forward. While gliding, WASD input replaces glideDir (camera turns alone do not rotate it).
- Jump: edge + grounded → vy = 10. `jumpHeldSince` = time of the Space press while it stays held.
  Flight: Space held ≥ 0.20 s **and airborne** and EN available → vy = 8 for the thrust time, 20 EN/s, limited to
  `en − enReserve`; if EN runs out mid-sub-step, thrust only for the affordable part and fall ballistically for the
  rest (no free climb). `lastEnSpentAt` = end of the thrust interval.
  A held Space never lifts a standing mech (leaving the ground takes a jump = a press edge while grounded, SPEC §7.4),
  but the hold itself stays valid through a landing: there is no "used up" latch. A mech that lands with Space down
  stays down (and recovers EN); if it then walks off an edge with Space still down it thrusts from its first airborne
  sub-step, because the two conditions of SPEC §7.1 (held ≥ 0.20 s, in the air) are met. The flight-threshold event is
  only reported while airborne.
- EN regen: grounded, nothing spent in the sub-step, and `t0 ≥ lastEnSpentAt + 0.75` (report that time as an event).
  Never regenerates in the air. Clamp EN to [0, maxEn].
- EN arithmetic: the two continuous changes (regeneration, flight drain) are evaluated in closed form from the instant
  the current one began (`en = en₀ + rate·(t − t₀)`, module-private anchor) and the result is stored on a lattice of
  1/(120·2²³) EN (≈ 1e-9 EN; every whole-tick amount `rate/120` and the costs 36 / 8 are exact multiples). Nothing is
  summed tick by tick, so EN does not depend on how ticks are cut into sub-steps and carries no accumulated rounding:
  at the instant the tank should hold exactly 36 (8) EN it holds exactly 36 (8), and the strict `en >= 36` / `en >= 8`
  tests (no tolerance) accept a QB / beam shot requested at that instant. `player.en` remains the only tank: QB and
  beam subtract from it directly, and the anchor restarts whenever anything else changed `en`.
- Collision: `world.moveBox`; remove the velocity component pointing into each contact normal; `ny = +1` → grounded.
  A fall whose sweep ends without contact but at most SKIN (+ CONTACT_EPS) above a supporting surface has landed too
  (`world.probeGround`): `moveBox` rests a landing SKIN above the floor and reports nothing for a sweep that ends inside
  that gap, and the mech must never be "falling" at or below its resting height.
  While grounded keep contact with `world.probeGround` (walking off an edge → falling). No step-up logic (floors are flat).
- Accepted consequence of the literal flight rules (SPEC §7.1 / §7.4: thrust = +8 m/s at once, a release keeps the
  vertical velocity, a re-press needs 0.20 s): "feathering" Space (hold 0.20 s + one thrust tick, release, repeat)
  climbs at about 6.2 m/s for about 0.8 EN/s, far cheaper than continuous flight (8 m/s for 20 EN/s). Every thrust
  tick is paid in full and none comes before its 0.20 s (tests/player.test.ts "feathering Space obeys every rule").
  It was left as is on purpose: a finite thrust acceleration would close most of it, but then a hold of 0.20 s would
  no longer give the 8 m/s climb of §7.1 at once (a falling mech would keep sinking while paying 20 EN/s). Nothing
  else depends on flight being scarce: the stage proofs V3–V8 in `tools/stageAnalysis.ts` are free-flight statements
  that ignore EN and gravity, and the stage bot itself hovers by re-pressing Space.
- Snapshot semantics: `desiredDir` = walk input dir / glideDir / qbDir / (0,0) when braking or idle.
  verticalMode: grounded | flying (thrusting) | rising (vy > 0) | falling.

### camera.ts (implemented)
`computeCameraRig`, `projectToViewport` (CSS px, origin top-left). The renderer must reuse `computeCameraRig`.

### fcs.ts
- Candidate test = alive ∧ |muzzle→centre| ≤ 120 ∧ in front of the camera ∧ projected centre inside the circle
  (radius `lock.radiusCssPx` = factor × min(viewport w, h), centre of the viewport) ∧ no stage box between the
  camera and the centre ∧ none between the muzzle and the centre.
  The inclusive 120 m limit carries a rounding guard of one nanometre (`FCS_RANGE_TOLERANCE` = 1e-9 m) and nothing
  more: a target placed to be at exactly 120 m at the firing instant (SPEC §4.6 A04 / A13) holds a position that was
  accumulated from rounded steps and comes out up to a few 1e-12 m on either side of 120 (measured; see the comment
  in fcs.ts and tests/fcs.test.ts "the 120 m limit …"). 120 m + 2 nm is rejected.
- `updateLock(sim, h)`: as SPEC §5 (sticky target, instant drop, progress restarts from 0, nearest-to-centre then id
  order). `h = 0` judges the lock for the current instant without letting time pass; the simulation does that
  wherever the judged state changes outside a sub-step:
  - `Sim.reset()` — the lock is judged at t = 0, so a target that is inside the circle from the first instant is
    `acquiring` with progress 0 at t = 0 and `locked` exactly `lockSeconds` after the sortie began (not one tick later);
  - `Sim.setViewport()` while the sortie is running (also while the app is paused and no tick runs) — the lock is
    re-judged against the new circle at once and `sim.fireControl` / `sim.aim` are refreshed: a target outside the
    displayed circle is dropped immediately with its solution, one that comes inside starts from 0, a valid lock is
    left untouched, and nothing advances however often the window is resized. A finished sortie (cleared / failed)
    stays frozen: only `radiusCssPx` and the camera aspect follow the window.
- `computeFireSolution`: MG → `solveGravityIntercept(m, p, v, 100, 18, 2)`; beam → direct, t = 0, residual 0;
  missile → `solveLinearIntercept(m, p, v, 45, 4)`; null → `no_solution` with direct aim (aimPoint = p).
  `v` is the enemy's actual `vel`. Uses `sim.player.muzzle`, never a cached value from an earlier target.
- `computeFreeAim`: camera-centre ray, started at the depth of the muzzle so nothing between camera and mech is hit;
  first world/enemy hit, else a far point; direction = muzzle → point.
- `refreshFireControl`: fills `sim.fireControl` and `sim.aim` (mode 'fcs' with the launch direction when locked).

### weapons.ts
Trigger held → fire when `sim.time ≥ nextFireAt[weapon]`; `nextFireAt = fireTime + interval` only on success.
Re-validate the lock, compute the solution from the same-time state, spawn/cast, pay ammo/EN, push a `ShotRecord`
(max 32, ids restart at 1 per sortie), emit events. Free fire uses `computeFreeAim`. Missile without a complete
lock → `fire-rejected` (no-lock); beam with EN < 8 → no-en; empty magazine → no-ammo (throttle these events).
Player projectiles never inherit the mech velocity.

### projectiles.ts
- MG bullet position is the closed form `origin + v0·a + ½g·a²`; per sub-step the chord prevPos→pos is tested
  (deviation ≪ 0.01 m at h ≤ 1/120). The last interval is clamped to the life end, tested, then the bullet is removed.
- Player projectiles test the world (raycast) and every living enemy with `sweepPointSphere` using the enemy's
  prevPos→pos over the same interval; earliest contact wins; `sim.damageEnemy` once.
- Missile: each sub-step observe the target (if alive and visible from the missile) → desired direction from
  `solveLinearIntercept` bounded by the remaining life, else straight at the observed/extrapolated position; rotate the
  heading by at most 120°/s·h; speed stays 45; keeps its target id; flies straight after the target died.
- Enemy bullets: straight, world + `sweepPointBox` against the player's box (prevPos→pos); `sim.damagePlayer` once.
  They pass through other enemies without effect.
- `castBeam`: first of world hit / enemy sphere hit within 120 m.

### enemies.ts + nav.ts
See SPEC §2.3 for the numbers (`ENEMIES`, `ENEMY_AI` in config). Decisions:
- Perception every sub-step: range from the enemy centre, LOS from `enemyMuzzle()` to the player's centre.
  Nothing else gives an enemy the player's position. A hit by the player makes a surviving enemy alert for the
  memory time (a guard looks around its post) but tells it no position — also from beyond its range with a clear
  line: perception does not depend on who fired first (`onEnemyDamaged`).
- Schedule: first own sighting → burst at `t + firstShotDelay`; later re-exposure → `max(nextBurstReadyAt, t + telegraph)`;
  `nextBurstReadyAt = burstStart + period`; telegraph window = the `telegraph` seconds before the burst start.
  Each shot of a burst is attempted at `burstStart + k·interval`; without muzzle LOS at that instant it is skipped.
  A burst that has not started when LOS is lost is cancelled (the ready time is kept).
- Aim: `solveLinearIntercept(muzzle, player.pos, player.vel, bulletSpeed, 1.2)`, fallback lead time
  `min(1.2, dist / bulletSpeed)`; jitter ≤ 0.5° from `sim.rng`.
- Guards move on the NavGrid only (multi-level walkable cells, A*, closed barriers block). Memory 8 s, start
  re-acquiring within 0.5 s.
- Alert sharing: a guard that sees the player reports the position (at most every 0.5 s, never relayed) to every
  other living enemy — "味方": guards AND turrets — connected to it by ≤ 60 m of walkable path. Guard: the path
  between the two. Turret: the path to the walkable spot at its foot (the one facing the guard) plus the open hop
  from there to the turret (level with the turret out to above the spot, then straight down: no wall and no floor
  in between). So a turret on the guard's floor or on a pedestal in its room is told; one on a deck of its own,
  behind a wall or on another storey is not. A receiver is alert and remembers the position (a guard walks there,
  a turret turns its barrel there); it shoots only with its own line of sight and its first own sighting still
  gets the full initial delay.
- Guard movement bands (seeing): > 55 m approach at 8 m/s — along the path to the player, or, when the player's
  floor cannot be reached (a guard on a gallery, the player below), along its own floor to the nearest spot within
  55 m that sees the player, else to the visible spot nearest to the player (`NavGrid.findVantage`); only when
  nothing is nearer does it strafe out there. 25–55 m strafe at 6 m/s on the circle around the player, turning
  0.5 m before a side ends; a side "ends" where it stops being walkable, free of other enemies or in view of the
  player. Strafing needs ≥ 3.5 m of such room (left + right); where the circle has none, a straight line within
  30° of "sideways" is swept instead (ledges, catwalks); with no room at all (a view through a narrow gap) the
  guard stands and fires rather than shuffle on the spot. A strafe leg (the time between two changes of
  direction) lasts at least 1.5 s (`ENEMY_TUNING.strafeMinLegSeconds`): where the room is shorter than
  1.5 s × 6 m/s = 9 m the guard crosses it at 6 m/s, stands at its end — firing — for the rest of the 1.5 s and
  only then runs back; a voluntary change of side needs 9 m of room on the other side and a fresh start takes
  the side with more room. (Before: sweeps of 2.5 m reversed every 0.4 s, which no constant-velocity lead can
  follow — a machine-gun bullet needs 0.53 s for 52 m.) 15–25 m diagonal back-off, < 15 m retreat at 8 m/s
  (after a change of side the guard keeps to the new side for 0.5 s: no zig-zag in a narrow view).
- Not seeing, alert: path to the last known position; without a route to it the nearest spot (by path) of its own
  floor that overlooks the position within 88 m, else the spot of its floor nearest to it, else a search around
  where it stands. It never just stands for the alert time.
- Other enemies: a living turret is a static obstacle of the NavGrid (`setObstacle`, keep-out sphere of
  1.2 + 1.4 + 0.4 + 0.1 m; removed when it is destroyed), so no path, reach test or strafe run leads through it.
  Guards keep 0.4 m between their hit spheres: a step that would come closer slides along a glancing contact and
  is otherwise cut at the separation distance (the guard stops; it never side-steps to and fro). A path follower
  held up for 0.25 s re-plans around the enemies near it (`findPath(…, { avoid })`); with no way round an approach
  becomes a strafe and a chase waits 1.5 s and then ends there. Safeguard: three direction reversals within 0.5 s
  make a guard stand for 0.5 s (`EnemyAi.oscCount` counts them; the tests expect 0).
- `enemy.vel` is the actual displacement / h (the FCS uses it).
- `enemy.sectorId` (snapshot `enemies[].sectorId`) is the sector the enemy is IN: it starts as the placement sector
  of the stage definition and follows a guard when it leaves that sector's bounds (`world.sectorAt`); turrets and
  destroyed enemies keep theirs; a re-sortie restores the placement.

### snapshot.ts
`buildSnapshot(sim, appState, garageLoadout?)` → the exact structure of SPEC §10 (plain copies, no NaN/Infinity,
arrays for vectors). In the garage it reports the currently selected loadout and its effective stats.

### guide.ts (route guidance, "次の進行方向")
Derived state only: `sim.guide` (created in `Sim.reset()`, updated once per tick after the last sub-step) is
never read by gameplay code, uses no `rng` and emits no events; `sim.guide.enabled = false` switches it off
without any other effect (tests/guide.test.ts compares the two bit for bit). `getRouteHint(sim)` returns the
point of `stage.route` the player should head for next (`RouteHint`: position, walk / climb / drop, distance,
route metres to the current goal, the closed barrier + control turret when the hint is the firing position).
While a barrier is closed the open part of the route ends at the firing position of its control turret (first
place on the route with the turret in view), never behind the barrier; once all are open it ends in the exit
zone. The HUD draws it (`Hud.updateRoute`: open-chevron marker + the "進路" row of the top-left panel).

### stage (src/stage/factory.ts)
`buildFactoryStage(): StageDef` (pure, deterministic) and `getFactoryStage()` (cached). Verified by
`tools/validateStage.ts` (voxel analysis of the real collision boxes).

### render (three.js) — src/render/*
- `MechModel` (mechModel.ts): procedural koala-headed mech. Group origin at the **feet centre**, facing -Z, about 4 m
  tall, fits the 2.6 × 4.0 × 2.6 box. The muzzle is at model-space (0.9, 2.75, -0.85); the weapon pivots about it.
- `enemyModels.ts`, `effects.ts`, `stageView.ts`, `renderer.ts` (GameRenderer: owns WebGLRenderer, scenes, camera).
- Render positions may be extrapolated by `sim.accumulator` seconds (pos + vel·accumulator) for smoothness.
- HUD markers are projected with the render camera (`GameRenderer.projectToCss`).
- The player's own projectiles and the own mech (`effects.ts`): the chase camera looks along the line of fire
  from behind the mech, so most of the screen path from the muzzle to a target near the reticle is covered by the
  mech's head and shoulders. The body material of `MechModel` therefore marks its pixels in the stencil buffer
  (`OWN_MECH_STENCIL`; the WebGLRenderer is created with a stencil buffer) and the machine-gun tracers and the
  missile exhaust are drawn a second time, at 70 % brightness, only on those pixels and only where they lie behind
  the surface drawn there. Everything else (walls, floors, enemies) hides projectiles as usual; enemy bolts are
  never drawn through anything. Render-only: nothing of it reaches the simulation.
- Particles that are stretched along an axis (sparks, the missile smoke trail) are camera-facing quads whose long
  side is the part of the axis that lies across the view: seen end-on they are round blobs, never slivers.

### ui / input / app
`ui/hud.ts`, `ui/garage.ts`, `ui/menus.ts`, `ui/help.ts`, `ui/styles.css`, `input/input.ts`, `app.ts`, `main.ts`.
HUD marker placement (`Hud.locate`, `Hud.settleEdge`): a world marker is drawn at its projection, or as an edge
arrow + label when the point is off screen / behind. The objective pin and the route marker (the two markers
with a text tag) also become an edge arrow — on the line from the centre, in front of the panel — when pin + tag
would lie on a HUD panel; an edge arrow moves in along its own line until its label lies on no panel and on no
other edge label / arrow. The lock-state label and the kill tag are painted above the marker layer (the reticle
above everything); a tag that would lie on the lock-state label is hidden (pin / chevrons remain). The objective
distance is measured from the muzzle, like the distance in the tag of the lock target.
App states: garage → playing ⇄ paused → cleared/failed → (re-sortie | garage). One RAF loop, listeners attached once.
`window.__AK2__ = { getSnapshot }` is read-only.

## 5. Working rules for parallel work

- Edit only the files you own. Shared contracts (`src/sim/types.ts`, `src/config.ts`, `src/sim/sim.ts`,
  `src/core/*`) may be changed only additively, with the Edit tool (never rewrite the file), and only when
  really needed — report every such change in your final message.
- Keep exported signatures that other modules already import.
- Leave the repository type-clean for your files (`npx tsc --noEmit`) and your tests green.
- Tests go to `tests/<area>.test.ts` (vitest). Use `makeTestStage` / `makeTarget` / `makeGuard` / `makeTurret`
  from `src/stage/testStages.ts`, drive the sim through `sim.input`, `sim.applyLook`, `sim.runFor`, `sim.tick`.
- Never weaken a spec number to make a test pass. Report honestly what was verified and what was not.
