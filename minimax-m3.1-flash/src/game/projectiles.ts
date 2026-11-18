import * as THREE from 'three';
import { raycastWorld, segmentSphere } from './collision';
import { SOLVER } from '../core/config';
import { solveConstantSpeedLead } from '../core/ballistics';
import type { World } from './world';
import type { Enemy } from './enemy';

export interface MachinegunBullet {
  kind: 'machinegun';
  ox: number;
  oy: number;
  oz: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  createdAt: number;
}

export interface Missile {
  kind: 'missile';
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  targetId: string | null;
  obsPos: THREE.Vector3 | null;
  obsVel: THREE.Vector3 | null;
  age: number;
  life: number;
  createdAt: number;
}

export interface EnemyBullet {
  kind: 'enemy';
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  damage: number;
  createdAt: number;
}

export type Projectile = MachinegunBullet | Missile | EnemyBullet;

export interface ProjectileEvents {
  onImpact: (x: number, y: number, z: number, nx: number, ny: number, nz: number, friendly: boolean) => void;
  onExplosion: (x: number, y: number, z: number) => void;
  onEnemyDamaged: (enemy: Enemy, damage: number) => void;
  onPlayerDamaged: (damage: number, sx: number, sy: number, sz: number) => void;
}

const bulletRadius = 0;

