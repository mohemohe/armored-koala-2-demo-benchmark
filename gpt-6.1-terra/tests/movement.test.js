import assert from 'node:assert/strict';
import {createMovement, beginMovement, stepMovement, spendEnergy} from '../src/movement.js';
const near = (a,b,eps=1e-7) => assert.ok(Math.abs(a-b)<eps, `${a} != ${b}`);
const input = {direction:{x:0,z:0},forward:{x:0,z:1},qbPressed:true};
for (const multiplier of [1,0.8]) {
  const s=createMovement({speedMultiplier:multiplier});
  beginMovement(s,input,0);
  for(let i=0;i<90;i++) stepMovement(s,{},1/120,i/120);
  near(s.position.z,42.6*multiplier);
  near(s.en,84);
  assert.equal(s.horizontalMode,'glide');
  assert.equal(s.qbSuccessfulCount,1);
  const z=s.position.z;
  for(let i=90;i<120;i++) stepMovement(s,{},1/120,i/120);
  near(s.position.z-z,22*multiplier*.25);
  near(s.en,87.75);
  console.log(`QB x${multiplier}: 0.75s z=${z.toFixed(6)}, EN=84; 1s z=${s.position.z.toFixed(6)}, EN=${s.en.toFixed(2)}`);
}
{
 const s=createMovement(); s.en=35; beginMovement(s,input,0); assert.equal(s.qbSuccessfulCount,0); near(s.en,35);
 s.en=36; beginMovement(s,input,0); assert.equal(s.qbSuccessfulCount,1); near(s.en,0);
 for(let i=0;i<90;i++) stepMovement(s,{},1/120,i/120);
 near(s.position.z,42.6); near(s.en,0); assert.equal(s.glideEnabled,true);
}
{
 const s=createMovement(); s.en=0; beginMovement(s,{shiftPressed:true,forward:{x:0,z:1}},0);
 for(let i=0;i<120;i++) stepMovement(s,{},1/120,i/120);
 assert.equal(s.glideEnabled,true); near(s.en,15); assert.ok(s.position.z>15);
}
{
 const s=createMovement(); beginMovement(s,input,0); assert.equal(spendEnergy(s,8,0),true);
 s.grounded=false; stepMovement(s,{spaceHeld:true,spaceHeldSeconds:.3},1/120,0);
 near(s.en,120-36-8-20/120);
}
console.log('movement tests passed');
{
 const s=createMovement(); let previous=false;
 for(let i=0;i<600;i++) {
   const down=true, time=i/120;
   beginMovement(s,{qbPressed:down&&!previous,forward:{x:0,z:1}},time);
   previous=down;
   stepMovement(s,{},1/120,time);
 }
 assert.equal(s.qbSuccessfulCount,1);
 near(s.position.z,136.1);
 near(s.en,120);
 console.log(`5s held Q: count=${s.qbSuccessfulCount}, z=${s.position.z.toFixed(3)}, EN=${s.en.toFixed(3)} (recovery included)`);
}
