# ARMORED KOALA 2 — Stage geometry and progression

The authoritative stage definition is `src/stage.js`. Distances are metres; +Y is up and +Z is forward. All solid boxes are created through one `addBox` function, recorded as collision AABBs, and rendered using the exact same minima and maxima. Static solids are instanced by sector/material; active gate solids use individual meshes. Painted arrows and lettering are surface graphics, not hidden obstructions.

## Scale and mandatory traversal

There are 17 physically divided sections, 30 mobile guards, 15 fixed turrets (including the six control turrets), and 572 structural solids. There is one continuous scene with no level transitions.

Spawn is (0, 0, 12). The earliest escape boundary is z=1924; therefore every feasible path has length at least |Δz|=1924−12=1912m, irrespective of flight, QB, diagonal movement, branch choices or remotely destroyed controls. This is a coordinate-displacement lower bound, not a sum of room centres or a recommended-path claim.

Each section has a solid foundation, exterior side walls and roof. Consecutive sections have a full boundary wall except for the central 18m-wide doorway, whose lower edge is at the higher floor and whose opening is 12m high. Roof and boundary wall geometry overlap to close roof-height transitions. End walls close both ends of the complex. These solids prevent exterior bypasses, floor underpasses and flying over room boundaries. To reach the final volume, all 17 distinct section interiors must be physically traversed. The six closed barrier leaves occupy the real doorways; their visuals and collisions are removed together only when their actual control turret is dead. The final gate additionally requires all six controls.

## Section bounds and independent enemy placements

Bounds are the usable interior AABB. Each adjacent pair in this table is connected only through its central framed portal. The floor heights form seven playable altitude bands; the power hall additionally has a physical mezzanine with a traversable surface above and an accessible lower floor beneath.

| ID | Name / physical type | Min bound | Max bound | Guards | Turrets |
|---|---|---|---|---:|---:|
| receiving | 北搬入口 / loading dock | (-32, 0, 0) | (32, 22, 95) | 0 | 0 |
| salvage | 資材ヤード / salvage arena | (-50, 0, 95) | (50, 29, 220) | 3 | 1 |
| rolling | 圧延棟 / rolling mill | (-55, 0, 220) | (55, 29, 350) | 3 | 2 |
| lift-a | 第一搬送縦坑 / lift shaft | (-18, 8, 350) | (18, 40, 430) | 1 | 0 |
| assembly | 組立ライン / assembly arena | (-47, 8, 430) | (47, 37, 550) | 3 | 1 |
| inspection | 検査棟 / inspection hall | (-35, 8, 550) | (35, 30, 650) | 1 | 2 |
| pipeworks | 保守配管区画 / pipe gallery | (-22, 16, 650) | (22, 38, 765) | 2 | 0 |
| power | 動力棟 / generator arena | (-53, 16, 765) | (53, 45, 900) | 3 | 1 |
| cooling | 冷却設備 / cooling arena | (-50, 16, 900) | (50, 45, 1025) | 3 | 2 |
| lift-b | 排気縦坑 / exhaust shaft | (-18, 24, 1025) | (18, 56, 1115) | 1 | 0 |
| conveyor | 下層搬送区画 / conveyor tunnel | (-30, 24, 1115) | (30, 46, 1230) | 2 | 1 |
| foundry | 主製造ホール / foundry arena | (-55, 24, 1230) | (55, 53, 1375) | 3 | 2 |
| warehouse | 出荷倉庫 / warehouse | (-48, 32, 1375) | (48, 54, 1505) | 2 | 0 |
| crane | クレーン移送室 / crane hall | (-38, 32, 1505) | (38, 54, 1610) | 1 | 1 |
| perimeter | 外周搬送路 / transfer gallery | (-27, 40, 1610) | (27, 62, 1730) | 1 | 0 |
| dispatch | 搬出管制室 / dispatch hall | (-40, 40, 1730) | (40, 62, 1840) | 1 | 2 |
| escape | 最終搬出ゲート / evacuation bay | (-32, 48, 1840) | (32, 70, 1940) | 0 | 0 |

