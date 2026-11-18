/**
 * Entry point of the shipped page: the real factory stage, the seed from the URL query (`?seed=<uint32>`,
 * default 20260908) and the read-only evaluation interface `window.__AK2__.getSnapshot()`.
 *
 * Nothing here (or anywhere else in the shipped page) can change the game state from outside: there is no
 * debug query parameter, no cheat and no other global.
 */
import { App, exposeSnapshotApi } from './app';
import { DEFAULT_SEED } from './config';
import { parseSeed } from './core/rng';
import { getFactoryStage } from './stage/factory';

const root = document.getElementById('app');
if (!root) throw new Error('#app element is missing');

const seed = parseSeed(new URLSearchParams(window.location.search).get('seed'), DEFAULT_SEED);
const app = new App({ root, stage: getFactoryStage(), seed });
// Available as soon as this module has run (state 'garage' until the first sortie).
exposeSnapshotApi(app);
