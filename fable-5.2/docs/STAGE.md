# ステージ設計書 / Stage design — 廃工場 (`factory`)

> **Generated file — do not edit by hand.** Regenerate with `npx tsx tools/stageReport.ts` (`npm run report:stage`).
> Sources: the stage definition `src/stage/factory.ts` (+ `layout.ts`, `sectorsA–D.ts`, `dressing.ts`, `route.ts`, `builder.ts`) and the
> measurements of the stage validator `tools/stageAnalysis.ts` (`npx tsx tools/validateStage.ts`, `npm run validate:stage`).
> **Measured vs. declared.** Everything in the "Measured" columns and in §9 is computed by the validator from the real collision
> boxes. Declared by the designer and then *checked*: sector bounds and kinds (each kind must hold as a geometric property of
> the sector, §1), the take-off / landing points of the climbs (the smallest climb that really crosses each cut is measured
> next to the declared one, §5), the via points of branches and the waypoints of loops and routes (§6–§8).

Units: metres, +Y up. Coordinates of the player and of enemies are hit-volume centres (a player standing on a floor at
height h has y = h + 2; a guard y = h + 1.3; a turret y = h + 1.6). Boxes are axis-aligned `x a..b, y a..b, z a..b`.

## 0. 概要 / Summary

- One continuous, fully enclosed facility: **19 sectors** (7 geometrically distinct kinds of space), 1075 collision boxes, 1449 decor boxes; stage bounds x -8..488, y -48..68, z -8..408; falling below y = -30 fails the sortie.
- Enemies: **30 guards + 15 turrets = 45** stationed in 16 of the 19 sectors, of which **6 control turrets** (one per barrier). Every guard stands on a main floor or on a walkway that is one navigation region with a place the route visits.
- Player start (20, 2, 90) in S01 搬入口, yaw 0° (yaw 0 looks along −Z).
- Final gate `GATE` 最終搬出ゲート: x 18..42, y 0..10, z 301..303 — opens when all 6 control turrets are destroyed. Exit zone (clear condition): x 4..56, y 0..12, z 274..298.
- Sector sequence of the shortest route: S01 → S02 → S03 → S04 → S06 → S07 → S08 → S09 → S10 → S11 → S12 → S13 → S14 → S15 → S16 → S17.

**Validation result: PASS** — 17 checks passed, 0 failed, 0 not run.

| SPEC §2.2 requirement | Required | Measured | Check |
| --- | --- | --- | --- |
| 区画数 / sectors | ≥ 15, each ≥ 150 m² of reachable floor | 19 (smallest S09: 856 m²) | V1 PASS |
| 空間構成の違い / kinds of space | ≥ 6, each a measured property of the sector | 7 geometric classes (narrow passage: S02 S09 S16 S18 S19 · open yard: S03 · equipment hall: S04 S05 S10 S11 · vertical shaft: S06 S12 · stacked floors: S07 S08 S14 · underground tunnel: S13 · rack warehouse: S15) | V1 PASS |
| 敵 / enemies | 30 guards + 15 turrets, 6 control turrets in different sectors, all attackable; enemies in ≥ 15 sectors; ≥ 24 guards able to walk to the route, ≥ 20 on main floors | 30 + 15, 6 controls in 6 sectors; enemies in 16 sectors; 30 mobile guards, 21 on main floors | V2 PASS |
| 必要な移動距離 / shortest feasible route | ≥ 1500 m | proven lower bound **2002 m**; grid shortest path Lgrid 2171.2 m; explicit swept route 2104.7 m | V3 PASS |
| 必須経路 / mandatory sectors | ≥ 12 | 16 (S01, S02, S03, S04, S06, S07, S08, S09, S10, S11, S12, S13, S14, S15, S16, S17) | V4 PASS |
| 進行 / progression | each barrier and the gate is a true cut; control turrets attackable in order only | 6 barriers + gate; order T01 → T04 → T06 → T08 → T11 → T14 | V5 PASS |
| 高低差 / mandatory flights | ≥ 6 separate climbs of 6–16 m needing flight | 7; declared climb / smallest climb that crosses the cut: F1 10 / 6 m, F2 12 / 6 m, F3 12 / 6 m, F4 14 / 6 m, F5 8 / 6 m, F6 14 / 6 m, F7 14 / 6 m; cuts disjoint and nested F1 < F2 < F3 < F4 < F5 < F6 < F7 | V6 PASS |
| 全構成で通過可能 / feasible for every loadout | real Sim lands every climb with all generator × legs combinations | 42/42 simulated flights landed; worst EN share 36 % | V6d PASS |
| 分岐 / branches | ≥ 3: two separate passages (closing both cuts the route), the shorter one clearly more exposed | 4 structurally separate (BR1 3.05 vs 0.11 firing lines/m, BR2 1.38 vs 0.57 firing lines/m, BR3 1.34 vs 0.15 firing lines/m, BR4 3.17 vs 0.26 firing lines/m) | V7 PASS |
| 環状経路 / loops | ≥ 2: circuits around ≥ 50 m² that cannot be walked on (≥ 25 % of what they enclose) | 4 (LP1 107.4 m around 212 m² = 38 %, LP2 297.7 m around 2624 m² = 49 %, LP3 277 m around 2742 m² = 70 %, LP4 253.3 m around 2752 m² = 77 %) | V8 PASS |
| 階層 / levels | ≥ 3 altitude bands, stacked floors | 11 bands from -12 m to 46 m; 26952 m² of stacked floor | V9 PASS |
| 広い戦闘空間 / arenas | ≥ 5 of ≥ 60 × 50 m | 7 (smallest: S11 104 × 94 m) | V10 PASS |
| 複数方向の攻撃 / multi-directional fire | ≥ 5 arenas with ≥ 4 enemies covering ≥ 15 % of the floor over ≥ 90° | 5 (S03 35 %, S07 24 %, S10 23 %, S11 27 %, S14 25 %) | V11 PASS |
| 開始地点 / start | sheltered, 60 m free lane | no enemy sees the start sector; lane 60 m free, floor 60 m | V12 PASS |
| 形状 / geometry | enclosed, inside bounds, decor outside the player volume | leak cells 0, decor intrusions 0 | V13 PASS |
| 実走 / walkthrough | real Sim plays the route to the exit | weakest loadout: cleared, 2668.4 m in 320.4 s; default loadout: cleared, 2687.2 m in 262.7 s; detour route (weakest): cleared, 2981.7 m, 19 sectors | V14 PASS |
| 経路の密度 / route defence | no stretch > 100 m without an enemy firing line, ≥ 60 % of the route under fire (outside the start sector) | longest quiet stretch 25 m (S10); 91 % under ≥ 1 firing line, 13 % under ≥ 4 | V15 PASS |
| 生存可能性 / survivability | a plain fighting bot clears the route against the real enemy AI without cheats (default loadout, 3 seeds) | 3/3 runs cleared; final HP 288 / 202 / 368 of 1000 | V16 PASS |

## 1. 区画 / Sectors

A point belongs to a sector when it lies inside one of its bounds boxes (sector bounds are pairwise disjoint; adjacent rooms share
their 2 m walls, so the boxes tile the building). "Floors" lists the standing surfaces the player can reach (height: area), measured
by the validator; ★ = combat arena (≥ 60 × 50 m main floor).

| ID | 名称 | Name | Kind | Arena | Mandatory | Bounds boxes | Reachable floors (height m: area m²) | Floor m² | Guards | Turrets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | 搬入口 | Loading dock | dock — 搬入口 (sheltered entry) |  | yes | [x 0..40, y -2..14, z 18..100] | 0: 1729 · 1.5: 170 · 3: 126 · 3.5: 138 · 4: 449 | 2612 | 0 | 0 |
| S02 | 検問連絡路 | Checkpoint link | corridor — 狭い連絡路 (narrow connector) |  | yes | [x 0..100, y -2..12, z 0..16]<br>[x 0..40, y -2..14, z 16..18] | 0: 832 · 4: 180 | 1032 | 1 | 0 |
| S03 | 資材ヤード | Material yard | yard — 広場 (open yard) | ★ | yes | [x 40..170, y -2..28, z 16..100]<br>[x 170..183, y 9..30, z 68..100] | 0: 7288 · 1: 176 · 3: 647 · 4: 1040 · 10: 364 | 9533 | 3 | 2 |
| S04 | 圧延棟 | Rolling mill | factory — 設備のある製造室 (machine hall) | ★ | yes | [x 170..310, y 2..30, z 0..68]<br>[x 183..310, y 2..30, z 68..100]<br>[x 170..183, y 2..9, z 68..100]<br>[x 213..231, y -48..2, z 21..37] | 4: 9456 · 5: 128 · 6: 420 · 7.5: 150 · 8: 182 · 9: 880 · 10: 2174 · 16: 66 | 13535 | 2 | 1 |
| S05 | 圧延制御室 | Mill control room | factory — 設備のある製造室 (machine hall) |  | optional | [x 310..350, y 2..16, z 50..100] | 4: 1060 · 7: 96 · 9: 200 | 1392 | 0 | 1 |
| S06 | 搬送縦坑 | Transfer shaft | shaft — 縦坑 (vertical shaft) |  | yes | [x 310..350, y 8..62, z 0..50]<br>[x 350..363, y 21..42, z 0..50] | 10: 1220 · 15: 120 · 16: 446 · 22: 544 | 2366 | 1 | 0 |
| S07 | 組立ライン | Assembly line | multilevel — 上下層 (stacked floors) | ★ | yes | [x 350..480, y 12..21, z 0..100]<br>[x 363..372, y 21..42, z 0..50]<br>[x 350..372, y 21..42, z 50..100]<br>[x 372..460, y 21..42, z 20..100]<br>[x 460..480, y 21..42, z 98..100]<br>[x 440..480, y 27..48, z 100..113] | 14: 9247 · 15: 76 · 16.5: 688 · 17: 128 · 17.5: 64 · 19: 200 · 20: 556 · 22: 1770 · 28: 405 | 13226 | 4 | 2 |
| S08 | 検査棟 | Inspection building | multilevel — 上下層 (stacked floors) |  | yes | [x 380..480, y 16..48, z 113..200]<br>[x 380..440, y 16..48, z 100..113]<br>[x 440..480, y 16..27, z 100..113] | 18: 6977 · 19: 88 · 19.5: 70 · 21: 100 · 26: 6184 · 28: 780 | 14238 | 1 | 1 |
| S09 | 保守用配管区画 | Pipe gallery | corridor — 狭い連絡路 (narrow connector) |  | yes | [x 250..380, y 32..44, z 184..200] | 34: 856 | 856 | 1 | 0 |
| S10 | 動力棟 | Power house | plant — 設備プラント (plant) | ★ | yes | [x 110..250, y 24..54, z 100..200] | 26: 10092 · 30: 300 · 31: 1316 · 34: 1726 · 40: 66 | 13581 | 4 | 1 |
| S11 | 冷却設備 | Cooling plant | plant — 設備プラント (plant) | ★ | yes | [x 0..110, y 30..60, z 100..200]<br>[x 0..40, y 45..64, z 200..213] | 32: 7566 · 35: 60 · 36: 352 · 37: 240 · 40: 4568 · 46: 452 | 13291 | 2 | 3 |
| S12 | 排気縦坑 | Exhaust shaft | shaft — 縦坑 (vertical shaft) |  | yes | [x 0..50, y -14..64, z 213..250]<br>[x 40..50, y -14..64, z 200..213]<br>[x 0..40, y -14..45, z 200..213] | -12: 1698 · -10: 64 · -9: 132 · -1: 400 · 14: 400 · 30: 400 · 46: 252 | 3382 | 1 | 0 |
| S13 | 地下搬送区画 | Underground conveyor tunnel | tunnel — 地下通路 (tunnel) |  | yes | [x 50..250, y -14..-1, z 200..270]<br>[x 103..119, y -48..-14, z 212..221] | -12: 5663 · -10: 684 · -9: 256 · -8.5: 136 | 6814 | 1 | 1 |
| S14 | 主製造ホール | Main production hall | multilevel — 上下層 (stacked floors) | ★ | yes | [x 250..480, y -14..-1, z 200..300]<br>[x 250..458, y -1..32, z 220..300] | -12: 17533 · -11: 94 · -10: 672 · -8: 224 · -7: 792 · -6: 1324 · 0: 4347 · 3: 200 | 25305 | 4 | 2 |
| S15 | 出荷倉庫 | Shipping warehouse | warehouse — 倉庫 (rack storage) | ★ | yes | [x 330..480, y -2..22, z 300..400] | 0: 11004 · 3: 256 · 3.5: 144 · 4: 208 · 12: 1920 | 13599 | 3 | 0 |
| S16 | 外周搬送路 | Perimeter haul road | road — 搬送路 (haul road) |  | yes | [x 60..330, y -2..14, z 370..400] | 0: 5423 · 1: 220 · 4: 567 · 4.5: 157 | 6388 | 2 | 0 |
| S17 | 搬出ゲート | Exit gate | gate — ゲート (gate) |  | yes | [x 0..60, y -2..18, z 270..400] | 0: 6015 · 3.5: 64 · 4: 188 · 5: 160 | 6536 | 0 | 1 |
| S18 | 部品搬送回廊 | Parts gallery | corridor — 狭い連絡路 (narrow connector) |  | optional | [x 372..480, y 21..42, z 0..20]<br>[x 460..480, y 21..42, z 20..98] | 22: 2514 | 2525 | 0 | 0 |
| S19 | 保守回廊 | Service gallery | corridor — 狭い連絡路 (narrow connector) |  | optional | [x 250..480, y -1..32, z 200..220]<br>[x 458..480, y -1..32, z 220..300] | 0: 4416 | 4416 | 0 | 0 |