export function updateProjectiles(
  projectiles: Projectile[],
  dt: number,
  now: number,
  world: World,
  enemies: Enemy[],
  playerCenter: THREE.Vector3,
  playerRadius: number,
  events: ProjectileEvents
): void {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    if (p.kind === 'machinegun') {
      const a0 = p.age;
      const a1 = p.age + dt;
      const x0 = p.ox + p.vx * a0;
      const y0 = p.oy + p.vy * a0 - 0.5 * SOLVER.mgGravity * a0 * a0;
      const z0 = p.oz + p.vz * a0;
      const x1 = p.ox + p.vx * a1;
      const y1 = p.oy + p.vy * a1 - 0.5 * SOLVER.mgGravity * a1 * a1;
      const z1 = p.oz + p.vz * a1;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dy, dz);
      let hitEnemy: Enemy | null = null;
      let hitT = Infinity;
      if (len > 1e-6) {
        const ux = dx / len;
        const uy = dy / len;
        const uz = dz / len;
        const wall = raycastWorld(world.hash, x0, y0, z0, ux, uy, uz, len);
        if (wall.hit) hitT = wall.distance;
        for (const e of enemies) {
          if (!e.alive) continue;
          const t = segmentSphere(x0, y0, z0, x1, y1, z1, e.pos.x, e.pos.y, e.pos.z, e.radius + bulletRadius);
          if (t >= 0 && t * len < hitT) {
            hitT = t * len;
            hitEnemy = e;
          }
        }
        if (hitT < Infinity) {
          const hx = x0 + ux * hitT;
          const hy = y0 + uy * hitT;
          const hz = z0 + uz * hitT;
          if (hitEnemy) {
            events.onEnemyDamaged(hitEnemy, 12);
            events.onImpact(hx, hy, hz, -ux, -uy, -uz, true);
          } else {
            const wall2 = raycastWorld(world.hash, x0, y0, z0, ux, uy, uz, hitT + 0.01);
            events.onImpact(hx, hy, hz, wall2.nx, wall2.ny, wall2.nz, true);
          }
          projectiles.splice(i, 1);
          continue;
        }
      }
      p.age = a1;
      if (p.age >= p.life) projectiles.splice(i, 1);
    } else if (p.kind === 'enemy') {
      const p0 = p.pos.clone();
      const p1 = p.pos.clone().addScaledVector(p.vel, dt);
      const d = p1.clone().sub(p0);
      const len = d.length();
      let hitT = Infinity;
      let hitPlayer = false;
      if (len > 1e-6) {
        const ux = d.x / len;
        const uy = d.y / len;
        const uz = d.z / len;
        const wall = raycastWorld(world.hash, p0.x, p0.y, p0.z, ux, uy, uz, len);
        if (wall.hit) hitT = wall.distance;
        const t = segmentSphere(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, playerCenter.x, playerCenter.y, playerCenter.z, playerRadius);
        if (t >= 0 && t * len < hitT) {
          hitT = t * len;
          hitPlayer = true;
        }
      }
      if (hitT < Infinity) {
        const ux = len > 1e-6 ? d.x / len : 0;
        const uy = len > 1e-6 ? d.y / len : 0;
        const uz = len > 1e-6 ? d.z / len : 0;
        const hx = p0.x + ux * hitT;
        const hy = p0.y + uy * hitT;
        const hz = p0.z + uz * hitT;
        if (hitPlayer) {
          events.onPlayerDamaged(p.damage, hx, hy, hz);
          events.onImpact(hx, hy, hz, -ux, -uy, -uz, false);
        } else {
          events.onImpact(hx, hy, hz, -ux, -uy, -uz, false);
        }
        projectiles.splice(i, 1);
        continue;
      }
      p.pos.copy(p1);
      p.life -= dt;
      if (p.life <= 0) projectiles.splice(i, 1);
    } else {
      // missile
      const target = p.targetId ? enemies.find((e) => e.id === p.targetId) ?? null : null;
      if (target && target.alive) {
        // line of sight from the missile itself
        const d = target.pos.clone().sub(p.pos);
        const dist = d.length();
        const dir = d.clone().normalize();
        const wall = raycastWorld(world.hash, p.pos.x, p.pos.y, p.pos.z, dir.x, dir.y, dir.z, Math.max(0.1, dist - 0.2));
        if (!wall.hit) {
          p.obsPos = target.pos.clone();
          p.obsVel = target.vel.clone();
        }
      }
      let desired: THREE.Vector3 | null = null;
      if (p.obsPos && p.obsVel) {
        const r = p.obsPos.clone().sub(p.pos);
        const remaining = Math.max(0.05, p.life - p.age);
        const t = solveConstantSpeedLead(r, p.obsVel, SOLVER.missileSpeed, remaining);
        if (t !== null) {
          desired = r.addScaledVector(p.obsVel, t).normalize();
        } else {
          desired = p.obsPos.clone().sub(p.pos).normalize();
        }
      } else if (p.obsPos) {
        desired = p.obsPos.clone().sub(p.pos).normalize();
      }
      if (desired) {
        const maxTurn = (SOLVER.missileTurnRateDeg * Math.PI) / 180 * dt;
        const cur = p.vel.clone().normalize();
        const dot = Math.max(-1, Math.min(1, cur.dot(desired)));
        const ang = Math.acos(dot);
        if (ang > 1e-6) {
          const t = Math.min(1, maxTurn / ang);
          const newDir = cur.lerp(desired, t).normalize();
          p.vel.copy(newDir.multiplyScalar(SOLVER.missileSpeed));
        }
      }
      const p0 = p.pos.clone();
      const p1 = p.pos.clone().addScaledVector(p.vel, dt);
      const d = p1.clone().sub(p0);
      const len = d.length();
      let hitT = Infinity;
      let hitEnemy: Enemy | null = null;
      if (len > 1e-6) {
        const ux = d.x / len;
        const uy = d.y / len;
        const uz = d.z / len;
        const wall = raycastWorld(world.hash, p0.x, p0.y, p0.z, ux, uy, uz, len);
        if (wall.hit) hitT = wall.distance;
        for (const e of enemies) {
          if (!e.alive) continue;
          const t = segmentSphere(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, e.pos.x, e.pos.y, e.pos.z, e.radius + 0.4);
          if (t >= 0 && t * len < hitT) {
            hitT = t * len;
            hitEnemy = e;
          }
        }
      }
      if (hitT < Infinity) {
        const ux = len > 1e-6 ? d.x / len : 0;
        const uy = len > 1e-6 ? d.y / len : 0;
        const uz = len > 1e-6 ? d.z / len : 0;
        const hx = p0.x + ux * hitT;
        const hy = p0.y + uy * hitT;
        const hz = p0.z + uz * hitT;
        events.onExplosion(hx, hy, hz);
        if (hitEnemy) events.onEnemyDamaged(hitEnemy, 180);
        projectiles.splice(i, 1);
        continue;
      }
      p.pos.copy(p1);
      p.age += dt;
      p.life -= dt;
      if (p.life <= 0) {
        events.onExplosion(p.pos.x, p.pos.y, p.pos.z);
        projectiles.splice(i, 1);
      }
    }
  }
}
