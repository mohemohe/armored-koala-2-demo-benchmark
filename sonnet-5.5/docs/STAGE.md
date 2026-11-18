# ステージ設計と検証結果

このファイルは `npx tsx tools/stage-report.ts` が自動生成する(手で編集しない)。数値は `src/stage/validate.ts` が
実際の衝突形状(`World`)と実際の移動物理(`Game`/player)から計測したもので、申告値ではない。

- ステージ: ARMORED KOALA 2 廃工場
- 検証結果: **全項目合格** (必須項目 32 件中 32 件合格)
- 区画数 20 / 敵 45 体 (警備 30、砲台 15) / 隔壁 7 / portal 23 / 飛行昇降 8
- 最短の実行可能経路(飛行自由・全隔壁開放、平滑化+sweep検証済みの上界): **2149.3 m** (要件 1500 m 以上)
- 物理的に通過する区画: 16 (S01 → S02 → S03 → S04 → S05 → S06 → S07 → S08 → S09 → S10 → S11 → S12 → S13 → S14 → S15 → S16)

## 1. 検証結果

| 判定 | 項目 | 内容 | 値 | 基準 | 詳細 |
| --- | --- | --- | --- | --- | --- |
| PASS | sectors.count | 区画数 | 20 | >= 15 | sectors=20 |
| PASS | sectors.ids | 区画IDの一意性と境界の妥当性 | 20 | unique ids == 20, valid bounds | ok |
| PASS | sectors.overlap | 区画boundsが互いに重ならない | 0 | 0 overlapping pairs | no overlaps |
| PASS | sectors.variety | 空間種別/名称の種類数 | 9 | kinds >= 6 and names >= 6 | kinds=dock/yard/factory/shaft/multilevel/pipe/corridor/warehouse/gate (9), distinct names=20/20 |
| PASS | enemies.count | 敵の数(警備30・砲台15・計45) | 30+15=45 | 30 guards + 15 turrets = 45 | guards=30, turrets=15 |
| PASS | enemies.ids | 敵IDの一意性とHP(enemies.ts側の設定) | 45 | unique ids == 45; guard hp 120, turret hp 240 | hp from createEnemies(): guard=120, turret=240 |
| PASS | enemies.controls | 制御砲台6体と隔壁の1対1対応・区画分散 | 6 controls / 6 sectors | 6 turrets <-> 6 barriers 1:1, >= 6 distinct sectors | controls: T03@S03->B1, T07@S06->B2, T08@S08->B3, T11@S11->B4, T14@S13->B5, T15@S14->B6 |
| PASS | enemies.spawns | 敵スポーンが埋まらず床の上にある | 0 | 0 buried / floating / low-headroom spawns | all 45 spawns are clear of boxes, on a floor, with >= 3 m headroom, inside their sector |
| PASS | route.length | 最短の実行可能経路長(飛行自由・全隔壁開放) | 2149.3 | >= 1500 m | smoothed sweep-verified route 2149.3 m (upper bound of the true shortest; raw grid path 2310.9 m, straight-line lower bound 727.5 m, grid 369x39x289 @ 2.00 m (4158999 nodes)); A* iterations 1; grid 3.00 m: 2149.3 m |
| PASS | route.sectors | 必須経路で物理的に通過する区画数 | 16 | >= 12 | S01 -> S02 -> S03 -> S04 -> S05 -> S06 -> S07 -> S08 -> S09 -> S10 -> S11 -> S12 -> S13 -> S14 -> S15 -> S16 |
| PASS (参考) | route.declared | 記載された経路座標(mainRoute)が通行可能で最短経路以上の長さ | 2231.2 | declared waypoints connected by collision-free straight moves; length >= verified shortest route | declared route 2231.2 m vs verified 2149.3 m |
| PASS | reach.enemies | 到達不能な敵がない | 0 | 0 enemies without a start-reachable player position within 6 m | all 45 enemies are within 6 m of the start-reachable free space (barriers open) |
| PASS | reach.floors | 到達不能な床がない | 80 | in every sector >= 50% of the standing-surface samples are start-reachable | standing samples=8848, unreachable=80 |
| PASS | layers.bands | 3層以上の高度帯(実際に立てる大きな床面) | 15 | >= 3 altitude bands (reachable box tops >= 100 m2 each, >= 250 m2 per band, clustered within 2.5 m) | y=-14.0(23292m2), y=-4.0(275m2), y=0.0(145888m2), y=3.0(1398m2), y=5.8(1699m2), y=9.0(1845m2), y=12.0(77241m2), y=14.6(1258m2), y=18.0(2330m2), y=20.6(484m2), y=24.0(49710m2), y=27.4(510m2), y=30.0(828m2), y=33.0(720m2), y=38.4(876m2) |
| PASS | shell.perimeter | 外周が閉じている(到達可能領域がbounds内) | 0 | 0 reachable free-space nodes outside every sector bounds | contacts with outside=0; reachable region stays inside the sector bounds |
| PASS | shell.roof | 各区画の上方に開口がない(屋根/天井が閉じている) | 0 | 0 reachable columns whose upward ray escapes without hitting a roof/ceiling | 68600 reachable columns all covered |
| PASS | shortcut.minHops | 区画を飛ばす近道がない(区画グラフの最少通過区画数) | 16 | >= 12 sectors on the fewest-sector path in the real connection graph | fewest-sector path: S01 -> S02 -> S03 -> S04 -> S05 -> S06 -> S07 -> S08 -> S09 -> S10 -> S11 -> S12 -> S13 -> S14 -> S15 -> S16 |
| PASS | shortcut.undeclaredOpenings | 宣言されていない開口(抜け道)がない | 0 | 0 real openings between sectors that are not declared portals | 23 real connections, all declared |
| PASS | topology.branches | 分岐して再合流する構造(実際の自由空間から) | 4 | >= 3 independent cycles whose two routes are each >= 40 m | 4 cycles in the sector graph (23 connections); counted: [S12>S13>S20 perimeter 244 arcs 118/125 apart 64%/67%] [S02>S03>S17 perimeter 332 arcs 161/172 apart 78%/79%] [S07>S08>S19 perimeter 384 arcs 198/186 apart 84%/83%] [S05>S06>S18 perimeter 429 arcs 211/219 apart 71%/71%] |
| PASS | topology.loops | 環状経路(単純往復でない閉路) | 4 | >= 2 independent cycles (the same structure may count as branch and loop, SPEC §2.2) | 4 independent qualifying cycles |
| PASS | topology.declaredBranches | 宣言された分岐(branches)の経路が通行可能・長さ一致 | 4/4 | >= 3 declared branches and every declared branch valid | BR1 ok \| BR2 ok \| BR3 ok \| BR4 ok |
| PASS | topology.declaredLoops | 宣言された環状経路(loops)が通行可能・閉じている | 4/4 | >= 2 declared loops and every declared loop valid | LOOP-BR1 ok (591.8 m) \| LOOP-BR2 ok (601.6 m) \| LOOP-BR3 ok (616.6 m) \| LOOP-BR4 ok (265.8 m) |
| PASS | portal.dimensions | portal開口寸法(幅>=5m・高さ>=6m) | 0 | width >= 5, height >= 6; valid sector/barrier references | 23 portals; min width 14.0 min height 8.0 |
| PASS | portal.open | 開いた状態でportalを実際に通行できる | 0 | every portal: at least one player-box lane passes through the opening (sweepAABB, barriers open) | 23 portals passable |
| PASS | barrier.block | 隔壁の箱が開口を完全に塞いでいる(閉鎖時に通れない) | 0 | 0 leaking lanes; every barrier has boxes and a portal | 7 barriers sealed (7497 lanes blocked) |
| PASS (参考) | portal.matched | portal宣言と実際の開口の一致 | 0 | every declared portal coincides with a real free-space connection | 23 portals matched to 23 connections |
| PASS | arena.wide | 広い戦闘空間(60x50m以上の空き床)の区画数 | 9 | >= 5 sectors with an obstacle-free 60x50 m rectangle | qualifying: S02(92x67), S03(77x71), S05(93x69), S08(102x81), S09(91x61), S11(110x64), S12(107x85), S13(87x62), S14(92x82) |
| PASS | combat.crossfire | 複数方向の攻撃(4体以上が射線を取れる区画) | 6 | >= 5 sectors where some floor point is visible from >= 4 in-range enemies of that sector | qualifying: S02(5/6), S03(5/5), S05(6/6), S08(5/5), S12(5/6), S13(4/4) |
| PASS | start.safe | スタートの安全(全敵の銃口から射線が通らない・衝突なし) | 0 | 0 enemies with line of sight to any of the 27 player-box sample points; no overlap; standing on a floor | exposed to: none; overlap=false; feet gap=0.000; inside a sector=true |
| PASS | climb.height | 昇降の高低差(6〜16m)と前後の足場 | 8 | heights 6..16 m (declared = measured), standing platforms at both ends | heights: C1=12.0, C2=12.0, C3=12.0, C4=14.0, C5=12.0, C6=12.0, C7=12.0, C8=12.0 |
| PASS | climb.needsFlight | 通常ジャンプ(最大2.78m)では上がれない | 2.79 | real jump physics: max rise <= 3.08 m and the upper platform is never reached | max jump rise 2.79 m (theory 2.78 m) |
| PASS | climb.onPath | 飛行が必要な昇降箇所(別々の場所)が最短経路上に6か所以上 | 8 | >= 6 distinct (>= 20 m apart) valid climbs within 12 m of the start->escape route | valid climbs=8/8: C1(6.0m off route), C2(8.4m off route), C3(4.9m off route), C4(2.6m off route), C5(10.1m off route), C6(1.6m off route), C7(3.5m off route), C8(5.0m off route); off-route: none |
| PASS | climb.flight18 | 全18構成で飛行昇降が可能(実際のplayer物理で着地) | 144/144 | every climb x 18 loadouts: lower platform -> Space hold flight + horizontal move + release -> land on the upper platform | all 144 runs succeeded; max EN used 33.0 of min max-EN 90 (recovery generator = 90) |
| PASS | shortcut.barrierLeak | 閉じた隔壁を迂回できない(各隔壁が必須) | 0 | for every barrier: closed (all others open) => the escape zone is unreachable; all closed => no sector after the first barrier is reachable | 7 single-barrier states and the all-closed state seal the escape zone; all-closed reachable sectors: S01, S02, S03, S17 |

