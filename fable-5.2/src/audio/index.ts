/**
 * Procedural audio for AK2 — public entry point.
 *
 * Wiring in the app (four call sites, all optional — without them the game is simply silent):
 *
 *   const audio = new AudioEngine();                      // creates nothing, never throws
 *
 *   // 1. inside the click handlers of "出撃" / "再開" / "再出撃" (user gesture, before the pointer lock request):
 *   audio.unlock();
 *
 *   // 2. in the frame loop, state 'playing', right after sim.drainEvents():
 *   audio.handleEvents(events, sim);
 *
 *   // 3. at the end of EVERY frame, in every app state:
 *   audio.update(sim, realDt, state === 'playing');
 *
 *   // 4. when a sortie is (re)initialised or the player returns to the garage:
 *   audio.stopAll();
 *
 *   // optional: audio.playUi('click' | 'sortie' | 'pause' | 'resume' | 'error'), audio.setMuted(!audio.muted) on a key
 */
export { AudioEngine, DEFAULT_VOLUME, type AudioDebugInfo, type AudioEngineOptions, type UiSound } from './engine';
export { EVENT_SOUNDS, dispatchEvent, createCueState, type AudioSimView, type CueSink, type CueState } from './cues';
export { Mixer, VOICE_CAP, CEILING, type MixerStats, type PlayOptions } from './mixer';
export { SOUNDS, SOUND_IDS, LOOPS, CATEGORIES, type SoundId, type LoopId, type SoundDef, type Category } from './sounds';
