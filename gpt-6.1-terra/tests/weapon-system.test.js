import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WeaponSystem } from '../src/weapons.js';
const v=(x,y,z)=>new THREE.Vector3(x,y,z), dt=1/120;
globalThis.window={innerWidth:1280,innerHeight:720};
const conditions=[[[0,0,20],[0,0,0]],[[0,0,60],[0,0,0]],[[0,0,100],[0,0,0]],[[0,0,120],[0,0,0]],[[0,0,100],[8,0,0]],[[0,0,100],[-8,0,0]],[[0,0,100],[0,0,8]],[[0,0,100],[0,0,-8]],[[0,16,100],[6,0,0]],[[0,-16,100],[-6,0,0]],[[0,0,100],[6,3,0]],[[0,0,100],[6,-3,0]],[[0,0,120],[6,3,4]]];
function launch(weapon,r,vel,playerVelocity={x:0,y:0,z:0}){
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(70,1280/720,.1,1000);camera.position.set(0,20,-10);camera.lookAt(0,20,100);camera.updateMatrixWorld();
 const enemy={id:'TEST',position:v(...r).add(v(0,20,0)).addScaledVector(v(...vel),-.8),velocity:v(...vel),alive:true,radius:.5};
 let hits=0; const ws=new WeaponSystem({scene,camera,stage:{colliders:[]},player:{position:{x:-1.52,y:16.83,z:-1.86},velocity:playerVelocity,en:120,lastEnSpentAtSeconds:null},enemies:[enemy],loadout:{fcs:'medium',legs:'biped'},onDamage:()=>hits++});
 ws.select(weapon);for(let i=0;i<96;i++){ws.update(dt,i*dt,false);enemy.position.addScaledVector(enemy.velocity,dt);}
 assert.equal(ws.lock.state,'locked');
 ws.update(dt,.8,true,true);enemy.position.addScaledVector(enemy.velocity,dt);ws.finishStep(dt,.8+dt);
 for(let t=.8+dt;t<5 && !hits;t+=dt){ws.update(dt,t,false,true);enemy.position.addScaledVector(enemy.velocity,dt);ws.finishStep(dt,t+dt);}
 const shot=ws.recentPlayerShots[0];assert.ok(shot);assert.deepEqual(shot.muzzlePosition,[0,20,0]);return {hits,shot};
}
test('normal FCS acquisition and actual weapon system: A01–A13, 20 machinegun shots each',()=>{
 for(let i=0;i<conditions.length;i++)for(let n=0;n<20;n++){
  const result=launch('machinegun',...conditions[i]);assert.equal(result.hits,1,`A${i+1}`);assert.equal(result.shot.solutionStatus,'solved');
 }
});
test('actual beam and missile weapon system: required stationary and moving test cases',()=>{
 for(const condition of conditions) for(let n=0;n<20;n++)assert.equal(launch('beam',...condition).hits,1);
 for(const condition of conditions.slice(4,7))for(let n=0;n<20;n++)assert.equal(launch('missile',...condition).hits,1);
});

test('lock retention, switching, expiry, wall occlusion and missile refusal',()=>{
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(70,1280/720,.1,1000);camera.position.set(0,20,-10);camera.lookAt(0,20,100);camera.updateMatrixWorld();
 const enemy={id:'TEST',position:v(0,20,60),velocity:v(0,0,0),alive:true,radius:.5};
 const player={position:{x:-1.52,y:16.83,z:-1.86},en:120,lastEnSpentAtSeconds:null}, stage={colliders:[]};
 const ws=new WeaponSystem({scene,camera,stage,player,enemies:[enemy],loadout:{fcs:'medium',legs:'biped'}});
 ws.select('missile');ws.update(dt,0,true);assert.equal(ws.ammo.missile,12);assert.equal(ws.recentPlayerShots.length,0);
 for(let i=1;i<97;i++)ws.update(dt,i*dt,false);assert.equal(ws.lock.state,'locked');
 ws.select('beam');ws.update(dt,1,false);assert.equal(ws.lock.state,'locked');assert.equal(ws.fireControl.weapon,'beam');
 stage.colliders.push({min:v(-4,10,25),max:v(4,30,26)});ws.update(dt,1.01,false);assert.equal(ws.lock.state,'none');assert.equal(ws.fireControl.status,'inactive');
 stage.colliders=[];ws.update(dt,1.02,false);assert.equal(ws.lock.state,'acquiring');assert.ok(ws.lock.progress<.1);
});

test('the last partial lifetime interval is collision tested',()=>{
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(70,1280/720,.1,1000);camera.position.set(0,20,-10);camera.lookAt(0,20,100);camera.updateMatrixWorld();
 const t=1.999;let hits=0;
 const enemy={id:'END',position:v(0,20-9*t*t,100*t),velocity:v(0,0,0),alive:true,radius:.05};
 const ws=new WeaponSystem({scene,camera,stage:{colliders:[]},player:{position:{x:-1.52,y:16.83,z:-1.86},en:120},enemies:[enemy],loadout:{fcs:'medium',legs:'biped'},onDamage:()=>hits++});
 ws.update(dt,0,true,true);ws.finishStep(dt,dt);
 for(let i=1;i<240;i++){ws.update(dt,i*dt,false,true);ws.finishStep(dt,(i+1)*dt);}
 assert.equal(hits,1);assert.equal(ws.projectiles.length,0);
});

test('machinegun uses world velocity while player is gliding, flying or quickboosting',()=>{
 const motions=[{x:22,y:0,z:0},{x:0,y:8,z:16},{x:80,y:0,z:0}];
 for(const velocity of motions)for(let n=0;n<20;n++){
  const result=launch('machinegun',...conditions[4],velocity);assert.equal(result.hits,1);
  assert.ok(Math.abs(Math.hypot(...result.shot.initialVelocity)-100)<1e-9);
  assert.ok(Math.abs(result.shot.initialVelocity[0]-8)<1e-7);
 }
});