## 2. 区画表

| ID | 名称 | 種別 | bounds min | bounds max | サイズ(x,y,z) | 床Y | 天井Y | 戦闘 | 敵数 | 空き床(最大矩形) | 60x50 | 射線を取る敵数(最大) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | 搬入口 | dock | (0, -2, 0) | (70, 16, 140) | 70 x 18 x 140 | 0.0 | 14.0 | - | 2 | 41 x 19 m | - | 2/2 |
| S02 | 資材ヤード | yard | (70, -2, 0) | (200, 26, 140) | 130 x 28 x 140 | 0.0 | 24.0 | ○ | 6 | 92 x 67 m | ○ | 5/6 |
| S03 | 圧延棟 | factory | (200, -2, 0) | (330, 28, 140) | 130 x 30 x 140 | 0.0 | 26.0 | ○ | 5 | 77 x 71 m | ○ | 5/5 |
| S04 | 搬送縦坑 | shaft | (330, -2, 60) | (390, 28, 140) | 60 x 30 x 80 | 0.0 | 26.0 | - | 0 | 32 x 45 m | - | 0/0 |
| S05 | 組立ライン | factory | (390, 10, 0) | (530, 36, 140) | 140 x 26 x 140 | 12.0 | 34.0 | ○ | 6 | 93 x 69 m | ○ | 6/6 |
| S06 | 検査棟 | multilevel | (530, 10, 0) | (640, 42, 140) | 110 x 32 x 140 | 12.0 | 40.0 | - | 3 | 26 x 51 m | - | 3/3 |
| S07 | 保守用配管区画 | pipe | (530, 22, 140) | (640, 42, 280) | 110 x 20 x 140 | 24.0 | 40.0 | - | 1 | 41 x 30 m | - | 1/1 |
| S08 | 動力棟 | multilevel | (390, -2, 140) | (530, 42, 280) | 140 x 44 x 140 | 0.0 | 40.0 | ○ | 5 | 102 x 81 m | ○ | 5/5 |
| S09 | 冷却設備 | factory | (270, -2, 140) | (390, 32, 280) | 120 x 34 x 140 | 0.0 | 30.0 | ○ | 3 | 91 x 61 m | ○ | 3/3 |
| S10 | 排気縦坑 | shaft | (210, -16, 200) | (270, 28, 280) | 60 x 44 x 80 | -14.0 | 26.0 | - | 0 | 27 x 47 m | - | 0/0 |
| S11 | 地下搬送区画 | corridor | (80, -16, 140) | (210, 14, 280) | 130 x 30 x 140 | -14.0 | 12.0 | ○ | 3 | 110 x 64 m | ○ | 3/3 |
| S12 | 主製造ホール | multilevel | (0, -2, 280) | (220, 44, 430) | 220 x 46 x 150 | 0.0 | 42.0 | ○ | 6 | 107 x 85 m | ○ | 5/6 |
| S13 | 出荷倉庫 | warehouse | (220, -2, 340) | (350, 42, 490) | 130 x 44 x 150 | 0.0 | 40.0 | ○ | 4 | 87 x 62 m | ○ | 4/4 |
| S14 | 外周搬送路 | corridor | (350, -2, 340) | (500, 32, 490) | 150 x 34 x 150 | 0.0 | 30.0 | ○ | 1 | 92 x 82 m | ○ | 1/1 |
| S15 | 搬出ゲート | gate | (500, 10, 340) | (640, 42, 490) | 140 x 32 x 150 | 12.0 | 40.0 | - | 0 | 36 x 77 m | - | 0/0 |
| S16 | 脱出領域 | yard | (640, 22, 340) | (720, 42, 490) | 80 x 20 x 150 | 24.0 | 40.0 | - | 0 | 50 x 39 m | - | 0/0 |
| S17 | 旧搬送トンネル | corridor | (100, -2, -40) | (300, 14, 0) | 200 x 16 x 40 | 0.0 | 12.0 | - | 0 | 153 x 4 m | - | 0/0 |
| S18 | 屋根裏保守通路 | corridor | (390, 10, -50) | (640, 26, 0) | 250 x 16 x 50 | 12.0 | 24.0 | - | 0 | 28 x 46 m | - | 0/0 |
| S19 | 上層配管ダクト | pipe | (400, 22, 280) | (640, 38, 340) | 240 x 16 x 60 | 24.0 | 36.0 | - | 0 | 44 x 44 m | - | 0/0 |
| S20 | 旧倉庫 | warehouse | (120, 22, 430) | (220, 38, 510) | 100 x 16 x 80 | 24.0 | 36.0 | - | 0 | 32 x 48 m | - | 0/0 |

