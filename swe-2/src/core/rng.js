// Deterministic seeded RNG (mulberry32). Used for gameplay-affecting randomness.
// Visual-only effects use a separate stream so gameplay stays reproducible.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const f = mulberry32(seed >>> 0);
  return {
    next: f,
    range: (lo, hi) => lo + (hi - lo) * f(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * f()),
    sign: () => (f() < 0.5 ? -1 : 1),
  };
}
