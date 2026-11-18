// Projectiles: player machinegun bullets (gravity), beams (hitscan),
// hand missiles (guided), enemy bullets. Swept collision against the world
// and moving entity hit-spheres. No DOM/three dependencies.

import { PARAMS } from './params.js';
import { sweptPointSphere } from './world.js';
import { solveLeadTime, rotateToward } from './ballistics.js';

const W = PARAMS.weapons;

export class Projectiles {
  constructor() { this.clear(); }
  clear() {
    this.playerBullets = [];   // {kind:'mg', m:[..], v0:[..], age, pos:[..]}
    this.enemyBullets = [];    // {pos, vel, age, life, damage}
    this.missiles = [];        // {pos, vel, age, targetId, obsPos, obsVel, obsAt}
    this.fx = [];              // transient visuals {kind,pos,...}
  }

  spawnMachinegun(muzzle, v0) {
    this.playerBullets.push({ kind: 'mg', m: muzzle.slice(), v0: v0.slice(), age: 0, pos: muzzle.slice() });
  }

  spawnEnemyBullet(muzzle, dir, spec) {
    this.enemyBullets.push({
      pos: muzzle.slice(),
      vel: [dir[0] * spec.bulletSpeed, dir[1] * spec.bulletSpeed, dir[2] * spec.bulletSpeed],
      age: 0, life: spec.bulletLife, damage: spec.damage,
    });
  }

  spawnMissile(muzzle, v0, targetId) {
    this.missiles.push({
      pos: muzzle.slice(), vel: v0.slice(), age: 0,
      targetId, obsPos: null, obsVel: [0, 0, 0], obsAt: -1e9,
    });
  }

  spawnBeamFx(from, to) {
    this.fx.push({ kind: 'beam', from: from.slice(), to: to.slice(), age: 0 });
  }

  // ---- update ---------------------------------------------------------
  // ctx: {world, enemies, player, playerPrevCenter, damageEnemy, damagePlayer, events, now}
  update(dt, ctx) {
    this._playerBullets(dt, ctx);
    this._missiles(dt, ctx);
    this._enemyBullets(dt, ctx);
    for (const f of this.fx) f.age += dt;
    this.fx = this.fx.filter(f => f.age < 0.4);
  }