高度帯(実際に立てる大きな床面): y=-14.0m (23292 m²), y=-4.0m (275 m²), y=0.0m (145888 m²), y=3.0m (1398 m²), y=5.8m (1699 m²), y=9.0m (1845 m²), y=12.0m (77241 m²), y=14.6m (1258 m²), y=18.0m (2330 m²), y=20.6m (484 m²), y=24.0m (49710 m²), y=27.4m (510 m²), y=30.0m (828 m²), y=33.0m (720 m²), y=38.4m (876 m²)

## 3. 区画の接続(portal)と実際の開口

| portal | a | b | 中心 | 幅x高 | 種別 | 隔壁 | 実開口(自由空間で検出) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P01 | S01 | S02 | (70.0, 4.0, 120.0) | 14.0 x 8.0 | door | - | C01 (71.0, 3.8, 119.3) |
| P02 | S02 | S03 | (200.0, 4.0, 20.0) | 14.0 x 8.0 | door | - | C02 (201.0, 3.8, 19.3) |
| P03 | S03 | S04 | (330.0, 4.0, 100.0) | 14.0 x 8.0 | door | B1 | C04 (331.0, 3.8, 99.3) |
| P04 | S04 | S05 | (390.0, 16.0, 100.0) | 14.0 x 8.0 | shaft | - | C06 (391.0, 15.8, 99.3) |
| P05 | S05 | S06 | (530.0, 16.0, 20.0) | 14.0 x 8.0 | door | - | C07 (531.0, 15.8, 19.3) |
| P06 | S06 | S07 | (620.0, 28.0, 140.0) | 14.0 x 8.0 | catwalk | B2 | C09 (619.3, 27.8, 141.0) |
| P07 | S07 | S08 | (530.0, 28.0, 266.0) | 14.0 x 8.0 | catwalk | - | C11 (529.0, 27.8, 265.3) |
| P08 | S08 | S09 | (390.0, 4.0, 156.0) | 14.0 x 8.0 | door | B3 | C13 (389.0, 3.8, 155.3) |
| P09 | S09 | S10 | (270.0, 16.0, 266.0) | 14.0 x 8.0 | catwalk | - | C15 (269.0, 15.8, 265.3) |
| P10 | S10 | S11 | (210.0, -10.0, 214.0) | 14.0 x 8.0 | tunnel | - | C16 (209.0, -10.3, 213.3) |
| P11 | S11 | S12 | (92.0, 4.0, 280.0) | 14.0 x 8.0 | catwalk | B4 | C17 (91.3, 3.8, 281.0) |
| P12 | S12 | S13 | (220.0, 28.0, 354.0) | 14.0 x 8.0 | catwalk | - | C18 (221.0, 27.8, 353.3) |
| P13 | S13 | S14 | (350.0, 4.0, 352.0) | 14.0 x 8.0 | door | B5 | C20 (351.0, 3.8, 351.3) |
| P14 | S14 | S15 | (500.0, 16.0, 474.0) | 14.0 x 8.0 | catwalk | B6 | C22 (501.0, 15.8, 473.3) |
| P15 | S15 | S16 | (640.0, 28.0, 352.0) | 14.0 x 8.0 | door | GATE | C23 (641.0, 27.8, 351.3) |
| P16 | S02 | S17 | (120.0, 4.0, 0.0) | 14.0 x 8.0 | tunnel | - | C03 (119.3, 3.8, -1.0) |
| P17 | S17 | S03 | (280.0, 4.0, 0.0) | 14.0 x 8.0 | tunnel | - | C05 (279.3, 3.8, -1.0) |
| P18 | S05 | S18 | (410.0, 16.0, 0.0) | 14.0 x 8.0 | tunnel | - | C08 (409.3, 15.8, -1.0) |
| P19 | S18 | S06 | (620.0, 16.0, 0.0) | 14.0 x 8.0 | tunnel | - | C10 (619.3, 15.8, -1.0) |
| P20 | S07 | S19 | (600.0, 28.0, 280.0) | 14.0 x 8.0 | tunnel | - | C12 (599.3, 27.8, 281.0) |
| P21 | S19 | S08 | (420.0, 28.0, 280.0) | 14.0 x 8.0 | catwalk | - | C14 (419.3, 27.8, 281.0) |
| P22 | S12 | S20 | (200.0, 28.0, 430.0) | 14.0 x 8.0 | catwalk | - | C19 (199.3, 27.8, 431.0) |
| P23 | S20 | S13 | (220.0, 28.0, 470.0) | 14.0 x 8.0 | catwalk | - | C21 (219.0, 27.8, 469.3) |

