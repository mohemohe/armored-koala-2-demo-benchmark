# Facility stage definition

The authoritative definition is `src/stage.js`; coordinates are metres, +Z points toward extraction. Sixteen bounded rooms span x = −40…40. Room `Snn` spans z = 110(n−1)…110n. Rooms are connected in numerical order by the 22 m wide portals at x = −11…11, z = 110n. Each has an actual floor, roof, perimeter walls and cross walls. Start is (0, 0, 8); the extraction region is behind the final gate at z = 1730, near (0, 48, 1750).

| Sector | Name | Floor Y | Portal / changes |
|---|---|---:|---|
| S01 | 搬入口 | 0 | Starting cover |
| S02 | 資材ヤード | 0 | T02 opens B01; rise 8 m |
| S03 | 圧延棟 | 8 | Press equipment |
| S04 | 搬送縦坑 | 8 | T04 opens B02; rise 8 m |
| S05 | 組立ライン | 16 | Assembly equipment |
| S06 | 検査棟 | 16 | T06 opens B03; rise 8 m |
| S07 | 保守配管区画 | 24 | Pipes |
| S08 | 動力棟 | 24 | T08 opens B04; rise 8 m |
| S09 | 冷却設備 | 32 | Press equipment |
| S10 | 排気縦坑 | 32 | T10 opens B05; rise 8 m |
| S11 | 地下搬送区画 | 40 | Assembly equipment |
| S12 | 主製造ホール | 40 | T12 opens B06; rise 8 m |
| S13 | 出荷倉庫 | 48 | Cargo cover |
| S14 | 外周搬送路 | 48 | Rack cover |
| S15 | 積載場 | 48 | Press equipment |
| S16 | 搬出ゲート | 48 | FINAL gate at z=1730 |

The route is continuous: the difference between start and exit along Z alone is 1742 m. The raised floors are solid to their tops, forcing 8 m climbs at each of the six listed transitions; every transition has floor on both sides. Roofs and perimeter/cross walls prevent going over or around the stage. A 20 m × 50 m central obstruction in S04, S10 and S16 divides each room into two routes which rejoin at the far end. Side plinths provide different pieces of cover. The resulting loops and travel times have not yet been playtested. Different equipment arrangements repeat in a six-sector pattern; the varied heights, partitions, enemies and objectives change the encounters.

For zero-based sector index `i = 0…14`, the initial guards are `G(2i+1)` at `(−29, floorY+2, 110i+31)` and `G(2i+2)` at `(29, floorY+2, 110i+81)`. The turret `T(i+1)` is `(x, floorY+2, 110i+87)`, where x = 0 for the six control turrets and otherwise x = −25 for even i or +25 for odd i. IDs are zero-padded to two digits. Seven exceptions redistribute `G02`, `G06`, `G10`, `G14`, `G18`, `G22`, and `G26` from S01, S03, S05, S07, S09, S11, and S13 into S02, S04, S06, S08, S10, S12, and S14, respectively; each moves to `(−30, floorY+2, 110i+60)` in its destination. Those seven destination rooms therefore contain four enemies each. These are hit-center positions. Every enemy is on the traversable side of the exterior shell. Destroying all control turrets opens FINAL.

These coordinates document the constructed geometry; they are not a substitute for measuring all loadouts, collision and shortest routes in the integrated game.