  _playerBullets(dt, ctx) {
    const g = W.machinegun.gravity;
    const life = W.machinegun.life;
    const out = [];
    for (const b of this.playerBullets) {
      const a0 = b.age, a1 = b.age + dt;
      const p0 = [b.m[0] + b.v0[0] * a0, b.m[1] + b.v0[1] * a0 - 0.5 * g * a0 * a0, b.m[2] + b.v0[2] * a0];
      const p1 = [b.m[0] + b.v0[0] * a1, b.m[1] + b.v0[1] * a1 - 0.5 * g * a1 * a1, b.m[2] + b.v0[2] * a1];
      let hitT = 2, hitEnemy = null, hitPoint = null;
      const wHit = ctx.world.raycastSegment(p0, p1);
      if (wHit) { hitT = wHit.t; hitPoint = wHit.point; }
      for (const en of ctx.enemies) {
        if (!en.alive) continue;
        const t = sweptPointSphere(p0, p1, en.prevCenter(), en.center(), en.radius);
        if (t !== null && t < hitT) {
          hitT = t; hitEnemy = en;
          hitPoint = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t];
        }
      }
      b.age = a1;
      if (hitEnemy) {
        ctx.damageEnemy(hitEnemy, W.machinegun.damage, hitPoint, 'machinegun');
        ctx.events.push({ type: 'impact', at: hitPoint });
        continue;
      }
      if (hitPoint) { ctx.events.push({ type: 'impact', at: hitPoint }); continue; }
      if (b.age >= life) continue;
      b.pos = p1;
      out.push(b);
    }
    this.playerBullets = out;
  }

  _missiles(dt, ctx) {
    const spec = W.missile;
    const out = [];
    for (const ms of this.missiles) {
      ms.age += dt;
      // guidance
      const tgt = ctx.enemies.find(e => e.id === ms.targetId && e.alive);
      if (tgt) {
        const tc = tgt.center();
        const tv = tgt.vel;
        if (ctx.world.lineOfSight(ms.pos, tc)) {
          ms.obsPos = tc.slice(); ms.obsVel = tv.slice(); ms.obsAt = ctx.now;
        }
        const ex = ms.obsPos
          ? [ms.obsPos[0] + ms.obsVel[0] * (ctx.now - ms.obsAt),
             ms.obsPos[1] + ms.obsVel[1] * (ctx.now - ms.obsAt),
             ms.obsPos[2] + ms.obsVel[2] * (ctx.now - ms.obsAt)]
          : tc;
        const r = [ex[0] - ms.pos[0], ex[1] - ms.pos[1], ex[2] - ms.pos[2]];
        const rem = Math.max(0.01, Math.min(4, spec.life - ms.age + dt));
        const t = solveLeadTime(r, ms.obsVel, spec.speed, rem);
        const aim = t === null ? r : [r[0] + ms.obsVel[0] * t, r[1] + ms.obsVel[1] * t, r[2] + ms.obsVel[2] * t];
        const al = Math.hypot(aim[0], aim[1], aim[2]) || 1;
        const desired = [aim[0] / al, aim[1] / al, aim[2] / al];
        const cur = norm3(ms.vel);
        const nd = rotateToward(cur, desired, spec.turnRate * dt);
        ms.vel = [nd[0] * spec.speed, nd[1] * spec.speed, nd[2] * spec.speed];
      }
      // move & collide
      const p1 = [ms.pos[0] + ms.vel[0] * dt, ms.pos[1] + ms.vel[1] * dt, ms.pos[2] + ms.vel[2] * dt];
      let hitT = 2, hitEnemy = null, hitPoint = null;
      const wHit = ctx.world.raycastSegment(ms.pos, p1);
      if (wHit) { hitT = wHit.t; hitPoint = wHit.point; }
      for (const en of ctx.enemies) {
        if (!en.alive) continue;
        const t = sweptPointSphere(ms.pos, p1, en.prevCenter(), en.center(), en.radius);
        if (t !== null && t < hitT) {
          hitT = t; hitEnemy = en;
          hitPoint = [ms.pos[0] + (p1[0] - ms.pos[0]) * t, ms.pos[1] + (p1[1] - ms.pos[1]) * t, ms.pos[2] + (p1[2] - ms.pos[2]) * t];
        }
      }
      if (hitEnemy) {
        ctx.damageEnemy(hitEnemy, spec.damage, hitPoint, 'missile');
        ctx.events.push({ type: 'explosion', at: hitPoint, big: true });
        continue;
      }
      if (hitPoint) { ctx.events.push({ type: 'explosion', at: hitPoint }); continue; }
      if (ms.age >= spec.life) { ctx.events.push({ type: 'explosion', at: ms.pos }); continue; }
      ms.pos = p1;
      out.push(ms);
    }
    this.missiles = out;
  }

  _enemyBullets(dt, ctx) {
    const out = [];
    const pc0 = ctx.playerPrevCenter, pc1 = ctx.playerCenter();
    for (const b of this.enemyBullets) {
      const p1 = [b.pos[0] + b.vel[0] * dt, b.pos[1] + b.vel[1] * dt, b.pos[2] + b.vel[2] * dt];
      let hitT = 2, hitPoint = null, hitPlayer = false;
      const wHit = ctx.world.raycastSegment(b.pos, p1);
      if (wHit) { hitT = wHit.t; hitPoint = wHit.point; }
      if (ctx.playerAlive) {
        const t = sweptPointSphere(b.pos, p1, pc0, pc1, PARAMS.player.hitRadius);
        if (t !== null && t < hitT) { hitT = t; hitPlayer = true; hitPoint = [b.pos[0] + b.vel[0] * dt * t, b.pos[1] + b.vel[1] * dt * t, b.pos[2] + b.vel[2] * dt * t]; }
      }
      b.age += dt;
      if (hitPlayer) {
        ctx.damagePlayer(b.damage, b.vel);
        ctx.events.push({ type: 'impact', at: hitPoint });
        continue;
      }
      if (hitPoint) { ctx.events.push({ type: 'impact', at: hitPoint }); continue; }
      if (b.age >= b.life) continue;
      b.pos = p1;
      out.push(b);
    }
    this.enemyBullets = out;
  }
}

// Instant beam shot: returns {point, enemy|null}.
export function beamHitscan(world, enemies, muzzle, dir, range) {
  const end = [muzzle[0] + dir[0] * range, muzzle[1] + dir[1] * range, muzzle[2] + dir[2] * range];
  let bestT = 1, bestEnemy = null, point = end;
  const wHit = world.raycastSegment(muzzle, end);
  if (wHit) { bestT = wHit.t; point = wHit.point; }
  for (const en of enemies) {
    if (!en.alive) continue;
    const t = sweptPointSphere(muzzle, end, en.center(), en.center(), en.radius);
    if (t !== null && t < bestT) {
      bestT = t; bestEnemy = en;
      point = [muzzle[0] + dir[0] * range * t, muzzle[1] + dir[1] * range * t, muzzle[2] + dir[2] * range * t];
    }
  }
  return { point, enemy: bestEnemy };
}

function norm3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