Kinds of space (V1). A kind is not taken from the label: the declared kind of every sector must hold as the measured property in
the last column, and the requirement "≥ 6 kinds" is counted over the geometric classes. Spans are clear widths of the space the
player's box can be in; "free square" is the largest axis-aligned square of it; "tall equipment" is the share of the main floor's
bounding rectangle under free-standing obstacles in which the player cannot be lower than 4.5 m above the floor.

| Sector | Declared kind | Geometric class | Span x × z (m) | Free square (m) | Clear height (m) | Floor levels / stacked m² | Tall equipment | Rack rows | Walkways m² | Measured property that makes the kind |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S01 搬入口 | dock | functional | 35.6 × 80.6 | 34.6 | 12 | 1 / 0 | 0 % | 0 | 0 | contains the player start |
| S02 検問連絡路 | corridor | narrow passage | 95.6 × 16.6 | 14.6 | 10 | 1 / 0 | 0 % | 0 | 0 | widest free square 14.6 m <= 20 m, length 95.6 m >= 60 m |
| S03 資材ヤード | yard | open yard | 141.6 × 82.6 | 29.6 | 28 | 1 / 0 | 4.5 % | 0 | 0 | single floor level, main floor 124 x 81 m, only 4.5 % (<= 8 %) of it under free-standing obstacles taller than the mech (4.5 m) |
| S04 圧延棟 | factory | equipment hall | 138.6 × 95.6 | 48.6 | 24 | 2 / 1492 | 14.2 % | 0 | 1492 | 14.2 % (>= 10 %) of the floor rectangle under free-standing machinery / structures taller than the mech (4.5 m) |
| S05 圧延制御室 | factory | equipment hall | 38.6 × 45.6 | 19.6 | 10 | 1 / 0 | 12.3 % | 0 | 0 | 12.3 % (>= 10 %) of the floor rectangle under free-standing machinery / structures taller than the mech (4.5 m) |
| S06 搬送縦坑 | shaft | vertical shaft | 54.6 × 45.6 | 33.6 | 50 | 3 / 318 | 8 % | 0 | 318 | clear height 50 m above its floor >= the floor's larger extent 45.6 m, and >= 30 m (footprint 54.6 x 45.6 m) |
| S07 組立ライン | multilevel | stacked floors | 125.6 × 111.6 | 33.6 | 32 | 3 / 1777 | 10.7 % | 0 | 1653 | 3 floor levels >= 5 m apart with >= 400 m² each, 1777 m² stacked >= 200 m² |
| S08 検査棟 | multilevel | stacked floors | 98.6 × 95.6 | 46.6 | 28 | 2 / 5368 | 4.3 % | 0 | 5368 | 2 floor levels >= 5 m apart with >= 400 m² each, 5368 m² stacked >= 200 m² |
| S09 保守用配管区画 | corridor | narrow passage | 131.6 × 11.6 | 11.6 | 8 | 1 / 0 | 0 % | 0 | 0 | widest free square 11.6 m <= 20 m, length 131.6 m >= 60 m |
| S10 動力棟 | plant | equipment hall | 141.6 × 95.6 | 41.6 | 26 | 2 / 1414 | 14.9 % | 0 | 1414 | 14.9 % (>= 10 %) of the floor rectangle under free-standing equipment taller than the mech, 1414 m² (>= 400) of service walkways >= 5 m over the floor |
| S11 冷却設備 | plant | equipment hall | 108.6 × 111.6 | 95.6 | 30 | 3 / 3054 | 14.8 % | 0 | 3042 | 14.8 % (>= 10 %) of the floor rectangle under free-standing equipment taller than the mech, 3042 m² (>= 400) of service walkways >= 5 m over the floor |
| S12 排気縦坑 | shaft | vertical shaft | 48.6 × 45.6 | 39.6 | 74 | 4 / 736 | 0 % | 0 | 952 | clear height 74 m above its floor >= the floor's larger extent 48.6 m, and >= 30 m (footprint 48.6 x 45.6 m) |
| S13 地下搬送区画 | tunnel | underground tunnel | 201.6 × 65.6 | 17.6 | 9 | 1 / 0 | 41.5 % | 0 | 0 | ceiling at -3 m <= 0 (below ground level), clear height 9 m <= 10 m |
| S14 主製造ホール | multilevel | stacked floors | 228.6 × 98.6 | 75.6 | 42 | 3 / 4275 | 10.9 % | 0 | 4041 | 3 floor levels >= 5 m apart with >= 400 m² each, 4275 m² stacked >= 200 m² |
| S15 出荷倉庫 | warehouse | rack warehouse | 148.6 × 98.6 | 94.6 | 20 | 2 / 0 | 13.5 % | 10 | 0 | 10 (>= 3) free-standing rack rows >= 8 m high, >= 20 m long, <= 8 m wide |
| S16 外周搬送路 | road | narrow passage | 271.6 × 25.6 | 25.6 | 12 | 1 / 0 | 0 % | 0 | 0 | widest free square 25.6 m <= 30 m, length 271.6 m >= 200 m |
| S17 搬出ゲート | gate | functional | 58.6 × 125.6 | 53.6 | 16 | 1 / 0 | 0 % | 0 | 0 | contains the final gate and the exit zone |
| S18 部品搬送回廊 | corridor | narrow passage | 106.6 × 96.6 | 16.6 | 18 | 1 / 0 | 0 % | 0 | 0 | widest free square 16.6 m <= 20 m, length 106.6 m >= 60 m |
| S19 保守回廊 | corridor | narrow passage | 225.6 × 98.6 | 18.6 | 30 | 1 / 0 | 0 % | 0 | 0 | widest free square 18.6 m <= 20 m, length 225.6 m >= 60 m |

Arena floors (largest connected component of the main floor, V10) and multi-directional fire (V11):

| Sector | Main floor height | Extent (m) | Fill of bounding rectangle | Area m² | Enemies | Floor under fire from ≥ 4 enemies over ≥ 90° |
| --- | --- | --- | --- | --- | --- | --- |
| S03 資材ヤード | 0 m | 124 × 81 | 73 % | 7288 | 5 | 35 % of 9533 m² |
| S04 圧延棟 | 4 m | 137 × 94 | 73 % | 9456 | 3 | 0 % of 13535 m² (does not count) |
| S07 組立ライン | 14 m | 124 × 94 | 79 % | 9247 | 6 | 24 % of 13226 m² |
| S10 動力棟 | 26 m | 134 × 94 | 80 % | 10092 | 5 | 23 % of 13581 m² |
| S11 冷却設備 | 32 m | 104 × 94 | 77 % | 7566 | 5 | 27 % of 13291 m² |
| S14 主製造ホール | -12 m | 227 × 94 | 82 % | 17533 | 6 | 25 % of 25305 m² |
| S15 出荷倉庫 | 0 m | 147 × 97 | 77 % | 11004 | 3 | 0 % of 13599 m² (does not count) |

## 2. 接続関係 / Connection graph

| From | To | Kind | Barrier | Note |
| --- | --- | --- | --- | --- |
| S01 搬入口 | S02 検問連絡路 | door |  | 搬入口南端の扉（幅12 m） |
| S02 検問連絡路 | S03 資材ヤード | door |  | 連絡路北壁の扉（幅16 m）。搬入口の扉と同じ壁面にあり射線が通らない |
| S03 資材ヤード | S04 圧延棟 | climb (flight) |  | F1: 東壁の開口 +10 m |
| S03 資材ヤード | S04 圧延棟 | barrier | B1 | F1着地直後の隔壁（制御砲台T01） |
| S04 圧延棟 | S05 圧延制御室 | door |  | 制御室南扉 |
| S04 圧延棟 | S05 圧延制御室 | door |  | 制御室北扉（環状経路LP1） |
| S04 圧延棟 | S06 搬送縦坑 | climb (flight) |  | F2: 南東の開口 +16 m |
| S06 搬送縦坑 | S07 組立ライン | climb (flight) |  | F3: 縦坑東壁の開口 +22 m |
| S06 搬送縦坑 | S07 組立ライン | barrier | B2 | F3着地直後の隔壁（制御砲台T04）。前室からはバルコニー開口（床面へ8 m降下）、北扉（西通路・中央キャットウォーク・部品ガントリー +22 m）、南端（S18）の3方向 |
| S07 組立ライン | S08 検査棟 | climb (flight) |  | F4: 北壁の開口 +28 m |
| S07 組立ライン | S08 検査棟 | barrier | B3 | F4着地直後の隔壁（制御砲台T06） |
| S08 検査棟 | S09 保守用配管区画 | climb (flight) |  | F5: 西壁の開口 +34 m |
| S09 保守用配管区画 | S10 動力棟 | barrier | B4 | 配管区画西端の隔壁（制御砲台T08） |
| S10 動力棟 | S11 冷却設備 | climb (flight) |  | F6: 西壁の開口 +40 m |
| S11 冷却設備 | S12 排気縦坑 | climb (flight) |  | F7: 北壁の開口 +46 m |
| S11 冷却設備 | S12 排気縦坑 | barrier | B5 | F7着地直後の隔壁（制御砲台T11） |
| S12 排気縦坑 | S13 地下搬送区画 | drop |  | 排気縦坑を58 m降下し、底の扉から地下搬送区画へ |
| S13 地下搬送区画 | S14 主製造ホール | door |  | 直通トンネル東端の扉 |
| S14 主製造ホール | S15 出荷倉庫 | barrier | B6 | 北ギャラリー(0 m)北東の隔壁（制御砲台T14）。最下層から12 mの飛行が必要 |
| S07 組立ライン | S18 部品搬送回廊 | open |  | 前室南端 ⇄ 部品搬送回廊（分岐BR1の遮蔽側） |
| S18 部品搬送回廊 | S08 検査棟 | climb (flight) |  | 回廊東辺の北端から搬入開口F4の東半分へ6 m上昇（開口の仕切り壁でホール側と分離。S07の境界帯を2 m横切る） |
| S14 主製造ホール | S19 保守回廊 | climb (flight) |  | 入口前室の天井ハッチから保守回廊へ12 m上昇（分岐BR4の遮蔽側） |
| S19 保守回廊 | S15 出荷倉庫 | barrier | B6 | 保守回廊北端は隔壁B6の扉の東半分に直結 |
| S15 出荷倉庫 | S16 外周搬送路 | door |  | 倉庫西壁の扉 |
| S16 外周搬送路 | S17 搬出ゲート | door |  | 搬送路西端の扉 |
| S17 搬出ゲート | (exit zone inside the same sector) | final gate | GATE | 最終搬出ゲート → 脱出領域 |

Mandatory sectors (blocking the sector disconnects the exit, V4): **16** — S01, S02, S03, S04, S06, S07, S08, S09, S10, S11, S12, S13, S14, S15, S16, S17. Optional: S05, S18, S19.

## 3. 隔壁と制御砲台 / Barriers and control turrets

Each barrier is a solid box that fills its doorway until its control turret is destroyed. The validator proves that every
barrier is a cut of the route and that control turret i+1 cannot be seen from anywhere reachable while barrier i is closed.

| Barrier | 名称 | Box | Between | Control turret | Turret position | Turret sector | Destroyed in the walkthrough from (distance) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | 第1隔壁（圧延棟入口） | x 182..184, y 10..18, z 77..91 | S03 → S04 | T01 | (139, 24.2, 28) | S03 資材ヤード | (83.83, 2, 18.78) (60.2 m) |
| B2 | 第2隔壁（組立ライン入口） | x 362..364, y 22..30, z 22..36 | S06 → S07 | T04 | (341, 7.1, 75) | S05 圧延制御室 | (300.36, 6, 61.43) (42.9 m) |
| B3 | 第3隔壁（検査棟入口） | x 453..467, y 28..36, z 112..114 | S07 → S08 | T06 | (360, 38.2, 90) | S07 組立ライン | (367.89, 24, 34.32) (58 m) |
| B4 | 第4隔壁（動力棟入口） | x 249..251, y 34..42, z 186..198 | S09 → S10 | T08 | (449, 20.6, 163) | S08 検査棟 | (449.67, 28, 145.18) (19.3 m) |
| B5 | 第5隔壁（排気縦坑入口） | x 13..27, y 46..54, z 212..214 | S11 → S12 | T11 | (55, 41.6, 153) | S11 冷却設備 | (98.84, 42, 115.56) (57.7 m) |
| B6 | 第6隔壁（出荷倉庫入口） | x 444..468, y 0..8, z 299..301 | S14 → S15 | T14 | (366, 4.6, 264) | S14 主製造ホール | (291.16, -10, 224.52) (85.9 m) |

Progression order measured by V5 (barriers i..6 and the gate closed):

| Stage | Control turret | Attackable from the reachable region, e.g. from (distance) | Next control turret | Visible before its turn? |
| --- | --- | --- | --- | --- |
| 1 | T01 | (139.5, 24, 23.5) (4.5 m) | T04 | no |
| 2 | T04 | (341.5, 11.5, 75.5) (4.5 m) | T06 | no |
| 3 | T06 | (360.5, 38, 85.5) (4.5 m) | T08 | no |
| 4 | T08 | (449.5, 25, 163.5) (4.5 m) | T11 | no |
| 5 | T11 | (55.5, 46, 153.5) (4.5 m) | T14 | no |
| 6 | T14 | (366.5, 9, 264.5) (4.5 m) | – | – |

## 4. 敵の初期配置 / Enemy placement (45)