The receiving section contains two container banks and a 24m-wide shielding baffle. The initial camera/actor area is physically occluded from every enemy; walking east around the baffle joins the first portal. Later sections use scrap stacks, floor-to-roof rolling machinery, lift counterweights, inspection booths, valve banks, generators, cooling equipment, low conveyors, furnaces, cargo racks, an overhead crane and control dais geometry. These are substantial, collidable floor-plan differences, not colour-only room changes.

## Clear battle courts

Each listed court has a 62m × 50m unobstructed floor rectangle, outside the machine footprints and structural columns. At least four independently simulated enemies occupy separated positions around a common engagement point. Surrounding machinery supplies additional cover and flanking space.

| Sector | Clear rectangle min | Clear rectangle max | Common engagement point | Enemies |
|---|---|---|---|---:|
| salvage | (-31, 0, 105) | (31, 12, 155) | (0, 2.2, 123) | 4 |
| rolling | (-31, 0, 230) | (31, 12, 280) | (0, 2.2, 248) | 5 |
| assembly | (-31, 8, 440) | (31, 20, 490) | (0, 10.2, 458) | 4 |
| power | (-31, 16, 775) | (31, 28, 825) | (0, 18.2, 793) | 4 |
| cooling | (-31, 16, 910) | (31, 28, 960) | (0, 18.2, 928) | 5 |
| foundry | (-31, 24, 1240) | (31, 36, 1290) | (0, 26.2, 1258) | 5 |

## Branches and loops

Three large machine cores join their room floor to the roof. Each creates a real split and rejoin. The eastern route is shorter and exposed to the battle court; the western maintenance route extends farther laterally and has two substantial cover stacks. Following one route outward and the other back makes a loop without retracing the same corridor. Because the cores meet the roof, flying does not erase these choices.

| Branch / sector | Split | Exposed waypoints | Covered waypoints | Rejoin |
|---|---|---|---|---|
| branch-1 / rolling | (0, 0, 280) | (0, 0, 280) → (18, 0, 281) → (18, 0, 324) → (0, 0, 325) | (0, 0, 280) → (-40, 0, 281) → (-40, 0, 324) → (0, 0, 325) | (0, 0, 325) |
| branch-2 / assembly | (0, 8, 484) | (0, 8, 484) → (18, 8, 485) → (18, 8, 528) → (0, 8, 529) | (0, 8, 484) → (-40, 8, 485) → (-40, 8, 528) → (0, 8, 529) | (0, 8, 529) |
| branch-3 / cooling | (0, 16, 960) | (0, 16, 960) → (18, 16, 961) → (18, 16, 1004) → (0, 16, 1005) | (0, 16, 960) → (-40, 16, 961) → (-40, 16, 1004) → (0, 16, 1005) | (0, 16, 1005) |

## Required flight and control gates

All six raised transitions are +8m. A normal jump with initial vertical velocity 10m/s and gravity 18m/s² reaches only 2.778m. The solid upper foundation reaches all the way to the lower facility foundation, so there is no walkable gap below the step. The old-room floor extends to the sill and the new-room floor extends away from it: each side offers a level recovery landing area. Portals leave 12m of space above the new floor, accommodating the 4.5m player body.

Flight rises at 8m/s and consumes 20 EN/s. From rest after a normal launch, rising 8m and crossing a 14m launch-to-landing span are within the minimum 90 EN budget and slowest 12.8m/s horizontal flight configuration. No QB, weapon ammunition or particular build is needed. Automated tests integrate actual movement through these physical fixtures; see verification below for measured results.

| Ascent | From → to | Lower recovery point | Upper recovery point | Rise | Controller / barrier |
|---|---|---|---|---:|---|
| ascent-1 | rolling → lift-a | (0, 0, 343) | (0, 8, 357) | 8 | control-1 / barrier-1 |
| ascent-2 | inspection → pipeworks | (0, 8, 643) | (0, 16, 657) | 8 | control-2 / barrier-2 |
| ascent-3 | cooling → lift-b | (0, 16, 1018) | (0, 24, 1032) | 8 | control-3 / barrier-3 |
| ascent-4 | foundry → warehouse | (0, 24, 1368) | (0, 32, 1382) | 8 | control-4 / barrier-4 |
| ascent-5 | crane → perimeter | (0, 32, 1603) | (0, 40, 1617) | 8 | control-5 / barrier-5 |
| ascent-6 | dispatch → escape | (0, 40, 1833) | (0, 48, 1847) | 8 | control-6 / barrier-6 |

