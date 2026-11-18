/**
 * SimEvent → sound mapping. Pure: no WebAudio here, the sounds are requested from a `CueSink` (the mixer
 * in the game, a recorder in tests). `EVENT_SOUNDS` documents the mapping and is exhaustive by type: a new
 * SimEvent variant does not compile until it has been given a sound or an explicit "silent" entry.
 */
import { ENEMIES } from '../config';
import type { SimEvent, Weapon } from '../sim/types';
import type { PlayOptions } from './mixer';
import type { SoundId } from './sounds';

/**
 * The part of the simulation the audio engine reads. `Sim` satisfies it; every field is optional so a
 * partially initialised or foreign object can never make the engine throw.
 */
export interface AudioSimView {
  time?: number;
  status?: string;
  camera?: { pos?: { x: number; y: number; z: number }; yaw?: number } | null;
  player?: {
    pos?: { x: number; y: number; z: number };
    vel?: { x: number; y: number; z: number };
    yaw?: number;
    hp?: number;
    en?: number;
    horizontalMode?: string;
    flying?: boolean;
    braking?: boolean;
  } | null;
  lock?: { state?: string; targetId?: string | null } | null;
  enemyById?: { get(id: string): { pos?: { x: number; y: number; z: number }; kind?: string; alive?: boolean } | undefined } | null;
}

export interface CueSink {
  play(id: SoundId, o?: PlayOptions): unknown;
}

/** Per-engine scratch state of the mapping (reused: the mapping itself allocates nothing). */
export interface CueState {
  /** Counts machine-gun shots (alternating colour of consecutive shots). */
  mgShots: number;
  opts: PlayOptions;
}

export const createCueState = (): CueState => ({ mgShots: 0, opts: {} });

/** What each SimEvent type sounds like. "silent: …" entries are intentional. */
export const EVENT_SOUNDS: Record<SimEvent['type'], string> = {
  'player-shot': 'mg / beam / missile-launch (by weapon)',
  beam: 'beam-hit-enemy / beam-hit-world at the end point (silent when the beam hit nothing)',
  'fire-rejected': 'reject-nolock / reject-noen / reject-noammo (by reason)',
  'weapon-switched': 'switch (blip pitch by weapon slot)',
  qb: 'qb (brighter variant when airborne)',
  'qb-rejected': 'qb-reject',
  glide: 'glide-on / glide-off for manual toggles (silent for the automatic glide after a quick boost: the glide loop takes over)',
  jump: 'jump',
  land: 'land, scaled by impact speed (silent below 1.5 m/s)',
  'projectile-hit':
    'mg→enemy: hit-enemy; mg→world: hit-world; missile→anything: explode-missile; enemy bullet→world: bullet-world (silent for enemy bullet→player: player-damaged plays the damage sound)',
  'projectile-expired': 'missile: explode-missile at reduced level (silent for bullets that simply time out)',
  'enemy-telegraph': 'telegraph-guard / telegraph-turret, panned and attenuated from the enemy position',
  'enemy-shot': 'shot-guard / shot-turret from the muzzle position',
  'enemy-damaged': 'silent: the hit itself is voiced by projectile-hit / beam',
  'enemy-destroyed': 'explode-guard / explode-turret / explode-control (control turrets are the biggest)',
  'enemy-alerted': 'alert from the enemy position',
  'player-damaged': 'damage, panned towards the shooter, heavier for turret shells',
  'barrier-opened': 'barrier-open',
  'gate-opened': 'gate-open (0.45 s after the barrier clank of the same turret)',
  'sector-entered': 'silent: informational, shown by the HUD',
  cleared: 'cleared (result jingle, not cut by the end of the sortie)',
  failed: 'failed (result jingle)',
};

const WEAPON_SLOT: Record<Weapon, number> = { machinegun: 0, beam: 1, missile: 2 };
const LAND_MIN_SPEED = 1.5;
const LAND_FULL_SPEED = 24;

function fresh(st: CueState): PlayOptions {
  const o = st.opts;
  o.pos = null;
  o.gain = 1;
  o.delay = 0;
  o.variant = 0;
  o.intensity = 1;
  o.duration = 0;
  return o;
}

