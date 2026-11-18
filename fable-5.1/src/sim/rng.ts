/**
 * シード付き乱数（mulberry32）。ゲーム進行用と視覚効果用で別インスタンスを使う。
 */
export class Rng {
  private state: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  reset(): void {
    this.state = this.seed;
  }

  /** [0, 1) の一様乱数 */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [lo, hi) の一様乱数 */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** 0..n-1 の整数 */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** URL クエリー seed（32bit 符号なし整数）を解析。無効なら既定値 */
export function parseSeed(search: string, fallback: number): number {
  try {
    const params = new URLSearchParams(search);
    const raw = params.get('seed');
    if (raw === null || raw.trim() === '') return fallback;
    if (!/^\d+$/.test(raw.trim())) return fallback;
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return fallback;
    return n >>> 0;
  } catch {
    return fallback;
  }
}
