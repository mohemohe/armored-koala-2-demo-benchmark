/**
 * スクリーンショット (PNG) の簡易解析。画像ライブラリを使わず、別ページの canvas でデコードして集計する。
 * 戻り値は集計値のみ (画素そのものは持ち出さない)。
 */
import type { Browser, Page } from 'playwright';
import { readFileSync } from 'node:fs';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LumaStats {
  mean: number;
  p5: number;
  p50: number;
  p95: number;
  /** 輝度 < 0.05 の割合 */
  dark: number;
  /** 輝度 > 0.9 の割合 */
  bright: number;
}

export class ImgAnalyzer {
  private page: Page | null = null;
  constructor(private browser: Browser) {}

  private async ensure(): Promise<Page> {
    if (!this.page) {
      const ctx = await this.browser.newContext();
      // tsx (esbuild keepNames) が evaluate 関数へ差し込む __name のシム
      await ctx.addInitScript('window.__name = window.__name || ((f) => f);');
      this.page = await ctx.newPage();
      await this.page.goto('about:blank');
    }
    return this.page;
  }

  async close(): Promise<void> {
    await this.page?.context().close().catch(() => {});
    this.page = null;
  }

  private async load(path: string): Promise<string> {
    return readFileSync(path).toString('base64');
  }

  /** 画像の輝度統計 (rect 省略で全体)。輝度 = 0.2126R + 0.7152G + 0.0722B (sRGB 値のまま 0..1) */
  async luma(path: string, rect?: Rect): Promise<LumaStats> {
    const page = await this.ensure();
    const b64 = await this.load(path);
    return page.evaluate(
      async ({ b64, rect }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const r = rect ?? { x: 0, y: 0, w: bmp.width, h: bmp.height };
        const c = new OffscreenCanvas(r.w, r.h);
        const g = c.getContext('2d')!;
        g.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        const d = g.getImageData(0, 0, r.w, r.h).data;
        const n = r.w * r.h;
        const ys = new Float32Array(n);
        let sum = 0;
        let dark = 0;
        let bright = 0;
        for (let i = 0; i < n; i++) {
          const y = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
          ys[i] = y;
          sum += y;
          if (y < 0.05) dark++;
          if (y > 0.9) bright++;
        }
        const sorted = Array.from(ys).sort((a, b) => a - b);
        const q = (p: number): number => sorted[Math.min(n - 1, Math.floor(p * n))];
        return { mean: sum / n, p5: q(0.05), p50: q(0.5), p95: q(0.95), dark: dark / n, bright: bright / n };
      },
      { b64, rect },
    );
  }

  /** 2 枚の同サイズ画像の rect 内で、いずれかのチャンネル差が thr (0..255) を超えた画素の割合 */
  async diff(pathA: string, pathB: string, rect?: Rect, thr = 24): Promise<number> {
    const page = await this.ensure();
    const a = await this.load(pathA);
    const b = await this.load(pathB);
    return page.evaluate(
      async ({ a, b, rect, thr }) => {
        const dec = async (s: string): Promise<ImageBitmap> => {
          const bin = atob(s);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        };
        const A = await dec(a);
        const B = await dec(b);
        const r = rect ?? { x: 0, y: 0, w: Math.min(A.width, B.width), h: Math.min(A.height, B.height) };
        const px = (bmp: ImageBitmap): Uint8ClampedArray => {
          const c = new OffscreenCanvas(r.w, r.h);
          const g = c.getContext('2d')!;
          g.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
          return g.getImageData(0, 0, r.w, r.h).data;
        };
        const da = px(A);
        const db = px(B);
        let n = 0;
        for (let i = 0; i < r.w * r.h; i++) {
          if (Math.abs(da[i * 4] - db[i * 4]) > thr || Math.abs(da[i * 4 + 1] - db[i * 4 + 1]) > thr || Math.abs(da[i * 4 + 2] - db[i * 4 + 2]) > thr) n++;
        }
        return n / (r.w * r.h);
      },
      { a, b, rect, thr },
    );
  }

