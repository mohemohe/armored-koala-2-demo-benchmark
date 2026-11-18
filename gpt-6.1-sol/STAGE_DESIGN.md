# AK2 factory: physical stage definition

`src/stage.js` is the authoritative geometry and initial enemy inventory. The
renderer and the physics world consume the same solid axis-aligned boxes.
Coordinates below are world metres, with Y up. Bounds are walkable building
interiors; the wall, floor and roof slabs extend beyond those bounds.

## Scale, enclosure and shortest-route bound

The player starts at **[10, 2.1, 0]** inside the sheltered intake bay. The final
extraction volume is **[2425, 16, -8] to [2438, 42, 8]**. Any continuous legal
trajectory reaching extraction has length at least the absolute difference of
its initial and final X coordinates: **2425 − 10 = 2415 metres**. This is a
lower bound on the actual shortest executable trajectory, including flight,
QB, every branch, and any long-distance destruction of a control turret. It is
not a sum of room centres or a suggested route. Combat time and waiting are
not part of this bound.

There are fifteen physically separate enclosed buildings in sequence. Each
shared X boundary is a solid wall with one 16-metre doorway; each building has
a solid roof and side walls. A legal trajectory from X=10 to X=2425 must pass
through the physical X interval of all fifteen sectors. Flying over a building
is prevented by its visible collidable roof; flying around the chain is
prevented by its visible collidable side walls. Gates occupy the actual
doorways, from sill to lintel and jamb to jamb.

The final extraction annex extends from X=2400 to X=2440 and has its own
collidable floor, walls and roof. The final gate does not open until all six
control turrets have been destroyed. The stage does not require the remaining
39 enemies to die.

## Building inventory

Every sector spans 160 metres along X. Different widths, elevations, roof
heights and machinery configurations provide distinct spaces. The five marked
combat rectangles are each genuinely clear 70×50-metre floor regions; four
independent enemies in each have simultaneous sight lines to a point in that
region.

| Sector | Interior X | Interior Z | Floor / roof Y | Space and geometry |
| --- | --- | --- | --- | --- |
| S01 | 0–160 | −55–55 | 0 / 30 | Sheltered intake bay; L-shaped start enclosure; clear combat floor |
| S02 | 160–320 | −55–55 | 8 / 36 | Materials yard; roof-height machinery island; exposed and covered branches |
| S03 | 320–480 | −55–55 | 16 / 48 | Rolling mill; press machinery and side cover; clear combat floor |
| S04 | 480–640 | −32–32 | 16 / 50 | Tall transport shaft; elevated side platform; structural column |
| S05 | 640–800 | −55–55 | 8 / 36 | Assembly line; roof-height production island and crate cover |
| S06 | 800–960 | −55–55 | 0 / 28 | Inspection hall; machinery and side cover; clear combat floor |
| S07 | 960–1120 | −23–23 | 0 / 22 | Narrow pipe service hall; alternating side machinery |
| S08 | 1120–1280 | −55–55 | 8 / 38 | Power house; large generator blocks and raised maintenance platform |
| S09 | 1280–1440 | −55–55 | 16 / 46 | Cooling plant; tall cooler columns; clear combat floor |
| S10 | 1440–1600 | −32–32 | 16 / 50 | Exhaust shaft; upper side platform and large extraction column |
| S11 | 1600–1760 | −27–27 | 8 / 30 | Underground transit; alternating full-height equipment bends |
| S12 | 1760–1920 | −60–60 | 0 / 34 | Main foundry; tallest press and broad clear combat floor |
| S13 | 1920–2080 | −55–55 | 0 / 30 | Shipping warehouse; full-height storage block with two tactical routes |
| S14 | 2080–2240 | −23–23 | 8 / 30 | Perimeter service transfer; alternating sealed machine bays |
| S15 | 2240–2400 | −55–55 | 16 / 46 | Export hall; freight machinery, pillars and final gate |

The clear combat rectangles are X=sector minimum+30..+100, Z=−25..25 in
S01, S03, S06, S09 and S12. Actual floors at Y=0,8,16 provide three traversable
altitude bands, connected within one continuous stage. Platforms are additional
optional elevated fighting positions.

