// 描画フレームから固定ステップへの分割（フレームレート非依存）。
import { MAX_STEPS_PER_FRAME, SIM_DT } from '../config';

export class FixedStepper {
  private acc = 0;

  reset() {
    this.acc = 0;
  }

  /**
   * 実経過時間 frameDt を受け取り、実行すべきステップ数を返す。
   * 上限を超えた分は破棄する（一時停止明けなどにまとめて加算しない）。
   */
  advance(frameDt: number): number {
    if (!(frameDt > 0)) return 0;
    this.acc += Math.min(frameDt, MAX_STEPS_PER_FRAME * SIM_DT);
    let n = Math.floor(this.acc / SIM_DT + 1e-9);
    if (n > MAX_STEPS_PER_FRAME) n = MAX_STEPS_PER_FRAME;
    this.acc -= n * SIM_DT;
    if (this.acc < 0) this.acc = 0;
    return n;
  }
}
