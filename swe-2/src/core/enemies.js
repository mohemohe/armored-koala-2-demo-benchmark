// Enemy simulation: guard robots (mobile) and fixed turrets.
// Independent attack timers, bursts with telegraphs, lead prediction,
// last-seen memory, sector-graph pursuit. No DOM/three dependencies.

import { PARAMS } from './params.js';
import { solveLeadTime } from './ballistics.js';

const E = PARAMS.enemies;

export class Enemy {
  constructor(sp) {
    const spec = E[sp.kind];
    this.id = sp.id;
    this.kind = sp.kind;
    this.spec = spec;
    this.sectorId = sp.sectorId;
    this.isGateControl = sp.isGateControl;
    this.barrierId = sp.barrierId;
    this.pos = sp.pos.slice();
    this.prevPos = sp.pos.slice();
    this.vel = [0, 0, 0];
    this.homePos = sp.pos.slice();
    this.hp = spec.hp;
    this.alive = true;
    this.radius = spec.hitRadius;

    this.alert = false;
    this.hasLineOfSight = false;
    this.lastSeenPos = null;
    this.lastSeenAt = -Infinity;
    this.seenBefore = false;

    // fire scheduling (absolute sim times)
    this.nextBurstAt = Infinity;
    this.burstActive = false;
    this.burstLeft = 0;
    this.burstT0 = 0;
    this.shotsFired = 0;
    this.lastShotAt = null;
    this.telegraph = false;

    // guard movement
    this.strafeSign = 1;
    this.scriptVel = [0, 0, 0];   // 'dummy' kind: externally scripted velocity
    this.centerOffY = sp.kind === 'turret' ? 1.1 : 1.0;
    this.lostSince = null;
    this.path = null;         // [waypoint,...]
    this.stuckT = 0;
    this.sidestepT = 0;
    this.sidestepDir = [0, 0];
    this.aimYaw = 0;
  }

  muzzle() {
    if (this.kind === 'turret') return [this.pos[0], this.pos[1] + 1.45, this.pos[2]];
    const a = this.aimYaw;
    return [this.pos[0] + Math.sin(a) * 0.5, this.pos[1] + 1.35, this.pos[2] + Math.cos(a) * 0.5];
  }

  center() {
    return [this.pos[0], this.pos[1] + this.centerOffY, this.pos[2]];
  }

  prevCenter() {
    return [this.prevPos[0], this.prevPos[1] + this.centerOffY, this.prevPos[2]];
  }
}

// Build live enemy list from stage spawns.
export function makeEnemies(spawns) {
  return spawns.map(sp => new Enemy(sp));
}

// Sector graph BFS: returns list of door positions from sectorA to sectorB.
function findSectorPath(adjacency, from, to, isBarrierOpen) {
  if (from === to) return [];
  const prev = new Map([[from, null]]);
  const q = [from];
  while (q.length) {
    const cur = q.shift();
    for (const e of (adjacency[cur] || [])) {
      if (prev.has(e.to)) continue;
      if (e.barrier && !isBarrierOpen(e.barrier)) continue;
      prev.set(e.to, { from: cur, door: e.pos });
      if (e.to === to) {
        const doors = [];
        let s = to;
        while (prev.get(s)) { doors.unshift(prev.get(s).door); s = prev.get(s).from; }
        return doors;
      }
      q.push(e.to);
    }
  }
  return null;
}