Guards: hit sphere r 1.2 m, centre 1.3 m above their floor, HP 120, range 90 m. Turrets: r 1.4 m, centre 1.6 m above their base, HP 240, range 120 m.

| ID | Kind | Sector | x | y | z | Stands on (m) | Yaw | Control turret of | Guard: walkable region (all barriers open) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| G01 | guard 警備ロボット | S02 検問連絡路 | 72 | 1.3 | 9 | 0 | 90° |  | 9883 m², reaches the route, main floor |
| G02 | guard 警備ロボット | S03 資材ヤード | 98 | 1.3 | 44 | 0 | 180° |  | 9883 m², reaches the route, main floor |
| G03 | guard 警備ロボット | S03 資材ヤード | 122 | 1.3 | 82 | 0 | 90° |  | 9883 m², reaches the route, main floor |
| G04 | guard 警備ロボット | S03 資材ヤード | 66 | 1.3 | 56 | 0 | 180° |  | 9883 m², reaches the route, main floor |
| G05 | guard 警備ロボット | S04 圧延棟 | 240 | 5.3 | 30 | 4 | -90° |  | 10568 m², reaches the route, main floor |
| G06 | guard 警備ロボット | S04 圧延棟 | 284 | 5.3 | 30 | 4 | 90° |  | 10568 m², reaches the route, main floor |
| G07 | guard 警備ロボット | S06 搬送縦坑 | 332 | 11.3 | 11 | 10 | 90° |  | 1220 m², reaches the route, main floor |
| G08 | guard 警備ロボット | S07 組立ライン | 414 | 15.3 | 30 | 14 | 90° |  | 9327 m², reaches the route, main floor |
| G09 | guard 警備ロボット | S07 組立ライン | 432 | 15.3 | 86 | 14 | 90° |  | 9327 m², reaches the route, main floor |
| G10 | guard 警備ロボット | S07 組立ライン | 400 | 23.3 | 59 | 22 | 90° |  | 4542 m², reaches the route, other level (walkway / gallery / upper storey) |
| G11 | guard 警備ロボット | S07 組立ライン | 416 | 23.3 | 59 | 22 | 90° |  | 4542 m², reaches the route, other level (walkway / gallery / upper storey) |
| G12 | guard 警備ロボット | S08 検査棟 | 458 | 27.3 | 184 | 26 | 180° |  | 5916 m², reaches the route, other level (walkway / gallery / upper storey) |
| G13 | guard 警備ロボット | S09 保守用配管区画 | 302 | 35.3 | 192 | 34 | -90° |  | 2338 m², reaches the route, main floor |
| G14 | guard 警備ロボット | S10 動力棟 | 236 | 27.3 | 150 | 26 | 90° |  | 10092 m², reaches the route, main floor |
| G15 | guard 警備ロボット | S10 動力棟 | 220 | 27.3 | 140 | 26 | 90° |  | 10092 m², reaches the route, main floor |
| G16 | guard 警備ロボット | S10 動力棟 | 179 | 35.3 | 148 | 34 | 90° |  | 2338 m², reaches the route, other level (walkway / gallery / upper storey) |
| G17 | guard 警備ロボット | S10 動力棟 | 206 | 35.3 | 192.3 | 34 | 90° |  | 2338 m², reaches the route, other level (walkway / gallery / upper storey) |
| G18 | guard 警備ロボット | S11 冷却設備 | 60 | 41.3 | 115 | 40 | 180° |  | 2582 m², reaches the route, other level (walkway / gallery / upper storey) |
| G19 | guard 警備ロボット | S11 冷却設備 | 44 | 33.3 | 152 | 32 | 90° |  | 7566 m², reaches the route, main floor |
| G20 | guard 警備ロボット | S12 排気縦坑 | 37 | -10.7 | 211 | -12 | 90° |  | 24904 m², reaches the route, main floor |
| G21 | guard 警備ロボット | S13 地下搬送区画 | 136 | -10.7 | 210 | -12 | -90° |  | 24904 m², reaches the route, main floor |
| G22 | guard 警備ロボット | S14 主製造ホール | 378 | -10.7 | 210 | -12 | 90° |  | 24904 m², reaches the route, main floor |
| G23 | guard 警備ロボット | S14 主製造ホール | 322 | 1.3 | 281.3 | 0 | 90° |  | 30621 m², reaches the route, other level (walkway / gallery / upper storey) |
| G24 | guard 警備ロボット | S14 主製造ホール | 425 | 1.3 | 281.3 | 0 | 90° |  | 30621 m², reaches the route, other level (walkway / gallery / upper storey) |
| G25 | guard 警備ロボット | S14 主製造ホール | 396 | 1.3 | 240 | 0 | 90° |  | 30621 m², reaches the route, other level (walkway / gallery / upper storey) |
| G26 | guard 警備ロボット | S15 出荷倉庫 | 396 | 1.3 | 314 | 0 | 90° |  | 30621 m², reaches the route, main floor |
| G27 | guard 警備ロボット | S15 出荷倉庫 | 338 | 1.3 | 356 | 0 | 0° |  | 30621 m², reaches the route, main floor |
| G28 | guard 警備ロボット | S15 出荷倉庫 | 458 | 1.3 | 338 | 0 | 180° |  | 30621 m², reaches the route, main floor |
| G29 | guard 警備ロボット | S16 外周搬送路 | 250 | 1.3 | 385 | 0 | -90° |  | 30621 m², reaches the route, main floor |
| G30 | guard 警備ロボット | S16 外周搬送路 | 122 | 1.3 | 385 | 0 | -90° |  | 30621 m², reaches the route, main floor |
| T01 | turret 固定砲台 | S03 資材ヤード | 139 | 24.2 | 28 | 22.6 | 90° | **B1** |  |
| T02 | turret 固定砲台 | S03 資材ヤード | 75 | 24.2 | 56 | 22.6 | -90° |  |  |
| T03 | turret 固定砲台 | S04 圧延棟 | 235 | 26.2 | 76 | 24.6 | 90° |  |  |
| T04 | turret 固定砲台 | S05 圧延制御室 | 341 | 7.1 | 75 | 5.5 | 90° | **B2** |  |
| T05 | turret 固定砲台 | S11 冷却設備 | 17 | 41.6 | 189 | 40 | 0° |  |  |
| T06 | turret 固定砲台 | S07 組立ライン | 360 | 38.2 | 90 | 36.6 | 180° | **B3** |  |
| T07 | turret 固定砲台 | S07 組立ライン | 456 | 38.2 | 36 | 36.6 | -90° |  |  |
| T08 | turret 固定砲台 | S08 検査棟 | 449 | 20.6 | 163 | 19 | 180° | **B4** |  |
| T09 | turret 固定砲台 | S10 動力棟 | 160 | 50.2 | 112 | 48.6 | 90° |  |  |
| T10 | turret 固定砲台 | S11 冷却設備 | 77 | 41.6 | 171 | 40 | 90° |  |  |
| T11 | turret 固定砲台 | S11 冷却設備 | 55 | 41.6 | 153 | 40 | 180° | **B5** |  |
| T12 | turret 固定砲台 | S13 地下搬送区画 | 236 | -8.4 | 204 | -10 | 90° |  |  |
| T13 | turret 固定砲台 | S14 主製造ホール | 432 | 4.6 | 236 | 3 | -90° |  |  |
| T14 | turret 固定砲台 | S14 主製造ホール | 366 | 4.6 | 264 | 3 | 90° | **B6** |  |
| T15 | turret 固定砲台 | S17 搬出ゲート | 30 | 3.6 | 316 | 2 | 0° |  |  |

Enemies per sector: S01 0 · S02 1 · S03 5 · S04 3 · S05 1 · S06 1 · S07 6 · S08 2 · S09 1 · S10 5 · S11 5 · S12 1 · S13 2 · S14 6 · S15 3 · S16 2 · S17 1 · S18 0 · S19 0 — 16 sectors with enemies (required ≥ 15).

Guard mobility (V2, the game's NavGrid with every barrier open): **30 of 30** guards have a walkable region of ≥ 1000 m² that contains a waypoint of the recommended route (required ≥ 24); **21** stand on the main floor of their sector (required ≥ 20); the others stand on another level — catwalks, galleries, the upper storey of the inspection building — that is one navigation region with a place the route visits. The navigation grid has no climbing or dropping, so no guard is posted on an isolated deck or machine top; those vantage points are held by turrets.

## 5. 飛行が必要な昇降箇所 / Mandatory climbs that need flight

A normal jump reaches 2.78 m. For each declared spot the validator checks: (a) blocking the `cut` box disconnects the exit
(every route crosses it), (b) a jump-only closure from everything on the near side cannot get beyond the cut, (c) height and
6 × 6 m standing areas at both ends, (d) the real Sim flies it with every generator × legs combination, (e) the smallest climb
that crosses the cut. "Declared climb" is the recommended take-off (the floor in front of the opening); the **smallest climb**
is measured, not declared: the lowest continuous rise above any resting place before the cut — deck, catwalk, machine top — that gets across (0.5 m resolution). It must be ≥ 6 m.

| ID | Sector | From (take-off) | To (landing) | Declared climb | (e) Smallest climb | Horizontal | Cut box | (a) cut | (b) needs flight | (d) EN used: weakest 90 / default 120 | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | S03 資材ヤード | (163, 2, 84) | (177, 12, 84) | 10 m | 6 m | 14 m | x 165..174, y 9..19, z 71..97 | yes | yes | 22.2 EN, 2.26 s / 22.2 EN, 2.26 s (6/6 combinations land) | 資材ヤード東壁の搬入開口(+10 m)へ上昇 |
| F2 | S04 圧延棟 | (303, 6, 18) | (317, 18, 18) | 12 m | 6 m | 14 m | x 305..314, y 15..25, z 5..31 | yes | yes | 27.2 EN, 2.51 s / 27.2 EN, 2.51 s (6/6 combinations land) | 圧延棟南東の開口(+16 m)から搬送縦坑へ |
| F3 | S06 搬送縦坑 | (343, 12, 29) | (357, 24, 29) | 12 m | 6 m | 14 m | x 345..354, y 21..31, z 13..45 | yes | yes | 27.2 EN, 2.51 s / 27.2 EN, 2.51 s (6/6 combinations land) | 搬送縦坑の底(+10 m)から組立ライン入口(+22 m)へ |
| F4 | S07 組立ライン | (452, 16, 93) | (452, 30, 107) | 14 m | 6 m | 14 m | x 445..475, y 27..37, z 95..104 | yes | yes | 32.2 EN, 2.76 s / 32.2 EN, 2.76 s (6/6 combinations land) | 組立ライン北東の開口(+28 m)から検査棟へ |
| F5 | S08 検査棟 | (387, 28, 192) | (372, 36, 192) | 8 m | 6 m | 15 m | x 376..385, y 33..43, z 185..199 | yes | yes | 17.2 EN, 2.01 s / 17.2 EN, 2.01 s (6/6 combinations land) | 検査棟上階(+26 m)から配管区画(+34 m)へ |
| F6 | S10 動力棟 | (117, 28, 116) | (103, 42, 116) | 14 m | 6 m | 14 m | x 106..115, y 39..49, z 103..129 | yes | yes | 32.2 EN, 2.76 s / 32.2 EN, 2.76 s (6/6 combinations land) | 動力棟南西の開口(+40 m)から冷却設備へ |
| F7 | S11 冷却設備 | (10, 34, 194) | (10, 48, 207) | 14 m | 6 m | 13 m | x 5..35, y 45..55, z 195..204 | yes | yes | 32.2 EN, 2.76 s / 32.2 EN, 2.76 s (6/6 combinations land) | 冷却設備北西の開口(+46 m)から排気縦坑上部へ |

Closest pair of from / to points of two different spots: 28.9 m (required ≥ 20 m). The cut boxes are pairwise disjoint and the climbs come strictly one after the other (F1 < F2 < F3 < F4 < F5 < F6 < F7): no opening is counted twice. EN is regenerated only on the ground; smallest max EN 90.

Every climb the walkthrough bot (V14) had to fly on the recommended route — 8 in total. Climbs that are on the route but are not
declared flight spots are listed too: they are real mandatory climbs, but the conservative jump-only closure of check (b) cannot
certify them (the closure ignores that height is lost when dropping, so a climb below an earlier, higher floor never passes it).

| Route waypoint | Sector of the landing | Take-off | Landing | Height | Horizontal | EN used: weakest / default | Flight time: weakest / default | Declared spot |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #14 | S03 資材ヤード | (162.79, 2, 83.34) | (177, 12, 84) | 10 m | 14.2 m | 22.2 / 22.2 | 2.26 s / 2.26 s | F1 |
| #25 | S06 搬送縦坑 | (302.97, 6, 18.72) | (317, 18, 18) | 12 m | 14.1 m | 27.2 / 27.2 | 2.51 s / 2.51 s | F2 |
| #29 | S06 搬送縦坑 | (342.61, 12, 28.38) | (357, 24, 29) | 12 m | 14.4 m | 27.2 / 27.2 | 2.51 s / 2.51 s | F3 |
| #42 | S07 組立ライン | (452.16, 16, 92.33) | (452, 30, 107) | 14 m | 14.7 m | 32.2 / 32.2 | 2.76 s / 2.76 s | F4 |
| #50 | S09 保守用配管区画 | (387.22, 28, 191.32) | (372, 36, 192) | 8 m | 15.2 m | 17.2 / 17.2 | 2.01 s / 2.01 s | F5 |
| #58 | S11 冷却設備 | (117.47, 28, 116.57) | (103, 42, 116) | 14 m | 14.5 m | 32.2 / 32.2 | 2.76 s / 2.76 s | F6 |
| #64 | S11 冷却設備 | (10, 34, 193.25) | (10, 48, 207) | 14 m | 13.7 m | 32.2 / 32.2 | 2.76 s / 2.76 s | F7 |
| #92 | S14 主製造ホール | (451.33, -10, 271.87) | (452, 2, 289) | 12 m | 17.1 m | 27.2 / 27.2 | 2.51 s / 2.51 s | not declared |

## 6. 分岐 / Branches (split and rejoin)

Each alternative is a real route from → via → to that stays ≥ 12 m away from the other via point. On top of that the validator
requires **structure**: the 2 m slab through each via point closes one passage; with either passage closed the rejoin point is still
reachable, with both closed it is not (two separate passages, no third way — an open floor or a hole in the separating wall fails).
And a **tactical difference**, measured on each alternative's own section (the samples farther than
8 m from the other alternative; the stretches at the split and the rejoin point are shared): the shorter alternative must be seen by
more enemies, by more of them at once, and have at least twice the firing lines per metre (enemies at their initial positions,
all barriers open).

