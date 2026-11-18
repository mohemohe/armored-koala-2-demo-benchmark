# Movement and keyboard verification

Measured on 2026-09-30 with the production `src/movement.js`, shared `src/config.js`, and production keyboard adapter `src/input.js`:

```sh
npm test
# focused repeat:
node --test tests/input.test.js tests/movement.test.js
```

The focused command completed **27 tests, 27 passed, 0 failed**: 19 movement/configuration tests and 8 keyboard adapter tests. Positions below are measured world coordinates from actual movement integration. Tests use a flat, obstacle-free collision fixture unless a collision case is explicitly stated. They do not modify production movement speed, EN costs, gravity, or input behavior.

## QB measurements

The baseline starts at `[0,0,0]`, faces world `+Z`, selects the balanced generator, and starts with EN 120. Only the Q edge is issued; no WASD, Shift, Space, or brake input follows it.

| Legs | Outer update rate | Elapsed | Measured position | Measured horizontal velocity | EN | QB count |
| --- | --- | --- | --- | --- | --- | --- |
| Biped | 30 Hz | 0.75 s | `[0,0,42.5999999999999]` | 22 m/s | 84 | 1 |
| Biped | 60 Hz | 0.75 s | `[0,0,42.5999999999999]` | 22 m/s | 84 | 1 |
| Biped | 120 Hz | 0.75 s | `[0,0,42.5999999999999]` | 22 m/s | 84 | 1 |
| Quadruped | 30 Hz | 0.75 s | `[0,0,34.07999999999996]` | 17.6 m/s | 84 | 1 |
| Quadruped | 60 Hz | 0.75 s | `[0,0,34.07999999999996]` | 17.6 m/s | 84 | 1 |
| Quadruped | 120 Hz | 0.75 s | `[0,0,34.07999999999996]` | 17.6 m/s | 84 | 1 |

At 0.15 s, biped position was 12 m and velocity remained 80 m/s. Quadruped position was 9.6 m and velocity remained 64 m/s. Both had entered `horizontalMode=glide` with no velocity discontinuity. Internal integration splits the impulse end and target-speed arrival and never advances more than 1/120 s at once.

### Held and released keyboard input

These tests inject ordinary keydown/keyup-shaped events through the same `InputController` used by the game, then consume `movementInput()` through production movement. They are automated adapter/integration measurements, not a claim that a human physically held a key in the browser.

- **Q held for 5.00 simulation seconds:** one initial non-repeat `KeyQ` keydown followed by 99 repeat keydowns. `KeyQ` remained in the held-key set throughout. At 0.75 s, position was `[0,0,42.5999999999999]`, EN 84, and QB count 1. At 5.00 s, position was `[0,0,136.100000000001]`, EN 120, and QB count remained 1. Minimum EN was 84. `lastEnSpentAtSeconds` remained 0; EN recovery had restored the initial 36 EN expenditure by the end.
- **Brief Q tap, then every key released:** initial `KeyQ` keydown and keyup both occurred before the first simulation update. At 0.75 s, held-key count was 0, position was `[0,0,42.5999999999999]`, EN 84, and mode was `glide`. The queued single edge, impulse, inertia, and auto-glide all survived release.
- **Duplicate keydown without an OS repeat flag:** repeated calls while Q was already held did not manufacture another edge. A release followed by another press after cooldown produced a second QB.
- **Pause/resume while Q stays held:** after 0.20 s of motion, `clear()` removed live inputs and firing, retaining the release guard. Thirty seconds of paused repeat events left all player values unchanged because simulation time did not advance. Resume and additional repeat or non-repeat keydowns produced no second QB. A later keyup followed by a fresh keydown did.
- A Q press initially received in `garage`, `paused`, `cleared`, or `failed` state stayed blocked on entering play until release. Shift repeat did not retoggle glide, and releasing Shift did not stop glide. Space had one jump edge; its hold duration used simulation time and restarted on release/repress.

## Resources and motion boundaries

- EN 35 rejected QB, preserved unused timestamps/cooldown, and did not queue an activation when recovery later exceeded 36.
- EN 36 permitted one QB. At 0.75 s, EN was 0 and displacement was 42.6 m. Free glide continued; the next 1.00 s produced position 64.6 m and EN 15 with the balanced/biped configuration.
- Manually enabling glide at EN 0 was successful. With last consumption at time 0, EN remained 0 through 0.75 s and reached 15 at 1.75 s while glide continued.
- Rotating the camera alone preserved the saved world glide direction. Diagonal movement remained capped at the normal 10 m/s. Screen-right movement at yaw 0 used world `-X`, matching the camera basis.
- Brake and Shift could not interrupt the 0.15 s QB impulse. Brake subsequently used the 120 m/s² normal acceleration limit, reducing 80 to 68 m/s over 0.10 s instead of immediately clearing velocity. A new QB requested during brake consumed no EN.
- The shared spending sequence was exercised explicitly: EN 44.05 became 8.05 after QB, 0.05 after beam cost, and 0 after 0.0025 s of actual flight propulsion. The remaining 0.0075 s in that update followed gravity; vertical velocity was 7.865 m/s. A beam refused at EN 4 left that EN available for flight.
- Jump gave one 10 m/s vertical impulse. Airborne repeated jump edges did not reset vertical velocity. Space holding did not begin powered flight before 0.20 s. Release or exhaustion preserved current vertical velocity and gravity resumed.
- Airborne QB at initial altitude 50 m and vertical speed 2 m/s produced 40.8 m horizontal travel by 0.75 s and settled at the airborne glide speed of 16 m/s. Height followed gravity; enabling glide did not provide lift.
- A wall collision during the QB impulse removed the into-wall velocity. Subsequent impulse updates did not restore it.

## All configurations and verification limits

All 18 combinations were instantiated and checked against the shared generator, FCS, and leg formulas. The maximum-EN/base-recovery product was 1800 for each generator. Quadruped applied 0.8 horizontal speed, 0.75 recovery, and divided lock duration by 1.5.

All 18 configurations completed a free-space ascent with a 0.20 s jump followed by 2.00 s of flight. Each reached height 17.64 m with vertical velocity 8 m/s and consumed exactly 40 EN. This validates the movement/EN budget for a 16 m ascent, **not the accessibility of every actual stage platform**. Stage collision/traversal tests are reported separately.

Fresh-player construction reset position, velocity, HP, EN, ammo, glide, QB count, impulse/cooldown, and EN-spending timestamps. The movement tests do not certify browser pointer lock, real focus events, rendering, model switching, FCS/projectile behavior, or a complete manually played mission. Browser and broader integration findings belong in the main README verification section.