export function updateEnemy(en, dt, ctx) {
  if (!en.alive) { en.vel = [0, 0, 0]; return; }
  if (en.kind === 'dummy') {
    en.prevPos = en.pos.slice();
    en.pos = [en.pos[0] + en.scriptVel[0] * dt, en.pos[1] + en.scriptVel[1] * dt, en.pos[2] + en.scriptVel[2] * dt];
    en.vel = en.scriptVel.slice();
    return;
  }
  const spec = en.spec;
  const now = ctx.now;
  en.prevPos = en.pos.slice();

  const pCenter = ctx.playerCenter();
  const dx = pCenter[0] - en.pos[0], dy = pCenter[1] - en.center()[1], dz = pCenter[2] - en.pos[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // --- perception ---
  let canSee = false;
  if (ctx.playerAlive && dist <= spec.range) {
    canSee = ctx.world.lineOfSight(en.muzzle(), pCenter);
  }
  const wasLOS = en.hasLineOfSight;
  en.hasLineOfSight = canSee;

  if (canSee) {
    en.lastSeenPos = pCenter.slice();
    en.lastSeenAt = now;
    if (!en.alert) {
      en.alert = true;
      en.seenBefore = true;
      en.nextBurstAt = now + spec.firstDelay;
      if (en.kind === 'guard') shareAlert(en, ctx);
    }
    // re-exposure: honor kept ready time + required telegraph
    if (!wasLOS) {
      if (en.burstActive && en.burstLeft > 0) {
        const k = en.spec.burst - en.burstLeft;
        en.burstT0 = now + en.spec.telegraph - k * en.spec.shotInterval;
      } else if (now > en.nextBurstAt - en.spec.telegraph) {
        en.nextBurstAt = now + en.spec.telegraph;
      }
    }
  } else {
    if (wasLOS) en.lostSince = now;
    if (en.alert && now - en.lastSeenAt > E.memoryTime) {
      en.alert = false;
      en.burstActive = false;
      en.burstLeft = 0;
    }
  }

  // --- fire schedule ---
  en.telegraph = false;
  const n = spec.burst, iv = spec.shotInterval;
  if (en.alert) {
    if (canSee) {
      if (!en.burstActive && now >= en.nextBurstAt) {
        en.burstActive = true;
        en.burstLeft = n;
        en.burstT0 = en.nextBurstAt;
        en.nextBurstAt += en.spec.period;
      }
      if (en.burstActive) {
        const k = n - en.burstLeft;
        if (now >= en.burstT0 + k * iv - en.spec.telegraph) en.telegraph = true;
        while (en.burstLeft > 0 && now >= en.burstT0 + (n - en.burstLeft) * iv) {
          fireShot(en, ctx, pCenter);
          en.burstLeft--;
        }
        if (en.burstLeft === 0) en.burstActive = false;
      } else if (now >= en.nextBurstAt - en.spec.telegraph) {
        en.telegraph = true;
      }
    } else {
      // occluded: schedule advances, shots are skipped
      if (en.burstActive) {
        while (en.burstLeft > 0 && now >= en.burstT0 + (n - en.burstLeft) * iv) en.burstLeft--;
        if (en.burstLeft === 0) en.burstActive = false;
      }
      if (!en.burstActive) {
        while (now >= en.nextBurstAt + (n - 1) * iv) en.nextBurstAt += en.spec.period;
        if (now >= en.nextBurstAt) {
          en.burstActive = true;
          en.burstLeft = n;
          en.burstT0 = en.nextBurstAt;
          en.nextBurstAt += en.spec.period;
          while (en.burstLeft > 0 && now >= en.burstT0 + (n - en.burstLeft) * iv) en.burstLeft--;
          if (en.burstLeft === 0) en.burstActive = false;
        }
      }
    }
  }

  // --- movement ---
  if (en.kind === 'guard') updateGuardMovement(en, dt, ctx, dist, canSee, pCenter);
  else {
    // turret: just track aim yaw for rendering/muzzle
    if (en.lastSeenPos) en.aimYaw = Math.atan2(en.lastSeenPos[0] - en.pos[0], en.lastSeenPos[2] - en.pos[2]);
    en.vel = [0, 0, 0];
  }
}

function shareAlert(en, ctx) {
  // share lastSeenPos with guards within 60m reachable via <=2 sector hops
  for (const other of ctx.enemies) {
    if (other === en || !other.alive || other.kind !== 'guard') continue;
    const dx = other.pos[0] - en.pos[0], dy = other.pos[1] - en.pos[1], dz = other.pos[2] - en.pos[2];
    if (dx * dx + dy * dy + dz * dz > E.alertShareRange * E.alertShareRange) continue;
    const hops = sectorHops(ctx.stage.adjacency, en.sectorId, other.sectorId, ctx.isBarrierOpen, 2);
    if (hops === null) continue;
    other.alert = true;
    other.lastSeenPos = en.lastSeenPos.slice();
    other.lastSeenAt = ctx.now;
    other.lostSince = ctx.now;
  }
}

function sectorHops(adj, from, to, isBarrierOpen, maxHops) {
  if (from === to) return 0;
  const seen = new Set([from]);
  let frontier = [from];
  for (let h = 1; h <= maxHops; h++) {
    const next = [];
    for (const s of frontier) {
      for (const e of (adj[s] || [])) {
        if (seen.has(e.to)) continue;
        if (e.barrier && !isBarrierOpen(e.barrier)) continue;
        if (e.to === to) return h;
        seen.add(e.to);
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return null;
}

function updateGuardMovement(en, dt, ctx, dist, canSee, pCenter) {
  const spec = en.spec;
  const now = ctx.now;
  let wish = null; // desired XZ direction
  let speed = 0;

  if (canSee) {
    if (dist > spec.approachAbove) {
      wish = toward(en.pos, pCenter); speed = spec.speedApproach;
    } else if (dist < spec.retreatBelow) {
      wish = away(en.pos, pCenter); speed = spec.speedRetreat;
    } else {
      // strafe band: orbit + radial correction toward ~35m
      const t = toward(en.pos, pCenter);
      const perp = [-t[1] * en.strafeSign, t[0] * en.strafeSign];
      let radial = 0;
      if (dist < spec.strafeMin) radial = -0.7;
      else if (dist > spec.strafeMax) radial = 0.7;
      wish = norm2([perp[0] + t[0] * radial, perp[1] + t[1] * radial]);
      speed = spec.speedStrafe;
    }
    en.path = null;
  } else if (en.alert && en.lastSeenPos && now >= (en.lostSince ?? now) + E.lostMoveDelay) {
    // pursue last seen position via sector path
    const target = en.lastSeenPos;
    const targetSector = ctx.stage.sectorAt(target) || en.sectorId;
    if (!en.path || en.pathGoal !== targetSector) {
      en.path = findSectorPath(ctx.stage.adjacency, en.sectorId, targetSector, ctx.isBarrierOpen) || [];
      en.path.push([target[0], target[1], target[2]]);
      en.pathGoal = targetSector;
    }
    const wp = en.path.length ? en.path[0] : [target[0], target[1], target[2]];
    const d = Math.hypot(wp[0] - en.pos[0], wp[2] - en.pos[2]);
    if (d < 1.8 && en.path.length) en.path.shift();
    if (!en.path.length && Math.hypot(target[0] - en.pos[0], target[2] - en.pos[2]) < 2) {
      wish = null; speed = 0; // arrived at last seen point
    } else {
      const w = en.path.length ? en.path[0] : target;
      wish = toward(en.pos, w); speed = spec.speedApproach;
    }
  }

  // obstacle avoidance & edge guard
  let mvx = 0, mvz = 0;
  if (wish && speed > 0) {
    if (en.sidestepT > 0) { en.sidestepT -= dt; wish = en.sidestepDir; }
    mvx = wish[0] * speed * dt;
    mvz = wish[1] * speed * dt;
    // edge guard: refuse moves off drops > 1.5m
    const nx = en.pos[0] + mvx * 2.5, nz = en.pos[2] + mvz * 2.5;
    const gh = ctx.world.groundHeightAt(nx, nz, en.pos[1] + 0.2, 1.0);
    if (gh < en.pos[1] - 1.5 && canSee) { mvx = 0; mvz = 0; }
    else if (gh < en.pos[1] - 2.0) { mvx = 0; mvz = 0; }
  }

  // integrate with collision (guards are 0.6 x 1.6 x 0.6)
  const before = en.pos.slice();
  if (mvx !== 0 || mvz !== 0) {
    const ext = [1.2, 1.6, 1.2];
    const min = [en.pos[0] - 0.6, en.pos[1], en.pos[2] - 0.6];
    const r = ctx.world.sweepAABB(min, ext, [mvx, 0, mvz]);
    en.pos = [r.pos[0] + 0.6, r.pos[1], r.pos[2] + 0.6];
    // stuck check
    const moved = Math.hypot(en.pos[0] - before[0], en.pos[2] - before[2]);
    const wanted = Math.hypot(mvx, mvz);
    if (wanted > 1e-4 && moved < wanted * 0.25) {
      en.stuckT += dt;
      if (en.stuckT > E.stuckCheckInterval) {
        en.stuckT = 0;
        en.sidestepT = 0.5;
        const s = ctx.rng.sign();
        en.sidestepDir = [-wish[1] * s, wish[0] * s];
        en.strafeSign *= -1;
      }
    } else en.stuckT = 0;
  }

  // ground snap
  const gh = ctx.world.groundHeightAt(en.pos[0], en.pos[2], en.pos[1] + 0.5, 1.2);
  if (gh > -Infinity) en.pos[1] = gh;

  en.vel = [(en.pos[0] - before[0]) / dt, 0, (en.pos[2] - before[2]) / dt];
  en.vel[1] = (en.pos[1] - before[1]) / dt;

  // aim yaw toward last seen / player
  const tgt = canSee ? pCenter : en.lastSeenPos;
  if (tgt) en.aimYaw = Math.atan2(tgt[0] - en.pos[0], tgt[2] - en.pos[2]);
}

function fireShot(en, ctx, pCenter) {
  const spec = en.spec;
  const m = en.muzzle();
  // per-shot LOS verification from muzzle to player hit center
  if (!ctx.world.lineOfSight(m, pCenter)) return;
  const r = [pCenter[0] - m[0], pCenter[1] - m[1], pCenter[2] - m[2]];
  const v = ctx.playerVelocity();
  let t = solveLeadTime(r, v, spec.bulletSpeed, 1e9);
  if (t === null) t = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]) / spec.bulletSpeed;
  t = Math.min(t, E.leadMaxTime);
  const aim = [pCenter[0] + v[0] * t, pCenter[1] + v[1] * t, pCenter[2] + v[2] * t];
  let dir = [aim[0] - m[0], aim[1] - m[1], aim[2] - m[2]];
  const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  dir = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
  // spread: rotate by <=0.5deg
  dir = applySpread(dir, E.spreadDeg * Math.PI / 180, ctx.rng);
  en.shotsFired++;
  en.lastShotAt = ctx.now;
  ctx.spawnEnemyBullet(m, dir, spec);
}

function applySpread(dir, maxAng, rng) {
  const ang = rng.next() * maxAng;
  const phi = rng.next() * Math.PI * 2;
  const t = Math.tan(ang);
  // orthonormal basis
  const up = Math.abs(dir[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const u = norm3(cross3(dir, up));
  const w = cross3(dir, u);
  const ox = Math.cos(phi) * t, oy = Math.sin(phi) * t;
  return norm3([
    dir[0] + u[0] * ox + w[0] * oy,
    dir[1] + u[1] * ox + w[1] * oy,
    dir[2] + u[2] * ox + w[2] * oy,
  ]);
}

function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function norm2(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
function toward(from, to) { return norm2([to[0] - from[0], to[2] - from[2]]); }
function away(from, to) { return norm2([from[0] - to[0], from[2] - to[2]]); }