| ID | From | To | Alternative | Via | Length | Own section | Enemies with a firing line onto it | Max at once | Firing lines per metre | Separate passages | Description |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BR1 | (368, 24, 10) | (460, 30, 118) | A | (400, 16, 30) | 172.1 m | 126 m | 7: G08 G09 G10 G11 G12 T06 T07 | 6 | 3.05 | yes (slabs ⟂ x / ⟂ x) | 前室のバルコニー開口から組立ライン床面へ降り、対角に横断して14 m上昇。最短だがマスト砲台T06・T07、中央キャットウォークのG10・G11、床面のG08・G09に四方から撃たれる |
| BR1 | (368, 24, 10) | (460, 30, 118) | B | (420, 24, 11) | 206.4 m | 178 m | 3: G10 G11 G12 | 1 | 0.11 | yes (slabs ⟂ x / ⟂ x) | 前室の南端から壁で囲われた部品搬送回廊(S18, +22 m)を南→東へ迂回して6 m上昇。約1.2倍の距離。回廊自体に敵はおらず、壁の銃眼(幅2 m)を横切る瞬間だけホールの敵の射線が通る |
| BR2 | (460, 30, 118) | (387, 28, 192) | A | (402, 28, 186) | 110.1 m | 64 m | 3: G12 T07 T08 | 2 | 1.38 | yes (slabs ⟂ x / ⟂ x) | 検査棟上階を対角に直進。短いが開けており、上階のG12と床開口H2越しの制御砲台T08に撃たれる |
| BR2 | (460, 30, 118) | (387, 28, 192) | B | (402, 20, 128) | 136 m | 102 m | 1: G12 | 1 | 0.57 | yes (slabs ⟂ x / ⟂ x) | 床開口H1から下階へ降り、T08の区画から隔壁で遮られた西側通路を進んでH3から8 m上昇して復帰。長いが、下階の通路自体は敵から見えない（開口の上り下りでのみG12に露出） |
| BR3 | (60, -10, 212) | (240, -10, 212) | A | (110, -10, 209) | 186.6 m | 76 m | 3: G20 G21 T12 | 2 | 1.34 | yes (slabs ⟂ x / ⟂ x) | 直通トンネル。最短だが東端のT12とトンネル内のG21に正面から撃たれ続け、崩落孔の南側(幅7 m)を通る |
| BR3 | (60, -10, 212) | (240, -10, 212) | B | (110, -10, 259) | 250 m | 134 m | 1: G21 | 1 | 0.15 | yes (slabs ⟂ x / ⟂ x) | 北側の側道を迂回。約65 m長いがコアが遮蔽となり、連絡路を横切る時以外は撃たれない |
| BR4 | (258, -10, 210) | (470, 2, 318) | A | (368, -10, 243) | 264.1 m | 206 m | 9: G22 G23 G24 G25 G26 G28 T12 T13 T14 | 6 | 3.17 | yes (slabs ⟂ x / ⟂ x) | 入口前室の北扉から最下層を斜めに横断し東端で12 m上昇。最短だが砲塔T13・T14、北ギャラリーと桟橋のG23〜G25、床面のG22に上下から撃たれる |
| BR4 | (258, -10, 210) | (470, 2, 318) | B | (380, 2, 211) | 319.1 m | 294 m | 7: G23 G24 G25 G28 T12 T13 T14 | 2 | 0.26 | yes (slabs ⟂ x / ⟂ x) | 入口前室の天井ハッチへ12 m上昇して壁で囲われた保守回廊(S19, 0 m)に入り、南→東を回って隔壁B6の東半分へ出る。長いが、回廊自体に敵はおらず、壁の銃眼(幅2 m)を横切る瞬間だけホールの敵の射線が通る |

## 7. 環状経路 / Local loops

Closed circuits whose consecutive waypoints are connected and which stay connected when a ball of 8 m around any one waypoint is blocked.
Structure: the plan polygon of the circuit must enclose ≥ 50 m² that cannot be walked on at the circuit's level (a solid core, or the void
between catwalks), these must be ≥ 25 % of everything it encloses, and no two non-adjacent waypoints may be joined by a straight walk —
waypoints on an open floor, or a wide round about a crate, are not a loop.

| ID | Waypoints | Perimeter | Encloses | of which not walkable | Description |
| --- | --- | --- | --- | --- | --- |
| LP1 | (304, 6, 61) → (322, 6, 66) → (336.5, 6, 75) → (322, 6, 84) → (304, 6, 89) | 107.4 m | 557 m² | 212 m² (38 %) | 圧延棟 ⇄ 制御室: 南扉から入り隔壁の東端を回って北扉から戻る |
| LP2 | (17, 42, 115) → (93, 42, 115) → (93, 42, 189) → (19, 42, 187) | 297.7 m | 5329 m² | 2624 m² (49 %) | 冷却設備のタンク群を囲むキャットウォーク環(+40 m) |
| LP3 | (60, -10, 212) → (150, -10, 214) → (150, -10, 259) → (60, -10, 259) | 277 m | 3918 m² | 2742 m² (70 %) | 地下搬送区画: 西コアを囲む直通トンネル → 中央連絡 → 側道 → 西連絡 |
| LP4 | (160, -10, 214) → (240, -10, 214) → (240, -10, 259) → (160, -10, 259) | 253.3 m | 3594 m² | 2752 m² (77 %) | 地下搬送区画: 東コアを囲む直通トンネル → 東連絡 → 側道 → 中央連絡 |

## 8. 攻略経路 / Recommended route

107 waypoints (player hit-box centres standing on the floor); waypoints without a note are corner points. The polyline can be
followed **exactly as drawn**: a level segment is a straight walk (the real box sweeps freely over continuous floor), a climb
rises straight up at its lower waypoint and flies level to the landing, a drop walks level off the edge and falls at the lower
waypoint — checked for all 88 level segments, 8 climbs and 10 drops (V14). "Polyline" is the cumulative straight-line length (2580.6 m in total); the
measured shortest-route length is in §9 (V3). "t" is the simulated time at which the walkthrough bot (V14) reached the waypoint
with the weakest / the default loadout, walking only (no glide, no quick boost) and without fighting.

