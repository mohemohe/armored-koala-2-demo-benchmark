/** Deterministic, seedable PRNG (mulberry32) used for gameplay randomness. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  get seed(): number {
    return this.state;
  }

  reset(seed: number): void {
    this.state = seed >>> 0;
  }

  /** Uniform [0,1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform [min,max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer [min,max] */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }

  /** Approximately normal with mean 0 and stddev 1 (sum of 3 uniforms). */
  normal(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }
}

/** Separate stream for purely cosmetic randomness (never affects gameplay). */
export class CosmeticRng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed ^ 0x9e3779b9) >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

export function parseSeedFromLocation(search: string): number {
  try {
    const params = new URLSearchParams(search);
    const raw = params.get('seed');
    if (raw === null) return NaN;
    if (!/^\d+$/.test(raw.trim())) return NaN;
    const v = Number(raw.trim());
    if (!Number.isFinite(v) || v < 0 || v > 0xffffffff) return NaN;
    return v >>> 0;
  } catch {
    return NaN;
  }
}
