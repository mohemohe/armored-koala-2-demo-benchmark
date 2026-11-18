# ARMORED KOALA 2 (AK2) — DEMO

A third-person, high-speed mecha action prototype built with **Three.js** and **TypeScript**.
You pilot a koala-headed battle mech through a decommissioned factory, break six
control turrets to open the blast barriers and reach the evacuation zone.

The project is a complete, playable game: real FCS (fire control) maths, real ballistic
projectiles, real collision, a 34-zone factory, 45 hostiles and a six-stage objective
chain.

---

## 1. Running it

```bash
npm ci                 # install the pinned dependencies (package-lock.json is included)
npm run build          # type-check (tsc --noEmit) + production bundle into dist/
npm run dev -- --host 0.0.0.0 --port 5173
```

Open `http://<host>:5173/` in a desktop browser (Chromium / Firefox / Edge, 1280×720 or
larger, keyboard + mouse). `npm run preview` serves the built bundle.

Optional query parameters:

| parameter | meaning |
| --- | --- |
| `?seed=<uint32>` | seeds the gameplay RNG (default `20260908`) |
| `?test=exposure` | developer scenario: stationary player, two guards + one turret in the open yard |
| `?test=barrier` | developer scenario: player facing the first control turret in the rolling mill |
| `?test=clear` | developer scenario: the six control turrets in front of the evacuation trigger |

The `?test=` scenarios only reposition actors for automated verification; they never change
any weapon, damage, collision or objective rule.

Nothing is downloaded at runtime: every texture, mesh and sound cue is generated from
code in this repository. No external CDN, image, model or audio file is referenced.

---

## 2. Controls

| input | action |
| --- | --- |
| `W` `A` `S` `D` | camera-relative movement (10 m/s, diagonals are not faster) |
| mouse | TPS camera / aim |
| `Space` | jump while grounded (10 m/s) — **hold 0.20 s** to fly (16 m/s horizontal, 8 m/s climb, 20 EN/s) |
| `Shift` | toggle the glide manually — **0 EN**, keeps running after release |
| `Ctrl` (left) | brake: cancels the glide and decelerates to a standstill |
| `Q` | **quick boost**: one shot, 36 EN paid at once, 0.15 s burn, then an automatic glide |
| left mouse | fire (hold for automatic fire) |
| `1` `2` `3` | machinegun / beam / hand missile (switching never resets ammo, EN or cooldowns) |
| `Esc` | pause (releases the pointer lock and clears the input state) |

**Aim assist is fully automatic.** Keep the enemy hit-box inside the central FCS circle and
the fire control system compensates both the lead angle and the bullet drop; the crosshair
never has to be placed on the corrected marker by hand. The corrected marker (cyan diamond)
and the target marker (red square) are drawn separately so the difference is visible.

---

## 3. The mech

A 3 m tall koala-headed battle mech: rounded head with two large round ears, a black nose
and glowing eyes, armoured torso, shoulder pods and a missile rack. The garage shows the
machine from the front (rotating slowly) so the head can be inspected before the sortie.

18 load-out combinations (3 FCS × 3 generators × 2 leg sets) are all usable. The leg choice
changes the real model: the biped has two animated legs, the quadruped has four.

| FCS | lock circle radius | lock time (2 legs) |
| --- | --- | --- |
| Wide | 0.30 × min(viewport) | 1.20 s |
| Medium | 0.20 × min(viewport) | 0.80 s |
| Narrow | 0.10 × min(viewport) | 0.40 s |

| generator | max EN | recharge |
| --- | --- | --- |
| High capacity | 180 | 10 EN/s |
| Balanced | 120 | 15 EN/s |
| High recovery | 90 | 20 EN/s |

| legs | move speed | EN recharge | lock speed |
| --- | --- | --- | --- |
| Biped | ×1.00 | ×1.00 | ×1.00 |
| Quadruped | ×0.80 | ×0.75 | ×1.50 (lock time ÷ 1.5) |

Effective values are shown in the hangar (max EN, recharge rate, lock time, walk speed,
glide speed, air speed, FCS radius).