区画グラフ上の最少通過区画数: 16 (S01 → S02 → S03 → S04 → S05 → S06 → S07 → S08 → S09 → S10 → S11 → S12 → S13 → S14 → S15 → S16)

## 4. 隔壁と制御砲台

| 隔壁 | ラベル | 制御砲台 | 砲台の区画 | 砲台位置 | 隔壁位置 | 最短経路上の通過位置 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 圧延棟東の隔壁(搬送縦坑へ) | T03 | S03 | (322.0, 7.6, 12.0) | (330.0, 4.0, 100.0) | 424.5 m (328.0, 6.5, 93.8) |
| B2 | 検査棟南の隔壁(配管区画へ) | T07 | S06 | (632.0, 21.6, 30.0) | (620.0, 28.0, 140.0) | 789.6 m (613.8, 27.0, 138.0) |
| B3 | 動力棟西の隔壁(冷却設備へ) | T08 | S08 | (440.0, 7.6, 240.0) | (390.0, 4.0, 156.0) | 1113.9 m (392.0, 6.3, 162.1) |
| B4 | 地下搬送区画南の隔壁(主製造ホールへ) | T11 | S11 | (196.0, -4.4, 146.0) | (92.0, 4.0, 280.0) | 1484.4 m (98.2, 5.6, 278.0) |
| B5 | 出荷倉庫東の隔壁(外周搬送路へ) | T14 | S13 | (338.0, 7.6, 420.0) | (350.0, 4.0, 352.0) | 1760.0 m (348.0, 6.5, 357.5) |
| B6 | 外周搬送路東の隔壁(搬出ゲートへ) | T15 | S14 | (470.0, 9.6, 350.0) | (500.0, 16.0, 474.0) | 1947.5 m (498.0, 17.3, 467.8) |
| GATE | 最終搬出ゲート | (6体全破壊) | - | - | (640.0, 28.0, 352.0) | 2127.3 m (638.0, 26.7, 358.2) |

閉鎖状態の到達性(単独閉鎖: 他の隔壁は全て開放):

| 状態 | 脱出領域へ到達 | 到達できる区画 |
| --- | --- | --- |
| B1のみ閉鎖(他は開放) | 到達不能 | S01, S02, S03, S17 |
| B2のみ閉鎖(他は開放) | 到達不能 | S01, S02, S03, S04, S05, S06, S17, S18 |
| B3のみ閉鎖(他は開放) | 到達不能 | S01, S02, S03, S04, S05, S06, S07, S08, S17, S18, S19 |
| B4のみ閉鎖(他は開放) | 到達不能 | S01, S02, S03, S04, S05, S06, S07, S08, S09, S10, S11, S17, S18, S19 |
| B5のみ閉鎖(他は開放) | 到達不能 | S01, S02, S03, S04, S05, S06, S07, S08, S09, S10, S11, S12, S13, S17, S18, S19, S20 |
| B6のみ閉鎖(他は開放) | 到達不能 | S01, S02, S03, S04, S05, S06, S07, S08, S09, S10, S11, S12, S13, S14, S17, S18, S19, S20 |
| GATEのみ閉鎖(他は開放) | 到達不能 | S01, S02, S03, S04, S05, S06, S07, S08, S09, S10, S11, S12, S13, S14, S15, S17, S18, S19, S20 |
| 全隔壁を閉鎖 | 到達不能 | S01, S02, S03, S17 |

## 5. 敵配置表

