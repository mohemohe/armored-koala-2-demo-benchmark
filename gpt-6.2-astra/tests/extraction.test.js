// Deterministic full-course integration pilot. Only normal movement and trigger
// inputs, weapon selection and camera pose are controlled. No state repair,
// teleports, special damage, actor replacement or direct barrier changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, PerspectiveCamera } from 'three';
import { createWorld } from '../src/stage.js';
import { createPlayer, stepMovement } from '../src/movement.js';
import { createCombat } from '../src/combat.js';

const dt = 1/120;
const up = new Vector3(0,1,0);
function route(sectors) {
  const points = [];
  for (const sector of sectors) {
    const point = (x,d) => points.push(new Vector3(x,0,-d));
    if (sector.i === 0) {
      point(0,26); point(25,41); point(25,71);
    } else {
      point(sector.x,sector.start+12);
      if (sector.rise) point(sector.x,sector.step+7);
      point(sector.x,sector.end-19);
    }
    point(sector.doorX, sector.end - (sector.i===15 ? 6 : 4));
    if (sector.i<15) point(sector.doorX,sector.end+3);
  }
  return points;
}
function selectTargets(world,center,combat) {
  function pending(e) {
    return combat.bullets.reduce((damage,b) => {
      const recent = b.age < (b.kind==='missile' ? 3 : 1.3);
      return damage + ((!b.hostile && b.targetId===e.id && recent) ? b.damage : 0);
    },0);
  }
  return world.enemies.filter(e=>e.alive && e.pos.distanceTo(center)<116 &&
    world.hit(center,e.pos)===Infinity && pending(e)<e.hp).sort((a,b)=>
      Number(b.isGateControl)-Number(a.isGateControl) || a.pos.distanceTo(center)-b.pos.distanceTo(center));
}
function aim(world,player,center,camera,lookAt) {
  const look = lookAt.clone().sub(center).normalize();
  const right = new Vector3().crossVectors(look,up).normalize();
  const pivot = player.pos.clone().add(new Vector3(0,2.35,0));
  const third = pivot.clone().addScaledVector(right,1.36).addScaledVector(look,-6.9);
  third.y += .65;
  const cameraClearance = world.hit(pivot,third,.16)-.015;
  camera.position.lerpVectors(pivot,third,Math.max(.002,Math.min(1,cameraClearance)));
  camera.lookAt(lookAt);
  camera.updateMatrixWorld();
  const forward = camera.getWorldDirection(new Vector3());
  forward.y = 0;
  forward.normalize();
  right.crossVectors(forward,up).normalize();
  const muzzle = player.pos.clone().addScaledVector(forward,2.03).addScaledVector(right,-1.30);
  muzzle.y += 2.42;
  const clearance = world.hit(center,muzzle,.035);
  if(clearance<=1) muzzle.lerpVectors(center,muzzle,Math.max(0,clearance-.045));
  return {forward,right,muzzle};
}
function wasdDirection(forward,right,desired) {
  let best = null, bestDot = -Infinity;
  for(let k=0;k<8;k++){
    const theta = k*Math.PI/4;
    const v = forward.clone().multiplyScalar(Math.cos(theta)).addScaledVector(right,Math.sin(theta));
    if(v.dot(desired)>bestDot){bestDot=v.dot(desired); best=v;}
  }
  return best;
}
test('single uninterrupted production mission with autonomous enemies and finite ammunition',()=>{
  const loadout={legs:'biped',generator:'recovery',fcs:'narrow'};
  const world=createWorld(), player=createPlayer(loadout,world.spawn), combat=createCombat(world,player,loadout);
  const points=route(world.sectors), visited=new Set(), camera=new PerspectiveCamera(62,16/9,.09,280);
  const shots={machinegun:0,beam:0,missile:0};
  let time=0,index=0,lastTarget=null,lastMissile=-10,lastBeam=-10,lastJump=-10,heldSpace=false,lastShot=0,distance=0;
  for(let frame=0;frame<120*180;frame++,time=frame*dt){
    if(player.hp<=0 || world.escaped(player.pos))break;
    const sector=world.sectors.find(s=>s.id===world.sector(player.pos));
    visited.add(sector.id);
    const direction=points[index].clone().sub(player.pos);
    direction.y=0;
    if(direction.length()<3 && index<points.length-1)index++;
    const center=player.pos.clone().add(new Vector3(0,2,0));
    const candidates=selectTargets(world,center,combat);
    let target=candidates[0];
    if(candidates.includes(lastTarget)&&(!target.isGateControl||lastTarget.isGateControl))target=lastTarget;
    lastTarget=target;
    const {forward,right,muzzle}=aim(world,player,center,camera,target?.pos || center.clone().add(direction));

    const lift=sector.rise && Math.abs(-player.pos.z-sector.step)<4.5 && player.pos.y<sector.top+.45;
    const danger=candidates.some(e=>e.pos.distanceTo(center)<(e.kind==='guard'?88:116));
    const jump=player.grounded && (lift || (danger&&time-lastJump>2.2));
    if(jump)lastJump=time;
    const space=!!lift || jump, jumpEdge=space&&!heldSpace;
    heldSpace=space;
    const reserve=sector.rise && player.pos.y<sector.top && sector.step+player.pos.z<51?36:10;
    const missileReserve=6-world.objective.controlsDestroyed;
    const locked=combat.lock.state==='locked';
    const missile=target?.kind==='turret' && (target.isGateControl || player.ammo.missile>missileReserve) &&
      target.hp>80 && time-lastMissile>1 && !combat.bullets.some(b=>b.kind==='missile'&&b.targetId===target.id) &&
      locked && combat.lock.targetId===target.id && player.ammo.missile>0;
    player.weapon=missile?'missile':target&&player.en>reserve+8&&time-lastBeam>.25?'beam':'machinegun';
    const fire=!!target && (player.weapon!=='machinegun'||(player.ammo.machinegun>0 && locked &&
      !combat.bullets.some(b=>b.targetId===target.id&&b.damage>=target.hp)));

    direction.normalize();
    if(danger && Math.abs(sector.step+player.pos.z)>10 && -player.pos.z<=sector.end-24 && sector.i>0) {
      const lateral=new Vector3(-direction.z,0,direction.x);
      direction.addScaledVector(lateral,Math.sin(time*5.7)*.85).normalize();
    }
    const move=wasdDirection(forward,right,direction);
    const input={x:move.x,z:move.z,forward,q:false,shift:!player.movement.glideEnabled,space,jump:jumpEdge,brake:false};
    const previous=player.pos.clone();
    stepMovement(player,input,dt,time,world,()=>combat.step(dt,time,camera,1280,720,muzzle,fire));
    distance+=player.pos.distanceTo(previous);
    world.update();
    const shot=combat.recentPlayerShots.at(-1);
    if(shot && shot.id!==lastShot) {
      lastShot=shot.id;shots[shot.weapon]++;
      if(shot.weapon==='beam')lastBeam=time;
      if(shot.weapon==='missile')lastMissile=time;
    }
  }
  console.log(JSON.stringify({time,distance,hp:player.hp,en:player.en,position:player.pos.toArray(),shots,
    controls:world.objective.controlsDestroyed,kills:world.enemies.filter(e=>!e.alive).length}));
  assert(player.hp>0);assert(world.escaped(player.pos));assert.equal(visited.size,16);
  assert.equal(world.objective.controlsDestroyed,6);assert(world.enemies.some(e=>e.shotsFired>0));
  world.dispose();
});
