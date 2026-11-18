// シード付き乱数（mulberry32）。ゲーム進行用と視覚効果用で別インスタンスを使う。

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  reset(seed: number) {
    this.s = seed >>> 0;
  }
  /** [0,1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
}

/** URLクエリーの seed を 32bit 符号なし整数として解釈。不正または未指定なら既定値。 */
export function parseSeed(search: string, fallback: number): number {
  try {
    const p = new URLSearchParams(search);
    const raw = p.get('seed');
    if (raw === null || raw.trim() === '') return fallback;
    if (!/^\d+$/.test(raw.trim())) return fallback;
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < 0 || n > 4294967295) return fallback;
    return n >>> 0;
  } catch {
    return fallback;
  }
}
