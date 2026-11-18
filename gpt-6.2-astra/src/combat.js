import { Vector3 } from 'three';
import { FCS, stats, spendEN, MOVEMENT } from './movement.js';
import { WEAPONS, LOCK_RANGE, inactive, solve, safeDirection, sweepSphere, interceptTime, turnToward } from './ballistics.js';
import { initializeEnemy, moveEnemies, updateEnemies, playerCenter } from './enemy-ai.js';

const EPS = 1e-8;
function lineClear(world, a, b) {return world.hit(a,b) >= 1 - EPS;}

function closestHit(world, a, b, from = 1, to = 1) {
  let fraction = world.hit(a, b), target = null;
  for (const e of world.enemies) {
    if (!e.alive) continue;
    const oldCenter = from === 1 ? e.pos : e.previous.clone().lerp(e.pos, from);
    const newCenter = to === 1 ? e.pos : e.previous.clone().lerp(e.pos, to);
    const f = sweepSphere(a,b,oldCenter,newCenter,e.radius);
    if (f < fraction) { fraction = f; target = e; }
  }
  return {fraction, target};
}

export function createCombat(world, player, loadout) {
  const c = {
    lock: {state:'none',targetId:null,progress:0,radiusCssPx:0},
    fireControl:inactive(player.weapon), recentPlayerShots:[], bullets:[], effects:[],
    notice:'', hitDirection:new Vector3(), hitAt:-Infinity, direction:new Vector3(0,0,-1),
  };
  const timers = { machinegun:0, beam:0, missile:0 };
  let acquiredAt = 0, noticeUntil = 0, serial = 0, previousTime = null;
  let previousPlayer = playerCenter(player);
  const parameters = stats(loadout);
  world.enemies.forEach(initializeEnemy);

  function message(s,t) { c.notice=s; noticeUntil=t+0.7; }
  function mark(kind,a,b,life) {c.effects.push({kind,a:a.clone(),b:b.clone(),life,duration:life});}
  function damage(target,n,point) {
    if (!target?.alive) return;
    target.hp = Math.max(0,target.hp-n);
    if (target.hp === 0) {
      target.alive = target.alert = target.warning = target.hasLineOfSight = false;
      target.vel.set(0,0,0);
      mark('explosion',target.pos,target.pos,.52);
    } else mark('impact',point,point,.13);
  }
  function lockAndAim(time,camera,w,h,muzzle) {
    const lock = c.lock;
    lock.radiusCssPx = FCS[loadout.fcs].radius * Math.min(w,h);
    const forward = camera.getWorldDirection(new Vector3());
    let best = null, bestScore = Infinity;
    for (const e of world.enemies) {
      if (!e.alive || e.pos.distanceToSquared(muzzle)>LOCK_RANGE**2+1e-8) continue;
      if (e.pos.clone().sub(camera.position).dot(forward) <= 0) continue;
      const screen = e.pos.clone().project(camera);
      if (Math.abs(screen.x)>1 || Math.abs(screen.y)>1 || screen.z < -1 || screen.z > 1) continue;
      const score = (screen.x*w/2)**2 + (screen.y*h/2)**2;
      if (score > lock.radiusCssPx**2) continue;
      if (!lineClear(world,camera.position,e.pos) || !lineClear(world,muzzle,e.pos)) continue;
      if (e.id === lock.targetId) {best=e; break;}
      if (score < bestScore || (score === bestScore && e.id < best.id)) {bestScore=score; best=e;}
    }
    if (lock.targetId !== (best?.id ?? null)) acquiredAt = time;
    lock.targetId = best?.id ?? null;
    const elapsed = Math.max(0,time-acquiredAt);
    lock.progress = best ? (elapsed + 1e-12 >= parameters.lockSeconds ? 1 : elapsed/parameters.lockSeconds) : 0;
    lock.state = !best ? 'none' : lock.progress >= 1 ? 'locked' : 'acquiring';
    c.fireControl = lock.state === 'locked' ? solve(player.weapon,muzzle,best,time,forward) : inactive(player.weapon);
    if (c.fireControl.launchDirection) c.direction.fromArray(c.fireControl.launchDirection);
    else {
      const far = camera.position.clone().addScaledVector(forward,250);
      const hit = closestHit(world,camera.position,far).fraction;
      const point = camera.position.clone().lerp(far,Number.isFinite(hit)?hit:1);
      c.direction.copy(safeDirection(point.sub(muzzle),forward));
    }
    return lock.state === 'locked' ? best : null;
  }

  function fireWeapon(time, muzzle, target) {
    const kind = player.weapon, cfg = WEAPONS[kind], fc = c.fireControl;
    if (time + EPS < timers[kind]) return;
    if (kind === 'missile' && !target) {message('LOCK REQUIRED',time);return;}
    if (kind !== 'beam' && !player.ammo[kind]) {message('AMMO DEPLETED',time);return;}
    if (kind === 'beam' && !spendEN(player,cfg.cost,time)) {message('INSUFFICIENT EN',time);return;}
    timers[kind] = time+cfg.interval;
    const dir = c.direction.clone();
    const vel = kind === 'beam' ? null : dir.clone().multiplyScalar(cfg.speed);
    c.recentPlayerShots.push({id:++serial,firedAtSeconds:time,weapon:kind,targetId:target?.id ?? null,
      solutionStatus:fc.status,muzzlePosition:muzzle.toArray(),targetPositionAtFire:fc.targetPosition?.slice() ?? null,
      targetVelocityAtFire:fc.targetVelocity?.slice() ?? null,launchDirection:dir.toArray(),
      initialVelocity:vel?.toArray() ?? null,accelerationAtFire:[0,cfg.gravity || 0,0],
      predictedFlightSeconds:fc.predictedFlightSeconds,predictedInterceptPosition:fc.predictedInterceptPosition?.slice() ?? null});
    if (c.recentPlayerShots.length>32) c.recentPlayerShots.shift();
    if (kind === 'beam') {
      const end = muzzle.clone().addScaledVector(dir,cfg.range);
      const {fraction, target:hit} = closestHit(world,muzzle,end);
      if (Number.isFinite(fraction)) end.lerpVectors(muzzle,end,fraction);
      mark(kind,muzzle,end,.13);
      if (hit) damage(hit,cfg.damage,end);
    } else {
      player.ammo[kind]--;
      c.bullets.push({kind,pos:muzzle.clone(),origin:muzzle.clone(),dir,velocity:vel,age:0,life:cfg.life,
        damage:cfg.damage,targetId:target?.id ?? null, observed:target?.pos.clone(), observedVelocity:target?.vel.clone(), observedAge:0});
      mark(kind,muzzle,muzzle.clone().addScaledVector(dir,1.2),.055);
    }
  }

  function advanceBullets(dt, currentPlayer, now) {
    if (dt <= 0) return;
    for (let i=c.bullets.length-1;i>=0;i--) {
      const b = c.bullets[i];
      const h = Math.min(dt,b.life-b.age);
      const end = b.pos.clone();
      const nextAge = b.age+h;
      if (b.kind === 'machinegun') {
        end.copy(b.origin).addScaledVector(b.velocity,nextAge);
        end.y += .5*WEAPONS.machinegun.gravity*nextAge*nextAge;
      } else {
        if (b.kind === 'missile') {
          const target = world.enemies.find(e=>e.id===b.targetId);
          if (target?.alive) {
            if (lineClear(world,b.pos,target.previous)) {
              b.observed.copy(target.previous); b.observedVelocity.copy(target.startVelocity);
              b.observedAge=b.age;
            }
            const r = b.observed.clone().addScaledVector(b.observedVelocity,b.age-b.observedAge).sub(b.pos);
            const t = interceptTime(r,b.observedVelocity,WEAPONS.missile.speed,b.life-b.age);
            const desired = safeDirection(r.addScaledVector(b.observedVelocity,t??0),b.dir);
            turnToward(b.dir,desired,WEAPONS.missile.turn*h);
            b.velocity.copy(b.dir).multiplyScalar(WEAPONS.missile.speed);
          }
        }
        end.addScaledVector(b.velocity,h);
      }
      let fraction,enemy = null,playerHit = false;
      if (!b.hostile) ({fraction,target:enemy}=closestHit(world,b.pos,end,0,h/dt));
      else {
        fraction = world.hit(b.pos,end);
        const finish = previousPlayer.clone().lerp(currentPlayer,h/dt);
        const offsets = [MOVEMENT.radius-2, -0.35, MOVEMENT.height-MOVEMENT.radius-2];
        for (const dy of offsets) {
          const old = previousPlayer.clone(), next = finish.clone();
          old.y+=dy;next.y+=dy;
          const f=sweepSphere(b.pos,end,old,next,MOVEMENT.radius);
          if (f < fraction) {fraction=f;playerHit=true;}
        }
      }
      b.age=nextAge;
      if (Number.isFinite(fraction)) {
        const point = b.pos.clone().lerp(end,fraction);
        if (playerHit) {
          player.hp = Math.max(0,player.hp-b.damage);
          c.hitDirection.copy(b.origin).sub(point).normalize(); c.hitAt=now;
          mark('impact',point,point,.13);
        } else if (enemy) damage(enemy,b.damage,point);
        else mark('impact',point,point,.09);
        c.bullets.splice(i,1);
      } else if (b.age >= b.life-1e-10) c.bullets.splice(i,1);
      else b.pos.copy(end);
    }
  }
  function launchEnemy(e,cfg,muzzle,dir) {
    const kind = e.kind==='guard'?'enemyGuard':'enemyTurret';
    c.bullets.push({kind,hostile:true,pos:muzzle.clone(),origin:muzzle.clone(),dir,
      velocity:dir.clone().multiplyScalar(cfg.speed),age:0,life:cfg.life,damage:cfg.damage});
    mark(kind,muzzle,muzzle.clone().addScaledVector(dir,1.2),.07);
  }
  // This phase also drives the isolated live-fire range. Actor carriers own
  // their motion; previous/pos bracket the exact interval for relative sweeps.
  c.stepWeapons = function(dt,time,camera,w,h,muzzle,fire) {
    if (time >= noticeUntil) c.notice='';
    for (let i=c.effects.length-1;i>=0;i--) {
      c.effects[i].life -= dt;
      if (c.effects[i].life <= 0) c.effects.splice(i,1);
    }
    const current = playerCenter(player);
    advanceBullets(dt,current,time);
    previousPlayer=current;
    const target = lockAndAim(time,camera,w,h,muzzle);
    if (fire && player.hp>0) fireWeapon(time,muzzle,target);
    if (target && !target.alive) lockAndAim(time,camera,w,h,muzzle);
  };
  c.step = function(dt,time,camera,w,h,muzzle,fire) {
    const interval = previousTime === null ? 0 : Math.max(0,time-previousTime);
    previousTime=time;
    for (const e of world.enemies) {
      if (!e.startVelocity) e.startVelocity = e.vel.clone();
      else e.startVelocity.copy(e.vel);
    }
    moveEnemies(world,interval,time,player);
    c.stepWeapons(interval,time,camera,w,h,muzzle,fire);
    if (player.hp>0) updateEnemies(world,player,time,launchEnemy);
  };
  return c;
}