The additional final gate is centred at (0, 54, 1908). The escape volume is (-27, 48, 1924) through (27, 66, 1937). Entering it while any control remains alive cannot clear the stage. Player survival is checked by the game state controller.

## Enemy coordinate registry

Enemy Y coordinates are collision centres (floor + 2m). These are actual live enemy spawns, not decorative objects. IDs persist through defeat and are reused after reset. Non-control turrets and guards can be bypassed; only the six orange control turrets unlock progression.

| ID | Type | Sector | Centre | Barrier |
|---|---|---|---|---|
| guard-01 | guard | salvage | (-24, 2, 136) | — |
| guard-02 | guard | salvage | (24, 2, 140) | — |
| guard-03 | guard | salvage | (2, 2, 150) | — |
| turret-01 | turret | salvage | (25, 2, 152) | — |
| guard-04 | guard | rolling | (-24, 2, 261) | — |
| guard-05 | guard | rolling | (24, 2, 265) | — |
| guard-06 | guard | rolling | (2, 2, 275) | — |
| turret-02 | turret | rolling | (25, 2, 277) | — |
| control-1 | turret / CONTROL | rolling | (-24, 2, 271) | barrier-1 |
| guard-07 | guard | lift-a | (-6, 10, 391) | — |
| guard-08 | guard | assembly | (-24, 10, 471) | — |
| guard-09 | guard | assembly | (24, 10, 475) | — |
| guard-10 | guard | assembly | (2, 10, 485) | — |
| turret-03 | turret | assembly | (25, 10, 487) | — |
| guard-11 | guard | inspection | (-24, 10, 591) | — |
| turret-04 | turret | inspection | (11, 10, 626) | — |
| control-2 | turret / CONTROL | inspection | (-11, 10, 626) | barrier-2 |
| guard-12 | guard | pipeworks | (-6, 18, 691) | — |
| guard-13 | guard | pipeworks | (6, 18, 695) | — |
| guard-14 | guard | power | (-24, 18, 806) | — |
| guard-15 | guard | power | (24, 18, 810) | — |
| guard-16 | guard | power | (2, 18, 820) | — |
| turret-05 | turret | power | (25, 18, 822) | — |
| guard-17 | guard | cooling | (-24, 18, 941) | — |
| guard-18 | guard | cooling | (24, 18, 945) | — |
| guard-19 | guard | cooling | (2, 18, 955) | — |
| turret-06 | turret | cooling | (25, 18, 957) | — |
| control-3 | turret / CONTROL | cooling | (-24, 18, 951) | barrier-3 |
| guard-20 | guard | lift-b | (-6, 26, 1066) | — |
| guard-21 | guard | conveyor | (-6, 26, 1156) | — |
| guard-22 | guard | conveyor | (6, 26, 1160) | — |
| turret-07 | turret | conveyor | (7, 26, 1192) | — |
| guard-23 | guard | foundry | (-24, 26, 1271) | — |
| guard-24 | guard | foundry | (24, 26, 1275) | — |
| guard-25 | guard | foundry | (2, 26, 1285) | — |
| turret-08 | turret | foundry | (25, 26, 1287) | — |
| control-4 | turret / CONTROL | foundry | (-24, 26, 1281) | barrier-4 |
| guard-26 | guard | warehouse | (-8, 34, 1416) | — |
| guard-27 | guard | warehouse | (8, 34, 1420) | — |
| guard-28 | guard | crane | (-7, 34, 1546) | — |
| control-5 | turret / CONTROL | crane | (4, 34, 1583) | barrier-5 |
| guard-29 | guard | perimeter | (-6, 42, 1651) | — |
| guard-30 | guard | dispatch | (-7, 42, 1771) | — |
| turret-09 | turret | dispatch | (12, 42, 1808) | — |
| control-6 | turret / CONTROL | dispatch | (-12, 42, 1808) | barrier-6 |

## Physically traversable walkthrough coordinates

These are advisory steering waypoints, not the distance proof. They skirt the receiving baffle and the exposed side of each machine island. Before each rise, hold flight to the upper waypoint, then translate over the sill and release Space to land. Control turrets must be defeated before crossing their barrier. Arrows are painted along this route using the same coordinate list.