| ID | 種別 | HP | 区画 | 位置(当たり判定中心) | 制御砲台 | 隔壁 | 配置検査 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G01 | 警備ロボット | 120 | S01 | (58.0, 1.5, 76.0) | - | - | OK |
| G02 | 警備ロボット | 120 | S01 | (26.0, 1.5, 100.0) | - | - | OK |
| G03 | 警備ロボット | 120 | S02 | (126.0, 1.5, 112.0) | - | - | OK |
| G04 | 警備ロボット | 120 | S02 | (168.0, 1.5, 40.0) | - | - | OK |
| G05 | 警備ロボット | 120 | S02 | (108.0, 1.5, 24.0) | - | - | OK |
| G06 | 警備ロボット | 120 | S02 | (164.0, 1.5, 122.0) | - | - | OK |
| G07 | 警備ロボット | 120 | S03 | (250.0, 1.5, 108.0) | - | - | OK |
| G08 | 警備ロボット | 120 | S03 | (276.0, 1.5, 24.0) | - | - | OK |
| G09 | 警備ロボット | 120 | S03 | (230.0, 1.5, 60.0) | - | - | OK |
| G10 | 警備ロボット | 120 | S05 | (438.0, 13.5, 112.0) | - | - | OK |
| G11 | 警備ロボット | 120 | S05 | (480.0, 13.5, 62.0) | - | - | OK |
| G12 | 警備ロボット | 120 | S05 | (512.0, 13.5, 44.0) | - | - | OK |
| G13 | 警備ロボット | 120 | S05 | (462.0, 13.5, 17.0) | - | - | OK |
| G14 | 警備ロボット | 120 | S06 | (556.0, 13.5, 108.0) | - | - | OK |
| G15 | 警備ロボット | 120 | S06 | (600.0, 13.5, 44.0) | - | - | OK |
| G16 | 警備ロボット | 120 | S07 | (590.0, 25.5, 200.0) | - | - | OK |
| G17 | 警備ロボット | 120 | S08 | (404.0, 1.5, 196.0) | - | - | OK |
| G18 | 警備ロボット | 120 | S08 | (462.0, 1.5, 152.0) | - | - | OK |
| G19 | 警備ロボット | 120 | S08 | (508.0, 1.5, 208.0) | - | - | OK |
| G20 | 警備ロボット | 120 | S09 | (330.0, 1.5, 182.0) | - | - | OK |
| G21 | 警備ロボット | 120 | S09 | (304.0, 1.5, 214.0) | - | - | OK |
| G22 | 警備ロボット | 120 | S11 | (122.0, -12.5, 186.0) | - | - | OK |
| G23 | 警備ロボット | 120 | S11 | (178.0, -12.5, 246.0) | - | - | OK |
| G24 | 警備ロボット | 120 | S12 | (28.0, 1.5, 378.0) | - | - | OK |
| G25 | 警備ロボット | 120 | S12 | (113.0, 1.5, 340.0) | - | - | OK |
| G26 | 警備ロボット | 120 | S12 | (132.6, 13.5, 326.0) | - | - | OK |
| G27 | 警備ロボット | 120 | S12 | (198.0, 25.5, 408.0) | - | - | OK |
| G28 | 警備ロボット | 120 | S13 | (250.2, 25.5, 406.0) | - | - | OK |
| G29 | 警備ロボット | 120 | S13 | (267.0, 1.5, 418.0) | - | - | OK |
| G30 | 警備ロボット | 120 | S13 | (303.0, 1.5, 440.0) | - | - | OK |
| T01 | 固定砲台 | 240 | S02 | (180.0, 9.6, 8.0) | - | - | OK |
| T02 | 固定砲台 | 240 | S02 | (188.0, 9.1, 130.0) | - | - | OK |
| T03 | 固定砲台 | 240 | S03 | (322.0, 7.6, 12.0) | 制御#1 | B1 | OK |
| T04 | 固定砲台 | 240 | S03 | (208.0, 6.6, 132.0) | - | - | OK |
| T05 | 固定砲台 | 240 | S05 | (474.0, 19.6, 6.0) | - | - | OK |
| T06 | 固定砲台 | 240 | S05 | (516.0, 19.6, 134.0) | - | - | OK |
| T07 | 固定砲台 | 240 | S06 | (632.0, 21.6, 30.0) | 制御#2 | B2 | OK |
| T08 | 固定砲台 | 240 | S08 | (440.0, 7.6, 240.0) | 制御#3 | B3 | OK |
| T09 | 固定砲台 | 240 | S08 | (516.0, 7.6, 145.0) | - | - | OK |
| T10 | 固定砲台 | 240 | S09 | (368.0, 19.6, 258.0) | - | - | OK |
| T11 | 固定砲台 | 240 | S11 | (196.0, -4.4, 146.0) | 制御#4 | B4 | OK |
| T12 | 固定砲台 | 240 | S12 | (30.0, 9.6, 288.0) | - | - | OK |
| T13 | 固定砲台 | 240 | S12 | (182.0, 29.6, 366.0) | - | - | OK |
| T14 | 固定砲台 | 240 | S13 | (338.0, 7.6, 420.0) | 制御#5 | B5 | OK |
| T15 | 固定砲台 | 240 | S14 | (470.0, 9.6, 350.0) | 制御#6 | B6 | OK |

## 6. 経路座標

スタート (12.0, 1.5, 14.0) → 脱出領域 min (660.0, 24.0, 344.0) / max (716.0, 38.0, 488.0)

### 6.1 検証器が求めた最短経路(プレイヤー中心座標)

長さ 2149.3 m (格子A*の生の長さ 2310.9 m、始点-終点の直線距離 727.5 m、プレイヤーを 0.4 m 細くした楽観推定 2141.0 m、格子 2.00 m)

区画への進入(経路の中心が最初にその区画のboundsに入った位置):

| 順 | 区画 | 経路長(m) |
| --- | --- | --- |
| 1 | S01 | 0.0 |
| 2 | S02 | 121.5 |
| 3 | S03 | 279.5 |
| 4 | S04 | 426.5 |
| 5 | S05 | 487.5 |
| 6 | S06 | 644.0 |
| 7 | S07 | 792.0 |
| 8 | S08 | 943.0 |
| 9 | S09 | 1116.0 |
| 10 | S10 | 1277.0 |
| 11 | S11 | 1355.0 |
| 12 | S12 | 1486.5 |
| 13 | S13 | 1630.0 |
| 14 | S14 | 1762.5 |
| 15 | S15 | 1949.5 |
| 16 | S16 | 2129.5 |

