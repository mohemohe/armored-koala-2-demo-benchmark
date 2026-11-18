/**
 * Seeded PRNG (mulberry32). The gameplay stream (`sim.rng`) is re-seeded on every sortie and is the ONLY
 * source of randomness the simulation may use. Visual-only randomness must use a separate instance
 * (or Math.random) so effects never perturb the gameplay stream.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** +1 or -1. */
  sign(): 1 | -1 {
    return this.next() < 0.5 ? -1 : 1;
  }
}

/** Parses the `seed` URL query value as an unsigned 32-bit integer; returns `fallback` when absent/invalid. */
export function parseSeed(value: string | null | undefined, fallback: number): number {
  if (value == null || !/^\d{1,10}$/.test(value.trim())) return fallback;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return fallback;
  return n >>> 0;
}