---

## 4. Weapons

| weapon | damage | interval | ammo | EN | gravity | lock |
| --- | ---: | ---: | --- | ---: | --- | --- |
| Machinegun | 12 | 0.10 s | 300 rounds | 0 | −18 m/s² | optional (free fire without a lock) |
| Beam | 40 | 0.25 s | unlimited | 8 | – | optional (free fire without a lock) |
| Hand missile | 180 | 1.00 s | 12 rounds | 0 | – | **required** |

* The machinegun is a world-space projectile with an initial speed of 100 m/s. While locked
  the FCS solves the lead **and** the gravity compensation, so the launch direction is
  tilted upward and the flight time changes with it.
* The beam is an instant 120 m line test that always strikes the target's **current**
  position; it never leads and never compensates gravity.
* The hand missile is launched along its own 45 m/s lead solution and then turns towards
  the target at a maximum of 120°/s while it keeps its 45 m/s speed.

Damage is never reduced by armour; a hit subtracts from the target's HP directly.
There is no HP regeneration, no ammo resupply and no EN pickup.

---

## 5. The factory

One continuous decommissioned plant, **34 zones** on three height tiers (y = 0, 12, 24)
plus ten vertical transfer shafts. The mandatory route crosses **24 zones** and the
shortest executable route between the spawn point and the evacuation trigger is
**≈ 1 678 m** (lower bound, computed from the door-to-door geometry, see
`scripts/stage-check.ts`).

* 6 different spatial archetypes: dock / yard, manufacturing halls, upper catwalk tiers,
  narrow service corridors, vertical shafts and warehouses.
* 15 rooms with at least 60 m × 50 m of clear combat space (the yard, the rolling mill,
  the assembly line, the conveyor section, the piping section, the shipping warehouse, the
  second dock, the gantry, the power house, the cooling plant, the main hall, the
  evacuation apron, …).
* 4 branch / ring structures (`sluice_a-b-c`, `spur_d-e`, `duct_s-x2-n2`, `spur_k`) that
  give genuine alternatives — none of them skips a vertical transition, so the six
  flight ascents are unavoidable.
* 6 flight-required ascents (12 m each — a jump only reaches 2.78 m) and 4 descents, all
  inside the transfer shafts; every shaft has a landing platform above and below so the
  energy can be recovered.

See section 9 for the full zone / door / enemy tables.

---

## 6. Objectives

Six **control turrets** (out of the fifteen fixed turrets) are spread over six different
sectors, from the rolling mill to the second loading dock. Each one seals a barrier door
on the mandatory route:

| barrier | door | control turret | sector |
| --- | --- | --- | --- |
| BR1 | `towerA` ↔ `assembly` | E-TUR-01 | `mill` |
| BR2 | `towerB` ↔ `gantry` | E-TUR-03 | `inspect` |
| BR3 | `towerC` ↔ `conveyor` | E-TUR-06 | `towerC` (upper level) |
| BR4 | `mainhall` ↔ `towerG` | E-TUR-09 | `mainhall` |
| BR5 | `shipping` ↔ `towerH` | E-TUR-07 | `shipping` |
| BR6 | `towerJ` ↔ `exitgate` | E-TUR-08 | `dock2` |

Destroying all six opens the final evacuation gate; reaching the evacuation zone clears the
sortie. The remaining 39 hostiles do **not** have to be destroyed. Losing all HP or falling
out of the plant fails the sortie (failure is checked before the clear condition inside the
same update).

---

## 7. Hostiles

30 security robots (120 HP) and 15 fixed turrets (240 HP). Every hostile has its own
attack timer, its own sight line and its own burst counter; nothing limits how many of them
may fire at the same time.

| | security robot | fixed turret |
| --- | ---: | ---: |
| detection range | 90 m | 120 m |
| first shot after the sight line | 0.50 s | 0.70 s |
| telegraph | 0.15 s | 0.35 s |
| damage | 18 | 40 |
| bullet speed | 70 m/s | 60 m/s |
| burst | 3 shots | 2 shots |
| burst interval | 0.12 s | 0.25 s |
| burst cycle | 1.20 s | 1.60 s |
| bullet life | 2 s | 3 s |