| # | Sector | x | y | z | Polyline m | t weakest s | t default s | Note |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | S01 搬入口 | 20 | 2 | 90 | 0 | 0 | 0 | 出撃地点。正面(-Z)は60 m以上の直線レーン |
| 1 | S01 搬入口 | 20 | 2 | 24 | 66 | 8.4 | 6.8 |  |
| 2 | S02 検問連絡路 | 20 | 2 | 8 | 82 | 10.4 | 8.4 | 連絡路。東へ |
| 3 | S02 検問連絡路 | 40.5 | 2 | 8.5 | 102.5 | 13 | 10.5 |  |
| 4 | S02 検問連絡路 | 53.5 | 2 | 8.5 | 115.5 | 14.6 | 11.8 |  |
| 5 | S02 検問連絡路 | 54.5 | 2 | 7.5 | 116.9 | 14.8 | 11.9 |  |
| 6 | S02 検問連絡路 | 84 | 2 | 8 | 146.4 | 18.5 | 14.9 |  |
| 7 | S03 資材ヤード | 84 | 2 | 24 | 162.4 | 20.5 | 16.5 | 資材ヤード入口。マスト上の制御砲台T01(139,28)を射撃 → 隔壁B1開放 |
| 8 | S03 資材ヤード | 104 | 2 | 23 | 182.4 | 23 | 18.5 | ヤード南縁をコンテナ列に沿って東へ（中央の広場は十字砲火） |
| 9 | S03 資材ヤード | 114.5 | 2 | 33.5 | 197.3 | 24.8 | 20 |  |
| 10 | S03 資材ヤード | 114.5 | 2 | 35.5 | 199.3 | 25 | 20.1 |  |
| 11 | S03 資材ヤード | 144.5 | 2 | 60.5 | 238.4 | 29.9 | 24.1 |  |
| 12 | S03 資材ヤード | 155.5 | 2 | 60.5 | 249.4 | 31.3 | 25.1 |  |
| 13 | S03 資材ヤード | 163 | 2 | 84 | 274 | 34.4 | 27.6 | F1離陸点（+10 m） |
| 14 | S03 資材ヤード | 177 | 12 | 84 | 291.2 | 36.6 | 29.9 | F1着地（隔壁B1の手前） |
| 15 | S04 圧延棟 | 187 | 12 | 84 | 301.2 | 37.9 | 30.9 | 隔壁B1を抜けた張り出し。北はクレーンデッキ(+10 m)へ続く |
| 16 | S04 圧延棟 | 194 | 6 | 84 | 310.4 | 39.3 | 32.2 | 圧延棟の床へ降下 |
| 17 | S04 圧延棟 | 204.5 | 6 | 72.5 | 326 | 41.2 | 33.8 |  |
| 18 | S04 圧延棟 | 273.5 | 6 | 73.5 | 395 | 49.9 | 40.7 |  |
| 19 | S04 圧延棟 | 291.5 | 6 | 65.5 | 414.7 | 52.3 | 42.6 |  |
| 20 | S04 圧延棟 | 300 | 6 | 61 | 424.3 | 53.5 | 43.6 | 制御室南扉 |
| 21 | S05 圧延制御室 | 324 | 6 | 66 | 448.9 | 56.6 | 46 | 制御砲台T04(341,75)を射撃 → 隔壁B2開放 |
| 22 | S04 圧延棟 | 300 | 6 | 61 | 473.4 | 59.6 | 48.5 |  |
| 23 | S04 圧延棟 | 301.5 | 6 | 58.5 | 476.3 | 59.9 | 48.8 |  |
| 24 | S04 圧延棟 | 303 | 6 | 18 | 516.8 | 65 | 52.9 | F2離陸点（+12 m） |
| 25 | S06 搬送縦坑 | 317 | 18 | 18 | 535.3 | 67.5 | 55.4 | F2着地（搬送縦坑の入口足場） |
| 26 | S06 搬送縦坑 | 327 | 12 | 13 | 547.9 | 69.2 | 56.9 | 縦坑の床へ降下 |
| 27 | S06 搬送縦坑 | 333.5 | 12 | 18.5 | 556.5 | 70.2 | 57.7 |  |
| 28 | S06 搬送縦坑 | 343 | 12 | 29 | 570.6 | 72 | 59.1 | F3離陸点（+12 m） |
| 29 | S06 搬送縦坑 | 357 | 24 | 29 | 589.1 | 74.5 | 61.6 | F3着地（隔壁B2の手前） |
| 30 | S07 組立ライン | 368 | 24 | 29 | 600.1 | 75.8 | 62.7 | 前室。分岐BR1: バルコニー開口から床面へ / 南端から部品搬送回廊(S18)へ / 北扉から西通路(+22 m)へ |
| 31 | S07 組立ライン | 368 | 24 | 36 | 607.1 | 76.7 | 63.4 | バルコニー開口 |
| 32 | S07 組立ライン | 376 | 16 | 36 | 618.4 | 78.4 | 64.9 | 床面へ降下。マスト上の制御砲台T06(360,90)を射撃 → 隔壁B3開放 |
| 33 | S07 組立ライン | 378.5 | 16 | 43.5 | 626.3 | 79.3 | 65.7 |  |
| 34 | S07 組立ライン | 394.5 | 16 | 53.5 | 645.1 | 81.7 | 67.6 |  |
| 35 | S07 組立ライン | 394.5 | 16 | 55.5 | 647.1 | 81.9 | 67.8 |  |
| 36 | S07 組立ライン | 412.5 | 16 | 59.5 | 665.6 | 84.2 | 69.7 |  |
| 37 | S07 組立ライン | 418.5 | 16 | 67.5 | 675.6 | 85.5 | 70.7 |  |
| 38 | S07 組立ライン | 439.5 | 16 | 82.5 | 701.4 | 88.7 | 73.2 |  |
| 39 | S07 組立ライン | 452.5 | 16 | 82.5 | 714.4 | 90.3 | 74.5 |  |
| 40 | S07 組立ライン | 452.5 | 16 | 91.5 | 723.4 | 91.5 | 75.5 |  |
| 41 | S07 組立ライン | 452 | 16 | 93 | 725 | 91.7 | 75.6 | F4離陸点（+14 m、防爆壁の内側） |
| 42 | S07 組立ライン | 452 | 30 | 107 | 744.8 | 94.4 | 78.4 | F4着地（隔壁B3の手前） |
| 43 | S08 検査棟 | 460 | 30 | 118 | 758.4 | 96.1 | 79.7 | 隔壁B3を抜けた張り出し。分岐BR2: 上階を直進 / 下階を迂回 |
| 44 | S08 検査棟 | 460 | 28 | 125 | 765.6 | 97.3 | 80.8 | 検査棟上階(+26 m)へ降りる |
| 45 | S08 検査棟 | 449 | 28 | 146.5 | 789.8 | 100.3 | 83.2 | 床開口H2の縁から下階の制御砲台T08(449,163)を射撃 → 隔壁B4開放 |
| 46 | S08 検査棟 | 435.5 | 28 | 150.5 | 803.9 | 102 | 84.6 |  |
| 47 | S08 検査棟 | 411.5 | 28 | 163.5 | 831.2 | 105.5 | 87.3 |  |
| 48 | S08 検査棟 | 388.5 | 28 | 186.5 | 863.7 | 109.5 | 90.6 |  |
| 49 | S08 検査棟 | 387 | 28 | 192 | 869.4 | 110.2 | 91.1 | F5離陸点（+8 m） |
| 50 | S09 保守用配管区画 | 372 | 36 | 192 | 886.4 | 112.3 | 93.1 | F5着地。配管区画を西へ |
| 51 | S09 保守用配管区画 | 256 | 36 | 192 | 1002.4 | 126.8 | 104.8 | 隔壁B4 |
| 52 | S10 動力棟 | 240 | 36 | 190 | 1018.5 | 128.8 | 106.4 | 動力棟の入口バルコニー。北は制御ギャラリーと中央キャットウォーク(+34 m)へ続く |
| 53 | S10 動力棟 | 228 | 28 | 183 | 1034.6 | 131.1 | 108.3 | バルコニー西縁から床面へ降下 |
| 54 | S10 動力棟 | 216.5 | 28 | 183.5 | 1046.1 | 132.5 | 109.5 |  |
| 55 | S10 動力棟 | 184.5 | 28 | 177.5 | 1078.6 | 136.6 | 112.8 |  |
| 56 | S10 動力棟 | 126 | 28 | 127 | 1155.9 | 146.3 | 120.5 | F6離陸点の北側入口（防爆壁の陰） |
| 57 | S10 動力棟 | 117 | 28 | 116 | 1170.1 | 148.1 | 122 | F6離陸点（+14 m） |
| 58 | S11 冷却設備 | 103 | 42 | 116 | 1189.9 | 150.8 | 124.7 | F6着地（防爆壁の内側） |
| 59 | S11 冷却設備 | 93 | 42 | 115 | 1200 | 152 | 125.7 | 防爆壁の開口からキャットウォーク環へ。制御砲台T11(55,153)を射撃 → 隔壁B5開放 |
| 60 | S11 冷却設備 | 17 | 42 | 115 | 1276 | 161.5 | 133.3 |  |
| 61 | S11 冷却設備 | 17 | 42 | 180 | 1341 | 169.6 | 139.8 |  |
| 62 | S11 冷却設備 | 10 | 34 | 180 | 1351.6 | 171.2 | 141.2 | キャットウォーク西縁から床面へ降下 |
| 63 | S11 冷却設備 | 10 | 34 | 194 | 1365.6 | 172.9 | 142.6 | F7離陸点（+14 m） |
| 64 | S11 冷却設備 | 10 | 48 | 207 | 1384.7 | 175.6 | 145.4 | F7着地（隔壁B5の手前） |
| 65 | S11 冷却設備 | 14.5 | 48 | 210.5 | 1390.4 | 176.3 | 145.9 |  |
| 66 | S12 排気縦坑 | 20 | 48 | 217 | 1398.9 | 177.4 | 146.8 | 隔壁B5を抜けた張り出し。排気縦坑を降下 |
| 67 | S12 排気縦坑 | 36 | 32 | 232 | 1426.1 | 179.6 | 148.7 | 足場 +30 m |
| 68 | S12 排気縦坑 | 12 | 16 | 238 | 1455.5 | 182.2 | 151 | 足場 +14 m |
| 69 | S12 排気縦坑 | 36 | 1 | 238 | 1483.8 | 185 | 153.5 | 足場 -1 m |
| 70 | S12 排気縦坑 | 38 | -10 | 220 | 1505 | 187.6 | 155.8 | 縦坑底 |
| 71 | S12 排気縦坑 | 40 | -10 | 212 | 1513.3 | 188.6 | 156.6 | 東の扉へ |
| 72 | S13 地下搬送区画 | 60 | -10 | 212 | 1533.3 | 191 | 158.6 | 地下搬送区画。分岐BR3: 直通トンネル / 側道 |
| 73 | S13 地下搬送区画 | 68.5 | -10 | 215.5 | 1542.5 | 192.2 | 159.5 |  |
| 74 | S13 地下搬送区画 | 77.5 | -10 | 215.5 | 1551.5 | 193.3 | 160.4 |  |
| 75 | S13 地下搬送区画 | 82.5 | -10 | 210.5 | 1558.5 | 194.2 | 161.1 |  |
| 76 | S13 地下搬送区画 | 110 | -10 | 209 | 1586.1 | 197.6 | 163.8 | 直通トンネル: 崩落孔の南側（幅7 m）を通過 |
| 77 | S13 地下搬送区画 | 148.5 | -10 | 211.5 | 1624.7 | 202.4 | 167.7 |  |
| 78 | S13 地下搬送区画 | 211.5 | -10 | 212.5 | 1687.7 | 210.3 | 174 |  |
| 79 | S13 地下搬送区画 | 240 | -10 | 212 | 1716.2 | 213.9 | 176.9 |  |
| 80 | S14 主製造ホール | 258 | -10 | 210 | 1734.3 | 216.1 | 178.7 | 主製造ホール入口前室。分岐BR4: 北扉から最下層へ / 天井ハッチから保守回廊(S19)へ |
| 81 | S14 主製造ホール | 262 | -10 | 226 | 1750.8 | 218.2 | 180.3 | 北扉を出て最下層へ。砲塔上の制御砲台T14(366,264,+3 m)を射撃 → 隔壁B6開放 |
| 82 | S14 主製造ホール | 280.5 | -10 | 224.5 | 1769.3 | 220.5 | 182.2 |  |
| 83 | S14 主製造ホール | 329.5 | -10 | 224.5 | 1818.3 | 226.6 | 187.1 |  |
| 84 | S14 主製造ホール | 345.5 | -10 | 234.5 | 1837.2 | 228.9 | 188.9 |  |
| 85 | S14 主製造ホール | 348.5 | -10 | 237.5 | 1841.4 | 229.5 | 189.4 |  |
| 86 | S14 主製造ホール | 374.5 | -10 | 245.5 | 1868.6 | 232.9 | 192.1 |  |
| 87 | S14 主製造ホール | 383.5 | -10 | 246.5 | 1877.7 | 234 | 193 |  |
| 88 | S14 主製造ホール | 386.5 | -10 | 253.5 | 1885.3 | 234.9 | 193.7 |  |
| 89 | S14 主製造ホール | 429.5 | -10 | 260.5 | 1928.9 | 240.4 | 198.1 |  |
| 90 | S14 主製造ホール | 440 | -10 | 270 | 1943 | 242.1 | 199.5 | 最下層を横断（または保守回廊S19を迂回） |
| 91 | S14 主製造ホール | 452 | -10 | 272 | 1955.2 | 243.7 | 200.7 | 北ギャラリーの真下 |
| 92 | S14 主製造ホール | 452 | 2 | 289 | 1976 | 246.2 | 203.2 | 北ギャラリー(0 m)へ12 m上昇 |
| 93 | S14 主製造ホール | 452 | 2 | 296 | 1983 | 247 | 203.9 | 隔壁B6（扉の西半分） |
| 94 | S15 出荷倉庫 | 456 | 2 | 312 | 1999.5 | 249.1 | 205.5 | 出荷倉庫 |
| 95 | S15 出荷倉庫 | 437.5 | 2 | 313.5 | 2018.1 | 251.4 | 207.4 |  |
| 96 | S15 出荷倉庫 | 339 | 2 | 316 | 2116.6 | 263.7 | 217.3 |  |
| 97 | S15 出荷倉庫 | 334.5 | 2 | 344.5 | 2145.5 | 267.3 | 220.1 |  |
| 98 | S15 出荷倉庫 | 334.5 | 2 | 380.5 | 2181.5 | 271.8 | 223.7 |  |
| 99 | S15 出荷倉庫 | 337 | 2 | 385 | 2186.6 | 272.4 | 224.2 | 西扉 |
| 100 | S16 外周搬送路 | 320 | 2 | 385 | 2203.6 | 274.5 | 225.9 | 外周搬送路を西へ（中央レーンは2体の警備ロボットの射線。両側の廃車が遮蔽） |
| 101 | S16 外周搬送路 | 200 | 2 | 385 | 2323.6 | 289.5 | 237.9 |  |
| 102 | S16 外周搬送路 | 70 | 2 | 385 | 2453.6 | 305.8 | 250.9 |  |
| 103 | S17 搬出ゲート | 48 | 2 | 385 | 2475.6 | 308.5 | 253.2 | 搬出ゲート区画 |
| 104 | S17 搬出ゲート | 35.5 | 2 | 356.5 | 2506.7 | 312.4 | 256.3 |  |
| 105 | S17 搬出ゲート | 20 | 2 | 330 | 2537.4 | 316.2 | 259.3 | 最終ゲート（6基破壊で開放） |
| 106 | S17 搬出ゲート | 30 | 2 | 288 | 2580.6 | 320.4 | 262.7 | 脱出領域 |

Walkthrough with the real simulation (V14): keyboard-level input only (W, mouse yaw, Space), real collision, gravity, EN and flight;
HP is refilled every tick and "shooting" is replaced by destroying the next control turret as soon as the standing player has a
clear line of ≤ 120 m from centre and muzzle. It proves that the route is physically passable, not that the fights are winnable.

| Route / loadout | Result | Simulated time | Distance travelled | Waypoints | Flights (max / total EN) | Lowest EN | Waiting for EN | Re-plans | Sectors entered |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| recommended route, weakest (recovery + quadruped) | cleared | 320.4 s | 2668.4 m | 107/107 | 8 (32.2 / 217.3) | 57.8 | 0 s | 0 | 17: S01 S02 S03 S04 S05 S06 S07 S08 S09 S10 S11 S12 S13 S14 S15 S16 S17 |
| recommended route, default (balanced + biped) | cleared | 262.7 s | 2687.2 m | 107/107 | 8 (32.2 / 217.3) | 87.8 | 0 s | 0 | 17: S01 S02 S03 S04 S05 S06 S07 S08 S09 S10 S11 S12 S13 S14 S15 S16 S17 |
| detour (B side of every branch), weakest loadout | cleared | 359.5 s | 2981.7 m | 108/108 | 9 (32.2 / 214.5) | 57.8 | 0 s | 0 | 19: S01 S02 S03 S04 S05 S06 S07 S18 S08 S09 S10 S11 S12 S13 S14 S19 S15 S16 S17 |

### 8.1 迂回経路 / Detour route (the B side of every branch)

