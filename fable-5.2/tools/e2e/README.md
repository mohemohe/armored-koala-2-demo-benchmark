# End-to-end scripts (headless Chromium, playwright-core)

Everything here drives the game the way a player can — real keyboard / mouse input injected by the browser,
clicks on the real buttons — and observes it through the read-only `window.__AK2__.getSnapshot()`, the DOM and
screenshots. No script needs (and the pages do not contain) a debug hook.

| File | Purpose |
| --- | --- |
| `lib.mjs` | Shared helpers: open a page, snapshot / wait helpers in **simulation time**, garage + sortie, keys, mouse, pause triggers, DOM / CDP measurements, screenshot pixels, the test-side scripted pointer lock and virtual frame clock, `Checks` (PASS / FAIL lines + summary). Read its header first. |
| `serve.mjs` | Builds `index.html` + `dev/app-test.html` to a directory outside the repo and serves it (a snapshot: not disturbed by people editing `src/`). |
| `app-smoke.mjs` | Application wiring: load / seed / API (a), garage + sortie (b), controls (c), pause + resume (d, e), pointer-lock failure (f), mini-stage fell / destroyed / cleared / re-sortie (g), repeated sorties (h), resize (i), no WebGL (j), screenshots (s). |
| `app-regress.mjs` | Regression checks for defects found in review: a pointer lock nobody waits for is released (k), races while a lock request is pending and the deferred re-sortie (l), double click on a start / resume button is not a shot (m), no animation state carried into a re-sortie (n), centre reticle never covered by the route marker (o), inline page icon (p), taps that are over before the next simulation tick on 240 / 360 Hz frames (y). |
| `audio.mjs` | Sound wiring (`src/app.ts` ↔ `src/audio`), observed with test-side WebAudio instrumentation only: no AudioContext before the first start click, sound sources and output signal for fire / quick boost / glide (u); pause = nothing starts, loops gone, output samples zero; mute; M key; text state; the sound toast covers no HUD block (v); the game is byte-identical without / with broken WebAudio (w); failed / cleared = a short cue, no loop left; garage silent; one context per session (x); at 1280×720 the sound toast goes below the gate banner + HUD messages when they are stacked at the top centre, and back afterwards (x2); a pause without a rendered frame — a hidden tab — silences the fight at once (z). |
| `spec-verify.mjs` | The browser-side record for the confirmation table of SPEC §11, one section group per process (`--only=S`, `M1`, `M2q`, `M3`, `M4`, `M5`, `M6`, `FC`, `PM`, `EP`, `U1`, `R1`): for every item it prints the input sequence, simulation times, positions, EN values, the value the SPEC text predicts and PASS / FAIL, and writes `rows-<group>.json` into `--out=<dir>` (`--merge --out=<dir>` → `results.json`). Movement / EN on the shipped page (single press, release, 0.75 s distance at 30 / 60 / 120 / 144 Hz virtual frames, EN 35 / 36, ledger), fire control checked against the script's own solver of §4.3 / §4.4 (mini stage and factory), enemy timing of guard G01 and turret T01, control turret T01 → barrier B1 on the factory, the mini-stage clear / fall / destroyed / re-sortie (whole t = 0 snapshot compared), pause triggers, resize and the lock circle in snapshot, DOM and pixels. Every row says whether it used the browser's own pointer lock or the scripted lock + virtual clock. |
| `delivery.mjs` | No browser: the real `npm run dev -- --host 0.0.0.0 --port <port>` and `npm run build` + `vite preview` answer 200 for any Host header (q, r), contents of the build (r), README sections (s), nothing shipped from `dev/` (t). |
| `factory-run.mjs` | (run with `npx tsx`: it imports the stage data and planners of the repo) A test-side bot plays the SHIPPED page on the real factory from the sortie to MISSION CLEAR with real key / mouse events — walks the recommended route, fights with the real weapons and FCS, flies the climbs with Space held — in lock step on the virtual frame clock, and reports four milestones (T01 → B1, first flight climb, six control turrets + gate open, exit → 'cleared' → 同じ構成で再出撃 with the t = 0 snapshot compared). Along the way: HUD text against the snapshot every 2 s of game time, the headless `Sim` fed the same input and compared after every frame ("shadow"), screenshots at 1280×720 through a real window resize. `--dry` runs the same pilot on the headless `Sim` (for developing the pilot; not evidence about the page), `--mini-fall` self-tests the end-of-sortie handling on the mini stage. Options and method are in the file header. |

## Running