## Doorways and control barriers

The coordinate is the player centre at the door sill. Each doorway is 16m
wide, has a 2m-thick visible surrounding bulkhead, and has its lintel at the
listed Y. Entry and exit waypoints are five metres inside each room at the
doorway's Z coordinate and that room's floor Y+2.1.

| Connection | Sill-centre [X,Y,Z] | Lintel Y | Barrier / control turret |
| --- | --- | --- | --- |
| S01→S02 | [160,10.1,−14] | 28 | — |
| S02→S03 | [320,18.1,14] | 34 | B01 / T02 |
| S03→S04 | [480,18.1,−14] | 46 | — |
| S04→S05 | [640,18.1,14] | 34 | B02 / T04 |
| S05→S06 | [800,10.1,−14] | 26 | — |
| S06→S07 | [960,2.1,13] | 20 | B03 / T06 |
| S07→S08 | [1120,10.1,−13] | 20 | — |
| S08→S09 | [1280,18.1,14] | 36 | B04 / T08 |
| S09→S10 | [1440,18.1,−14] | 44 | — |
| S10→S11 | [1600,18.1,14] | 28 | — |
| S11→S12 | [1760,10.1,−14] | 28 | B05 / T11 |
| S12→S13 | [1920,2.1,14] | 28 | — |
| S13→S14 | [2080,10.1,−13] | 28 | — |
| S14→S15 | [2240,18.1,13] | 28 | B06 / T14 |
| S15→extraction | [2400,18.1,0] | 40 | FINAL-GATE / all six controls |

`STAGE.barriers` records exact solid minimum and maximum coordinates. Adding a
barrier ID to `world.openBarrierIds` removes that same box from collision and
the visible gate. There is no invisible substitute blocker.

## Six compulsory flight transitions

The following are eight-metre upward floor changes. The sill completely closes
the doorway below the upper floor. A normal 10m/s jump under 18m/s² gravity
reaches only 2.778m, so it cannot pass. Each has broad solid takeoff and landing
floors, with enough headroom for the full-height player body.

| Transition | Takeoff centre | Landing centre | Clear doorway height |
| --- | --- | --- | --- |
| S01→S02 | [151,2.1,−14] | [169,10.1,−14] | 20m |
| S02→S03 | [311,10.1,14] | [329,18.1,14] | 18m |
| S07→S08 | [1111,2.1,−13] | [1129,10.1,−13] | 12m |
| S08→S09 | [1271,10.1,14] | [1289,18.1,14] | 20m |
| S13→S14 | [2071,2.1,−13] | [2089,10.1,−13] | 20m |
| S14→S15 | [2231,10.1,13] | [2249,18.1,13] | 12m |

The collision test flies a [1.1,2.1,1.1] half-extent body through every doorway
using the slowest configured horizontal flight speed, 12.8m/s, with an 8m/s
rise at 20 EN/s. The tested trajectory crosses the sill and reaches the
listed landing X in **1.875 seconds / 37.5 EN**, then releases thrust, falls
under 18m/s² gravity and lands on the upper floor. This is below the minimum
90 EN capacity and does not require QB. These measurements exercise the
actual stage swept collision world.

An additional test runs the **production** `createPlayer` and `stepMovement`
functions with all eighteen FCS/generator/leg combinations over all six
transitions, for **108 successfully landed trajectories**. It presses Space
once, includes the normal jump and 0.20s hold before flight, crosses the actual
sill, releases Space and brakes, then lands under the production gravity and
collision code. Measured ascent costs range from **31.333333 to 34.833333 EN**,
and the longest Space hold to reach the landing X is **1.941667 seconds**.
The minimum-capacity, slowest quadruped configuration passes every transition.
These tests use the shared production EN pool and no QB. Landing allows
ordinary ground EN recovery before continuing to the next ascent.

## Three splits and three local loops

S02, S05 and S13 contain a 64m-long, 22m-wide production/storage island reaching
the collidable roof. The island's local rectangle is X=52..116, Z=−12..10.
The north route is shorter and exposed to guards at negative Z. The south
route runs behind real crate cover at Z=26..45 and farther from those guards.
Both routes reconnect after the island. Circling the island uses different
passages on the outward and return legs, giving three local loops.