The telegraph time is **included** in the first-shot delay and in the burst cycle. Enemies
aim with a lead solution computed from the player's current position and velocity (capped at
1.20 s of prediction) plus at most 0.5° of dispersion. A shot is only emitted when the
muzzle still has a clear line to the player; re-acquiring a target does not restart the
first-shot delay, and enemies remember the last confirmed position for 8 s. Guards share
that position with connected allies within 60 m of path distance.

---

## 8. Read-only inspection API

```js
window.__AK2__.getSnapshot()
```

Returns a deep copy of the current game state (positions, velocities, lock state, the
current firing solution, the last 32 shots, every hostile, the objective and the visited
sectors). The values are the ones the game and the HUD actually use — nothing is
recomputed for the API and nothing in the returned object can change the game.

```jsonc
{
  "version": "AK2-1.2-candidate",
  "seed": 20260908,
  "state": "garage | playing | paused | cleared | failed",
  "elapsedSeconds": 0,
  "loadout": { "fcs": "medium", "generator": "balanced", "legs": "biped" },
  "player": {
    "position": [0, 0, 0], "velocity": [0, 0, 0], "grounded": true,
    "hp": 1000, "en": 120, "weapon": "machinegun",
    "ammo": { "machinegun": 300, "missile": 12 },
    "movement": {
      "horizontalMode": "walk | glide | quickboost",
      "verticalMode": "grounded | rising | flying | falling",
      "glideEnabled": false, "desiredHorizontalDirection": [0, 0],
      "qbSuccessfulCount": 0, "qbLastStartedAtSeconds": null,
      "qbImpulseRemainingSeconds": 0, "qbCooldownRemainingSeconds": 0,
      "lastEnSpentAtSeconds": null
    }
  },
  "effectiveStats": { "maxEn": 120, "regenPerSecond": 15, "lockSeconds": 0.8, "horizontalSpeedMultiplier": 1 },
  "lock": { "state": "none | acquiring | locked", "targetId": null, "progress": 0, "radiusCssPx": 144 },
  "fireControl": { "status": "inactive | solved | no_solution", "weapon": "machinegun", "…": "…" },
  "recentPlayerShots": [ /* the last 32 real shots, oldest first */ ],
  "enemies": [ /* all 45 hostiles, destroyed ones stay with alive:false */ ],
  "objective": { "controlsDestroyed": 0, "controlsRequired": 6, "openBarrierIds": [], "gateOpen": false },
  "stage": { "sectorCount": 34, "currentSectorId": "intake", "visitedSectorIds": [], "totalEnemies": 45 }
}
```

`fireControl.status` is `inactive` while no target is locked, `solved` when a firing
solution exists and `no_solution` when the locked target has no solution inside the weapon
limits (the direct aim direction is returned in that case).

---

## 9. Stage design

### Zones