```sh
# node / npm come from mise on this machine: prefix with `x` after sourcing the session's env.sh
node tools/e2e/serve.mjs --port=5190 &                       # stable build of both pages
AK2_URL=http://127.0.0.1:5190/ node tools/e2e/app-smoke.mjs  # everything except screenshots (≈ 25 min here)
AK2_URL=http://127.0.0.1:5190/ node tools/e2e/app-smoke.mjs --only=d,e              # selected sections
AK2_URL=http://127.0.0.1:5190/ node tools/e2e/app-smoke.mjs --only=d --triggers=pointerlock   # one pause trigger only
AK2_URL=http://127.0.0.1:5190/ node tools/e2e/app-smoke.mjs --only=s,g --shots=/tmp/ak2-shots   # with screenshots
AK2_URL=http://127.0.0.1:5190/ node tools/e2e/app-regress.mjs [--only=k,l,m,n,o,p,y] [--shots=/tmp/ak2-shots]   # ≈ 27 min (y alone ≈ 10)
AK2_URL=http://127.0.0.1:5190/ node tools/e2e/audio.mjs [--only=u,v,w,x,x2,z]   # u and v share one page (≈ 20 min in all)
AK2_URL=http://127.0.0.1:5190/ node tools/e2e/spec-verify.mjs --only=M3 --out=/tmp/ak2-verify   # ONE group per process: S M1 M2q M3 M4 M5 M6 FC PM EP U1 R1 (1 – 14 min each here)
node tools/e2e/spec-verify.mjs --merge --out=/tmp/ak2-verify   # rows-*.json → results.json
node tools/e2e/delivery.mjs --port=5191 [--only=q,r,s,t]     # needs a FREE port; starts and stops its own servers (≈ 1 min)
AK2_URL=http://127.0.0.1:5190/ npx tsx tools/e2e/factory-run.mjs --out=/tmp/ak2-factory   # the whole factory, sortie → MISSION CLEAR (≈ 334 s of game time in 5009 frames; 75 min here)
```

`AK2_URL` (or `--url=`) is the base URL; the default is `http://127.0.0.1:5173/` (`npm run dev`). The scripts
also work against the dev server, but it reloads the page whenever a source file changes.
The exit code is 0 only if every check passed.

## Things to know before writing a scenario

- **Use simulation time.** Software WebGL renders a few frames per second and the simulation advances at
  most 0.25 s per rendered frame, so the game runs in slow motion. `waitSimSeconds`, `holdKey`, `fireFor`
  count `snapshot.elapsedSeconds`; holds are quantised to rendered frames (allow ≈ 0.5 s of tolerance).
- **'playing' is slow in headless Chromium** because its emulated pointer lock floods the page with
  zero-movement mouse events (see `lib.mjs`) and because the game scene is expensive in software rendering.
  Paused / result / garage screens are not affected.
  Run **one** pointer-locked browser at a time, keep one page's playing time to a few minutes and use a
  fresh page per scenario: the flood also eats memory in the browser processes while frames are slow.
- **Scripted pointer lock + virtual frame clock** (`openGame(browser, { scripted: { lock: true, clock: true } })`):
  test-side replacements injected with `addInitScript` (never in the shipped page). The scripted lock answers
  `requestPointerLock` the way the test says (`lockMode(page, 'ok' | 'reject' | 'never', delayMs)`), which is
  the only way to produce a late or refused answer on demand; the virtual clock makes game time exact
  (`clockFreeze`, then `clockAdvance(page, frames, stepMs)`). Input is still real keyboard / mouse input.
  Use them for races and exact timing; use the browser's own (emulated) lock for everything else.
- **Mouse look:** `lookBy(page, dx, dy)` is real pointer movement but limited to the viewport (about one
  viewport width of turning per sortie); `syntheticLook` has no limit but uses script-made events.
- **Click counts:** Playwright sends `detail` 1 for every `mouse.down()` unless told otherwise; the second
  click of a double click is `mouse.down({ clickCount: 2 })`.
- **The mini stage** (`dev/app-test.html`, layout in `dev/app-test-stage.ts`) runs the real `App` on a tiny
  stage: hold S → fall, hold A → destroyed by the yard enemies, hold the trigger → the six control turrets
  die from cover, then D, W + Shift → exit. Use it for anything that needs a failed / cleared sortie quickly.
- **The factory start dock** is sheltered; walking ≈ 60 m forward leaves it and enemies open fire.
- **Pixels:** `capture(page)` decodes a screenshot in Node; `countDifferentPixels(a, b, rect, threshold, slack)`
  compares two of them (with `slack` it ignores outlines that moved by a pixel or two).
- **Frames without a simulation tick:** while the virtual clock stands still (`clockFreeze`) every rendered
  frame feeds 0 s to the simulation — the situation between two ticks on a display faster than 120 Hz. Input
  sent then is seen by tick-less frames only; `clockAdvance(page, n, 1000 / 240)` continues with 240 Hz frames
  (section y of `app-regress.mjs`).
- **Sound** (`audio.mjs`): nobody can listen here (no audio device), and the page has no audio hook. The
  script injects a probe before the page's scripts (`audioProbeInit`, `addInitScript`): it wraps the
  `AudioContext` constructor (how many, created inside which event), `start` / `stop` of the source nodes
  (sources started, sounding, running without a stop time = the glide / thrust layers), `connect` /
  `disconnect` (master gain = the node feeding the destination, game bus, loop gains) and the AudioParam
  writes to master / bus, and it connects an AudioWorklet meter to the master node that counts every output
  sample (non-zero samples, peak, RMS, stamped with the context time). "Silent" in its checks means the
  samples that leave the master node are below −120 dBFS (the count of non-zero samples is printed too).
  The same probe can remove or break `AudioContext` (fault injection) and hold `requestAnimationFrame` back
  (a hidden tab renders no frames). Audio runs in real time, so that script waits in wall-clock time.
  The app's sound toast ("音声 ON [M]" / "音声 OFF [M] — ミュート中") stays for 1.8 s of real time — less than
  one screenshot takes here — so the probe records it with a MutationObserver at the moment it appears: text,
  rectangle and the rectangles of the HUD blocks along the top (`toastGeom`).