/** Requests the sound(s) of one event. Unknown event types are ignored. */
export function dispatchEvent(e: SimEvent, sim: AudioSimView | null | undefined, sink: CueSink, st: CueState): void {
  const o = fresh(st);
  switch (e.type) {
    case 'player-shot':
      if (e.weapon === 'machinegun') {
        o.variant = st.mgShots++ & 1;
        sink.play('mg', o);
      } else if (e.weapon === 'beam') {
        sink.play('beam', o);
      } else {
        sink.play('missile-launch', o);
      }
      return;
    case 'beam':
      if (e.hit === 'none') return;
      o.pos = e.to;
      sink.play(e.hit === 'enemy' ? 'beam-hit-enemy' : 'beam-hit-world', o);
      return;
    case 'fire-rejected':
      sink.play(e.reason === 'no-lock' ? 'reject-nolock' : e.reason === 'no-en' ? 'reject-noen' : 'reject-noammo', o);
      return;
    case 'weapon-switched':
      o.variant = WEAPON_SLOT[e.weapon] ?? 0;
      sink.play('switch', o);
      return;
    case 'qb':
      o.variant = e.airborne ? 1 : 0;
      sink.play('qb', o);
      return;
    case 'qb-rejected':
      sink.play('qb-reject', o);
      return;
    case 'glide':
      if (e.auto) return;
      sink.play(e.enabled ? 'glide-on' : 'glide-off', o);
      return;
    case 'jump':
      sink.play('jump', o);
      return;
    case 'land': {
      if (!(e.speed >= LAND_MIN_SPEED)) return;
      const k = Math.min(1, (e.speed - LAND_MIN_SPEED) / (LAND_FULL_SPEED - LAND_MIN_SPEED));
      o.intensity = k;
      o.gain = 0.3 + 0.7 * k;
      sink.play('land', o);
      return;
    }
    case 'projectile-hit':
      o.pos = e.pos;
      if (e.kind === 'missile') sink.play('explode-missile', o);
      else if (e.kind === 'mg') {
        if (e.target === 'enemy') sink.play('hit-enemy', o);
        else if (e.target === 'world') sink.play('hit-world', o);
      } else if (e.target === 'world') sink.play('bullet-world', o);
      return;
    case 'projectile-expired':
      if (e.kind !== 'missile') return;
      o.pos = e.pos;
      o.gain = 0.6;
      sink.play('explode-missile', o);
      return;
    case 'enemy-telegraph': {
      const en = sim?.enemyById?.get(e.enemyId);
      o.pos = en?.pos ?? null;
      o.duration = e.duration;
      // an enemy that cannot be looked up still warns (centred, at reduced level)
      if (!en) o.gain = 0.6;
      sink.play(en?.kind === 'turret' ? 'telegraph-turret' : 'telegraph-guard', o);
      return;
    }
    case 'enemy-shot':
      o.pos = e.muzzle;
      sink.play(e.kind === 'turret' ? 'shot-turret' : 'shot-guard', o);
      return;
    case 'enemy-damaged':
      return;
    case 'enemy-destroyed':
      o.pos = e.pos;
      sink.play(e.isGateControl ? 'explode-control' : e.kind === 'turret' ? 'explode-turret' : 'explode-guard', o);
      return;
    case 'enemy-alerted': {
      const en = sim?.enemyById?.get(e.enemyId);
      if (!en?.pos) return;
      o.pos = en.pos;
      sink.play('alert', o);
      return;
    }
    case 'player-damaged': {
      const lo = ENEMIES.guard.damage;
      const hi = ENEMIES.turret.damage;
      const k = Math.min(1, Math.max(0, (e.amount - lo) / (hi - lo)));
      o.pos = e.sourcePos;
      o.intensity = k;
      o.gain = 0.8 + 0.2 * k;
      sink.play('damage', o);
      return;
    }
    case 'barrier-opened':
      sink.play('barrier-open', o);
      return;
    case 'gate-opened':
      o.delay = 0.45;
      sink.play('gate-open', o);
      return;
    case 'sector-entered':
      return;
    case 'cleared':
      sink.play('cleared', o);
      return;
    case 'failed':
      sink.play('failed', o);
      return;
    default: {
      // compile-time exhaustiveness; at run time an unknown event is simply ignored
      const unknown: never = e;
      void unknown;
    }
  }
}