| id | name | kind | X range (m) | Z range (m) | floor Y (m) | clear height (m) |
| --- | --- | --- | --- | --- | --- | --- |
| `intake` | Intake Dock | dock | 40 – 190 | 600 – 800 | 0 | 12 |
| `yard` | Material Yard | yard | 190 – 380 | 610 – 810 | 0 | 12 |
| `mill` | Rolling Mill | mill | 380 – 520 | 610 – 790 | 0 | 12 |
| `sluice_a` | Drain Link A | corridor | 250 – 330 | 490 – 610 | 0 | 9 |
| `sluice_b` | Drain Link B | corridor | 250 – 420 | 430 – 490 | 0 | 9 |
| `sluice_c` | Drain Link C | corridor | 420 – 480 | 430 – 610 | 0 | 9 |
| `spur_d` | Service Spur D | corridor | 100 – 190 | 490 – 600 | 0 | 9 |
| `spur_e` | Service Spur E | corridor | 100 – 250 | 430 – 490 | 0 | 9 |
| `assembly` | Assembly Line | assembly | 580 – 750 | 590 – 790 | 12 | 12 |
| `inspect` | Inspection Bay | inspection | 750 – 880 | 610 – 780 | 12 | 12 |
| `conveyor` | Conveyor Section | conveyor | 760 – 990 | 470 – 590 | 12 | 12 |
| `piping` | Maintenance Piping | piping | 140 – 370 | 470 – 590 | 12 | 12 |
| `shipping` | Shipping Warehouse | shipping | 540 – 720 | 280 – 400 | 12 | 12 |
| `dock2` | Second Loading Dock | dock | 840 – 960 | 280 – 400 | 12 | 12 |
| `duct_s` | Underfloor Duct S | corridor | 620 – 680 | 790 – 830 | 12 | 9 |
| `duct_x2` | Underfloor Duct X | corridor | 620 – 880 | 830 – 870 | 12 | 9 |
| `duct_n2` | Underfloor Duct N | corridor | 820 – 880 | 780 – 830 | 12 | 9 |
| `gantry` | Main Gantry | gantry | 940 – 1090 | 600 – 790 | 24 | 12 |
| `plant` | Power House | plant | 1060 – 1200 | 460 – 600 | 24 | 12 |
| `cooling` | Cooling Plant | cooling | 430 – 700 | 500 – 660 | 24 | 12 |
| `mainhall` | Main Manufacturing Hall | hall | 140 – 480 | 200 – 480 | 24 | 24 |
| `exitgate` | Evacuation Gate Front | gate | 1020 – 1200 | 260 – 420 | 24 | 12 |
| `escape` | Evacuation Zone | escape | 1200 – 1620 | 160 – 440 | 24 | 12 |
| `spur_k` | North Link K | corridor | 1000 – 1060 | 560 – 600 | 24 | 9 |
| `towerA` | Transfer Shaft A | shaft | 520 – 580 | 620 – 780 | 0/12 | 12/12 |
| `towerB` | Transfer Shaft B | shaft | 880 – 940 | 620 – 780 | 12/24 | 12/12 |
| `towerC` | Transfer Shaft C | shaft | 990 – 1060 | 460 – 560 | 12/24 | 12/12 |
| `towerD` | Transfer Shaft D | shaft | 700 – 760 | 480 – 580 | 12/24 | 12/12 |
| `towerE` | Transfer Shaft E | shaft | 370 – 430 | 480 – 590 | 12/24 | 12/12 |
| `towerF` | Transfer Shaft F | shaft | 80 – 140 | 450 – 580 | 12/24 | 12/12 |
| `towerG` | Transfer Shaft G | shaft | 480 – 540 | 290 – 390 | 12/24 | 12/12 |
| `towerH` | Transfer Shaft H | shaft | 720 – 780 | 290 – 390 | 12/24 | 12/12 |
| `towerI` | Transfer Shaft I | shaft | 780 – 840 | 290 – 390 | 12/24 | 12/12 |
| `towerJ` | Transfer Shaft J | shaft | 960 – 1020 | 290 – 390 | 12/24 | 12/12 |

### Connections (doors)

