import assert from 'node:assert/strict';
import { Vector3, PerspectiveCamera, Quaternion } from 'three';
import { buildMech } from '../src/model.js';
import { createCombat } from '../src/combat.js';
import { solve, interceptTime, sweepSphere, WEAPONS, turnToward } from '../src/ballistics.js';
import { createPlayer, stepMovement } from '../src/movement.js';

const V = (x=0,y=0,z=0) => new Vector3(x,y,z);
const m = V(0,20,0), dt = 1/120;
const base = {legs:'biped', fcs:'medium', generator:'balanced'};
const cases = [
  ...[20,60,100,120].map(d=>[[0,0,d],[0,0,0]]),
  [[0,0,100],[8,0,0]], [[0,0,100],[-8,0,0]], [[0,0,100],[0,0,8]], [[0,0,100],[0,0,-8]],
  [[0,16,100],[6,0,0]], [[0,-16,100],[-6,0,0]], [[0,0,100],[6,3,0]], [[0,0,100],[6,-3,0]], [[0,0,120],[6,3,4]],
];
function enemy(id,kind,pos,v=V(),radius=.5) {
  return {id,kind,pos,vel:v,radius,footOffset:radius,hp:kind==='turret'?240:120,alive:true,isGateControl:false};
}
const floor = {
  move(pos,delta,velocity) {
    pos.add(delta);
    if (pos.y <= 1e-8) {pos.y=0;velocity.y=Math.max(0,velocity.y);return true;}
    return false;
  },
  hit:()=>Infinity,
};
function cameraAt(pos,target) {
  const camera = new PerspectiveCamera(65,16/9,.05,500);
  camera.position.copy(pos);camera.lookAt(target);camera.updateMatrixWorld();
  return camera;
}
function motionInput(mode,tick) {
  const moving = Boolean(mode);
  return {x:moving?1:0,z:0,forward:V(1,0,0),q:mode==='QB'&&tick===90,
    shift:mode==='glide'&&tick===0,jump:mode==='flight'&&tick===0,space:mode==='flight',brake:false};
}
// A constant-velocity carrier provides positions at each time boundary.
// Acquisition, emission, ammunition/EN, trajectory, contact and HP use the production weapon phase.
// Only decal pixels need a canvas. All model transforms are Three.js objects.
globalThis.document={createElement:()=>({getContext:()=>({fillText(){}})})};
const rig=buildMech('biped');
delete globalThis.document;
function liveShot(index,weapon,mode=null) {
  const fireTick = 96, fireAt = fireTick * dt;
  const calibration = createPlayer(base,V());
  for (let i=0;i<fireTick;i++) stepMovement(calibration,motionInput(mode,i),dt,i*dt,floor);
  const yaw=Math.PI;
  const translate=m.clone().sub(rig.positionMuzzle(calibration.pos,yaw,floor,V()));
  const player = createPlayer(base,translate);player.weapon=weapon;
  rig.setWeapon(weapon);
  const [r,v] = cases[index].map(a=>V(...a));
  const targetAtFire = m.clone().add(r);
  const target=enemy('range','turret',targetAtFire.clone().addScaledVector(v,-fireAt),v);
  const world = {...floor,enemies:[target],move(p,d,vel){
    p.add(d);
    if(p.y<=translate.y+1e-10){p.y=translate.y;vel.y=Math.max(0,vel.y);return true;}
    return false;
  }}, c = createCombat(world,player,base);
  const camera = cameraAt(V(),target.pos);
  let measured, lastDir=null, maxTurn=0;
  for (let i=0;i<700;i++) {
    const t=i*dt;
    target.previous.copy(target.pos);
    target.pos.copy(targetAtFire).addScaledVector(v,t-fireAt);
    target.startVelocity=v;
    stepMovement(player,motionInput(mode,i),dt,t,world,()=>{
      const muzzle = rig.positionMuzzle(player.pos,yaw,world,V());
      camera.position.copy(muzzle);camera.position.z-=4;
      camera.lookAt(target.pos);camera.updateMatrixWorld();
      c.stepWeapons(i===0?0:dt,t,camera,1280,720,muzzle,i===fireTick);
      if (i===fireTick) {
        assert.ok(muzzle.distanceTo(m)<1e-8);
        assert.equal(c.lock.state,'locked');
        assert.equal(c.recentPlayerShots.length,1);
        assert.equal(c.fireControl.status,'solved');
        measured=c.fireControl;
        const localDir=c.direction.clone().applyQuaternion(rig.root.getWorldQuaternion(new Quaternion()).invert());
        rig.aimArm(localDir);
        assert.ok(rig.gunPivot.getWorldPosition(V()).distanceTo(muzzle)<1e-9);
        assert.ok(V(0,0,1).applyQuaternion(rig.gunPivot.getWorldQuaternion(new Quaternion())).distanceTo(c.direction)<1e-9);
        if (mode) {
          assert.ok(player.vel.length()>0);
          if (mode==='QB') assert.equal(player.movement.horizontalMode,'quickboost');
          if (mode==='flight') assert.equal(player.movement.verticalMode,'flying');
          if (mode==='glide') assert.equal(player.movement.horizontalMode,'glide');
        }
        if (weapon!=='beam') {
          const b = c.bullets[0];
          assert.equal(b.age,0);
          assert.ok(b.pos.distanceTo(m)<1e-8);
          assert.ok(Math.abs(b.velocity.length()-WEAPONS[weapon].speed)<1e-7);
          assert.deepEqual(b.velocity.toArray(),c.recentPlayerShots[0].initialVelocity);
          if (weapon==='missile') {
            const expected = r.clone().addScaledVector(v,interceptTime(r,v,45,4)).normalize();
            assert.ok(b.dir.distanceTo(expected)<1e-9);
          }
        } else assert.deepEqual(c.fireControl.aimPoint,target.pos.toArray());
      }
      if (weapon==='missile'&&c.bullets.length) {
        const dir=c.bullets[0].dir;
        if(lastDir) maxTurn=Math.max(maxTurn,lastDir.angleTo(dir)/dt);
        lastDir=dir.clone();
      }
    });
    if (target.hp<240) {
      assert.ok(i>=fireTick);
      assert.equal(target.hp,240-WEAPONS[weapon].damage);
      assert.ok(maxTurn<=WEAPONS.missile.turn+1e-6);
      return {residual:measured.residualMeters,t:measured.predictedFlightSeconds};
    }
  }
  assert.fail('miss '+[index+1,weapon,mode]);
}
for (const [weapon,indices,mode] of [
  ['machinegun',cases.keys()],['beam',cases.keys()],['missile',[4,5,6]],
  ...['glide','flight','QB'].map(k=>['machinegun',[4],k])
]) {
  for (const index of indices) {
    let maxResidual=0, t;
    for (let n=0;n<20;n++) {
      const result=liveShot(index,weapon,mode);maxResidual=Math.max(maxResidual,result.residual);t=result.t;
    }
    console.log(weapon,mode||'fixed','A'+String(index+1).padStart(2,'0'),'20/20',maxResidual.toExponential(4),'m',t.toFixed(9),'s');
  }
}
{
  const camera=cameraAt(V(0,2,0),V(0,2,-1));
  const player=createPlayer(base,V());
  const enemies=[enemy('G1','guard',V(-16,2,38),V(),2),enemy('G2','guard',V(16,2,38),V(),2),enemy('T1','turret',V(0,2,46),V(),2)];
  const world={...floor,enemies},c=createCombat(world,player,base);
  const times=enemies.map(()=>[]);let t=0;
  for(let i=0;i<=15*120 && player.hp>0;i++) {
    t=i*dt;c.step(dt,t,camera,1280,720,player.pos.clone().add(V(0,2,0)),false);
    enemies.forEach((e,j)=>{if(e.lastShotAtSeconds===t)times[j].push(t);});
  }
  assert.equal(player.hp,0);assert.ok(t<=15);
  times.forEach((a,j)=>{
    const expected=j<2?[.5,.62,.74,1.7]:[.7,.95,2.3,2.55];
    expected.forEach((v,i)=>assert.ok(Math.abs(a[i]-v)<dt+.000001));
  });
  console.log('2 guards + turret behind camera, stationary HP 1000 -> 0',t.toFixed(6),'s',JSON.stringify(times.map(a=>a.slice(0,6))));
}
{
  // Projectile crossing and a gravity quartic with a double root at t=1.
  assert.ok(sweepSphere(V(-1),V(1),V(0,-1),V(0,1),.01)<.5);
  const target=enemy('t','turret',V(9,0,0),V(82,0,0));
  // Vertical target tangent: 9 t² -18 t + 9 = 0.
  target.pos.set(0,9,0);target.vel.set(0,82,0);
  assert.ok(Math.abs(solve('machinegun',V(),target,0,V(0,1,0)).predictedFlightSeconds-1)<1e-7);
  target.pos.set(0,164,0);target.vel.set(0,0,0);
  assert.ok(Math.abs(solve('machinegun',V(),target,0,V(0,1,0)).predictedFlightSeconds-2)<1e-8);
  assert.equal(interceptTime(V(0,0,90),V(0,0,-45),45,4),1);
  const dir=V(0,0,1),goal=V(0,0,-1);
  turnToward(dir,goal,Math.PI/4);
  assert.ok(Math.abs(dir.angleTo(V(0,0,1))-Math.PI/4)<1e-10);
}
{
  // Keep an existing candidate when another crosses the center, then validate
  // a fresh acquisition, range failure, camera/muzzle occlusion and re-sizing.
  const p=createPlayer(base,V()), camera=cameraAt(m,m.clone().add(V(0,0,20)));
  const a=enemy('a','turret',m.clone().add(V(0,0,60)));
  const b=enemy('b','turret',m.clone().add(V(1,0,60)));
  let blocked=false;
  const world={...floor,enemies:[b,a],hit:(a,b)=>blocked?.45:Infinity};
  const c=createCombat(world,p,base);
  let ticks=0;
  const step=(fire=false,width=1280,height=720)=>{
    c.step(dt,ticks++*dt,camera,width,height,m,fire);
  };
  step();
  assert.equal(c.lock.targetId,'a');
  b.pos.x=0;a.pos.x=1;
  for(let i=0;i<96;i++) step();
  assert.equal(c.lock.targetId,'a');assert.equal(c.lock.state,'locked');
  p.weapon='beam';step(true);
  assert.equal(c.fireControl.weapon,'beam');assert.equal(p.en,112);
  p.weapon='machinegun';step(true);
  p.weapon='beam';step(true);
  assert.equal(c.recentPlayerShots.length,2);
  blocked=true;p.weapon='missile';step(true,1920,900);
  assert.equal(c.recentPlayerShots.length,2);assert.equal(c.notice,'LOCK REQUIRED');
  assert.equal(c.lock.progress,0);assert.equal(c.lock.radiusCssPx,180);
  assert.equal(c.fireControl.targetId,null);
  blocked=false;a.pos.z=121;b.pos.z=121;step();
  assert.equal(c.lock.targetId,null);
  b.pos.z=65;step();
  assert.equal(c.lock.progress,0);assert.equal(c.lock.targetId,'b');
  for(let i=0;i<96;i++) step();
  p.weapon='machinegun';b.vel.z=120;step(true);
  assert.equal(c.lock.state,'locked');assert.equal(c.fireControl.status,'no_solution');
  assert.equal(c.fireControl.predictedFlightSeconds,null);
  assert.deepEqual(c.fireControl.aimPoint,b.pos.toArray());
}
// A beam ends at cover, a solved MG trajectory clips an overhead beam, and a
// target changing direction after emission can avoid a correctly solved shot.
for (const scene of ['ceiling','evade','muzzle-cover']) {
  const p=createPlayer(base,V()), target=enemy('T','turret',m.clone().add(V(0,0,100)),V(8,0,0));
  const camera=cameraAt(m.clone().add(V(-2,0,-2)),target.pos);
  const world={...floor,enemies:[target],hit:(a,b)=>{
    if (scene==='ceiling' && a.y<21 && b.y>=21) return (21-a.y)/(b.y-a.y);
    if (scene==='muzzle-cover' && a.x>=-.4 && b.z>a.z && a.z<=.5 && b.z>=.5) return (.5-a.z)/(b.z-a.z);
    return Infinity;
  }};
  if(scene==='muzzle-cover')p.weapon='beam';
  const c=createCombat(world,p,base);
  for(let i=0;i<400;i++){
    target.previous.copy(target.pos);
    if(i>96 && scene!=='muzzle-cover') {
      if(scene==='evade') target.vel.x=-8;
      target.pos.addScaledVector(target.vel,dt);
    }
    target.startVelocity=target.vel;
    c.stepWeapons(i===0?0:dt,i*dt,camera,1280,720,m,i===96);
    if(i===96) assert.equal(c.recentPlayerShots[0].solutionStatus,scene==='muzzle-cover'?'inactive':'solved');
  }
  assert.equal(target.hp,240,scene);
  assert.equal(c.bullets.length,0);
}
// Exposure interrupted shortly before a turret's second burst. The weapon
// resumes at its ready time, including the required telegraph.
{
  const p=createPlayer(base,V()), e=enemy('T','turret',V(0,2,45));
  let blocked=false;
  const world={...floor,enemies:[e],hit:()=>blocked?.25:Infinity};
  const camera=cameraAt(V(0,2,0),V(0,2,-4)),c=createCombat(world,p,base);
  const shots=[];let warningStart=null;
  for(let i=0;i<330;i++) {
    const now=i*dt;
    blocked = now>=1.3 && now<2;
    c.step(dt,now,camera,1280,720,V(0,2,0),false);
    if(now>=2 && e.warning && warningStart===null) warningStart=now;
    if(e.lastShotAtSeconds===now)shots.push(now);
  }
  assert.ok(Math.abs(shots[2]-2.35)<=dt);assert.equal(warningStart,2);
  console.log('short occultation re-exposed at 2s, renewed turret telegraph',warningStart,'shot',shots[2]);
}
{
  const {createWorld} = await import('../src/stage.js');
  const w=createWorld(),p=createPlayer(base,w.spawn),c=createCombat(w,p,base);
  const camera=cameraAt(V(0,4,8),V(0,2,-100)),guard=w.enemies[0];
  p.pos.set(-25,0,-48);
  let oldPosition,regained=null,firstPursuit=null,memoryAge=null;
  for (let i=0;i<900;i++) {
    const now=i*dt;
    if(i===24){p.pos.x=-17; oldPosition=guard.pos.clone();}
    c.step(dt,now,camera,1280,720,p.pos.clone().add(V(.8,2,0)),false);
    if(i===23)assert.equal(guard.hasLineOfSight,true);
    if(i===24) {
      assert.equal(guard.hasLineOfSight,false);
      assert.deepEqual(guard.memory.toArray(),[-25,2,-48]);
      memoryAge=guard.expiry-23*dt;
    }
    if(i>24 && guard.pos.distanceTo(oldPosition)>.1 && firstPursuit===null)firstPursuit=now-24*dt;
    if(i>24 && guard.hasLineOfSight){regained=now-24*dt;break;}
  }
  assert.ok(firstPursuit>0 && firstPursuit<.5);assert.ok(regained>0 && regained<8);
  assert.equal(memoryAge,8);
  console.log('S01 blast screen, pursuit after',firstPursuit.toFixed(5),'s, LOS regained after',regained.toFixed(5),'s');
  w.dispose();
}
for(const kind of ['guard','turret']) {
  const p=createPlayer(base,V()),e=enemy('test',kind,V(0,2,45),V(),2);
  const world={...floor,enemies:[e]},c=createCombat(world,p,base);
  const camera=cameraAt(V(0,2,0),V(0,2,-4));p.vel.x=8;
  const until=kind==='guard'?60:84;
  for(let i=0;i<=until;i++) {
    p.pos.x=8*i*dt;
    c.step(dt,i*dt,camera,1280,720,p.pos.clone().add(V(0,2,0)),false);
  }
  const b=c.bullets.find(b=>b.hostile);
  const r=p.pos.clone().add(V(0,2,0)).sub(b.origin);
  const time=interceptTime(r,p.vel,b.velocity.length(),10);
  const predicted=r.clone().addScaledVector(p.vel,Math.min(1.2,time)).normalize();
  assert.ok(b.dir.distanceTo(predicted)<1e-9);
}
// Fire into each authored control turret from actual nearby standing room in
// its sector, retaining the same resources, cooldowns and objective across setups.
{
  const {createWorld}=await import('../src/stage.js');
  const w=createWorld(),p=createPlayer(base,w.spawn),c=createCombat(w,p,base);
  let tick=0;
  const camera=cameraAt(m,V(0,20,15));
  let count=0;
  for (const target of w.enemies.filter(e=>e.isGateControl)) {
    const area=w.sectors.find(s=>s.id===target.sectorId);
    const offsets=[[0,10],[10,0],[-10,0],[0,-10],[8,8],[-8,8]];
    let muzzle;
    for(const [dx,dz] of offsets){
      const candidate=target.pos.clone().add(V(dx,0,dz));
      const foot=candidate.clone();foot.y-=2;
      const velocity=V(0,-1,0);
      if(w.move(foot,V(0,-.1,0),velocity,.86,3.35)&&w.hit(candidate,target.pos,0)===Infinity&&w.sector(candidate)===area.id) {
        muzzle=candidate;p.pos.copy(foot);break;
      }
    }
    assert.ok(muzzle,'firing position '+target.id);
    camera.position.copy(muzzle);camera.lookAt(target.pos);camera.updateMatrixWorld();
    p.weapon='machinegun';
    const first=target.hp;
    for(let i=0;i<600 && target.alive;i++,tick++) {
      for(const e of w.enemies) {e.previous.copy(e.pos);e.startVelocity=e.vel;}
      c.stepWeapons(dt,tick*dt,camera,1280,720,muzzle,c.lock.state==='locked');
      w.update();
    }
    count++;assert.equal(first,240);assert.equal(target.hp,0);assert.equal(target.alive,false);
    assert.equal(w.objective.controlsDestroyed,count);
    assert.ok(w.objective.openBarrierIds.includes(target.barrierId));
  }
  assert.ok(w.objective.gateOpen);
  console.log('Actual 6 control turrets destroyed, all barriers open.',300-p.ammo.machinegun,'MG rounds emitted across fixtures.');
  w.dispose();
}
