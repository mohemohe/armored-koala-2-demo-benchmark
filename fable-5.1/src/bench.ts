/**
 * 評価用の読み取り専用インターフェース（§10）。
 * window.AK2_BENCH.getSnapshot() は毎回新しいコピーを返し、ゲーム状態を変更しない。
 */
import type { Game } from './sim/game';
import type { Snapshot } from './types';

export interface Ak2Bench {
  getSnapshot(): Snapshot;
}

declare global {
  interface Window {
    AK2_BENCH?: Ak2Bench;
  }
}

export function installBench(getGame: () => Game): void {
  const bench: Ak2Bench = Object.freeze({
    getSnapshot(): Snapshot {
      return getGame().getSnapshot();
    },
  });
  Object.defineProperty(window, 'AK2_BENCH', { value: bench, writable: false, configurable: false, enumerable: true });
}
