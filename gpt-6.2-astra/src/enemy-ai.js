import { Vector3 } from 'three';
import { interceptTime, safeDirection } from './ballistics.js';

export const ENEMY_WEAPONS = {
  guard: {range:90, delay:.5, damage:18, speed:70, burst:3, spacing:.12, cycle:1.2, warning:.15, life:2},
  turret:{range:120, delay:.7, damage:40, speed:60, burst:2, spacing:.25, cycle:1.6, warning:.35, life:3},
};
export const playerCenter = p => p.pos.clone().add(new Vector3(0, p.hitOffset ?? 2.0, 0));
const EPS = 1e-8;
function clear(world, a, b) { return world.hit(a, b) >= 1 - EPS; }

export function initializeEnemy(e,index) {
  Object.assign(e, { home: e.pos.clone(), previous: e.pos.clone(), alert: false,
    hasLineOfSight: false, warning: false, shotsFired: 0, lastShotAtSeconds: null,
    memory: null, expiry: -Infinity, firstBurst: null, nextBurst: 0, rounds: 0, burstAt: 0,
    sightSince: null, reportAt: 0, nextPath: 0, path: [], movementGoal: null,
    facing: new Vector3(0,0,1), verticalSpeed: 0, index, side: index % 2 === 0 ? 1 : -1 });
}
function steer(world,e,goal,time) {
  const localGoal = goal.clone();
  localGoal.y = e.pos.y;
  const delta = localGoal.clone().sub(e.pos);
  if (delta.lengthSq() < .01) return delta.set(0,0,0);
  const side = new Vector3(-delta.z,0,delta.x).normalize().multiplyScalar((e.navRadius ?? e.radius * .72) + .12);
  const blocked = [0, 1, -1].some(sign => {
    const a = e.pos.clone().addScaledVector(side,sign);
    return !clear(world,a,localGoal.clone().addScaledVector(side,sign));
  });
  if (blocked) {
    if (time >= e.nextPath) {
      e.path = world.walkPath?.(e.pos, goal, 140) || [];
      e.nextPath = time + .45;
    }
    while (e.path.length && Math.hypot(e.path[0].x-e.pos.x,e.path[0].z-e.pos.z) < 1.5) e.path.shift();
    if (e.path.length) delta.copy(e.path[0]).sub(e.pos);
    else {
      const alternate = side.clone().normalize().multiplyScalar(e.side * 4);
      if (!clear(world,e.pos,e.pos.clone().add(alternate))) alternate.negate();
      delta.copy(alternate);
    }
  } else {
    e.path.length = 0;
    e.nextPath = 0;
  }
  delta.y = 0;
  return delta.normalize();
}
export function moveEnemies(world,dt,time,player) {
  for (const e of world.enemies) {
    e.previous.copy(e.pos);
    if (!e.alive || e.kind !== 'guard' || dt <= 0) { if (!e.alive) e.vel.set(0,0,0); continue; }
    // Far patrols stay at their post. Alert/moving enemies continue to simulate off-camera.
    if (!e.alert && e.pos.distanceToSquared(player.pos)>110*110) {e.vel.set(0,0,0); continue;}
    let goal, speed;
    if (e.memory && time <= e.expiry) {
      const radial = e.memory.clone().sub(e.pos);
      radial.y = 0;
      const dist = radial.length();
      radial.normalize();
      if (!e.hasLineOfSight || dist > 55) { goal = e.memory; speed = 8; }
      else if (dist < 15) { goal = e.pos.clone().addScaledVector(radial,-8); speed = 8; }
      else {
        const lateral = new Vector3(-radial.z, 0, radial.x).multiplyScalar(e.side);
        if (dist < 25) lateral.addScaledVector(radial, -.55).normalize();
        goal = e.pos.clone().addScaledVector(lateral, 6);
        if (!clear(world,e.pos,goal) && time >= (e.flipAt || 0)) {
          e.side *= -1; e.flipAt = time+.8;
          goal = e.pos.clone().addScaledVector(lateral,-6);
        }
        speed = 6;
      }
    } else {
      goal = e.home.clone();
      goal.x += 3 * Math.sin(time*.45 + e.index);
      goal.z += 4 * Math.sin(time*.33 + e.index*2);
      speed = Math.min(2, goal.distanceTo(e.pos) * 1.5);
    }
    const dir = steer(world,e,goal,time);
    for (const other of world.enemies) {
      if (other === e || !other.alive || Math.abs(other.pos.y-e.pos.y) > e.radius+other.radius) continue;
      const dx = e.pos.x-other.pos.x, dz = e.pos.z-other.pos.z;
      const range = e.radius+other.radius+.6, d2 = dx*dx+dz*dz;
      if (d2 < range*range && d2 > .0001) {
        const d = Math.sqrt(d2), weight = 2*(range-d)/range/d;
        dir.x += dx*weight; dir.z += dz*weight;
      }
    }
    const velocity = dir.normalize().multiplyScalar(speed);
    e.verticalSpeed = Math.max(-28,e.verticalSpeed - 18*dt);
    velocity.y = e.verticalSpeed;
    const offset = e.footOffset ?? e.radius;
    const foot = e.pos.clone(); foot.y -= offset;
    world.move(foot,velocity.clone().multiplyScalar(dt),velocity,e.navRadius ?? e.radius*.72,e.height ?? offset*2);
    e.verticalSpeed = velocity.y;
    e.pos.copy(foot); e.pos.y += offset;
    e.vel.copy(e.pos).sub(e.previous).multiplyScalar(1/dt);
  }
}
function share(world,e,time) {
  if (e.kind !== 'guard' || time < e.reportAt) return;
  e.reportAt = time+.6;
  for (const other of world.enemies) {
    if (other === e || other.kind !== 'guard' || !other.alive || other.hasLineOfSight ||
        e.pos.distanceToSquared(other.pos) > 60*60) continue;
    if (!clear(world,e.pos,other.pos) && !world.walkPath?.(e.pos,other.pos,60)?.length) continue;
    other.memory = e.memory.clone();
    other.expiry = time+8;
    other.alert = true;
  }
}