The same sortie through the covered / longer alternative of all four branches: the parts gallery S18, the lower storey of the
inspection building, the side tunnel and the service gallery S19. The control turrets T06 and T14 stand in their halls: T06 is shot
from the balcony opening of the vestibule, for T14 the route steps out of the entry vestibule and returns. Played by the walkthrough bot with the weakest loadout (V14); only the
stretches that differ from the recommended route are listed (# = index in the 108-waypoint detour route, see `DETOUR_KEYS` in src/stage/route.ts).

| # | Sector | x | y | z | t weakest s | Note |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 31 | S07 組立ライン | 368 | 24 | 36 | 76.7 | バルコニー開口からマスト上の制御砲台T06(360,90)を射撃 → 隔壁B3開放 |
| 32 | S07 組立ライン | 368 | 24 | 10 | 79.9 | 分岐BR1-B: 前室の南端 |
| 33 | S18 部品搬送回廊 | 380 | 24 | 11 | 81.4 | 部品搬送回廊（南辺）。銃眼からホールの敵に撃たれる |
| 34 | S18 部品搬送回廊 | 431.5 | 24 | 10.5 | 87.8 |  |
| 35 | S18 部品搬送回廊 | 469 | 24 | 11 | 92.5 |  |
| 36 | S18 部品搬送回廊 | 469.5 | 24 | 38.5 | 95.9 |  |
| 37 | S18 部品搬送回廊 | 469 | 24 | 93 | 102.8 | 部品搬送回廊（東辺）の北端 |
| 38 | S07 組立ライン | 468 | 30 | 106 | 104.5 | 搬入開口F4の東半分へ6 m上昇 |
| 39 | S07 組立ライン | 463 | 30 | 110 | 105.3 | 隔壁B3の手前 |
| 40 | S08 検査棟 | 460 | 30 | 118 | 106.3 | 隔壁B3を抜けた張り出し。分岐BR2: 上階を直進 / 下階を迂回 |
| 42 | S08 検査棟 | 449 | 28 | 146.5 | 110.6 | 床開口H2の縁から下階の制御砲台T08(449,163)を射撃 → 隔壁B4開放 |
| 43 | S08 検査棟 | 433 | 28 | 135 | 113 | 分岐BR2-B: 床開口H1の東縁 |
| 44 | S08 検査棟 | 426 | 20 | 135 | 114.6 | 下階へ降下 |
| 45 | S08 検査棟 | 415.5 | 20 | 144.5 | 116.3 |  |
| 46 | S08 検査棟 | 405.5 | 20 | 143.5 | 117.6 |  |
| 47 | S08 検査棟 | 393 | 20 | 138 | 119.3 | 下階の西側通路 |
| 48 | S08 検査棟 | 393 | 20 | 160 | 122 | 床開口H3の真下 |
| 49 | S08 検査棟 | 393 | 28 | 177 | 124 | 8 m上昇して上階へ復帰 |
| 50 | S08 検査棟 | 387 | 28 | 192 | 126 | F5離陸点（+8 m） |
| 73 | S13 地下搬送区画 | 60 | -10 | 212 | 206.8 | 地下搬送区画。分岐BR3: 直通トンネル / 側道 |
| 74 | S13 地下搬送区画 | 60 | -10 | 259 | 212.7 | 分岐BR3-B: 西連絡から側道へ |
| 75 | S13 地下搬送区画 | 91.5 | -10 | 258.5 | 216.6 |  |
| 76 | S13 地下搬送区画 | 110 | -10 | 259 | 218.9 |  |
| 77 | S13 地下搬送区画 | 185.5 | -10 | 258.5 | 228.4 |  |
| 78 | S13 地下搬送区画 | 240 | -10 | 259 | 235.2 | 東連絡で直通トンネルへ戻る |
| 79 | S13 地下搬送区画 | 240 | -10 | 212 | 241 |  |
| 81 | S14 主製造ホール | 262 | -10 | 226 | 245.3 | 北扉から最下層へ出て砲塔上の制御砲台T14(366,264,+3 m)を射撃 → 隔壁B6開放 |
| 82 | S14 主製造ホール | 262 | -10 | 209 | 247.4 | 分岐BR4-B: 入口前室へ戻り、天井ハッチの真下へ |
| 83 | S19 保守回廊 | 274 | 2 | 209 | 249.9 | ハッチを通って12 m上昇、保守回廊へ |
| 84 | S19 保守回廊 | 343.5 | 2 | 211.5 | 258.6 |  |
| 85 | S19 保守回廊 | 380 | 2 | 211 | 263.2 | 保守回廊（南辺）。銃眼からホールの敵に撃たれる |
| 86 | S19 保守回廊 | 386.5 | 2 | 209.5 | 264 |  |
| 87 | S19 保守回廊 | 428.5 | 2 | 209.5 | 269.3 |  |
| 88 | S19 保守回廊 | 430.5 | 2 | 211.5 | 269.6 |  |
| 89 | S19 保守回廊 | 468 | 2 | 211 | 274.3 |  |
| 90 | S19 保守回廊 | 468 | 2 | 290 | 284.1 | 保守回廊（東辺）の北端 |
| 91 | S19 保守回廊 | 463.5 | 2 | 296 | 285.1 | 隔壁B6（扉の東半分） |
| 92 | S15 出荷倉庫 | 463.5 | 2 | 312 | 287.1 |  |
| 93 | S15 出荷倉庫 | 460.5 | 2 | 313.5 | 287.4 |  |
| 94 | S15 出荷倉庫 | 456.5 | 2 | 313.5 | 287.9 |  |
| 95 | S15 出荷倉庫 | 456 | 2 | 312 | 288.1 | 出荷倉庫 |

Climbs flown on the detour route: #14 +10 m (22.2 EN), #25 +12 m (27.2 EN), #29 +12 m (27.2 EN), #38 +6 m (12.2 EN), #49 +8 m (17.2 EN), #51 +8 m (17.2 EN), #59 +14 m (32.2 EN), #65 +14 m (32.2 EN), #83 +12 m (27.2 EN).

### 8.2 経路上の敵の射線 / Enemy firing lines along the route (V15)

The route as drawn, sampled every metre; an enemy "has a firing line" when the sample is within its range and its muzzle has an
unobstructed line to the player's centre (enemies at their initial positions, all barriers open — guards will move, so this is a
static picture). Outside the start sector no stretch longer than 100 m may be without a firing line.

| Sector | Route in the sector (m) | Without a firing line (m) | Enemies stationed | Enemies with a line onto the route there | Which |
| --- | ---: | ---: | ---: | ---: | --- |
| S01 搬入口 | 73 | 73 | 0 | 0 |  |
| S02 検問連絡路 | 82 | 8 | 1 | 5 | G01 G02 G03 G04 T02 |
| S03 資材ヤード | 150 | 0 | 5 | 7 | G01 G02 G03 G04 G05 T01 T02 |
| S04 圧延棟 | 214 | 58 | 3 | 4 | G05 G06 T03 T04 |
| S05 圧延制御室 | 29 | 0 | 1 | 1 | T04 |
| S06 搬送縦坑 | 79 | 0 | 1 | 5 | G06 G07 G10 G11 T03 |
| S07 組立ライン | 171 | 12 | 6 | 6 | G09 G10 G11 G12 T06 T07 |
| S08 検査棟 | 134 | 24 | 2 | 4 | G12 G13 T07 T08 |
| S09 保守用配管区画 | 130 | 0 | 1 | 3 | G12 G13 G17 |
| S10 動力棟 | 189 | 39 | 5 | 8 | G13 G14 G15 G16 G17 G18 T09 T10 |
| S11 冷却設備 | 224 | 17 | 5 | 6 | G16 G18 G19 T05 T10 T11 |
| S12 排気縦坑 | 170 | 48 | 1 | 2 | G20 T11 |
| S13 地下搬送区画 | 203 | 4 | 2 | 3 | G20 G21 T12 |
| S14 主製造ホール | 270 | 12 | 6 | 9 | G22 G23 G24 G25 G26 G28 T12 T13 T14 |
| S15 出荷倉庫 | 206 | 25 | 3 | 8 | G24 G25 G26 G27 G28 G29 T13 T14 |
| S16 外周搬送路 | 270 | 0 | 2 | 4 | G27 G29 G30 T15 |
| S17 搬出ゲート | 117 | 0 | 1 | 2 | G30 T15 |

Longest stretch without a firing line: **25 m** (stretches ≥ 20 m: 25 m in S10, 21 m in S12, 21 m in S15, 20 m in S04). Under ≥ 1 firing line: 91 % of the route outside the start sector; under ≥ 2: 43 %; under ≥ 4: 13 %; most at one point: 6. Enemies that do not see the route from where they start: G08.

### 8.3 戦闘ありの実走 / Combat walkthrough (V16)

The same bot, but **without cheats**: HP is real and nothing is destroyed for free. It follows the recommended route and fights with
the real weapons and the real FCS against the real enemy AI: target = the next control turret when it can be engaged, otherwise the
nearest enemy that currently has a firing line on it; mouse-look puts the camera centre on the target; beam while EN ≥ 60 (down to
16), otherwise machine gun once locked; while fighting it stands on its floor and strafes left / right, reversing every 0.35–0.65 s.
It never glides, quick-boosts, takes cover or fights in the air — it has perfect aim and reactions but no tactics: a floor for what a
player can do, not a model of a first-time player. The simulation is deterministic for a seed (enemy aim jitter, AI choices).

| Run | Result | Time (fighting) | Final HP | Damage taken | Enemy shots fired | Enemies destroyed | Shots MG / beam / missile | HP when B1 … B6 opened |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| default loadout (medium FCS + balanced + biped), default seed | cleared | 308 s (44.1 s) | 288 / 1000 | 712 | 130 | 44 / 45 | 91 / 165 / 0 | 964 · 884 · 790 · 696 · 620 · 418 |
| default loadout, seed 1000 | cleared | 308.1 s (44.4 s) | 202 / 1000 | 798 | 132 | 44 / 45 | 91 / 166 / 0 | 946 · 866 · 718 · 624 · 548 · 328 |
| default loadout, seed 32676 | cleared | 313.3 s (47.3 s) | 368 / 1000 | 632 | 136 | 44 / 45 | 105 / 171 / 0 | 964 · 884 · 790 · 736 · 624 · 462 |
| weakest loadout (medium FCS + recovery + quadruped), default seed (informative) | cleared | 369.6 s (47.8 s) | 390 / 1000 | 610 | 138 | 43 / 45 | 142 / 151 / 0 | 928 · 888 · 762 · 726 · 654 · 506 |

Damage taken per sector in the first run: S02 36 · S04 98 · S05 40 · S06 18 · S07 112 · S10 76 · S11 58 · S12 108 · S13 36 · S14 58 · S15 72. Order of kills: G01 G02 G04 G03 T02 T01 G05 T03 T04 G06 G07 G11 G10 T06 T07 G09 G12 T08 G13 G17 G15 G14 T09 G16 G18 T11 T10 T05 G19 G20 G21 T12 G23 T14 G22 G25 T13 G24 G28 G26 G27 G29 G30 T15.

## 9. 検証結果 / Measured validation results

Voxel model: 498 × 237 × 418 cells of 1 × 0.5 × 1 m over the stage bounds. A cell is free when the player's box (2.6 × 4 × 2.6 m) centred
on it overlaps no solid (STRICT, used for "possible" claims) or when any point of the cell is a legal player centre (LOOSE, used for
"impossible / unavoidable" claims). Reachable with all barriers open: 4974601 strict / 5057444 loose cells, 154627 m² of standing floor.
Free-flight reachability ignores gravity and EN, so it over-estimates what a player can do: lower bounds and "must cross" results derived from it are safe.

### 9.1 最短経路 / Shortest route (V3)

| Quantity | Value | Meaning |
| --- | --- | --- |
| Lgrid | 2171.2 m | shortest 26-neighbour grid path start → exit zone through STRICT-free cells, every barrier and the gate open (free flight) |
| LgridLoose | 2168.5 m | same on the LOOSE (over-approximated) free space |
| Proven lower bound | **2002 m** | octagonal hop count 2003 − 1 on the LOOSE grid; holds for every continuous path of the player's centre, whatever the movement ability |
| Voxel-model lower bound | 1920 m | (LgridLoose − 2.5) / 1.128 (worst-case ratio of the grid metric to the Euclidean metric) |
| Lower bound used | **2002 m ≥ 1500 m** | max of the two bounds |
| Explicit feasible route | 2104.7 m | string-pulled polyline, every segment swept with the real collision World (upper bound of the free-flight optimum) |
| Walked route (V14) | 2668.4 m | distance really travelled by the walkthrough bot along the recommended route (gravity, EN, real physics) |

The true shortest route (even with unlimited flight) therefore lies between 2002 m and 2104.7 m; a real sortie is longer because the player has to walk, drop and climb.

<details><summary>Explicit feasible free-flight route: 52 points (x, y, z)</summary>

```
(20, 2, 90) → (24.5, 5.5, 12.5) → (54.5, 6, 12.5) → (77.5, 6, 12.5) →
(83.5, 6, 19.5) → (109.5, 13.5, 33.5) → (156.5, 16, 68.5) → (177.5, 16, 78.5) →
(185.5, 16, 78.5) → (306.5, 22, 28.5) → (313.5, 22, 28.5) → (362.5, 25, 34.5) →
(365.5, 25, 34.5) → (452.5, 34, 82.5) → (454.5, 34, 113.5) → (454.5, 34, 115.5) →
(383.5, 40, 187.5) → (342.5, 40, 191.5) → (293.5, 40, 192.5) → (293.5, 40, 191.5) →
(246.5, 40, 192.5) → (216.5, 44.5, 183.5) → (113.5, 46, 126.5) → (106.5, 46, 126.5) →
(32.5, 48, 196.5) → (25.5, 48, 210.5) → (25.5, 48, 220.5) → (26.5, 48, 221.5) →
(43.5, -1, 220.5) → (46.5, -6, 215.5) → (79.5, -6, 215.5) → (82.5, -6, 210.5) →
(89.5, -6, 210.5) → (253.5, -6, 216.5) → (257.5, -6, 217.5) → (260.5, -6, 221.5) →
(343.5, 6, 292.5) → (433.5, 6, 292.5) → (445.5, 6, 296.5) → (445.5, 6, 303.5) →
(428.5, 14, 318.5) → (379.5, 14, 360.5) → (375.5, 11.5, 365.5) → (333.5, 6, 375.5) →
(326.5, 6, 375.5) → (245.5, 6.5, 375.5) → (63.5, 6.5, 375.5) → (63.5, 6, 375.5) →
(56.5, 6, 375.5) → (48.5, 6, 314.5) → (40.5, 5, 305.5) → (40.5, 4.5, 297.5)
```

</details>

### 9.2 階層 / Altitude bands (V9)

| Floor height (m) | -12 | -7 | -1 | 4 | 9 | 14 | 19 | 26 | 31 | 36 | 46 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Standing area within ±1 m (m²) | 25114 | 2340 | 41454 | 15262 | 5020 | 9879 | 7954 | 16357 | 9582 | 652 | 704 |

### 9.3 全チェックの出力 / Full validator output

**V1 — PASS** — Sectors: >= 15, disjoint, each >= 150 m² reachable standing floor, >= 6 kinds