```text
01 (0, 0, 12)
02 (0, 0, 65)
03 (14, 0, 65)
04 (14, 0, 89)
05 (0, 0, 90)
06 (0, 0, 87)
07 (0, 0, 102)
08 (0, 0, 212)
09 (0, 0, 227)
10 (0, 0, 280)
11 (18, 0, 281)
12 (18, 0, 324)
13 (0, 0, 325)
14 (0, 0, 343)
15 (0, 8.15, 343)
16 (0, 8.15, 357)
17 (0, 8, 357)
18 (0, 8, 422)
19 (0, 8, 437)
20 (0, 8, 484)
21 (18, 8, 485)
22 (18, 8, 528)
23 (0, 8, 529)
24 (0, 8, 542)
25 (0, 8, 557)
26 (0, 8, 643)
27 (0, 16.15, 643)
28 (0, 16.15, 657)
29 (0, 16, 657)
30 (0, 16, 757)
31 (0, 16, 772)
32 (0, 16, 892)
33 (0, 16, 907)
34 (0, 16, 960)
35 (18, 16, 961)
36 (18, 16, 1004)
37 (0, 16, 1005)
38 (0, 16, 1018)
39 (0, 24.15, 1018)
40 (0, 24.15, 1032)
41 (0, 24, 1032)
42 (0, 24, 1107)
43 (0, 24, 1122)
44 (0, 24, 1222)
45 (0, 24, 1237)
46 (0, 24, 1368)
47 (0, 32.15, 1368)
48 (0, 32.15, 1382)
49 (0, 32, 1382)
50 (0, 32, 1497)
51 (0, 32, 1512)
52 (0, 32, 1603)
53 (0, 40.15, 1603)
54 (0, 40.15, 1617)
55 (0, 40, 1617)
56 (0, 40, 1722)
57 (0, 40, 1737)
58 (0, 40, 1833)
59 (0, 48.15, 1833)
60 (0, 48.15, 1847)
61 (0, 48, 1847)
62 (0, 48, 1927)
```

## Collision and navigation

Player movement uses a continuous segment sweep against every potentially intersecting expanded AABB, including floors, roofs, machinery and closed gates. It consumes the earliest collision, removes only velocity into the contact face and sweeps the remaining tangential displacement. This prevents high-speed QB tunnelling and preserves sliding. A contact probe preserves grounding during horizontal movement. Projectile and camera raycasts use the same live structural collider set.

Guard routing uses an eight-neighbour 4m navigation lattice at the actual local floor elevation, clearance checks against body-sized collision volumes, and swept edges to prevent diagonal corner cutting. It cannot invent stairs across the six flight-only rises. Local ally alerts use actual navigable path distance; gate state changes invalidate navigation caches. All enemy timers remain independent of rendering visibility.

## Verification

Run `npm test` (or `node --test tests/stage.test.js`) for the geometry, collision and progression checks. The accompanying tests create this same stage and use its actual collision methods; they do not substitute a miniature verification map. Runtime/browser evidence is reported separately in the project README. A 10–20 minute first-play duration is a design target and is not claimed as a measured completion time.

Measured stage tests passed for all 45 enemy clearances/reachable placements, all 16 intersector portals, three traversable branch loops, six clear 62m × 50m combat courts with four or more independent initial sightlines, exact solid-render transforms, spawn shielding, continuous collision at unusually large movement deltas, and all gate/reset transitions. Flight tests ran the ordinary player movement implementation through every ascent with every loadout: 6 × 18 = 108 successful traversals and landings. Maximum measured powered flight was 1.992 seconds; minimum measured remaining EN was 50.167 from a 90 EN build. Ordinary jumping failed to cross each of the six physical sills.

All 12 stage tests pass. Sweeping the complete body along the advisory walkthrough reaches the escape volume through all 17 sectors; its measured polyline length is 2100.002m. This route measurement is separate from the unconditional 1912m shortest-distance lower bound. Actual guard movement follows the navigation output around each machine island without collision sticking: branches 1/3 take 6.892 seconds over 55.133m and branch 2 takes 6.475 seconds over 51.800m at 8m/s. These navigation tests exercise the real solid geometry and body movement.