| # | zone A | zone B | shared wall | opening (centre) | width | barrier |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `intake` | `yard` | x = 190 | 26 m | 26 m |  |
| 2 | `yard` | `mill` | x = 380 | 26 m | 26 m |  |
| 3 | `mill` | `towerA` | x = 520 | 26 m | 26 m |  |
| 4 | `towerA` | `assembly` | x = 580 | 26 m | 26 m | **BR1** |
| 5 | `assembly` | `inspect` | x = 750 | 26 m | 26 m |  |
| 6 | `inspect` | `towerB` | x = 880 | 26 m | 26 m |  |
| 7 | `towerB` | `gantry` | x = 940 | 26 m | 26 m | **BR2** |
| 8 | `gantry` | `plant` | z = 460 | 26 m | 26 m |  |
| 9 | `plant` | `towerC` | x = 990 | 26 m | 26 m |  |
| 10 | `towerC` | `conveyor` | x = 760 | 26 m | 26 m | **BR3** |
| 11 | `conveyor` | `towerD` | x = 700 | 26 m | 26 m |  |
| 12 | `towerD` | `cooling` | x = 430 | 26 m | 26 m |  |
| 13 | `cooling` | `towerE` | x = 370 | 26 m | 26 m |  |
| 14 | `towerE` | `piping` | x = 140 | 26 m | 26 m |  |
| 15 | `piping` | `towerF` | x = 80 | 26 m | 26 m |  |
| 16 | `towerF` | `mainhall` | x = 140 | 26 m | 26 m |  |
| 17 | `mainhall` | `towerG` | x = 480 | 26 m | 26 m | **BR4** |
| 18 | `towerG` | `shipping` | x = 540 | 26 m | 26 m |  |
| 19 | `shipping` | `towerH` | x = 720 | 26 m | 26 m | **BR5** |
| 20 | `towerH` | `towerI` | x = 780 | 26 m | 26 m |  |
| 21 | `towerI` | `dock2` | x = 840 | 26 m | 26 m |  |
| 22 | `dock2` | `towerJ` | x = 960 | 26 m | 26 m |  |
| 23 | `towerJ` | `exitgate` | x = 1020 | 26 m | 26 m | **BR6** |
| 24 | `exitgate` | `escape` | x = 1200 | 26 m | 26 m | final gate |
| 25 | `yard` | `sluice_a` | z = 490 | 26 m | 26 m |  |
| 26 | `sluice_a` | `sluice_b` | z = 430 | 26 m | 26 m |  |
| 27 | `sluice_b` | `sluice_c` | x = 420 | 26 m | 26 m |  |
| 28 | `sluice_c` | `mill` | z = 610 | 26 m | 26 m |  |
| 29 | `intake` | `spur_d` | z = 490 | 26 m | 26 m |  |
| 30 | `spur_d` | `spur_e` | z = 430 | 26 m | 26 m |  |
| 31 | `spur_e` | `sluice_b` | x = 250 | 26 m | 26 m |  |
| 32 | `assembly` | `duct_s` | z = 790 | 26 m | 26 m |  |
| 33 | `duct_s` | `duct_x2` | z = 830 | 26 m | 26 m |  |
| 34 | `duct_x2` | `duct_n2` | z = 780 | 26 m | 26 m |  |
| 35 | `duct_n2` | `inspect` | z = 610 | 26 m | 26 m |  |
| 36 | `gantry` | `spur_k` | z = 560 | 26 m | 26 m |  |
| 37 | `spur_k` | `plant` | x = 1060 | 26 m | 26 m |  |

### Barrier doors and their control turrets

| barrier | door | control turret | turret sector |
| --- | --- | --- | --- |
| BR1 | `towerA` ↔ `assembly` | E-TUR-01 | `mill` |
| BR2 | `towerB` ↔ `gantry` | E-TUR-03 | `inspect` |
| BR3 | `towerC` ↔ `conveyor` | E-TUR-06 | `towerC` |
| BR4 | `mainhall` ↔ `towerG` | E-TUR-09 | `mainhall` |
| BR5 | `shipping` ↔ `towerH` | E-TUR-07 | `shipping` |
| BR6 | `towerJ` ↔ `exitgate` | E-TUR-08 | `dock2` |

### Hostiles

