export class SeededRandom {
  constructor(seed) { this.state = seed >>> 0; }
  next() {
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
}

export function querySeed() {
  const raw = new URLSearchParams(location.search).get('seed');
  if (raw !== null && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) return n;
  }
  return 20260908;
}
