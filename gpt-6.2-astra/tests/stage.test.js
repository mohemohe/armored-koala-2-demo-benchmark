import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createWorld } from '../src/stage.js';
import { createPlayer, stepMovement } from '../src/movement.js';

const standard={legs:'biped',fcs:'medium',generator:'balanced'};
const h=1/120,forward=new Vector3(0,0,-1);
const input={forward,x:0,z:-1,q:false,brake:false,space:false,shift:false,jump:false};
function tick(p,w,frames,i){for(let j=0;j<frames;j++)stepMovement(p,i(j),h,j*h,w);}
test('45 accessible entities with unique stable IDs, five simultaneous four-way firing lanes, protected spawn',()=>{
  const w=createWorld();
  assert.equal(new Set(w.enemies.map(e=>e.id)).size,45);
  assert.equal(w.enemies.filter(e=>e.kind==='guard').length,30);
  assert.equal(w.enemies.filter(e=>e.kind==='turret').length,15);
  const p=new Vector3(0,2,0);
  assert(w.enemies.every(e=>e.pos.distanceTo(p)>(e.kind==='guard'?90:120)||Number.isFinite(w.hit(p,e.pos))));
  for(const e of w.enemies){
    assert.equal(w.sector(e.pos),e.sectorId);
    assert.equal(w.hit(e.pos.clone().add(new Vector3(0,0,.1)),e.pos),Infinity);
    const foot=e.pos.clone();foot.y-=e.footOffset;
    assert(w.move(foot,new Vector3(0,-.01,0),new Vector3(0,-1,0),.85,3.35));
  }
  const positions={S02:[-1,2,-176],S05:[8.5,22,-517],S08:[-20,32,-854],S10:[4.5,40,-1097],S12:[-7,52,-1314]};
  for(const [id,pt] of Object.entries(positions)){
    const target=new Vector3(...pt);
    const clear=w.enemies.filter(e=>e.sectorId===id&&e.pos.distanceTo(target)<(e.kind==='guard'?90:120)&&w.hit(e.pos,target)===Infinity);
    assert.equal(clear.length,4,id);
  }
  w.dispose();
});
test('the receiving dock preserves the flat-ground impulse and stops the coast at the blast screen',()=>{
  const w=createWorld();const p=createPlayer(standard,w.spawn);
  tick(p,w,90,j=>({...input,z:0,q:!j}));assert(Math.abs(p.pos.z+42.6)<1e-6);
  tick(p,w,240,()=>({...input,z:0}));assert(p.pos.z > -49);assert.equal(p.vel.z,0);
  w.dispose();
});
test('each of 18 loadouts can fly through all six risers; an unpowered jump stops at every riser',()=>{
  const w=createWorld();let minEn=Infinity,maxCost=0;
  for(const s of w.sectors.filter(s=>s.rise)){
    const at=new Vector3(s.x,s.base,-s.step+2.5);
    const jump=createPlayer(standard,at);
    tick(jump,w,360,j=>({...input,jump:j===0}));
    assert(jump.pos.z>-s.step, s.id);
    for(const fcs of ['medium','wide','narrow'])for(const generator of ['recovery','balanced','capacity'])for(const legs of ['biped','quadruped']){
      const p=createPlayer({fcs,generator,legs},at);let min=p.en;
      tick(p,w,480,j=>{
        min=Math.min(min,p.en);
        return {...input,jump:j===0,space:j*h<(s.rise+1)/8};
      });
      assert(p.pos.z < -s.step-2,s.id);assert.equal(p.pos.y,s.top);assert(p.grounded);
      maxCost=Math.max(maxCost,p.stats.maxEn-min);minEn=Math.min(minEn,min);
    }
  }
  console.log('Flight checks 108/108. Minimum remaining EN:',minEn.toFixed(3),'maximum consumed:',maxCost.toFixed(3));
  w.dispose();
});
test('both full-length bypasses have clearance in each of five rooms',()=>{
  const w=createWorld();
  for(const s of w.sectors.filter(s=>s.branch)){
    for(const right of [false,true]){
      const px=right?s.xMax-8.5:s.x-.1*s.width;
      const d=s.start+(s.end-s.start)*.22,goal=s.start+(s.end-s.start)*.73;
      const p=createPlayer(standard,new Vector3(px,s.base,-d));
      tick(p,w,Math.ceil(120*(goal-d+1)/10),()=>input);
      assert(p.pos.z<=-goal,s.id+' '+right);
    }
  }
  w.dispose();
});
test('all control shutters, final gate and extraction volume honour their prerequisites',()=>{
  const w=createWorld(), end=w.sectors.at(-1),dest=new Vector3(end.doorX,end.top+1,-end.end+7);
  const ray=(x,y,z)=>w.hit(new Vector3(x,y,z+3),new Vector3(x,y,z-3));
  const final=()=>ray(end.doorX,end.top+2,-end.end+13);
  assert(!w.escaped(dest));assert(Number.isFinite(final()));
  for(const [i,e] of w.enemies.filter(e=>e.isGateControl).entries()){
    const s=w.sectors.find(s=>s.id===e.sectorId),check=()=>ray(s.doorX,s.top+2,-s.end);
    assert(Number.isFinite(check()));e.alive=false;e.hp=0;w.update();
    assert.equal(check(),Infinity);assert.equal(w.objective.controlsDestroyed,i+1);
    assert.equal(w.objective.gateOpen,i===5);assert.equal(w.escaped(dest),i===5);
    assert.equal(w.objective.openBarrierIds.length,i+1);
  }
  assert.equal(final(),Infinity);assert(!w.escaped(w.spawn));assert(-dest.z>1500);
  w.dispose();
});
test('continuous walk and flight through all 16 sectors on the production collision mesh',()=>{
  const w=createWorld(), p=createPlayer(standard,w.spawn), seen=new Set();
  const aim=new Vector3(), prior=new Vector3();let elapsed=0,length=0;
  function goto(x,depth,s){
    for(let frame=0;frame<3600;frame++){
      const dx=x-p.pos.x,dz=-depth-p.pos.z;
      const nearLift=s.rise&&Math.abs(-p.pos.z-s.step)<3&&p.pos.y<s.top+.5;
      const distance=Math.hypot(dx,dz);
      if(distance<.25)return;
      aim.set(dx/distance,0,dz/distance);prior.copy(p.pos);
      stepMovement(p,{...input,x:aim.x,z:aim.z,space:!!nearLift,jump:nearLift&&p.grounded},h,elapsed,w);
      elapsed+=h;length+=prior.distanceTo(p.pos);
      const id=w.sector(p.pos);if(id)seen.add(id);
    }
    assert.fail('stopped in '+s.id+' at '+p.pos.toArray()+' heading to '+x+','+depth);
  }
  for(const s of w.sectors){
    if(s.i===0){goto(0,27,s);goto(23,41,s);goto(23,65,s);}
    else {
      goto(s.x,s.start+12,s);
      goto(s.x,s.end-16,s);
    }
    const controller=w.enemies.find(e=>e.sectorId===s.id&&e.isGateControl);
    if(controller){
      const firing=p.pos.clone().add(new Vector3(0,2,0));
      assert(firing.distanceTo(controller.pos)<120&&w.hit(firing,controller.pos)===Infinity,'controller inaccessible '+s.id);
      controller.alive=false;controller.hp=0;w.update();
    }
    if(s.i===15)goto(s.doorX,s.end-7,s);
    else {goto(s.doorX,s.end-6,s);goto(s.doorX,s.end+2,s);}
  }
  assert(w.escaped(p.pos));assert.equal(seen.size,16);assert(length>1807);
  console.log('Continuous stage route:',length.toFixed(2),'m /',elapsed.toFixed(2),'seconds / final',p.pos.toArray());
  w.dispose();
});
test('five distinct arenas contain clear 60-by-50 metre rectangles',()=>{
  const w=createWorld();
  const footprints={S02:[-42,168,0],S05:[-25,449,9],S08:[-58,786,30],S10:[-39.5,1023,38],S12:[-40.5,1246,50]};
  for(const [id,[left,near,floor]] of Object.entries(footprints)){
    for(let x=left;x<=left+60;x+=.5){
      const a=new Vector3(x,floor+2,-near),b=new Vector3(x,floor+2,-near-50);
      assert.equal(w.sector(a),id);assert.equal(w.sector(b),id);
      assert.equal(w.hit(a,b,.86),Infinity,id);
    }
  }
  w.dispose();
});
