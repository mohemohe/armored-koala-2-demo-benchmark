import * as THREE from 'three';
import { ENEMY, SOLVER } from '../core/config';
import { solveConstantSpeedLead } from '../core/ballistics';
import { raycastWorld } from './collision';
import type { World } from './world';
import type { Rng } from '../core/rng';

export interface EnemyShot {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  damage: number;
  createdAt: number;
}

export type EnemySpec = Omit<(typeof ENEMY)['guard'], 'kind'> & { kind: 'guard' | 'turret' };

export interface EnemyInit {
  id: string;
  kind: 'guard' | 'turret';
  zoneId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  isGateControl: boolean;
}

export class Enemy {
  readonly id: string;
  readonly kind: 'guard' | 'turret';
  readonly zoneId: string;
  readonly isGateControl: boolean;
  readonly spec: EnemySpec;

  /** hit-box centre */
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  hp: number;
  maxHp: number;
  alive = true;

  // perception
  hasLos = false;
  alert = false;
  lastKnown = new THREE.Vector3();
  hasLastKnown = false;
  lastSeenAt = -999;
  reactionUntil = -1;

  // attack timing
  nextBurstStart: number | null = null;
  burstActive = false;
  burstShotIndex = 0;
  burstNextShotAt = 0;
  burstStart = 0;
  telegraphing = false;
  shotsFired = 0;
  lastShotAt: number | null = null;

  // movement
  yaw: number;
  strafeSign = 1;
  strafeUntil = 0;
  path: number[] = [];
  pathIndex = 0;
  pathTimer = 0;
  alertShareCooldown = 0;

  constructor(init: EnemyInit) {
    this.id = init.id;
    this.kind = init.kind;
    this.zoneId = init.zoneId;
    this.isGateControl = init.isGateControl;
    this.spec = ENEMY[init.kind];
    this.maxHp = this.spec.hp;
    this.hp = this.spec.hp;
    this.yaw = init.yaw;
    this.pos.set(init.x, init.y + this.spec.height / 2, init.z);
  }

  /** optional override (used by the FCS accuracy trials with a 0.5 m target) */
  radiusOverride: number | null = null;
  /** developer test flag: the enemy keeps its sight line but never fires */
  passive = false;

  get radius(): number {
    return this.radiusOverride ?? this.spec.radius;
  }

  reset(): void {
    this.hp = this.maxHp;
    this.alive = true;
    this.vel.set(0, 0, 0);
    this.hasLos = false;
    this.alert = false;
    this.hasLastKnown = false;
    this.lastSeenAt = -999;
    this.reactionUntil = -1;
    this.nextBurstStart = null;
    this.burstActive = false;
    this.burstShotIndex = 0;
    this.telegraphing = false;
    this.shotsFired = 0;
    this.lastShotAt = null;
    this.path = [];
    this.pathIndex = 0;
  }

  /** the point the enemy aims at / uses for line of sight (hit-box centre) */
  get center(): THREE.Vector3 {
    return this.pos;
  }
}

export interface EnemyUpdateContext {
  dt: number;
  now: number;
  world: World;
  playerPos: THREE.Vector3;
  playerVel: THREE.Vector3;
  playerCenter: THREE.Vector3;
  rng: Rng;
  shots: EnemyShot[];
  enemies: Enemy[];
  /** shared last known position broadcast by allies */
  sharedContact: { x: number; y: number; z: number; at: number } | null;
}

