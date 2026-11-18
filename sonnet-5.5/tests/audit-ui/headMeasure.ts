/**
 * 格納庫の頭部の見え方の測定 (head-audit.ts と tests/audit-ui-browser.test.ts が共有)。
 * 起動直後 (正面を向いている 3.8 秒の間) の頭部 (耳・鼻を含む全メッシュ) の画面上の外接矩形と、格納庫のパネル (左右の部品選択・実効性能・下部の出撃帯)
 * の矩形を、実ブラウザ (実 DOM のレイアウト + three.js の実カメラ) から取り出し、頭部がパネルに覆われる割合を求める。
 */
import type { Browser } from 'playwright';
import { Sess } from './lib';

export interface HeadMeasure {
  w: number;
  h: number;
  /** 頭部の外接矩形 [CSS px] */
  head: { l: number; r: number; t: number; b: number };
  /** 頭部の全頂点が画面内にある */
  inside: boolean;
  /** 頭部の外接矩形のうち、パネルの矩形に覆われる割合 (0..1) */
  covered: number;
  panels: { cls: string; l: number; t: number; r: number; b: number }[];
}

export async function measureHead(browser: Browser, w: number, h: number, shotName?: string): Promise<HeadMeasure> {
  const s = await Sess.open(browser, { w, h, path: 'tests/audit-ui/harness.html' });
  try {
    await s.step(4, 16); // 起動直後 (正面を向いている 3.8 秒の間の、ごく初期)
    const m = await s.app((app) => {
      // 監査専用: 実プレイでは公開されない内部 (renderer.hangar) を harness からだけ読む
      const r = app as unknown as {
        renderer: {
          hangar: {
            camera: { projectionMatrix: { elements: number[] }; matrixWorldInverse: { elements: number[] }; updateMatrixWorld: (b: boolean) => void };
            mech: { head: { updateWorldMatrix: (a: boolean, b: boolean) => void; traverse: (fn: (o: any) => void) => void } };
          };
        };
      };
      const hg = r.renderer.hangar;
      hg.camera.updateMatrixWorld(true);
      const pv = hg.camera.projectionMatrix.elements;
      const vv = hg.camera.matrixWorldInverse.elements;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const pts: { x: number; y: number }[] = [];
      hg.mech.head.updateWorldMatrix(true, true);
      hg.mech.head.traverse((o: any) => {
        if (!o.isMesh) return;
        const pos = o.geometry.getAttribute('position');
        const e = o.matrixWorld.elements;
        for (let i = 0; i < pos.count; i += 3) {
          const x = pos.getX(i);
          const y = pos.getY(i);
          const z = pos.getZ(i);
          const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
          const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
          const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
          const ex = vv[0] * wx + vv[4] * wy + vv[8] * wz + vv[12];
          const ey = vv[1] * wx + vv[5] * wy + vv[9] * wz + vv[13];
          const ez = vv[2] * wx + vv[6] * wy + vv[10] * wz + vv[14];
          const cx = pv[0] * ex + pv[4] * ey + pv[8] * ez + pv[12];
          const cy = pv[1] * ex + pv[5] * ey + pv[9] * ez + pv[13];
          const cw = pv[3] * ex + pv[7] * ey + pv[11] * ez + pv[15];
          if (cw <= 0) continue;
          pts.push({ x: ((cx / cw + 1) / 2) * W, y: ((1 - cy / cw) / 2) * H });
        }
      });
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const panels = Array.from(document.querySelectorAll('.gar-sec, .gar-bottom, .gar-title')).map((e) => {
        const b = e.getBoundingClientRect();
        return { cls: e.className, l: b.left, t: b.top, r: b.right, b: b.bottom };
      });
      return { W, H, head: { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) }, panels, n: pts.length };
    });
    let total = 0;
    let covered = 0;
    const N = 60;
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        const x = m.head.l + ((ix + 0.5) / N) * (m.head.r - m.head.l);
        const y = m.head.t + ((iy + 0.5) / N) * (m.head.b - m.head.t);
        total++;
        if (m.panels.some((q) => x >= q.l && x <= q.r && y >= q.t && y <= q.b)) covered++;
      }
    }
    if (shotName) await s.shot(shotName, `格納庫 起動直後 ${w}x${h} (頭部の位置とパネル)`);
    return {
      w,
      h,
      head: m.head,
      inside: m.head.l >= 0 && m.head.r <= m.W && m.head.t >= 0 && m.head.b <= m.H,
      covered: covered / total,
      panels: m.panels,
    };
  } finally {
    await s.close();
  }
}
