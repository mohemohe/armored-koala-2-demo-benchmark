/**
 * Mini-stage harness for the application shell (src/app.ts).
 *
 *   /dev/app-test.html[?seed=<uint32>]
 *
 * Runs the REAL `App` class — same simulation, renderer, HUD, garage, menus, input and the same read-only
 * `window.__AK2__.getSnapshot()` as the shipped page — on the tiny hand-made stage of ./app-test-stage.ts,
 * so that an end-to-end script (tools/e2e/app-flow.mjs) can reach 'failed' (fell / destroyed) and 'cleared'
 * by really playing with keyboard and mouse in well under a minute.
 *
 * There is no debug hook of any kind here either: the page differs from index.html only in the StageDef.
 */
import { App, exposeSnapshotApi } from '../src/app';
import { DEFAULT_SEED } from '../src/config';
import { parseSeed } from '../src/core/rng';
import { buildMiniStage } from './app-test-stage';

const root = document.getElementById('app');
if (!root) throw new Error('#app element is missing');
const seed = parseSeed(new URLSearchParams(window.location.search).get('seed'), DEFAULT_SEED);
const app = new App({ root, stage: buildMiniStage(), seed });
exposeSnapshotApi(app);