export function updateEnemies(ctx: EnemyUpdateContext): void {
  const { dt, now } = ctx;
  for (const e of ctx.enemies) {
    if (!e.alive) continue;
    const spec = e.spec;

    // ---------- perception ----------
    const toPlayer = ctx.playerCenter.clone().sub(e.pos);
    const dist = toPlayer.length();
    let los = false;
    if (dist <= spec.detectRange) {
      const dir = toPlayer.clone().normalize();
      const hit = raycastWorld(ctx.world.hash, e.pos.x, e.pos.y, e.pos.z, dir.x, dir.y, dir.z, dist - 0.2);
      los = !hit.hit;
    }
    const hadLos = e.hasLos;
    e.hasLos = los;

    if (los) {
      e.lastKnown.copy(ctx.playerCenter);
      e.hasLastKnown = true;
      e.lastSeenAt = now;
      e.alert = true;
      if (!hadLos) {
        // (re)acquiring: the weapon's next ready time is preserved
        if (e.nextBurstStart === null) {
          e.nextBurstStart = now + spec.firstShotDelay;
        } else {
          e.nextBurstStart = Math.max(e.nextBurstStart, now + spec.telegraph);
        }
        e.burstActive = false;
        e.telegraphing = false;
      }
    } else {
      if (hadLos) {
        e.burstActive = false;
        e.telegraphing = false;
        // alert memory: keep the last confirmed position for 8 s
        e.reactionUntil = now + 0.5;
      }
      if (e.hasLastKnown && now - e.lastSeenAt > spec.alertMemory) {
        e.hasLastKnown = false;
        e.alert = false;
      }
    }

    // ---------- alert sharing (guards only) ----------
    e.alertShareCooldown -= dt;
    if (e.kind === 'guard' && los && e.alertShareCooldown <= 0) {
      e.alertShareCooldown = 0.5;
      for (const other of ctx.enemies) {
        if (other === e || other.kind !== 'guard' || !other.alive) continue;
        if (other.hasLastKnown && now - other.lastSeenAt < 1) continue;
        const d = Math.hypot(other.pos.x - e.pos.x, other.pos.z - e.pos.z);
        if (d > spec.shareRadius * 2) continue;
        if (pathDistance(ctx.world, e, other) > spec.shareRadius) continue;
        other.lastKnown.copy(e.lastKnown);
        other.hasLastKnown = true;
        other.alert = true;
        other.reactionUntil = Math.max(other.reactionUntil, now + 0.5);
      }
    }

    // ---------- movement ----------
    if (e.kind === 'guard') {
      moveGuard(ctx, e);
    } else {
      // turrets do not move, they only rotate
      const aim = e.hasLos ? ctx.playerCenter : e.hasLastKnown ? e.lastKnown : null;
      if (aim) {
        const d = aim.clone().sub(e.pos);
        e.yaw = Math.atan2(d.x, d.z);
      }
    }

    // ---------- firing ----------
    e.telegraphing = false;
    if (e.passive) {
      e.burstActive = false;
      continue;
    }
    if (!e.hasLos) {
      e.burstActive = false;
    } else {
      if (!e.burstActive) {
        if (e.nextBurstStart === null) e.nextBurstStart = now + spec.firstShotDelay;
        if (now >= e.nextBurstStart) {
          e.burstActive = true;
          e.burstStart = e.nextBurstStart;
          e.burstShotIndex = 0;
          e.burstNextShotAt = now;
        } else if (now >= e.nextBurstStart - spec.telegraph) {
          e.telegraphing = true;
        }
      }
      if (e.burstActive && now >= e.burstNextShotAt) {
        fireEnemyShot(ctx, e);
        e.burstShotIndex++;
        e.burstNextShotAt = now + spec.burstInterval;
        if (e.burstShotIndex >= spec.burstCount) {
          e.burstActive = false;
          e.nextBurstStart = e.burstStart + spec.burstCycle;
        }
      }
    }
  }
}

/** distance along the navigation graph between two enemies */
function pathDistance(world: World, a: Enemy, b: Enemy): number {
  const na = world.nearestNavNode(a.pos.x, a.pos.y, a.pos.z);
  const nb = world.nearestNavNode(b.pos.x, b.pos.y, b.pos.z);
  if (na < 0 || nb < 0) return Infinity;
  const path = world.navPath(na, nb);
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    const p = world.navNodes[path[i - 1]];
    const q = world.navNodes[path[i]];
    d += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  }
  return d;
}

