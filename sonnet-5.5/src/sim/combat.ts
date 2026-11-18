/** Shared damage / event helpers so every module applies damage and emits events the same way. */
import { LIMITS } from '../config';
import { normalize, sub } from './math';
import type { EnemyState, GameEvent, GameState, V3, WeaponId } from './types';

export function pushEvent(state: GameState, ev: GameEvent): void {
  const evs = state.events;
  evs.push(ev);
  if (evs.length > LIMITS.EVENTS) evs.splice(0, evs.length - LIMITS.EVENTS);
}

export function findEnemy(state: GameState, id: string | null): EnemyState | undefined {
  if (id === null) return undefined;
  return state.enemies.find((e) => e.id === id);
}

/** Apply damage (no armor) to an enemy. Returns true when this hit destroyed it. */
export function damageEnemy(state: GameState, enemy: EnemyState, amount: number, weapon: WeaponId): boolean {
  if (!enemy.alive) return false;
  enemy.hp -= amount;
  enemy.hitFlash = 0.12;
  if (enemy.hp <= 0) {
    enemy.hp = 0;
    enemy.alive = false;
    enemy.alert = false;
    enemy.hasLineOfSight = false;
    enemy.telegraph = 0;
    enemy.vel = { x: 0, y: 0, z: 0 };
    if (!enemy.scripted) state.killCount += 1;
    pushEvent(state, { type: 'enemyDown', time: state.time, id: enemy.id, kind: enemy.kind, pos: { ...enemy.pos } });
    pushEvent(state, { type: 'explosion', time: state.time, pos: { ...enemy.pos }, size: enemy.kind === 'turret' ? 2.6 : 2.0 });
    return true;
  }
  void weapon;
  return false;
}

/** Apply enemy bullet damage to the player (records the hit direction for the HUD). */
export function damagePlayer(state: GameState, amount: number, fromPos: V3): void {
  const p = state.player;
  if (p.hp <= 0) return;
  p.hp = Math.max(0, p.hp - amount);
  state.damageTaken += amount;
  const dirToSource = normalize(sub(fromPos, p.pos));
  state.damageIndicators.push({ time: state.time, dirToSource, damage: amount });
  if (state.damageIndicators.length > LIMITS.DAMAGE_INDICATORS) state.damageIndicators.shift();
  pushEvent(state, { type: 'playerHit', time: state.time, damage: amount, fromPos: { ...fromPos }, dirToSource });
}