| id | kind | sector | X | Z | control turret |
| --- | --- | --- | --- | --- | --- |
| E-GRD-01 | guard | `yard` | 235 | 650 |  |
| E-GRD-02 | guard | `yard` | 330 | 665 |  |
| E-GRD-03 | guard | `yard` | 250 | 760 |  |
| E-GRD-04 | guard | `yard` | 335 | 765 |  |
| E-TUR-15 | turret | `yard` | 285 | 705 |  |
| E-TUR-01 | turret | `mill` | 450 | 700 | yes |
| E-GRD-05 | guard | `mill` | 415 | 650 |  |
| E-GRD-06 | guard | `mill` | 485 | 750 |  |
| E-GRD-07 | guard | `sluice_c` | 450 | 520 |  |
| E-GRD-08 | guard | `assembly` | 615 | 630 |  |
| E-GRD-09 | guard | `assembly` | 710 | 640 |  |
| E-GRD-10 | guard | `assembly` | 630 | 750 |  |
| E-GRD-11 | guard | `assembly` | 705 | 755 |  |
| E-TUR-02 | turret | `assembly` | 665 | 695 |  |
| E-TUR-03 | turret | `inspect` | 815 | 700 | yes |
| E-GRD-12 | guard | `inspect` | 790 | 650 |  |
| E-TUR-04 | turret | `conveyor` | 870 | 530 |  |
| E-GRD-14 | guard | `conveyor` | 805 | 505 |  |
| E-GRD-15 | guard | `conveyor` | 905 | 515 |  |
| E-GRD-16 | guard | `conveyor` | 850 | 565 |  |
| E-TUR-05 | turret | `piping` | 300 | 530 |  |
| E-GRD-17 | guard | `piping` | 190 | 510 |  |
| E-GRD-18 | guard | `piping` | 215 | 560 |  |
| E-TUR-06 | turret | `towerC` | 1045 | 540 | yes |
| E-TUR-07 | turret | `shipping` | 630 | 340 | yes |
| E-GRD-19 | guard | `shipping` | 580 | 315 |  |
| E-GRD-20 | guard | `shipping` | 675 | 370 |  |
| E-TUR-08 | turret | `dock2` | 900 | 340 | yes |
| E-GRD-21 | guard | `dock2` | 870 | 315 |  |
| E-GRD-22 | guard | `dock2` | 930 | 370 |  |
| E-TUR-09 | turret | `mainhall` | 300 | 330 | yes |
| E-TUR-10 | turret | `mainhall` | 420 | 250 |  |
| E-GRD-23 | guard | `mainhall` | 210 | 250 |  |
| E-GRD-24 | guard | `mainhall` | 380 | 420 |  |
| E-GRD-25 | guard | `mainhall` | 250 | 430 |  |
| E-TUR-11 | turret | `cooling` | 565 | 580 |  |
| E-GRD-26 | guard | `cooling` | 480 | 540 |  |
| E-GRD-27 | guard | `cooling` | 650 | 615 |  |
| E-GRD-28 | guard | `cooling` | 505 | 625 |  |
| E-TUR-12 | turret | `gantry` | 1015 | 700 |  |
| E-GRD-29 | guard | `gantry` | 975 | 645 |  |
| E-TUR-13 | turret | `plant` | 1130 | 530 |  |
| E-GRD-30 | guard | `plant` | 1095 | 480 |  |
| E-TUR-14 | turret | `exitgate` | 1110 | 340 |  |
| E-GRD-31 | guard | `exitgate` | 1060 | 300 |  |

Totals: 30 guards, 15 turrets (6 of them gate controls).

Player start: `intake` (70, 705), yaw 0.
Evacuation trigger: `escape` (1580, 300), tier y = 24.

---

## 10. Verification

Everything below was measured with the shipped code. The automated harnesses live in
`scripts/` and can be re-run against a local server.

### 10.1 FCS accuracy trials (specification §4.6)

`tests/index.html` (also built to `dist/tests/index.html`) runs the acceptance matrix with
the **real** FCS class, the **real** `Player` (muzzle placement + firing) and the **real**
projectile / collision code — nothing is re-implemented for the test. The muzzle is placed
at exactly `m = (0, 20, 0)`, the target is a 0.5 m sphere at `p = m + r` that keeps the
given velocity, and every condition is fired 20 times.

