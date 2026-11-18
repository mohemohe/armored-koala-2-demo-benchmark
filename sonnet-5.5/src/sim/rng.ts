/** Seeded PRNG (mulberry32). Gameplay randomness ONLY; visual-only randomness must use a separate Rng instance or Math.random. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** uniform [0,1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  /** integer in [lo, hi] inclusive */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  /** approx uniform point inside a cone of half-angle `maxRad` around +Z; returns [azimuth, polar] */
  cone(maxRad: number): { azimuth: number; polar: number } {
    return { azimuth: this.next() * Math.PI * 2, polar: maxRad * Math.sqrt(this.next()) };
  }
  getState(): number {
    return this.s;
  }
}

/** parse ?seed=... (32-bit unsigned). Falls back to the default when missing/invalid. */
export function parseSeed(search: string, fallback: number): number {
  const m = /[?&]seed=([^&#]*)/.exec(search);
  if (!m) return fallback;
  let raw: string;
  try {
    raw = decodeURIComponent(m[1]).trim();
  } catch {
    return fallback; // malformed percent-encoding must never throw at startup
  }
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 4294967295) return fallback;
  return n >>> 0;
}