```
ok   sector count 19 >= 15
ok   sector ids unique (19/19)
ok   sector bounds pairwise disjoint
standing area per sector (m²): S01 2612 · S02 1032 · S03 9533 · S04 13535 · S05 1392 · S06 2366 · S07 13226 · S08 14238 · S09 856 · S10 13581 · S11 13291 · S12 3382 · S13 6814 · S14 25305 · S15 13599 · S16 6388 · S17 6536 · S18 2525 · S19 4416
ok   every sector has >= 150 m² of reachable standing cells
ok   S01 dock → functional: contains the player start
ok   S02 corridor → narrow passage: widest free square 14.6 m <= 20 m, length 95.6 m >= 60 m
ok   S03 yard → open yard: single floor level, main floor 124 x 81 m, only 4.5 % (<= 8 %) of it under free-standing obstacles taller than the mech (4.5 m)
ok   S04 factory → equipment hall: 14.2 % (>= 10 %) of the floor rectangle under free-standing machinery / structures taller than the mech (4.5 m)
ok   S05 factory → equipment hall: 12.3 % (>= 10 %) of the floor rectangle under free-standing machinery / structures taller than the mech (4.5 m)
ok   S06 shaft → vertical shaft: clear height 50 m above its floor >= the floor's larger extent 45.6 m, and >= 30 m (footprint 54.6 x 45.6 m)
ok   S07 multilevel → stacked floors: 3 floor levels >= 5 m apart with >= 400 m² each, 1777 m² stacked >= 200 m²
ok   S08 multilevel → stacked floors: 2 floor levels >= 5 m apart with >= 400 m² each, 5368 m² stacked >= 200 m²
ok   S09 corridor → narrow passage: widest free square 11.6 m <= 20 m, length 131.6 m >= 60 m
ok   S10 plant → equipment hall: 14.9 % (>= 10 %) of the floor rectangle under free-standing equipment taller than the mech, 1414 m² (>= 400) of service walkways >= 5 m over the floor
ok   S11 plant → equipment hall: 14.8 % (>= 10 %) of the floor rectangle under free-standing equipment taller than the mech, 3042 m² (>= 400) of service walkways >= 5 m over the floor
ok   S12 shaft → vertical shaft: clear height 74 m above its floor >= the floor's larger extent 48.6 m, and >= 30 m (footprint 48.6 x 45.6 m)
ok   S13 tunnel → underground tunnel: ceiling at -3 m <= 0 (below ground level), clear height 9 m <= 10 m
ok   S14 multilevel → stacked floors: 3 floor levels >= 5 m apart with >= 400 m² each, 4275 m² stacked >= 200 m²
ok   S15 warehouse → rack warehouse: 10 (>= 3) free-standing rack rows >= 8 m high, >= 20 m long, <= 8 m wide
ok   S16 road → narrow passage: widest free square 25.6 m <= 30 m, length 271.6 m >= 200 m
ok   S17 gate → functional: contains the final gate and the exit zone
ok   S18 corridor → narrow passage: widest free square 16.6 m <= 20 m, length 106.6 m >= 60 m
ok   S19 corridor → narrow passage: widest free square 18.6 m <= 20 m, length 225.6 m >= 60 m
ok   the declared kind of every sector is a measured property of its geometry
ok   geometrically distinct kinds of space 7 >= 6 (narrow passage: S02 S09 S16 S18 S19 · open yard: S03 · equipment hall: S04 S05 S10 S11 · vertical shaft: S06 S12 · stacked floors: S07 S08 S14 · underground tunnel: S13 · rack warehouse: S15)
reachable standing area total 154627 m², outside every sector 0 m²
```

**V2 — PASS** — Enemies: 30 guards + 15 turrets, 6 control turrets, legal placement, all attackable

```
ok   guards 30 = 30
ok   turrets 15 = 15
ok   enemy ids unique
ok   no enemy uses isolated-test overrides
ok   control turrets 6 = 6 (all of kind turret)
ok   barriers 6 = 6
ok   control turret <-> barrier links are one-to-one
ok   control turrets lie in 6 different sectors (T01@S03, T04@S05, T06@S07, T08@S08, T11@S11, T14@S14)
ok   every enemy is placed legally (inside its sector, clear of solids, resting on a surface, guards on >= 100 m² floor)
ok   every enemy can be attacked from a reachable cell within 100 m with a clear line
smallest connected guard floor found: >= 100 m²
ok   every guard starts on the game's NavGrid with >= 100 m² of connected walkable floor within 12 m (smallest: G16 144 m²)
ok   guards that can walk to the route (NavGrid region >= 1000 m² containing a route waypoint, all barriers open): 30 >= 24
ok   guards standing on the main floor of their sector: 21 >= 20
ok   every combat arena has a mobile guard on its main floor
smallest guard region: G07 1220 m²; regions (m²): G01 9883 G02 9883 G03 9883 G04 9883 G05 10568 G06 10568 G07 1220 G08 9327 G09 9327 G10 4542* G11 4542* G12 5916* G13 2338 G14 10092 G15 10092 G16 2338* G17 2338* G18 2582* G19 7566 G20 24904 G21 24904 G22 24904 G23 30621* G24 30621* G25 30621* G26 30621 G27 30621 G28 30621 G29 30621 G30 30621  (* = not on the sector's main floor)
ok   sectors that contain at least one enemy: 16 >= 15 (empty: S01, S18, S19)
enemies per sector: S01 0 · S02 1 · S03 5 · S04 3 · S05 1 · S06 1 · S07 6 · S08 2 · S09 1 · S10 5 · S11 5 · S12 1 · S13 2 · S14 6 · S15 3 · S16 2 · S17 1 · S18 0 · S19 0
```

**V3 — PASS** — Shortest start→exit route with every barrier and the gate open: lower bound >= 1500 m

```
(a) Lgrid = 2171.2 m  — shortest 26-neighbour grid path through STRICT-free cells (player box centred on each cell)
    LgridLoose = 2168.5 m — same metric on the LOOSE (over-approximated) free space
(b) lower bounds of the true Euclidean shortest path:
    proven hop bound      = 2002 m  (octagonal hop count 2003 - 1 on the LOOSE grid; valid for every continuous path)
    voxel-model bound     = 1920 m  ((LgridLoose - 2.5) / 1.12809)
(c) explicit feasible route (string-pulled, every segment swept with the real collision World) = 2104.7 m in 51 segments
ok   lower bound 2002 m >= 1500 m
sectors along the grid path: S01 → S02 → S03 → S04 → S06 → S07 → S08 → S09 → S10 → S11 → S12 → S13 → S14 → S15 → S16 → S17
```

**V4 — PASS** — Mandatory sectors: >= 12 sectors that every start→exit route must cross

```
ok   mandatory sectors 16 >= 12
mandatory: S01, S02, S03, S04, S06, S07, S08, S09, S10, S11, S12, S13, S14, S15, S16, S17
optional:  S05, S18, S19
```

**V5 — PASS** — Progression: every barrier and the gate is a true cut; control turrets are attackable in order only

```
ok   exit reachable with every barrier and the gate open
ok   closing any single barrier makes the exit unreachable
ok   closing only the final gate makes the exit unreachable (exit zone lies beyond the gate)
ok   stage 1 (B1, B2, B3, B4, B5, B6, GATE closed): control turret T01 attackable from the reachable region — e.g. from (139.5, 24, 23.5) at 4.5 m
ok   stage 1: the next control turret T04 is NOT attackable while B1 is closed (ray fan + 0 region cells within range tested by exact segments)
ok   stage 2 (B2, B3, B4, B5, B6, GATE closed): control turret T04 attackable from the reachable region — e.g. from (341.5, 11.5, 75.5) at 4.5 m
ok   stage 2: the next control turret T06 is NOT attackable while B2 is closed (ray fan + 345475 region cells within range tested by exact segments)
ok   stage 3 (B3, B4, B5, B6, GATE closed): control turret T06 attackable from the reachable region — e.g. from (360.5, 38, 85.5) at 4.5 m
ok   stage 3: the next control turret T08 is NOT attackable while B3 is closed (ray fan + 203749 region cells within range tested by exact segments)
ok   stage 4 (B4, B5, B6, GATE closed): control turret T08 attackable from the reachable region — e.g. from (449.5, 25, 163.5) at 4.5 m
ok   stage 4: the next control turret T11 is NOT attackable while B4 is closed (ray fan + 242648 region cells within range tested by exact segments)
ok   stage 5 (B5, B6, GATE closed): control turret T11 attackable from the reachable region — e.g. from (55.5, 46, 153.5) at 4.5 m
ok   stage 5: the next control turret T14 is NOT attackable while B5 is closed (ray fan + 105813 region cells within range tested by exact segments)
ok   stage 6 (B6, GATE closed): control turret T14 attackable from the reachable region — e.g. from (366.5, 9, 264.5) at 4.5 m
```

**V6 — PASS** — Flight spots: >= 6 separate mandatory climbs (6–16 m) that cannot be crossed without flight

```
ok   declared flight spots 7 >= 6
ok   spots pairwise >= 20 m apart (closest pair of from/to points 28.9 m)
ok   F1 (S03) declared climb 10 m, smallest climb that crosses the cut 6 m, horizontal 14 m, est. EN 22.2/90: cut ok, flight required yes
ok   F2 (S04) declared climb 12 m, smallest climb that crosses the cut 6 m, horizontal 14 m, est. EN 27.2/90: cut ok, flight required yes
ok   F3 (S06) declared climb 12 m, smallest climb that crosses the cut 6 m, horizontal 14 m, est. EN 27.2/90: cut ok, flight required yes
ok   F4 (S07) declared climb 14 m, smallest climb that crosses the cut 6 m, horizontal 14 m, est. EN 32.2/90: cut ok, flight required yes
ok   F5 (S08) declared climb 8 m, smallest climb that crosses the cut 6 m, horizontal 15 m, est. EN 17.2/90: cut ok, flight required yes
ok   F6 (S10) declared climb 14 m, smallest climb that crosses the cut 6 m, horizontal 14 m, est. EN 32.2/90: cut ok, flight required yes
ok   F7 (S11) declared climb 14 m, smallest climb that crosses the cut 6 m, horizontal 13 m, est. EN 32.2/90: cut ok, flight required yes
ok   the cut boxes are pairwise disjoint
ok   no spot has its take-off and landing on different sides of (or inside) another spot's cut
ok   the climbs come one after the other: near sides strictly nested in the order F1 < F2 < F3 < F4 < F5 < F6 < F7
```

**V6d — PASS** — Flight feasibility simulated with the real Sim: all 6 generator x legs combinations (weakest: recovery EN 90 + quadruped)

```
ok   F1: weakest (recovery + quadruped) EN 22.2/90 in 2.26 s, landed at (176.6, 12, 84) · default (balanced + biped) EN 22.2/120 in 2.26 s · 6/6 combinations land, worst EN share 25 %
ok   F2: weakest (recovery + quadruped) EN 27.2/90 in 2.51 s, landed at (316.6, 18, 18) · default (balanced + biped) EN 27.2/120 in 2.51 s · 6/6 combinations land, worst EN share 30 %
ok   F3: weakest (recovery + quadruped) EN 27.2/90 in 2.51 s, landed at (356.6, 24, 29) · default (balanced + biped) EN 27.2/120 in 2.51 s · 6/6 combinations land, worst EN share 30 %
ok   F4: weakest (recovery + quadruped) EN 32.2/90 in 2.76 s, landed at (452, 30, 106.6) · default (balanced + biped) EN 32.2/120 in 2.76 s · 6/6 combinations land, worst EN share 36 %
ok   F5: weakest (recovery + quadruped) EN 17.2/90 in 2.01 s, landed at (373, 36, 192) · default (balanced + biped) EN 17.2/120 in 2.01 s · 6/6 combinations land, worst EN share 19 %
ok   F6: weakest (recovery + quadruped) EN 32.2/90 in 2.76 s, landed at (103.4, 42, 116) · default (balanced + biped) EN 32.2/120 in 2.76 s · 6/6 combinations land, worst EN share 36 %
ok   F7: weakest (recovery + quadruped) EN 32.2/90 in 2.76 s, landed at (10, 48, 206.7) · default (balanced + biped) EN 32.2/120 in 2.76 s · 6/6 combinations land, worst EN share 36 %
```

**V7 — PASS** — Branches: >= 3 split-and-rejoin structures with two genuinely different alternatives

```
ok   declared branches 4 >= 3
ok   branches are at different places (closest pair of via mid-points 80.4 m >= 20 m)
ok   BR1: A 172.1 m, own section 126 m: 7 enemies with a firing line, max 6 at once, 3.05 per metre | B 206.4 m, own section 178 m: 3 enemies with a firing line, max 1 at once, 0.11 per metre | separate passages (cross-sections ⟂ x / ⟂ x; both closed → rejoin point unreachable)
ok   BR2: A 110.1 m, own section 64 m: 3 enemies with a firing line, max 2 at once, 1.38 per metre | B 136 m, own section 102 m: 1 enemies with a firing line, max 1 at once, 0.57 per metre | separate passages (cross-sections ⟂ x / ⟂ x; both closed → rejoin point unreachable)
ok   BR3: A 186.6 m, own section 76 m: 3 enemies with a firing line, max 2 at once, 1.34 per metre | B 250 m, own section 134 m: 1 enemies with a firing line, max 1 at once, 0.15 per metre | separate passages (cross-sections ⟂ x / ⟂ x; both closed → rejoin point unreachable)
ok   BR4: A 264.1 m, own section 206 m: 9 enemies with a firing line, max 6 at once, 3.17 per metre | B 319.1 m, own section 294 m: 7 enemies with a firing line, max 2 at once, 0.26 per metre | separate passages (cross-sections ⟂ x / ⟂ x; both closed → rejoin point unreachable)
```

**V8 — PASS** — Loops: >= 2 local circuits (60–400 m) that survive blocking any waypoint

```
ok   declared loops 4 >= 2
ok   loops are at different places (closest pair of centroids 95 m >= 20 m)
ok   LP1: 5 waypoints, perimeter 107.4 m, encloses 557 m² of which 212 m² (38 %) cannot be walked on at its level
ok   LP2: 4 waypoints, perimeter 297.7 m, encloses 5329 m² of which 2624 m² (49 %) cannot be walked on at its level
ok   LP3: 4 waypoints, perimeter 277 m, encloses 3918 m² of which 2742 m² (70 %) cannot be walked on at its level
ok   LP4: 4 waypoints, perimeter 253.3 m, encloses 3594 m² of which 2752 m² (77 %) cannot be walked on at its level
```