| trial | r | v | machinegun hits | residual | predicted t |
| --- | --- | --- | --- | --- | --- |
| A01 | (0,0,20) | (0,0,0) | 20/20 | 3.5e-74 m | 0.200032 s |
| A02 | (0,0,60) | (0,0,0) | 20/20 | 7.1e-15 m | 0.600879 s |
| A03 | (0,0,100) | (0,0,0) | 20/20 | 2.9e-14 m | 1.004109 s |
| A04 | (0,0,120) | (0,0,0) | 20/20 | 0 m | 1.207145 s |
| A05 | (0,0,100) | (8,0,0) | 20/20 | 3.6e-15 m | 1.007391 s |
| A06 | (0,0,100) | (-8,0,0) | 20/20 | 1.8e-15 m | 1.007391 s |
| A07 | (0,0,100) | (0,0,8) | 20/20 | 1.6e-27 m | 1.092714 s |
| A08 | (0,0,100) | (0,0,-8) | 20/20 | 1.4e-14 m | 0.928937 s |
| A09 | (0,16,100) | (6,0,0) | 20/20 | 2.8e-14 m | 1.034175 s |
| A10 | (0,-16,100) | (-6,0,0) | 20/20 | 8.9e-16 m | 1.003625 s |
| A11 | (0,0,100) | (6,3,0) | 20/20 | 2.8e-14 m | 1.009226 s |
| A12 | (0,0,100) | (6,-3,0) | 20/20 | 2.8e-14 m | 1.003639 s |
| A13 | (0,0,120) | (6,3,4) | 20/20 | 0 m | 1.266138 s |

* machinegun total: **260/260** hits, maximum residual **2.9e-14 m** (requirement ≤ 0.01 m),
  initial speed error **≤ 1.5e-14 m/s** (requirement ≤ 0.001 m/s).
* The predicted times reproduce the reference values of the specification: A03
  `1.004108529 s` / `v0 = (0, 9.036976765, 99.590828147)`, A05 `1.007391236 s` /
  `v0 = (8, 9.066521121, 99.266299391)`, A13 `1.266137996 s`.
* beam: **260/260** hits (the beam always strikes the current position).
* missile: **260/260** hits (own lead solution, 120°/s turn limit).
* FCS / leg variants (wide/medium/narrow × biped/quadruped, conditions A05 and A09):
  **20/20** for every combination, identical residuals — the correction accuracy does not
  depend on the load-out.
* self-motion (glide 22 m/s, flight 8/16 m/s, quick boost 80 m/s) on condition A05:
  **20/20** hits — the projectile never inherits the player's velocity.

The same solver is unit-checked without a browser by `scripts/ballistics-check.ts`.

### 10.2 Movement and energy (specification §7)

Measured with `scripts/gameplay-test.mjs` (Chromium, 1280×720):

| check | result |
| --- | --- |
| one `Q` press | exactly one quick boost, EN 120 → 84 (36 EN) |
| holding `Q` for 5 s | still exactly one quick boost (`qbSuccessfulCount = 1`) |
| biped quick boost distance | **42.08 m** measured over 0.75 s of simulation time (specification: 42.6 m) |
| after the burn | `horizontalMode = glide` automatically, the direction is kept |
| glide | 22.00 m/s, keeps running with no input, **EN unchanged** (0 EN) |
| brake | cancels the glide, horizontal speed → 0.000 m/s |
| beam | drains 8 EN per shot |
| EN below 36 | the quick boost is refused (no EN spent, no cooldown started) |
| glide with almost no energy | still works (13.2 m travelled) |

### 10.3 Combat behaviour (specification §2.3)

Measured with `scripts/combat-test.mjs` in the `?test=exposure` scenario (a stationary
1000 HP player in the open, two security robots and one turret at 35–50 m):

* 3 hostiles acquired a sight line, 63 shots were fired;
* the first damage landed 0.60–0.80 s after the sight line was acquired;
* the player was destroyed after **7.6–7.8 s** (requirement: within 15 s).

In the live game the FCS locked a target (`lock.state = "locked"`, `progress = 1`,
`radiusCssPx = 144` on a 1280×720 screen) and 6/6 machinegun shots reported
`solutionStatus = "solved"` and damaged the locked robot. The hand missile refuses to fire
while the lock is incomplete (`ammo 12 → 12`, 0 shots) and fires exactly once per lock
(`ammo 12 → 11`).