  /**
   * 2 枚の同サイズ画像の差分マスク (いずれかのチャンネル差が thr 超) の統計。
   * frac: マスク画素の割合 / bbox: マスクの外接矩形 / mean: 画像 B のマスク画素の平均色 (0..255) /
   * center: 画面中央 (中心から centerR px 以内) のうちマスクの割合 / lumaIn, lumaRing: 画像 B のマスク内・マスクを ring px 膨らませた外周の平均輝度 (0..1)
   */
  async diffInfo(
    pathA: string,
    pathB: string,
    o: { thr?: number; centerR?: number; ring?: number; rect?: Rect } = {},
  ): Promise<{
    frac: number;
    count: number;
    bbox: { x0: number; y0: number; x1: number; y1: number } | null;
    /** マスクの重心 (rect 内の画素座標) */
    centroid: { x: number; y: number } | null;
    mean: [number, number, number];
    center: number;
    lumaIn: number;
    lumaRing: number;
    /** マスクを ring px 膨らませた外周の平均色 (0..255) */
    ringMean: [number, number, number];
    maxLuma: number;
    /** マスク内で輝度 0.9 超の画素の割合 (白飛びの目安) */
    whiteFrac: number;
    width: number;
    height: number;
  }> {
    const page = await this.ensure();
    const a = await this.load(pathA);
    const b = await this.load(pathB);
    return page.evaluate(
      async ({ a, b, thr, centerR, ring, rect }) => {
        const dec = async (s: string): Promise<ImageBitmap> => {
          const bin = atob(s);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        };
        const A = await dec(a);
        const B = await dec(b);
        const r = rect ?? { x: 0, y: 0, w: Math.min(A.width, B.width), h: Math.min(A.height, B.height) };
        const px = (bmp: ImageBitmap): Uint8ClampedArray => {
          const c = new OffscreenCanvas(r.w, r.h);
          const g = c.getContext('2d')!;
          g.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
          return g.getImageData(0, 0, r.w, r.h).data;
        };
        const da = px(A);
        const db = px(B);
        const W = r.w;
        const H = r.h;
        const mask = new Uint8Array(W * H);
        let count = 0;
        let x0 = W;
        let y0 = H;
        let x1 = -1;
        let y1 = -1;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sxx = 0;
        let syy = 0;
        let cIn = 0;
        let cTot = 0;
        let white = 0;
        let maxLuma = 0;
        const cx = W / 2;
        const cy = H / 2;
        const lum = (i: number): number => (0.2126 * db[i * 4] + 0.7152 * db[i * 4 + 1] + 0.0722 * db[i * 4 + 2]) / 255;
        for (let i = 0; i < W * H; i++) {
          const x = i % W;
          const y = (i / W) | 0;
          const inC = (x - cx) * (x - cx) + (y - cy) * (y - cy) <= centerR * centerR;
          if (inC) cTot++;
          if (Math.abs(da[i * 4] - db[i * 4]) > thr || Math.abs(da[i * 4 + 1] - db[i * 4 + 1]) > thr || Math.abs(da[i * 4 + 2] - db[i * 4 + 2]) > thr) {
            mask[i] = 1;
            count++;
            if (inC) cIn++;
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
            sr += db[i * 4];
            sg += db[i * 4 + 1];
            sb += db[i * 4 + 2];
            sxx += x;
            syy += y;
            const l = lum(i);
            if (l > 0.9) white++;
            if (l > maxLuma) maxLuma = l;
          }
        }
        // 外周: マスクを ring px 膨らませた領域からマスク自身を除いた画素 (bbox を ring 広げた範囲内で判定して計算量を抑える)
        let lumaIn = 0;
        let lumaRing = 0;
        let nRing = 0;
        let rr = 0;
        let rg = 0;
        let rb = 0;
        if (count > 0) {
          const ex0 = Math.max(0, x0 - ring);
          const ey0 = Math.max(0, y0 - ring);
          const ex1 = Math.min(W - 1, x1 + ring);
          const ey1 = Math.min(H - 1, y1 + ring);
          const near = new Uint8Array(W * H);
          for (let y = ey0; y <= ey1; y++) {
            for (let x = ex0; x <= ex1; x++) {
              if (!mask[y * W + x]) continue;
              lumaIn += lum(y * W + x);
              for (let yy = Math.max(0, y - ring); yy <= Math.min(H - 1, y + ring); yy++) {
                for (let xx = Math.max(0, x - ring); xx <= Math.min(W - 1, x + ring); xx++) near[yy * W + xx] = 1;
              }
            }
          }
          for (let i = 0; i < W * H; i++) {
            if (near[i] && !mask[i]) {
              lumaRing += lum(i);
              rr += db[i * 4];
              rg += db[i * 4 + 1];
              rb += db[i * 4 + 2];
              nRing++;
            }
          }
          lumaIn /= count;
          lumaRing = nRing ? lumaRing / nRing : 0;
        }
        return {
          frac: count / (W * H),
          count,
          bbox: count ? { x0, y0, x1, y1 } : null,
          centroid: count ? { x: sxx / count, y: syy / count } : null,
          mean: (count ? [sr / count, sg / count, sb / count] : [0, 0, 0]) as [number, number, number],
          center: cTot ? cIn / cTot : 0,
          lumaIn,
          lumaRing,
          ringMean: (nRing ? [rr / nRing, rg / nRing, rb / nRing] : [0, 0, 0]) as [number, number, number],
          maxLuma,
          whiteFrac: count ? white / count : 0,
          width: W,
          height: H,
        };
      },
      { a, b, thr: o.thr ?? 30, centerR: o.centerR ?? 40, ring: o.ring ?? 6, rect: o.rect },
    );
  }

  /** rect 内で色 (r,g,b) に近い (各チャンネル差 tol 以内) 画素の割合と、その画素の重心 (rect 内座標) */
  async colorFraction(path: string, rgb: [number, number, number], tol: number, rect?: Rect): Promise<{ frac: number; cx: number; cy: number; count: number }> {
    const page = await this.ensure();
    const b64 = await this.load(path);
    return page.evaluate(
      async ({ b64, rgb, tol, rect }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const r = rect ?? { x: 0, y: 0, w: bmp.width, h: bmp.height };
        const c = new OffscreenCanvas(r.w, r.h);
        const g = c.getContext('2d')!;
        g.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        const d = g.getImageData(0, 0, r.w, r.h).data;
        let n = 0;
        let sx = 0;
        let sy = 0;
        for (let i = 0; i < r.w * r.h; i++) {
          if (Math.abs(d[i * 4] - rgb[0]) <= tol && Math.abs(d[i * 4 + 1] - rgb[1]) <= tol && Math.abs(d[i * 4 + 2] - rgb[2]) <= tol) {
            n++;
            sx += i % r.w;
            sy += Math.floor(i / r.w);
          }
        }
        return { frac: n / (r.w * r.h), cx: n ? sx / n : -1, cy: n ? sy / n : -1, count: n };
      },
      { b64, rgb, tol, rect },
    );
  }
}
