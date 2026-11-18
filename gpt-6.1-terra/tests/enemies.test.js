import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EnemySystem } from '../src/enemies.js';

test('independent normal projectiles defeat an exposed stationary target within 15 seconds', () => {
  const player={position:{x:0,y:0,z:0},velocity:{x:0,y:0,z:0},hp:1000};
  const stage={enemies:[
    {id:'G01',kind:'guard',isGateControl:false,position:[45,2,0],sectorId:'S01'},
    {id:'G02',kind:'guard',isGateControl:false,position:[-45,2,0],sectorId:'S01'},
    {id:'T01',kind:'turret',isGateControl:false,position:[0,2,45],sectorId:'S01'},
  ],colliders:[],sectorAt:()=>({floorY:0}),removeBarrier:()=>{}};
  const ai=new EnemySystem({THREE,scene:new THREE.Scene(),stage,player});
  let time=0;
  while(time<15 && player.hp>0){ai.update(1/120,time);time+=1/120;}
  assert.ok(player.hp<=0,`HP ${player.hp} after ${time}s`);
  assert.ok(ai.enemies.every(e=>e.shotsFired>0));
  console.log(`Exposure: HP ${player.hp} at ${time.toFixed(4)} s, shots ${ai.enemies.map(e=>e.shotsFired).join('/')}`);
  ai.dispose();
});
