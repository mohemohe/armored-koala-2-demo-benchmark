# ARMORED KOALA 2 — DEMO

A single-mission third-person mech action shooter in the browser.
You pilot a combat robot with a koala head and fight your way out of a
sealed, abandoned factory. Built with JavaScript + Three.js — **no runtime
external assets or APIs**; all geometry, models and effects are procedural.

Parody homage: high-speed TPS mech combat (walk / jump / QB / glide /
flight), FCS lock-on, three weapons, guard robots and fixed turrets, and a
six-control escape route.

## Install & run

```bash
npm install
npm run dev        # http://localhost:5173
# or production build:
npm run build && npm run preview   # http://localhost:4173
```

Requires Node 18+ (developed on Node 24). Chrome/Firefox/Edge with WebGL.

## Controls

| Input | Action |
|---|---|
| WASD | move (camera-relative) |
| Mouse | camera (pointer lock) |
| Left click | fire current weapon |
| Space (tap) | jump |
| Space (hold ≥0.2s in air) | flight — drains EN while rising |
| Q | **Quick Boost** — one impulse per press (36 EN), then inertial glide |
| C / Ctrl | air brake / descend |
| 1 / 2 / 3 | machine gun / beam rifle / hand missile |
| Esc | pause |

## Loadout (garage)

Pick one part per slot before deploying. All stats come from the shared
parameter table (`src/core/params.js`) — the numbers on the cards are the
same values the simulation uses.

- **FCS** — wide / medium / narrow lock reticle. Bigger circle ⇄ slower lock.
- **Generator** — capacity (180 EN) / balanced (120 EN) / recovery (90 EN).
- **Legs** — biped (standard) / quadruped (slower walk, faster lock, +regen).

## Mission structure

23 sectors, ~415×195 m factory. Six **control turrets** (TC1–TC6) each hold
a barrier:

```
TC1 pipes       → B1 west gate          → power plant
TC2 power deck  → B2 assembly gate      → assembly line
TC3 assembly    → B3 conveyor + hall    → east block
TC4 underground → B4 gantry vault + shaft vestibule
TC5 gantry      → B5 boiler hatch       → boiler room
TC6 boiler      → B6 FINAL GATE         → escape
```

The route zigzags west→east twice (forced conveyor run, exhaust pit,
underground dock) with branches and loops everywhere. Destroying the first
control turret unlocks the FCS module (lock-on). All six down opens the
final gate — reach the escape zone to clear.

- Shortest valid clear route: **1562 m** (graph lower bound over the
  sector/barrier network) — design route ≈ 2190 m.
- 30 guard robots + 15 fixed turrets, 8 mandatory flight climbs.
- Enemies share alerts in-sector, telegraph before bursting, lead their
  shots, and pursue your last seen position when they lose sight of you.

## Architecture

```
src/core/      — pure simulation (no DOM/Three.js). Shared by tests.
  params.js    — single source of truth for all gameplay numbers
  world.js     — AABB world: swept movement, raycast, spatial hash
  ballistics.js— gravity-aware intercept, lead solvers, guidance
  player.js    — movement/EN/QB/glide/flight state machine
  enemies.js   — guard & turret AI (LOS, bursts, telegraph, pursuit)
  weapons.js   — projectile sim + swept hit tests
  fcs.js       — lock-on + fire-control solutions
  game.js      — fixed-step orchestration + objectives + snapshot
src/render/    — Three.js scene built from the same collision boxes
src/ui/        — HUD (reads live game state)
src/main.js    — input, camera, fixed-step loop (120 Hz sim)
test/run.mjs   — 89-check Node harness (physics, weapons, AI, stage, save)
test/smoke.mjs — headless-Chrome smoke test (needs chrome-headless-shell)
```

Fixed timestep: 120 Hz sim, render-decoupled. Deterministic seeded RNG for
anything gameplay-affecting.

## Verification

```bash
npm test           # 89 checks — all passing
npm run build      # vite production build — clean
npm run preview &  # then:
node test/smoke.mjs http://localhost:4173/   # 13/13 in headless Chrome
```

Harness covers: stage structure (sector counts, branch/loop rank, route
length), QB edge semantics incl. the EN 35/36 boundary, glide at zero EN,
EN regen delay, machine-gun predictive fire vs moving targets at up to
30 m/s (A01–A13, 20/20 hits, ≤0.01 m residual), beam instant hit, missile
lead + 120°/s turn cap, no velocity inheritance, no forced hits after
target reversal, enemy timing/LOS/occlusion pursuit/lethality, barrier and
FCS progression, clear/fail states, and the snapshot schema.

Smoke test verified: title → garage → deploy, WASD movement, QB, firing,
HUD values, enemy spawn count, screenshots render, zero console errors.