export function updateEnemies(world, player, now, launch) {
  const center = playerCenter(player);
  for (const e of world.enemies) {
    if (!e.alive) {
      e.warning = e.alert = e.hasLineOfSight = false;
      continue;
    }
    const cfg = ENEMY_WEAPONS[e.kind];
    const visible = e.pos.distanceToSquared(center) <= cfg.range**2 && clear(world,e.pos,center);
    if (visible) {
      if (!e.hasLineOfSight) e.sightSince = now;
      e.memory = center.clone(); e.expiry = now+8;
      e.alert = true;
      share(world,e,now);
      if (e.firstBurst === null) {
        e.firstBurst = now+cfg.delay;
        e.nextBurst = e.firstBurst;
      }
      const muzzle = e.pos.clone().addScaledVector(safeDirection(center.clone().sub(e.pos)),e.radius*.78);
      const r = center.clone().sub(muzzle);
      const t = interceptTime(r,player.vel,cfg.speed,1000);
      const lead = Math.min(1.2,t ?? r.length()/cfg.speed);
      const dir = safeDirection(r.addScaledVector(player.vel,lead));
      e.facing.copy(dir);
      const start = Math.max(e.nextBurst,e.sightSince+cfg.warning);
      e.warning = e.rounds === 0 && now+EPS >= start-cfg.warning && now < start;
      if (!e.rounds && now+EPS >= start) {
        e.burstAt = start;
        e.nextBurst = start+cfg.cycle;
        e.rounds = cfg.burst;
      }
      if (e.rounds && now+EPS >= e.burstAt+(cfg.burst-e.rounds)*cfg.spacing) {
        if (clear(world,e.pos,muzzle) && clear(world,muzzle,center)) {
          launch(e,cfg,muzzle,dir);
          e.shotsFired++;
          e.lastShotAtSeconds = now;
        }
        e.rounds--;
      }
    } else {
      e.sightSince = null; e.warning = false;
      // Never queue rounds through a wall. Retain the next attack time.
      e.rounds = 0;
      if (now > e.expiry) {e.alert = false; e.memory = null;}
    }
    e.hasLineOfSight = visible;
  }
}
