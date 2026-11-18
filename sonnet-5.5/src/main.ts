/**
 * AK2 DEMO entry point. HUD / 格納庫 / 入力 / ポインターロックは src/ui/app.ts。
 * window に公開するのは AK2_BENCH.getSnapshot だけ (SPEC §10)。
 */
import { buildSnapshot } from './sim/bench';
import type { Snapshot } from './sim/bench';
import { App } from './ui/app';
import { parseSeed } from './ui/seed';

declare global {
  interface Window {
    AK2_BENCH?: { getSnapshot: () => Snapshot };
  }
}

function boot(): void {
  const byId = <T extends HTMLElement>(id: string): T => {
    const e = document.getElementById(id);
    if (!e) throw new Error(`#${id} not found`);
    return e as T;
  };
  let app: App;
  try {
    app = new App(
      { canvas: byId<HTMLCanvasElement>('game-canvas'), hud: byId('hud'), garage: byId('garage'), screens: byId('screens') },
      parseSeed(window.location.search),
    );
  } catch (e) {
    console.error('AK2: boot failed', e);
    return;
  }
  // game.state は再出撃で置き換わるので、呼ぶたびに現在の state から作る (返却値はコピー)
  window.AK2_BENCH = Object.freeze({ getSnapshot: () => buildSnapshot(app.game.state) });
  app.start();
}

boot();
