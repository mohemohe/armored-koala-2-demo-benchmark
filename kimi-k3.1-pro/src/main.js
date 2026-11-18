import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/700.css';
import './style.css';
import { Game } from './game.js';
import { querySeed } from './random.js';

const game = new Game(document.getElementById('game-canvas'), querySeed());
window.__AK2__ = Object.freeze({ getSnapshot: () => game.getSnapshot() });
