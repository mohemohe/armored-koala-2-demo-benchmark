# Combat implementation and measured verification

Run `npm test` or `node --test tests/combat.test.js tests/enemy-ai.test.js`.
These are simulator integration tests using the production `createCombat`, normal FCS acquisition, `fire`, projectile integration, moving-target collision, shared movement and shared AI. No evaluation-only direction, forced damage, larger targets, or runtime mutation API is used. Test fixtures supply only initial states, an empty physical arena and a target collision radius of 0.5 m, as requested. Every shot starts with reset firing/target state and completes normal lock acquisition.

## Machinegun A01–A13

Muzzle at `(0,20,0)`; target starts at muzzle plus the listed relative displacement **at firing time**. Its listed velocity remains constant after firing. The simulation runs at 1/120 s. Actual shots and contacts were measured on 2026-09-30.

| Test | Relative position (m) | Target velocity (m/s) | Hits / shots | Largest center-solution residual (m) |
|---|---|---|---|---|
| A01 | (0,0,20) | (0,0,0) | 20 / 20 | 1.928e-11 |
| A02 | (0,0,60) | (0,0,0) | 20 / 20 | 3.593e-11 |
| A03 | (0,0,100) | (0,0,0) | 20 / 20 | 7.763e-12 |
| A04 | (0,0,120) | (0,0,0) | 20 / 20 | 1.511e-11 |
| A05 | (0,0,100) | (8,0,0) | 20 / 20 | 9.406e-12 |
| A06 | (0,0,100) | (-8,0,0) | 20 / 20 | 9.406e-12 |
| A07 | (0,0,100) | (0,0,8) | 20 / 20 | 2.513e-12 |
| A08 | (0,0,100) | (0,0,-8) | 20 / 20 | 7.230e-12 |
| A09 | (0,16,100) | (6,0,0) | 20 / 20 | 3.925e-11 |
| A10 | (0,-16,100) | (-6,0,0) | 20 / 20 | 4.334e-11 |
| A11 | (0,0,100) | (6,3,0) | 20 / 20 | 4.318e-12 |
| A12 | (0,0,100) | (6,-3,0) | 20 / 20 | 2.616e-11 |
| A13 | (0,0,120) | (6,3,4) | 20 / 20 | 3.508e-11 |

All 260 shots contacted the 0.5 m collision sphere through production collision handling. The listed residual is the distance between the analytically evolved projectile center and the predicted target center at the computed arrival time; contact occurs slightly earlier due to target radius. Initial world speed is verified within 0.001 m/s of 100 m/s. A03 arrival agrees with 1.004108529 s within 1e-8 s; A13 is explicitly checked to exceed 1.20 s and stay within 2 s.

The polynomial solver recursively isolates derivative roots, splits the domain into monotonic intervals, tests extrema for tangent roots, and bisects sign-changing intervals. Additional numerical tests cover a quartic root of multiplicity four, an exact 2 s lifetime-boundary root, the earliest positive root, degenerate linear intercepts, and no-solution cases. Every accepted solution is independently checked against the actual normalized initial velocity and the 0.01 m residual requirement.

## Other weapon and movement integration

- Beam: all A01–A13, 20 trials each, **260 / 260 hits**. Each shot deducts exactly 40 HP and 8 EN, points at current target position, and records zero flight time.
- Missile: A05, A06, A07, 20 trials each, **60 / 60 hits**. Initial direction equals the 45 m/s intercept solution; every guidance step is checked against 120 degrees/s and constant speed. Concealment preserves the previous observation and target ID; destruction makes the missile continue straight.
- Gliding, flying and QB: A05 with shared movement preparation/integration, 20 trials per mode, **60 / 60 machinegun hits**. Records confirm the changed actual muzzle position and exactly 100 m/s world initial speed, without adding shooter velocity.
- All 18 loadouts complete their own actual FCS lock duration and hit A05 with identical correction accuracy (one shot per combination).
- A ceiling beam that clears the direct camera/muzzle sightline blocks the corrected ballistic arc. A separate thin-wall test leaves the camera's sightline open while blocking the muzzle, invalidating the lock and stopping the resulting free beam.
- No-solution shots keep the valid lock, use direct aim and remain on the original gravity trajectory after target movement.
- Continuous relative segment collision catches opposing fast projectile/target movement, including terminal contact. At 1/120 s, the gravity curve's maximum displacement from its segment chord is 0.00015625 m, below 0.01 m.
- A projectile born at 75% of an update interval advances for only the remaining 25%.
- Weapon switching preserves cooldowns, failed EN expenditure does not alter recovery time, target replacement starts at zero lock progress, an existing valid target cannot be stolen by a more central candidate, snapshot copies cannot mutate live state, and reset clears histories/timers.

## Enemy aggression

An open arena with an actual floor contains guards at `(-20,2.2,30)` and `(20,2.2,35)` and a turret at `(0,2.2,45)`, initially 36.06 m, 40.31 m and 45 m from the static player's center. Production AI moves the guards and independently generates ordinary projectiles. HP begins at 1000; there are no invulnerability windows or direct test damage.

Measured defeat: **7.800000 s**. Guards each emitted **19** projectiles and the turret emitted **10** before defeat. Damage arose only from normal moving-projectile intersections with the player. No enemy stats were reduced or altered.

The first attempt exposed a fixture mistake: its arena lacked a floor and guards fell until outside detection range. Adding a physical floor corrected the fixture; no gameplay stats or AI attack cadence changed.

Independent AI scheduling, occlusion, observation memory and connected local alerts also have dedicated tests in `tests/enemy-ai.test.js`.

## Verification limits

These results prove the shared simulation's actual launch and collision paths, not browser pixels, pointer lock, interactive aiming comfort, end-to-end mission completion or a 10–20 minute human playthrough. Browser and stage integration evidence is recorded separately in the main README. The test fixtures do not replace or weaken the production 45-enemy stage.
