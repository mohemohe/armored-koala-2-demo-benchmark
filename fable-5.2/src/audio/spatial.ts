/**
 * Stereo placement of world sounds relative to the TPS camera — pure maths, no WebAudio (tested in Node).
 *
 * Convention (docs/ARCHITECTURE.md §2): yaw 0 looks along -Z, positive yaw turns left;
 * forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw).
 */

export interface Listener {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** False until a camera pose has been seen: world sounds then play centred and unattenuated. */
  valid: boolean;
}

export interface Placement {
  /** StereoPanner value, -1 (left) … +1 (right). */
  pan: number;
  /** Linear gain factor from distance, 0…1. */
  gain: number;
  /** Low-pass cutoff in Hz (sources behind the camera sound duller); OPEN_CUTOFF = no filter. */
  cutoff: number;
  distance: number;
}

/**
 * How a sound loses level with distance:
 *  - 'world'    plain distance law (enemy shots, stray impacts)
 *  - 'near'     steeper: only audible close to the listener (enemy bullets hitting walls)
 *  - 'warning'  never drops below a floor inside the combat range (enemy telegraphs must stay readable)
 *  - 'event'    half of the level is kept at any range (explosions of destroyed enemies)
 *  - 'feedback' mostly kept (hit confirmation of the player's own weapons)
 *  - 'pan'      direction only, no attenuation (damage taken)
 */
export type Rolloff = 'world' | 'near' | 'warning' | 'event' | 'feedback' | 'pan';

/** Distance at which the plain law has dropped to one half. */
export const HALF_DISTANCE = 35;
/** World sounds fade to nothing between these distances (the longest enemy weapon range is 120 m). */
export const FADE_START = 150;
export const FADE_END = 200;
/** Widest stereo position used (never hard left / right: both ears always get the warning). */
export const MAX_PAN = 0.85;
export const OPEN_CUTOFF = 15000;
/** Cutoffs above this are treated as "no filter" (sources in front of the camera inside the combat range). */
export const FILTER_BELOW = 9000;
/** Lowest cutoff applied to an enemy telegraph (its chirp must not lose level behind the camera). */
export const BEHIND_WARNING_CUTOFF = 3500;

const smooth = (a: number, b: number, x: number): number => {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
};

/** Plain distance law: 1 at the listener, 0.5 at HALF_DISTANCE, about 0.17 at 120 m. */
export function distanceGain(distance: number, half = HALF_DISTANCE): number {
  const d = distance > 0 ? distance : 0;
  return 1 / (1 + Math.pow(d / half, 1.3));
}

export function rolloffGain(rolloff: Rolloff, distance: number): number {
  if (rolloff === 'pan') return 1;
  const far = 1 - smooth(FADE_START, FADE_END, distance);
  const g = distanceGain(distance);
  switch (rolloff) {
    case 'world':
      return g * far;
    case 'near':
      return distanceGain(distance, 14) * far;
    case 'warning':
      return Math.max(0.38, g) * far;
    case 'event':
      return (0.45 + 0.55 * g) * far;
    case 'feedback':
      return 0.6 + 0.4 * g;
    default:
      return g * far;
  }
}

/**
 * Pan / gain / cutoff of a source at (sx, sy, sz) for the given listener. Non-finite input yields the
 * neutral placement (centre, full level) — never NaN.
 */
export function place(l: Listener, sx: number, sy: number, sz: number, rolloff: Rolloff, out: Placement): Placement {
  out.pan = 0;
  out.gain = 1;
  out.cutoff = OPEN_CUTOFF;
  out.distance = 0;
  if (!l.valid) return out;
  const dx = sx - l.x;
  const dy = sy - l.y;
  const dz = sz - l.z;
  const dist = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(dist) || !Number.isFinite(l.yaw)) return out;
  const c = Math.cos(l.yaw);
  const s = Math.sin(l.yaw);
  const right = dx * c - dz * s;
  const front = -dx * s - dz * c;
  const horiz = Math.hypot(right, front);
  out.distance = dist;
  out.gain = rolloffGain(rolloff, dist);
  if (dist > 1e-6 && horiz > 1e-6) {
    // sin(azimuth), flattened for sources straight above / below and for sources right at the listener
    const elevation = horiz / dist;
    const nearness = Math.min(1, dist / 4);
    out.pan = Math.max(-MAX_PAN, Math.min(MAX_PAN, (right / horiz) * elevation * nearness * MAX_PAN));
    if (rolloff !== 'pan') {
      // Stereo cannot tell front from back, so sources behind the camera are made duller (about 2 kHz when
      // straight behind). Warnings keep their 1-2 kHz body: they are only dulled down to BEHIND_WARNING_CUTOFF.
      const behind = front < 0 ? -front / horiz : 0;
      const air = 1 / (1 + dist / 160);
      const floor = rolloff === 'warning' ? BEHIND_WARNING_CUTOFF : 1400;
      out.cutoff = Math.max(floor, OPEN_CUTOFF * 1.2 * (1 - 0.86 * behind) * air);
      // a filter that would only shave the top octave is not worth a node per voice
      if (out.cutoff > FILTER_BELOW) out.cutoff = OPEN_CUTOFF;
    }
  }
  return out;
}