| # | 座標 | 前点からの距離 | 累積(m) |
| --- | --- | --- | --- |
| 0 | (12.00, 1.50, 14.00) | 0.00 | 0.00 |
| 1 | (21.18, 2.72, 50.82) | 37.97 | 37.97 |
| 2 | (32.82, 3.22, 55.18) | 12.44 | 50.41 |
| 3 | (67.18, 5.75, 113.82) | 68.01 | 118.42 |
| 4 | (72.82, 5.99, 113.82) | 5.65 | 124.07 |
| 5 | (136.96, 6.00, 66.21) | 79.88 | 203.95 |
| 6 | (196.06, 6.00, 26.18) | 71.38 | 275.33 |
| 7 | (202.82, 6.00, 26.18) | 6.76 | 282.09 |
| 8 | (327.18, 6.48, 93.82) | 141.56 | 423.66 |
| 9 | (332.82, 6.50, 93.86) | 5.64 | 429.30 |
| 10 | (359.18, 13.50, 94.07) | 27.27 | 456.57 |
| 11 | (392.82, 14.00, 93.82) | 33.65 | 490.22 |
| 12 | (527.18, 16.80, 26.18) | 150.45 | 640.67 |
| 13 | (532.82, 17.67, 26.18) | 5.71 | 646.38 |
| 14 | (571.14, 26.63, 70.92) | 59.58 | 705.96 |
| 15 | (606.81, 26.72, 107.17) | 50.86 | 756.82 |
| 16 | (606.82, 26.68, 107.18) | 0.04 | 756.86 |
| 17 | (613.82, 26.76, 119.18) | 13.89 | 770.75 |
| 18 | (613.82, 27.00, 142.82) | 23.64 | 794.40 |
| 19 | (600.82, 27.00, 184.82) | 43.97 | 838.36 |
| 20 | (569.28, 27.00, 213.04) | 42.32 | 880.68 |
| 21 | (532.82, 27.00, 259.82) | 59.31 | 940.00 |
| 22 | (527.18, 26.90, 259.82) | 5.64 | 945.64 |
| 23 | (520.94, 26.70, 255.18) | 7.78 | 953.41 |
| 24 | (393.16, 6.27, 162.19) | 159.35 | 1112.76 |
| 25 | (373.27, 6.04, 161.33) | 19.92 | 1132.68 |
| 26 | (286.00, 14.80, 248.02) | 123.32 | 1256.00 |
| 27 | (272.82, 14.90, 259.82) | 17.69 | 1273.69 |
| 28 | (267.18, 14.53, 259.82) | 5.65 | 1279.34 |
| 29 | (254.80, 13.50, 249.18) | 16.36 | 1295.70 |
| 30 | (210.97, -8.59, 218.71) | 57.77 | 1353.47 |
| 31 | (121.91, 2.62, 252.94) | 96.07 | 1449.54 |
| 32 | (102.18, 4.90, 273.07) | 28.28 | 1477.82 |
| 33 | (98.18, 5.54, 277.18) | 5.77 | 1483.59 |
| 34 | (98.18, 6.00, 282.82) | 5.66 | 1489.25 |
| 35 | (179.85, 25.50, 325.18) | 94.04 | 1583.29 |
| 36 | (217.18, 25.50, 347.82) | 43.66 | 1626.96 |
| 37 | (252.82, 25.50, 350.17) | 35.72 | 1662.67 |
| 38 | (347.18, 6.50, 357.44) | 96.53 | 1759.20 |
| 39 | (352.82, 6.50, 357.87) | 5.66 | 1764.86 |
| 40 | (497.18, 17.20, 467.82) | 181.78 | 1946.64 |
| 41 | (502.82, 17.53, 467.82) | 5.65 | 1952.29 |
| 42 | (552.82, 20.79, 434.82) | 60.00 | 2012.29 |
| 43 | (576.82, 22.50, 413.23) | 32.33 | 2044.61 |
| 44 | (607.01, 26.15, 385.94) | 40.85 | 2085.47 |
| 45 | (637.18, 26.67, 358.18) | 41.01 | 2126.47 |
| 46 | (660.01, 26.67, 358.18) | 22.83 | 2149.30 |

### 6.2 ステージ定義に記載された経路(mainRoute)

スタートから脱出領域までの最短の実行可能経路(全隔壁開放・飛行可)。tools/route-probe.ts --emit の出力 — 45 点

| # | 座標 |
| --- | --- |
| 0 | (12.00, 1.50, 14.00) |
| 1 | (20.00, 1.50, 52.00) |
| 2 | (34.00, 1.50, 54.00) |
| 3 | (56.00, 1.50, 88.00) |
| 4 | (66.00, 3.50, 114.00) |
| 5 | (78.00, 3.50, 114.00) |
| 6 | (196.00, 5.50, 26.00) |
| 7 | (258.00, 5.50, 26.00) |
| 8 | (326.00, 5.50, 94.00) |
| 9 | (354.00, 9.50, 94.00) |
| 10 | (358.00, 13.50, 94.00) |
| 11 | (458.00, 13.50, 94.00) |
| 12 | (526.00, 17.50, 26.00) |
| 13 | (534.00, 17.50, 26.00) |
| 14 | (588.00, 25.50, 110.00) |
| 15 | (614.00, 25.50, 136.00) |
| 16 | (614.00, 25.50, 174.00) |
| 17 | (568.00, 25.50, 214.00) |
| 18 | (534.00, 25.50, 260.00) |
| 19 | (492.00, 25.50, 260.00) |
| 20 | (414.00, 25.50, 182.00) |
| 21 | (394.00, 5.50, 162.00) |
| 22 | (386.00, 5.50, 162.00) |
| 23 | (300.00, 13.50, 234.00) |
| 24 | (274.00, 13.50, 260.00) |
| 25 | (266.00, 13.50, 260.00) |
| 26 | (248.00, 13.50, 242.00) |
| 27 | (238.00, 5.50, 234.00) |
| 28 | (214.00, -8.50, 220.00) |
| 29 | (154.00, -8.50, 220.00) |
| 30 | (132.00, 1.50, 242.00) |
| 31 | (98.00, 1.50, 276.00) |
| 32 | (98.00, 1.50, 284.00) |
| 33 | (166.00, 13.50, 298.00) |
| 34 | (192.00, 25.50, 324.00) |
| 35 | (216.00, 25.50, 348.00) |
| 36 | (326.00, 25.50, 348.00) |
| 37 | (348.00, 5.50, 358.00) |
| 38 | (386.00, 5.50, 358.00) |
| 39 | (466.00, 13.50, 438.00) |
| 40 | (496.00, 13.50, 468.00) |
| 41 | (526.00, 13.50, 468.00) |
| 42 | (602.00, 25.50, 392.00) |
| 43 | (636.00, 25.50, 358.00) |
| 44 | (660.00, 25.50, 358.00) |

## 7. 分岐と環状経路

実際の自由空間から検出した独立な閉路(2つの経路がそれぞれ 40 m 以上):

