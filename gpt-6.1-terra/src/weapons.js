import * as THREE from 'three';
import { spendEnergy } from './movement.js';
import { solveFireControl, projectilePosition, segmentMovingSphere, steerMissile } from './combat.js';

const V = p => p?.isVector3 ? p.clone() : Array.isArray(p) ? new THREE.Vector3(...p) : new THREE.Vector3(p?.x || 0,p?.y || 0,p?.z || 0);
const arr = p => p ? [p.x,p.y,p.z] : null;
const stats = {wide:[.30,1.20],medium:[.20,.80],narrow:[.10,.40]};
const configs = {machinegun:{interval:.1, damage:12, speed:100, life:2},beam:{interval:.25,damage:40,range:120},missile:{interval:1,damage:180,speed:45,life:4}};
const inactive = weapon => ({status:'inactive', weapon, targetId:null,evaluatedAtSeconds:null,muzzlePosition:null,targetPosition:null,targetVelocity:null,launchDirection:null,predictedFlightSeconds:null,predictedInterceptPosition:null,aimPoint:null,residualMeters:null});

// Stage solids are exactly the boxes used for player and projectile collision.
export function stageSegment(start, end, colliders) {
  const delta=end.clone().sub(start), length=delta.length();
  if(length<1e-9)return null;
  const ray=new THREE.Ray(start,delta.multiplyScalar(1/length));
  let best=null;
  for(const c of colliders){
    const box=new THREE.Box3(c.min,c.max);
    if(box.containsPoint(start))return {distance:0,point:start.clone(),collider:c};
    const p=ray.intersectBox(box,new THREE.Vector3());
    if(p){const distance=p.distanceTo(start); if(distance<=length && (!best || distance<best.distance))best={distance,point:p,collider:c};}
  }
  return best;
}