The following are local coordinates relative to each sector's minimum X;
add 160,640,1920 respectively to X for S02,S05,S13. Y is that sector's
floor+2.1. These are tested body-clear routes rather than decorative arrows.

- Split/rejoin: [34,Y,−14] and [140,Y,−14].
- Exposed: [34,Y,−14] → [45,Y,−22] → [124,Y,−22] → [140,Y,−14].
- Covered: [34,Y,−14] → [43,Y,18] → [79,Y,22] → [119,Y,22] → [140,Y,−14].

The covered route has a longer approach around the south end and machinery
blocks sight lines from the northern firing lane. A player may choose its
cover or cross the shorter route under fire; neither is necessary for the
2415m distance proof.

## Enemy initial coordinates

All 45 enemies have stable unique IDs. Every guard has 120 HP; every turret has
240 HP. All positions are centres with feet on the sector floor. An asterisk
marks a control turret. The tests check every initial body against physical
geometry and find a finite ground navigation route from its sector entrance.

| Sector | Guards [X,Y,Z] | Turret [X,Y,Z] |
| --- | --- | --- |
| S01 | G01 [70,2.1,−20]; G02 [86,2.1,21]; G03 [101,2.1,−24] | T01 [143,2.1,27] |
| S02 | G04 [236,10.1,−27]; G05 [279,10.1,34] | T02* [303,10.1,27] |
| S03 | G06 [390,18.1,−20]; G07 [406,18.1,21]; G08 [421,18.1,−24] | T03 [463,18.1,27] |
| S04 | G09 [573,18.1,−18] | T04* [607,18.1,27] |
| S05 | G10 [716,10.1,−27]; G11 [759,10.1,34] | T05 [783,10.1,27] |
| S06 | G12 [870,2.1,−20]; G13 [886,2.1,21]; G14 [901,2.1,−24] | T06* [943,2.1,27] |
| S07 | G15 [1042,2.1,−11] | T07 [1103,2.1,15] |
| S08 | G16 [1190,10.1,−24]; G17 [1224,10.1,4] | T08* [1263,10.1,27] |
| S09 | G18 [1350,18.1,−20]; G19 [1366,18.1,21]; G20 [1381,18.1,−24] | T09 [1374,18.1,30] |
| S10 | G21 [1533,18.1,−18] | T10 [1567,18.1,27] |
| S11 | G22 [1679,10.1,−12]; G23 [1730,10.1,13] | T11* [1743,10.1,17] |
| S12 | G24 [1830,2.1,−20]; G25 [1846,2.1,21]; G26 [1861,2.1,−24] | T12 [1903,2.1,27] |
| S13 | G27 [2048,2.1,−27] | T13 [2063,2.1,27] |
| S14 | G28 [2159,10.1,−12]; G29 [2210,10.1,13] | T14* [2223,10.1,15] |
| S15 | G30 [2341,18.1,−29] | T15 [2383,18.1,27] |

## Collision and navigation

`world.traceSegment` performs continuous slab intersection against visible
world boxes, including roofs, floors, machinery and unopened gates.
`world.moveBody` sweeps an expanded AABB through the entire motion interval,
clips only the inward component of velocity at contact and continues sliding
for the remainder. It prevents an 80m/s QB from tunnelling through even a
0.1m-thick wall. Ground support and roof collisions use the same geometry.

Guard navigation uses cached 4m grid A* with expanded body clearance and no
diagonal corner cutting. Routes are smoothed only after an actual body sweep
confirms the shortcut. Closed barriers invalidate connected routes. Nearby
alert-sharing distance uses obstacle-aware path distance, including open
same-floor doorways, rather than Euclidean distance through a wall.

Run `node --test tests/stage.test.js` for inventory, simultaneous sight lines,
body-clear enemy placement, start shelter, every sector's machinery navigation,
branch paths, six flight/landing trajectories, gate collision, roof enclosure,
ground contact and high-speed wall sweep tests. These automated geometry tests
do not claim a 10–20-minute human clear or browser playthrough measurement.