| 区画 | 開口 | 周長(m) | 2経路の長さ(m) |
| --- | --- | --- | --- |
| S12 → S13 → S20 | C18, C21, C19 | 244 | 118 / 125 |
| S02 → S03 → S17 | C02, C05, C03 | 332 | 161 / 172 |
| S07 → S08 → S19 | C11, C14, C12 | 384 | 198 / 186 |
| S05 → S06 → S18 | C07, C10, C08 | 429 | 211 / 219 |

宣言された分岐(stage.branches):

| 分岐 | 分岐→合流 | 独立経路数(実グラフ) | 経路 | 判定 |
| --- | --- | --- | --- | --- |
| BR1 | S02 → S03 | 2 | BR1-direct: 240.7 m [S02>S03] / BR1-tunnel: 351.2 m [S02>S17>S03] | OK |
| BR2 | S05 → S06 | 2 | BR2-direct: 209.1 m [S05>S06] / BR2-attic: 392.5 m [S05>S18>S06] | OK |
| BR3 | S07 → S08 | 2 | BR3-direct: 208.6 m [S07>S08] / BR3-duct: 408.0 m [S07>S19>S08] | OK |
| BR4 | S12 → S13 | 2 | BR4-direct: 65.0 m [S12>S13] / BR4-warehouse: 200.8 m [S12>S20>S13] | OK |

宣言された環状経路(stage.loops):

| ID | 長さ(m) | 区画 | 判定 |
| --- | --- | --- | --- |
| LOOP-BR1 | 591.8 | S02>S03>S17 | OK |
| LOOP-BR2 | 601.6 | S05>S06>S18 | OK |
| LOOP-BR3 | 616.6 | S07>S08>S19 | OK |
| LOOP-BR4 | 265.8 | S12>S13>S20 | OK |

## 8. 飛行昇降