export class WeaponSystem {
 constructor(context){
  Object.assign(this,context); this.reset();
 }
 reset(){
  if(this.projectiles) for(const p of this.projectiles){this.scene.remove(p.mesh);p.mesh.geometry.dispose();p.mesh.material.dispose();}
  if(this.effects) for(const e of this.effects){this.scene.remove(e.mesh);e.mesh.geometry.dispose();e.mesh.material.dispose();}
  this.projectiles=[];this.effects=[];this.weapon='machinegun';this.ammo={machinegun:300,missile:12};
  this.nextFire={machinegun:0,beam:0,missile:0};this.lock={state:'none',targetId:null,progress:0,radiusCssPx:0};
  this.fireControl=inactive(this.weapon);this.recentPlayerShots=[];this.shotId=0;this.lockTime=0;this.currentTarget=null;
 }
 select(weapon){if(configs[weapon])this.weapon=weapon;}
 muzzle(){
  const f=this.camera.getWorldDirection(new THREE.Vector3());f.y=0;if(f.lengthSq()<1e-8)f.set(0,0,1);f.normalize();
  const right=new THREE.Vector3(f.z,0,-f.x);
  return V(this.player.position).add(new THREE.Vector3(0,3.17,0)).addScaledVector(right,1.52).addScaledVector(f,1.86);
 }
 dimensions(){return {w:window.innerWidth,h:window.innerHeight};}
 radius(){const {w,h}=this.dimensions();return stats[this.loadout.fcs][0]*Math.min(w,h);}
 hasLOS(a,b){return !stageSegment(a,b,this.stage.colliders);}
 candidate(enemy,muzzle){
  if(!enemy?.alive)return null;
  const p=V(enemy.position);if(muzzle.distanceTo(p)>120+1e-8)return null;
  const cameraDirection=this.camera.getWorldDirection(new THREE.Vector3());
  if(p.clone().sub(this.camera.position).dot(cameraDirection)<=0)return null;
  const projected=p.clone().project(this.camera),{w,h}=this.dimensions();
  if(projected.z < -1 || projected.z > 1)return null;
  const x=projected.x*w/2,y=projected.y*h/2,dist=Math.hypot(x,y);
  if(dist>this.radius() || !this.hasLOS(this.camera.position,p) || !this.hasLOS(muzzle,p))return null;
  return dist;
 }
 updateLock(dt){
  const muzzle=this.muzzle();this.lock.radiusCssPx=this.radius();
  if(this.currentTarget && this.candidate(this.currentTarget,muzzle)===null){this.currentTarget=null;this.lockTime=0;}
  if(!this.currentTarget){
   let best=Infinity;
   for(const e of this.enemies){const d=this.candidate(e,muzzle);if(d!==null && (d<best-1e-8 || (Math.abs(d-best)<1e-8 && e.id<(this.currentTarget?.id||'~')))){best=d;this.currentTarget=e;}}
  }
  if(!this.currentTarget){this.lock.state='none';this.lock.targetId=null;this.lock.progress=0;return;}
  const required=stats[this.loadout.fcs][1]/(this.loadout.legs==='quadruped'?1.5:1);
  this.lockTime=Math.min(required,this.lockTime+dt);
  this.lock.state=this.lockTime>=required-1e-9?'locked':'acquiring';this.lock.targetId=this.currentTarget.id;this.lock.progress=Math.min(1,this.lockTime/required);
 }
 evaluate(now){
  const e=this.currentTarget;
  if(this.lock.state!=='locked' || !e || this.candidate(e,this.muzzle())===null){this.fireControl=inactive(this.weapon);return null;}
  const m=this.muzzle(),p=V(e.position),v=V(e.velocity),s=solveFireControl(this.weapon,m,p,v);
  this.fireControl={status:s.status,weapon:this.weapon,targetId:e.id,evaluatedAtSeconds:now,muzzlePosition:arr(m),targetPosition:arr(p),targetVelocity:arr(v),launchDirection:arr(s.direction),predictedFlightSeconds:s.time,predictedInterceptPosition:arr(s.intercept),aimPoint:arr(s.aimPoint),residualMeters:s.residual};
  return s;
 }
 freeDirection(m){
  const direction=this.camera.getWorldDirection(new THREE.Vector3()).normalize();
  const far=this.camera.position.clone().addScaledVector(direction,120);
  const wall=stageSegment(this.camera.position,far,this.stage.colliders);
  let best=wall?wall.distance:120, point=wall?wall.point:far;
  for(const e of this.enemies){if(!e.alive)continue;const center=V(e.position),t=segmentMovingSphere(this.camera.position,far,center,center,e.radius||2);if(t!==null && t*120<best){best=t*120;point=this.camera.position.clone().addScaledVector(direction,best);}}
  return point.clone().sub(m).normalize();
 }
 line(a,b,color,duration=.10){
  const geometry=new THREE.BufferGeometry().setFromPoints([a,b]);const mesh=new THREE.Line(geometry,new THREE.LineBasicMaterial({color,transparent:true,opacity:.9}));this.scene.add(mesh);this.effects.push({mesh,life:duration});
 }
 fire(now){
  const cfg=configs[this.weapon];if(now+1e-9<this.nextFire[this.weapon])return;
  // Revalidation occurs at the same instant as the shot.
  this.updateLock(0);const s=this.evaluate(now),e=this.currentTarget;
  if(this.weapon==='missile' && !s){this.onNotice?.('ミサイルはロック完了が必要');return;}
  if(this.weapon==='machinegun' && this.ammo.machinegun<=0 || this.weapon==='missile' && this.ammo.missile<=0){this.onNotice?.('弾切れ');return;}
  if(this.weapon==='beam' && !spendEnergy(this.player,8,now)){this.onNotice?.('EN不足');return;}
  if(this.weapon==='machinegun')this.ammo.machinegun--;if(this.weapon==='missile')this.ammo.missile--;
  this.nextFire[this.weapon]=now+cfg.interval;
  const m=this.muzzle(), direction=s?s.direction.clone():this.freeDirection(m), vel=cfg.speed?direction.clone().multiplyScalar(cfg.speed):null;
  const shot={id:++this.shotId,firedAtSeconds:now,weapon:this.weapon,targetId:s?e.id:null,solutionStatus:s?s.status:'inactive',muzzlePosition:arr(m),targetPositionAtFire:s?arr(V(e.position)):null,targetVelocityAtFire:s?arr(V(e.velocity)):null,launchDirection:arr(direction),initialVelocity:arr(vel),accelerationAtFire:this.weapon==='machinegun'?[0,-18,0]:[0,0,0],predictedFlightSeconds:s?s.time:null,predictedInterceptPosition:s?arr(s.intercept):null};
  this.recentPlayerShots.push(shot);if(this.recentPlayerShots.length>32)this.recentPlayerShots.shift();
  if(this.weapon==='beam'){
   const end=m.clone().addScaledVector(direction,120),wall=stageSegment(m,end,this.stage.colliders);let fraction=wall?wall.distance/120:1,hit=null;
   for(const enemy of this.enemies){if(!enemy.alive)continue;const p=V(enemy.position),t=segmentMovingSphere(m,end,p,p,enemy.radius||2);if(t!==null && t<fraction){fraction=t;hit=enemy;}}
   const impact=m.clone().lerp(end,fraction);this.line(m,impact,0x79edff,.14);if(hit)this.onDamage?.(hit,40);
  }else{
   const geometry=this.weapon==='machinegun'?new THREE.SphereGeometry(.16,6,4):new THREE.ConeGeometry(.36,1.4,6);
   const material=new THREE.MeshBasicMaterial({color:this.weapon==='machinegun'?0xffdf83:0xffa855});const mesh=new THREE.Mesh(geometry,material);mesh.position.copy(m);this.scene.add(mesh);
   this.projectiles.push({weapon:this.weapon,mesh,origin:m.clone(),position:m.clone(),velocity:vel,acceleration:new THREE.Vector3(0,this.weapon==='machinegun'?-18:0,0),direction:direction.clone(),age:0,targetId:s?e.id:null,observedPosition:s?V(e.position):null,observedVelocity:s?V(e.velocity):null,observationAge:0});
  }
 }
 updateProjectiles(dt,targetStarts=null){
  for(let i=this.projectiles.length-1;i>=0;i--){
   const q=this.projectiles[i],cfg=configs[q.weapon],h=Math.min(dt,cfg.life-q.age),from=q.position.clone();if(h<=0){this.scene.remove(q.mesh);this.projectiles.splice(i,1);continue;}
   if(q.weapon==='machinegun')q.position=projectilePosition(q,q.age+h);
   else {
    const target=this.enemies.find(e=>e.id===q.targetId);
    if(target?.alive){
     const observation=targetStarts?.get(target.id);const targetPosition=observation?.position || V(target.position);const targetVelocity=observation?.velocity || V(target.velocity);
     if(this.hasLOS(from,targetPosition)){q.observedPosition=targetPosition.clone();q.observedVelocity=targetVelocity.clone();q.observationAge=0;}
     else q.observationAge+=h;
     const forecast=q.observedPosition.clone().addScaledVector(q.observedVelocity,q.observationAge);
     const s=solveFireControl('missile',from,forecast,q.observedVelocity,cfg.life-q.age);
     q.direction=steerMissile(q.direction,s.direction,h);
    }
    q.position.addScaledVector(q.direction,45*h);q.velocity.copy(q.direction).multiplyScalar(45);
   }
   const wall=stageSegment(from,q.position,this.stage.colliders);let fraction=wall?wall.distance/Math.max(from.distanceTo(q.position),1e-9):1,hit=null;
   for(const e of this.enemies){if(!e.alive)continue;const before=targetStarts?.get(e.id);const p=before ? before.position : V(e.position);const end=before ? p.clone().lerp(V(e.position),h/dt) : p.clone().addScaledVector(V(e.velocity),h);const t=segmentMovingSphere(from,q.position,p,end,e.radius||2);if(t!==null && (t<fraction || (!wall && t<=fraction))){fraction=t;hit=e;}}
   if(hit || wall){q.mesh.position.copy(from.clone().lerp(q.position,fraction));if(hit)this.onDamage?.(hit,cfg.damage);this.line(from,q.mesh.position,q.weapon==='machinegun'?0xffdd99:0xff9e52,.10);this.scene.remove(q.mesh);q.mesh.geometry.dispose();q.mesh.material.dispose();this.projectiles.splice(i,1);}
   else {q.age+=h;q.mesh.position.copy(q.position);if(q.weapon==='missile')q.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),q.direction);if(q.age>=cfg.life-1e-9){this.scene.remove(q.mesh);q.mesh.geometry.dispose();q.mesh.material.dispose();this.projectiles.splice(i,1);}}
  }
 }
 update(dt,now,shooting,deferProjectiles=false){
  this.updateLock(deferProjectiles ? 0 : dt);this.evaluate(now);if(shooting)this.fire(now);
  if(deferProjectiles){this.targetStarts=new Map(this.enemies.map(e=>[e.id,{position:V(e.position),velocity:V(e.velocity)}]));return;}
  this.updateProjectiles(dt);this.ageEffects(dt);
 }
 finishStep(dt,now){
  this.updateProjectiles(dt,this.targetStarts);this.targetStarts=null;this.ageEffects(dt);
  // Drop a destroyed or newly obscured target before reporting another frame.
  this.updateLock(dt);this.evaluate(now);
 }
 ageEffects(dt){
  for(let i=this.effects.length-1;i>=0;i--){const e=this.effects[i];e.life-=dt;if(e.life<=0){this.scene.remove(e.mesh);e.mesh.geometry.dispose();e.mesh.material.dispose();this.effects.splice(i,1);}}
 }
 getAimDirection(){return this.fireControl.launchDirection ? new THREE.Vector3(...this.fireControl.launchDirection) : this.freeDirection(this.muzzle());}
 getLockSnapshot(){return {...this.lock};}
 getFireControlSnapshot(){return structuredClone(this.fireControl);}
 getSnapshot(){return {weapon:this.weapon,ammo:{...this.ammo},lock:{...this.lock},fireControl:structuredClone(this.fireControl),recentPlayerShots:structuredClone(this.recentPlayerShots)};}
}
