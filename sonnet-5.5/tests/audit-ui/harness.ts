/**
 * 監査用ハーネス: src/main.ts と同じ手順で App を起動し、window.__app に公開する (実ゲームコードそのまま)。
 * 位置の移動 (ワープ) など、実プレイでは 1500m 歩かないと確認できない場面へ移るためだけに使う。
 */
import { buildSnapshot } from '../../src/sim/bench';
import { updateCamera } from '../../src/sim/camera';
import { damageEnemy } from '../../src/sim/combat';
import { App } from '../../src/ui/app';
import { parseSeed } from '../../src/ui/seed';

declare global {
  interface Window {
    __app?: App;
    /** 監査専用の補助 (本番の main.ts には存在しない): 敵の撃破 (制御砲台の破壊で隔壁を実際に開ける) と、状態変更後のカメラ更新 */
    __t?: {
      damageEnemy: typeof damageEnemy;
      updateCamera: typeof updateCamera;
    };
    AK2_BENCH?: { getSnapshot: () => ReturnType<typeof buildSnapshot> };
  }
}

const byId = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} not found`);
  return e as T;
};
const app = new App(
  { canvas: byId<HTMLCanvasElement>('game-canvas'), hud: byId('hud'), garage: byId('garage'), screens: byId('screens') },
  parseSeed(window.location.search),
);
window.__app = app;
window.__t = { damageEnemy, updateCamera };
window.AK2_BENCH = Object.freeze({ getSnapshot: () => buildSnapshot(app.game.state) });
app.start();