function moveGuard(ctx: EnemyUpdateContext, e: Enemy): void {
  const spec = e.spec;
  const target = new THREE.Vector3();
  let haveTarget = false;

  if (e.hasLos) {
    target.copy(ctx.playerCenter);
    haveTarget = true;
  } else if (e.hasLastKnown && ctx.now < e.reactionUntil + 60) {
    // the reaction delay of 0.5 s after losing the line of sight
    if (ctx.now >= e.reactionUntil) {
      target.copy(e.lastKnown);
      haveTarget = true;
    } else {
      e.vel.set(0, 0, 0);
      return;
    }
  }

  if (!haveTarget) {
    e.vel.set(0, 0, 0);
    return;
  }

  const flat = new THREE.Vector3(target.x - e.pos.x, 0, target.z - e.pos.z);
  const dist = flat.length();
  let desired = new THREE.Vector3();

  if (e.hasLos) {
    if (dist > 55) {
      // close in
      desired = flat.clone().normalize().multiplyScalar(spec.moveSpeed);
    } else if (dist >= 25) {
      // strafe, changing direction periodically
      if (ctx.now > e.strafeUntil) {
        e.strafeUntil = ctx.now + 1.4 + ctx.rng.next() * 0.8;
        e.strafeSign = ctx.rng.next() < 0.5 ? -1 : 1;
      }
      const perp = new THREE.Vector3(-flat.z, 0, flat.x).normalize();
      desired = perp.multiplyScalar(spec.strafeSpeed * e.strafeSign);
      // keep the distance band
      if (dist > 48) desired.addScaledVector(flat.clone().normalize(), spec.moveSpeed * 0.5);
      else if (dist < 30) desired.addScaledVector(flat.clone().normalize(), -spec.moveSpeed * 0.5);
    } else if (dist < 15) {
      desired = flat.clone().normalize().multiplyScalar(-spec.moveSpeed);
    } else {
      const dir = flat.clone().normalize();
      desired = dir.multiplyScalar((dist - 20) * 0.5);
    }
  } else {
    desired = flat.clone().normalize().multiplyScalar(spec.moveSpeed);
  }

  // ---- path following when the direct route is blocked ----
  const straight = raycastWorld(
    ctx.world.hash,
    e.pos.x,
    e.pos.y,
    e.pos.z,
    flat.x / (dist || 1),
    0,
    flat.z / (dist || 1),
    Math.max(0.1, dist - 1.5)
  );
  if (straight.hit) {
    e.pathTimer -= ctx.dt;
    if (e.pathTimer <= 0 || e.path.length === 0) {
      e.pathTimer = 0.6;
      const from = ctx.world.nearestNavNode(e.pos.x, e.pos.y, e.pos.z);
      const to = ctx.world.nearestNavNode(target.x, target.y, target.z);
      e.path = ctx.world.navPath(from, to);
      e.pathIndex = 0;
    }
    while (e.pathIndex < e.path.length) {
      const n = ctx.world.navNodes[e.path[e.pathIndex]];
      const d = Math.hypot(n.x - e.pos.x, n.z - e.pos.z);
      if (d < 3.5) e.pathIndex++;
      else break;
    }
    if (e.pathIndex < e.path.length) {
      const n = ctx.world.navNodes[e.path[e.pathIndex]];
      const wp = new THREE.Vector3(n.x - e.pos.x, 0, n.z - e.pos.z);
      if (wp.lengthSq() > 0.01) {
        desired = wp.normalize().multiplyScalar(desired.length() || spec.moveSpeed);
      }
    }
  }

  const len = desired.length();
  if (len > spec.moveSpeed) desired.multiplyScalar(spec.moveSpeed / len);
  e.vel.x = desired.x;
  e.vel.z = desired.z;

  // face the player when visible
  if (e.hasLos) {
    const d = ctx.playerCenter.clone().sub(e.pos);
    e.yaw = Math.atan2(d.x, d.z);
  } else if (len > 0.01) {
    e.yaw = Math.atan2(desired.x, desired.z);
  }
}

function fireEnemyShot(ctx: EnemyUpdateContext, e: Enemy): void {
  const spec = e.spec;
  const muzzle = e.pos.clone();
  const toPlayer = ctx.playerCenter.clone().sub(muzzle);
  const dist = toPlayer.length();
  const r = toPlayer.clone();
  const pv = ctx.playerVel.clone();

  let t = solveConstantSpeedLead(r, pv, spec.bulletSpeed, 1000);
  if (t === null) t = Math.min(dist / spec.bulletSpeed, ENEMY.leadTimeCap);
  t = Math.min(t, ENEMY.leadTimeCap);
  t = Math.max(0, t);

  const aim = ctx.playerCenter.clone().addScaledVector(pv, t);
  const dir = aim.sub(muzzle).normalize();

  // small random dispersion, at most 0.5 degrees
  const spread = (ctx.rng.next() - 0.5) * 2 * (ENEMY.aimSpreadDegrees * Math.PI) / 180;
  const cs = Math.cos(spread);
  const sn = Math.sin(spread);
  const nx = dir.x * cs - dir.z * sn;
  const nz = dir.x * sn + dir.z * cs;
  dir.set(nx, dir.y, nz).normalize();

  ctx.shots.push({
    x: muzzle.x,
    y: muzzle.y,
    z: muzzle.z,
    vx: dir.x * spec.bulletSpeed,
    vy: dir.y * spec.bulletSpeed,
    vz: dir.z * spec.bulletSpeed,
    life: spec.bulletLife,
    damage: spec.damage,
    createdAt: ctx.now
  });
  e.shotsFired++;
  e.lastShotAt = ctx.now;
}