### 10.4 Flight ascent in the transfer shafts (specification §2.2)

`scripts/shaft-test.mjs` drives the `?test=shaft` scenario (the player standing under the
18 m opening of transfer shaft A):

* holding `Space` for 0.20 s switches the thrusters on: the machine climbed from
  **y = 0.00 m to y = 21.40 m** and the energy dropped from 120 EN to 0 EN at exactly
  20 EN/s while flying;
* steering onto the landing deck afterwards left the machine **standing on the upper deck at
  y = 12.00 m** (`grounded = true`, sector `towerA`);
* a jump only reaches 2.78 m, so every one of the six mandatory ascents (12 m each) really
  needs the flight mode.

### 10.5 Objective chain (specification §2.1)

Measured with `scripts/objective-test.mjs`:

* destroying the control turret `E-TUR-01` opened `BR1` (`controlsDestroyed = 1`,
  `openBarrierIds = ["BR1"]`) while the final gate stayed closed;
* destroying all six control turrets opened all six barriers and the final evacuation gate
  (`controlsDestroyed = 6`, `gateOpen = true`);
* entering the evacuation zone afterwards produced `state = "cleared"`;
* the re-sortie restored the whole state: `controlsDestroyed = 0`,
  `openBarrierIds = []`, `gateOpen = false`, all 45 hostiles alive again, HP 1000,
  EN 120, 300 machinegun rounds and 12 missiles, the clock back at zero and the quick-boost
  counter at 0.

### 10.6 Stage validator

`scripts/stage-check.ts` verifies the stage data (no overlapping volumes, every door shares
a wall with its partner, 30 guards + 15 turrets + 6 control turrets, every hostile inside a
reachable zone, ≥ 15 zones, ≥ 5 large combat rooms, ≥ 3 independent branch/loop structures
and the shortest barrier-complete route ≥ 1500 m). It reports:

```
guards=30 turrets=15 controls=6 total=45
shortest barrier-complete route (lower bound) = 1677.9 m, zones touched = 14
zones = 34
combat zones >= 60x50: 15
independent cycles (branch/loop structures) = 4
STAGE CHECK PASSED
```

### 10.7 Not verified / known limitations

* The harnesses run in headless Chromium with a software rasteriser, so the wall-clock
  duration of the timed checks is much longer than the simulated duration. All measurements
  above are expressed in **simulation time** taken from `elapsedSeconds`.
* A full unassisted playthrough (spawn → six control turrets → evacuation) was not
  automated; the traversal itself was verified per section (movement, doors, barriers, the
  flight shafts) rather than as one continuous run.
* The game was not profiled on a real GPU; the renderer keeps the static factory in three
  merged meshes and limits the per-frame object churn, but frame times on weak hardware will
  be lower than 60 fps (the simulation itself is frame-rate independent).
* Sound is not implemented (the specification lists music and sound effects as optional).

---

## 11. Project layout

```
index.html            entry point
src/core/             parameters, seeded RNG, ballistic solver
src/game/             stage data, world/collision, models, player, FCS, enemies,
                      projectiles, the game loop and the read-only API
src/ui/               HUD and hangar (HTML/CSS)
tests/                in-browser FCS accuracy trials (§4.6)
scripts/              node/browser verification harnesses
  stage-check.ts      stage data validator (node)
  ballistics-check.ts solver unit test (node)
  gameplay-test.mjs   movement / energy checks (chromium)
  combat-test.mjs     exposure, lock and weapon checks (chromium)
  objective-test.mjs  barrier, gate, clear and re-sortie checks (chromium)
  shaft-test.mjs      flight ascent in a transfer shaft (chromium)
```

The browser harnesses need Playwright (`npm i --no-save playwright`) and a running server
(`npm run preview -- --port 4173`); `node scripts/run-all-tests.mjs` runs every suite in
sequence and prints `ALL SUITES PASSED` when everything is green.

`src/core/config.ts` holds every tunable value; the HUD renders those numbers directly
instead of inventing its own.