| ID | 区画 | 下の足場(from) | 上の足場(to) | 高低差(m) | ジャンプ最大上昇(m) | 最短経路との距離 | 18構成の成功 | 成功した制御 | EN消費(18構成の最小〜最大) | 飛行時間(s) | 所要時間(s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | S04 | (352.0, 0.0, 100.0) | (366.0, 12.0, 100.0) | 12.0 | 2.79 | 6.0 m | 18/18 | vertical | 28.0〜28.0 | 1.40〜1.41 | 2.59〜3.61 |
| C2 | S06 | (584.0, 12.0, 96.0) | (594.0, 24.0, 106.0) | 12.0 | 2.79 | 8.4 m | 18/18 | vertical | 28.0〜28.0 | 1.40〜1.41 | 2.59〜3.61 |
| C3 | S09 | (304.0, 0.0, 228.0) | (300.0, 12.0, 242.0) | 12.0 | 2.79 | 4.9 m | 18/18 | vertical | 28.0〜28.0 | 1.40〜1.41 | 2.59〜3.61 |
| C4 | S11 | (138.0, -14.0, 256.0) | (122.0, 0.0, 256.0) | 14.0 | 2.79 | 2.6 m | 18/18 | vertical | 33.0〜33.0 | 1.65〜1.66 | 2.84〜3.86 |
| C5 | S12 | (160.0, 0.0, 292.0) | (160.0, 12.0, 306.0) | 12.0 | 2.79 | 10.1 m | 18/18 | vertical | 28.0〜28.0 | 1.40〜1.41 | 2.59〜3.61 |
| C6 | S12 | (168.0, 12.0, 322.0) | (188.0, 24.0, 332.0) | 12.0 | 2.79 | 1.6 m | 18/18 | vertical | 28.0〜28.0 | 1.41〜1.41 | 3.61〜3.61 |
| C7 | S14 | (452.0, 0.0, 434.0) | (466.0, 12.0, 448.0) | 12.0 | 2.79 | 3.5 m | 18/18 | vertical | 28.0〜28.0 | 1.41〜1.41 | 3.61〜3.61 |
| C8 | S15 | (590.0, 12.0, 396.0) | (604.0, 24.0, 382.0) | 12.0 | 2.79 | 5.0 m | 18/18 | vertical | 28.0〜28.0 | 1.41〜1.41 | 3.61〜3.61 |

<details><summary>構成別の結果(実際のGame物理: Space長押し飛行 + 水平移動 + 解放で着地)</summary>

| 昇降 | FCS | ジェネレーター | 脚部 | 成否 | 制御 | EN開始→最小 | EN消費 | 飛行(s) | 所要(s) | 失敗理由 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | wide | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C1 | wide | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C1 | wide | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C1 | wide | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C1 | wide | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C1 | wide | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C1 | medium | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C1 | medium | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C1 | medium | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C1 | medium | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C1 | medium | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C1 | medium | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C1 | narrow | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C1 | narrow | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C1 | narrow | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C1 | narrow | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C1 | narrow | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C1 | narrow | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C2 | wide | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C2 | wide | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C2 | wide | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C2 | wide | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C2 | wide | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C2 | wide | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C2 | medium | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C2 | medium | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C2 | medium | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C2 | medium | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C2 | medium | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C2 | medium | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C2 | narrow | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C2 | narrow | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C2 | narrow | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C2 | narrow | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C2 | narrow | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C2 | narrow | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C3 | wide | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C3 | wide | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C3 | wide | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C3 | wide | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C3 | wide | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C3 | wide | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C3 | medium | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C3 | medium | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C3 | medium | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C3 | medium | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C3 | medium | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C3 | medium | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C3 | narrow | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C3 | narrow | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C3 | narrow | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C3 | narrow | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C3 | narrow | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C3 | narrow | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C4 | wide | capacity | biped | OK | vertical | 180→147.0 | 33.0 | 1.65 | 2.84 |  |
| C4 | wide | capacity | quadruped | OK | vertical | 180→147.0 | 33.0 | 1.66 | 3.86 |  |
| C4 | wide | balanced | biped | OK | vertical | 120→87.0 | 33.0 | 1.65 | 2.84 |  |
| C4 | wide | balanced | quadruped | OK | vertical | 120→87.0 | 33.0 | 1.66 | 3.86 |  |
| C4 | wide | recovery | biped | OK | vertical | 90→57.0 | 33.0 | 1.65 | 2.84 |  |
| C4 | wide | recovery | quadruped | OK | vertical | 90→57.0 | 33.0 | 1.66 | 3.86 |  |
| C4 | medium | capacity | biped | OK | vertical | 180→147.0 | 33.0 | 1.65 | 2.84 |  |
| C4 | medium | capacity | quadruped | OK | vertical | 180→147.0 | 33.0 | 1.66 | 3.86 |  |
| C4 | medium | balanced | biped | OK | vertical | 120→87.0 | 33.0 | 1.65 | 2.84 |  |
| C4 | medium | balanced | quadruped | OK | vertical | 120→87.0 | 33.0 | 1.66 | 3.86 |  |
| C4 | medium | recovery | biped | OK | vertical | 90→57.0 | 33.0 | 1.65 | 2.84 |  |
| C4 | medium | recovery | quadruped | OK | vertical | 90→57.0 | 33.0 | 1.66 | 3.86 |  |
| C4 | narrow | capacity | biped | OK | vertical | 180→147.0 | 33.0 | 1.65 | 2.84 |  |
| C4 | narrow | capacity | quadruped | OK | vertical | 180→147.0 | 33.0 | 1.66 | 3.86 |  |
| C4 | narrow | balanced | biped | OK | vertical | 120→87.0 | 33.0 | 1.65 | 2.84 |  |
| C4 | narrow | balanced | quadruped | OK | vertical | 120→87.0 | 33.0 | 1.66 | 3.86 |  |
| C4 | narrow | recovery | biped | OK | vertical | 90→57.0 | 33.0 | 1.65 | 2.84 |  |
| C4 | narrow | recovery | quadruped | OK | vertical | 90→57.0 | 33.0 | 1.66 | 3.86 |  |
| C5 | wide | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C5 | wide | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C5 | wide | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C5 | wide | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C5 | wide | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C5 | wide | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C5 | medium | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C5 | medium | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C5 | medium | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C5 | medium | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C5 | medium | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C5 | medium | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C5 | narrow | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.40 | 2.59 |  |
| C5 | narrow | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C5 | narrow | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.40 | 2.59 |  |
| C5 | narrow | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C5 | narrow | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.40 | 2.59 |  |
| C5 | narrow | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | wide | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | wide | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | wide | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | wide | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | wide | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | wide | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | medium | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | medium | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | medium | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | medium | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | medium | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | medium | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | narrow | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | narrow | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | narrow | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | narrow | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | narrow | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C6 | narrow | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | wide | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | wide | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | wide | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | wide | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | wide | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | wide | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | medium | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | medium | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | medium | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | medium | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | medium | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | medium | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | narrow | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | narrow | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | narrow | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | narrow | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | narrow | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C7 | narrow | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | wide | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | wide | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | wide | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | wide | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | wide | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | wide | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | medium | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | medium | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | medium | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | medium | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | medium | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | medium | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | narrow | capacity | biped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | narrow | capacity | quadruped | OK | vertical | 180→152.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | narrow | balanced | biped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | narrow | balanced | quadruped | OK | vertical | 120→92.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | narrow | recovery | biped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |
| C8 | narrow | recovery | quadruped | OK | vertical | 90→62.0 | 28.0 | 1.41 | 3.61 |  |

</details>

## 9. 検証手法と限界

- 最短経路: プレイヤーAABB(1.6×3.0×1.6、側方に 2 cm の余裕)の中心が通れる3D格子(設定値 `gridStep`、既定 2 m と 1.5 倍粗い格子の2回)上でA*を行い、経路の全辺を厳密な連続衝突 `sweepAABB` で再検証(失敗辺は禁止して再探索)、
  さらに見通し判定つきのtaut-string平滑化(最も近い箱の辺に沿った折れ点挿入を含む)で短縮し、短い方を採用する。報告値は実行可能な経路の長さなので **真の最短長の上界** であり、格子・平滑化の局所解により真値より数%長く出ることがある
  (解析解の分かる合成ステージでは 0.5 % 以内に収まることをテストしている)。逆向きの見積もりとして、プレイヤーを 0.4 m 細くした楽観推定を併記する。
- 飛行はEN無視・どこでも自由に飛べる最も緩い条件で経路を求めている(EN予算は昇降ボットの実測で別に確認)。
- 抜け道検査: 各隔壁を単独で閉じた状態(他は開放)で脱出領域へ到達できないこと、全閉鎖状態で最初の隔壁より先の区画へ到達できないことを、格子の連結成分(6近傍)で判定し、到達すると出た場合はsweep検証済み経路で確認する。
  格子より狭い(自由空間の幅が格子間隔未満の)隙間は格子では見つからないため、隔壁が開口を塞いでいることは別にportalの開口全面をプレイヤー箱でレーン掃引して確認している。
- 区画グラフ: 区画境界をまたいで隣り合う自由格子点の対をsweepで再検証し、近い対をクラスタ化して1開口とする(多重辺を区別できる)。閉路は多重グラフ上で列挙し、閉路の周長を区画内の実最短経路(区画内に限定したA*)で測る。
- 昇降ボット: 本物の `Game`(player物理)にステージ自身の箱を渡し、下の足場からSpace長押し飛行 + 水平移動 + 解放で上の足場に着地できるかを全18構成で実行する(QBは使わない)。制御則は単純なもの(垂直優先/斜め同時の2方式)で、失敗した場合は人間なら成功する可能性がある。
- 「広い戦闘空間」は区画の主床(`floorY`)上で高さ 3 m までに障害物(箱)が無い 1 m 格子セルから最大の軸並行な空き矩形を求めて判定する。
- 未確認/範囲外: 敵AIの経路探索(nav)がその区画を歩いて移動できるかは検証していない。人間のプレイテストによる所要時間(10〜20分)の確認もしていない。

### 計測時間(ms)

| 処理 | ms |
| --- | --- |
| sectors | 1 |
| enemies | 119 |
| grid | 29 |
| route | 4870 |
| route.checks | 3 |
| flood | 42 |
| connections | 181 |
| reachability | 494 |
| shell | 127 |
| hops | 0 |
| topology | 685 |
| declared | 65 |
| portals | 137 |
| arenas | 130 |
| start | 4 |
| climbs | 388 |
| barrierStates | 749 |
| relaxedRoute | 2024 |