**V9 — PASS** — Levels: >= 3 altitude bands >= 5 m apart with >= 400 m² each, >= 200 m² of stacked floors

```
ok   altitude bands 11 >= 3 (floor heights -12 m: 25114 m², -7 m: 2340 m², -1 m: 41454 m², 4 m: 15262 m², 9 m: 5020 m², 14 m: 9879 m², 19 m: 7954 m², 26 m: 16357 m², 31 m: 9582 m², 36 m: 652 m², 46 m: 704 m²)
ok   stacked floor area 26952 m² >= 200 m² (columns with two major floors >= 5 m apart)
standing floor heights from -12 m to 46 m
```

**V10 — PASS** — Arenas: >= 5 combat sectors whose main floor spans >= 60 x 50 m with >= 45 % fill

```
ok   S03 Material yard: main floor y=0 m, 124 x 81 m, fill 73 %, 7288 m²
ok   S04 Rolling mill: main floor y=4 m, 137 x 94 m, fill 73 %, 9456 m²
ok   S07 Assembly line: main floor y=14 m, 124 x 94 m, fill 79 %, 9247 m²
ok   S10 Power house: main floor y=26 m, 134 x 94 m, fill 80 %, 10092 m²
ok   S11 Cooling plant: main floor y=32 m, 104 x 94 m, fill 77 %, 7566 m²
ok   S14 Main production hall: main floor y=-12 m, 227 x 94 m, fill 82 %, 17533 m²
ok   S15 Shipping warehouse: main floor y=0 m, 147 x 97 m, fill 77 %, 11004 m²
ok   qualifying arenas 7 >= 5 (declared combatArena: 7)
```

**V11 — PASS** — Multi-directional attack: >= 5 arenas where >= 15 % of the floor is covered by >= 4 enemies spanning >= 90°

```
ok   S03 Material yard: 5 enemies, 35 % of 9533 m² under fire from >= 4 of them over >= 90°
no   S04 Rolling mill: 3 enemies, 0 % of 13535 m² under fire from >= 4 of them over >= 90°
ok   S07 Assembly line: 6 enemies, 24 % of 13226 m² under fire from >= 4 of them over >= 90°
ok   S10 Power house: 5 enemies, 23 % of 13581 m² under fire from >= 4 of them over >= 90°
ok   S11 Cooling plant: 5 enemies, 27 % of 13291 m² under fire from >= 4 of them over >= 90°
ok   S14 Main production hall: 6 enemies, 25 % of 25305 m² under fire from >= 4 of them over >= 90°
no   S15 Shipping warehouse: 3 enemies, 0 % of 13599 m² under fire from >= 4 of them over >= 90°
ok   arenas with multi-directional fire 5 >= 5
```

**V12 — PASS** — Start: sheltered standing position with a free 60 m quick-boost lane

```
ok   the player start (20, 2, 90) is a standing position
ok   the player start lies in a sector (S01)
ok   no enemy has range + line of sight to any standing cell of the start sector S01 (2612 m²)
ok   the player box sweeps 60 m along the start yaw without contact (need 60 m)
ok   continuous flat floor under the lane for 60 m (need 60 m)
```

**V13 — PASS** — Geometry sanity: inside bounds, enclosed building, decor outside the player volume, box budget

```
ok   everything lies inside stage.bounds
ok   no degenerate (empty or inverted) boxes (0)
ok   solids 1075 <= 3500
ok   decor 1449 <= 3500
ok   the reachable region is enclosed (boundary-layer cells reached: 0)
reachable volume: 2487301 m³ strict / 2528722 m³ loose
ok   decor does not intrude into the player's volume (0 offending)
ok   thin decor inside the player's volume (323 lamps / cables / plates, all thinner than 0.25 m and > 5 m above the floor) is mounted: <= 4.5 m below a ceiling or clamped to a wall (0 free-hanging)
ok   no visible coplanar overlapping faces between solids (0)
```

**V14 — PASS** — Walkthrough: the recommended route is played to the exit by the real Sim (weakest and default loadout)

```
ok   the 107 route waypoints are standing positions inside their declared sectors
polyline length of the recommended route: 2580.6 m
ok   every segment of the recorded route can be followed as drawn: 88 level segments walk straight over continuous floor, 8 climbs and 10 drops are collision-free elbows
ok   route "detour (B side of every branch)": its 108 waypoints are standing positions inside their declared sectors
ok   route "detour (B side of every branch)": every segment can be followed as drawn (88 level, 9 climbs, 10 drops)
ok   weakest (recovery + quadruped): cleared in 320.4 s of simulated time, 2668.4 m travelled, 107/107 waypoints, 8 flights (max 32.2 EN, total 217.3 EN), lowest EN 57.8, 0 s waiting for EN, 0 re-plans, 17 sectors entered
ok   weakest (recovery + quadruped): control turrets destroyed in barrier order (T01 → T04 → T06 → T08 → T11 → T14)
ok   weakest (recovery + quadruped): every route waypoint reached in order
ok   weakest (recovery + quadruped): sectors entered 17 >= 12 (S01 S02 S03 S04 S05 S06 S07 S08 S09 S10 S11 S12 S13 S14 S15 S16 S17)
ok   weakest (recovery + quadruped): distance travelled 2668.4 m >= 1500 m
ok   default (balanced + biped): cleared in 262.7 s of simulated time, 2687.2 m travelled, 107/107 waypoints, 8 flights (max 32.2 EN, total 217.3 EN), lowest EN 87.8, 0 s waiting for EN, 0 re-plans, 17 sectors entered
ok   default (balanced + biped): control turrets destroyed in barrier order (T01 → T04 → T06 → T08 → T11 → T14)
ok   default (balanced + biped): every route waypoint reached in order
ok   default (balanced + biped): sectors entered 17 >= 12 (S01 S02 S03 S04 S05 S06 S07 S08 S09 S10 S11 S12 S13 S14 S15 S16 S17)
ok   default (balanced + biped): distance travelled 2687.2 m >= 1500 m
ok   detour (B side of every branch), weakest loadout: cleared in 359.5 s of simulated time, 2981.7 m travelled, 108/108 waypoints, 9 flights (max 32.2 EN, total 214.5 EN), lowest EN 57.8, 0 s waiting for EN, 0 re-plans, 19 sectors entered
ok   detour (B side of every branch), weakest loadout: control turrets destroyed in barrier order (T01 → T04 → T06 → T08 → T11 → T14)
ok   detour (B side of every branch), weakest loadout: every route waypoint reached in order
ok   detour (B side of every branch), weakest loadout: sectors entered 19 >= 12 (S01 S02 S03 S04 S05 S06 S07 S18 S08 S09 S10 S11 S12 S13 S14 S19 S15 S16 S17)
ok   detour (B side of every branch), weakest loadout: distance travelled 2981.7 m >= 1500 m
    T01 (B1) destroyed at t = 19.9 s from (83.8, 2, 18.8), 60.2 m away, on the way to waypoint #7
    T04 (B2) destroyed at t = 53.7 s from (300.4, 6, 61.4), 42.9 m away, on the way to waypoint #21
    T06 (B3) destroyed at t = 76.6 s from (367.9, 24, 34.3), 58 m away, on the way to waypoint #31
    T08 (B4) destroyed at t = 100.2 s from (449.7, 28, 145.2), 19.3 m away, on the way to waypoint #45
    T11 (B5) destroyed at t = 151.4 s from (98.8, 42, 115.6), 57.7 m away, on the way to waypoint #59
    T14 (B6) destroyed at t = 221.9 s from (291.2, -10, 224.5), 85.9 m away, on the way to waypoint #83
```

**V15 — PASS** — Route defence: no stretch of the recommended route longer than 100 m without an enemy firing line, >= 60 % of it under fire

```
ok   longest stretch without any enemy firing line (outside the start sector) 25 m <= 100 m — stretches >= 20 m: 25 m in S10, 21 m in S12, 21 m in S15, 20 m in S04
ok   91 % of the route outside the start sector (2391 of 2638 m) lies under at least one firing line (need >= 60 %)
ok   every sector on the route (except the start sector) has an enemy with a firing line onto the route
route sampled every metre as drawn: 2711 m; under >= 2 firing lines 43 %, >= 4 13 %, most at one point 6
per sector (route m / m without a firing line / enemies stationed / enemies with a line onto the route there): S01 73/73/0/0 · S02 82/8/1/5 · S03 150/0/5/7 · S04 214/58/3/4 · S05 29/0/1/1 · S06 79/0/1/5 · S07 171/12/6/6 · S08 134/24/2/4 · S09 130/0/1/3 · S10 189/39/5/8 · S11 224/17/5/6 · S12 170/48/1/2 · S13 203/4/2/3 · S14 270/12/6/9 · S15 206/25/3/8 · S16 270/0/2/4 · S17 117/0/1/2
enemies without a firing line onto the route from their initial position: G08
```

**V16 — PASS** — Combat walkthrough: a plain fighting bot clears the recommended route against the real enemy AI without cheats

```
ok   default loadout (medium FCS + balanced + biped), default seed: CLEARED after 308 s (44.1 s of it fighting), HP 288/1000 at the end, 712 damage taken from 130 enemy shots, 44/45 enemies destroyed, shots MG 91 / beam 165 / missile 0
    HP when each barrier opened: B1 964 (t = 23 s) · B2 884 (t = 53.8 s) · B3 790 (t = 78.2 s) · B4 696 (t = 103.5 s) · B5 620 (t = 152.4 s) · B6 418 (t = 221.2 s)
    damage taken per sector: S02 36 · S04 98 · S05 40 · S06 18 · S07 112 · S10 76 · S11 58 · S12 108 · S13 36 · S14 58 · S15 72
ok   default loadout (medium FCS + balanced + biped), default seed: all 6 control turrets were destroyed by the bot's own fire (T01 → T04 → T06 → T08 → T11 → T14)
ok   default loadout, seed 1000: CLEARED after 308.1 s (44.4 s of it fighting), HP 202/1000 at the end, 798 damage taken from 132 enemy shots, 44/45 enemies destroyed, shots MG 91 / beam 166 / missile 0
    HP when each barrier opened: B1 946 (t = 23 s) · B2 866 (t = 53.8 s) · B3 718 (t = 78.2 s) · B4 624 (t = 103.5 s) · B5 548 (t = 152.4 s) · B6 328 (t = 221.3 s)
    damage taken per sector: S02 54 · S04 116 · S05 40 · S06 36 · S07 130 · S10 76 · S11 58 · S12 108 · S13 54 · S14 36 · S15 90
ok   default loadout, seed 1000: all 6 control turrets were destroyed by the bot's own fire (T01 → T04 → T06 → T08 → T11 → T14)
ok   default loadout, seed 32676: CLEARED after 313.3 s (47.3 s of it fighting), HP 368/1000 at the end, 632 damage taken from 136 enemy shots, 44/45 enemies destroyed, shots MG 105 / beam 171 / missile 0
    HP when each barrier opened: B1 964 (t = 23 s) · B2 884 (t = 53.8 s) · B3 790 (t = 78.2 s) · B4 736 (t = 103.5 s) · B5 624 (t = 152.4 s) · B6 462 (t = 225.8 s)
    damage taken per sector: S02 36 · S04 98 · S05 40 · S06 18 · S07 72 · S10 112 · S12 126 · S13 36 · S14 40 · S15 54
ok   default loadout, seed 32676: all 6 control turrets were destroyed by the bot's own fire (T01 → T04 → T06 → T08 → T11 → T14)
info weakest loadout (medium FCS + recovery + quadruped), default seed: CLEARED after 369.6 s (47.8 s of it fighting), HP 390/1000 at the end, 610 damage taken from 138 enemy shots, 43/45 enemies destroyed, shots MG 142 / beam 151 / missile 0
    HP when each barrier opened: B1 928 (t = 26.6 s) · B2 888 (t = 62.9 s) · B3 762 (t = 92.5 s) · B4 726 (t = 121.5 s) · B5 654 (t = 180.6 s) · B6 506 (t = 262.7 s)
    damage taken per sector: S02 72 · S03 40 · S04 36 · S06 90 · S07 36 · S10 54 · S11 58 · S12 108 · S14 80 · S15 36
lowest final HP of the required runs: 202/1000
```

## 10. 検証の限界 / What these checks do not show

- V3–V8 are free-flight statements (gravity and EN ignored). They bound the real game from the safe side; the real-physics evidence is V6d (every declared climb, all generator × legs combinations), V14 (both routes, walked) and V16 (the recommended route, fought).
- V14 does not fight (HP refilled, control turrets destroyed on sight): it shows that the routes are passable. V16 fights without cheats, but with a bot: perfect aim and reactions, no glide / quick boost / cover. It shows that a sortie is survivable with the real enemy AI as it is now; it does not predict how long a first-time player needs (the bot takes about 5 minutes, walking), and its result changes when the enemy AI or the weapons change.
- V5 "not visible before its turn", V11, V15 and the exposure numbers of §6 are dense samplings of lines of sight from the initial enemy positions; moving guards are not modelled.
- V2 guard mobility uses the game's NavGrid, which has no climbing or dropping: a guard on a walkway (crane deck, catwalks, galleries) stays on that level. Such walkways are connected to a place the route visits, so these guards can still close in on a player who is up there and move to regain a firing line on one who is not.
- The firing slits of the galleries S18 / S19, the roof trusses and the turret masts were placed by measurement (V7, V11), not by play-testing with a human.
