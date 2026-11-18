import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFile} from 'node:fs/promises';

const renderLog = [];
// Three geometries, scenes, transforms, cameras, meshes, instancing and game
// code are real. Replace only the GPU renderer at the import boundary.
const realThree = import.meta.resolve('three');
const shim = 'data:text/javascript,'+encodeURIComponent(`
export * from ${JSON.stringify(realThree)};
export class WebGLRenderer {
  constructor({canvas}) {this.canvas=canvas; this.shadowMap={};}
  setPixelRatio(v){ this.pixelRatio=v; }
  setSize(w,h) { this.canvas.width=w*this.pixelRatio;this.canvas.height=h*this.pixelRatio; }
  render(scene,camera) {
    scene.updateMatrixWorld();camera.updateMatrixWorld();
    globalThis.recordScene(this.canvas,scene,camera);
  }
}`);
registerHooks({resolve(specifier, context, next) {
  return specifier==='three'?{url:shim,shortCircuit:true}:next(specifier,context);
}});
globalThis.recordScene=(canvas,scene,camera)=>{
  assert.ok(scene.isScene);assert.ok(camera.isCamera);assert.ok(scene.children.length>0);
  assert.ok(camera.matrixWorld.elements.every(Number.isFinite));
  renderLog.push(canvas.id);
};
function emit(obj,type,props={}) {
  const event=new Event(type);
  Object.assign(event,props);
  obj.dispatchEvent(event);
}
const ids=new Map(), special=new Map(), parts=[], actions=[];
class Element extends EventTarget {
  constructor(id,dataset={}) {
    super();this.id=id;this.dataset=dataset;this.hidden=false;this.style={};this.attributes={};
    this.classList={toggle:()=>{}};this.clientWidth=774;this.clientHeight=554;
  }
  setAttribute(k,v) { this.attributes[k]=v; }
  closest(s) {return s==='[data-part]' && this.dataset.part?this:null;}
  querySelectorAll(s) {return s==='[data-action]'?actions:[];}
  click(){this.onclick?.({target:this});}
  set innerHTML(html) {
    this.html=html;
    for(const [,id] of html.matchAll(/\bid="([^"]+)"/g)) if(!ids.has(id))ids.set(id,new Element(id));
    if(this.id==='dialog'){
      actions.length=0;
      for(const [,action] of html.matchAll(/data-action="(\d+)"/g))actions.push(new Element('',{action}));
    }
    if(this.id==='components'){
      parts.length=0;
      for(const [,part,value] of html.matchAll(/data-part="(\w+)" data-value="(\w+)"/g))
        parts.push(new Element('',{part,value}));
    }
  }
  get innerHTML(){return this.html||'';}
  getContext(type) {
    assert.equal(type,'2d');
    return new Proxy({createRadialGradient:()=>({addColorStop(){}}),createLinearGradient:()=>({addColorStop(){}})},
      {get:(o,k)=>o[k]||(()=>{})});
  }
}
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
for(const [,id] of html.matchAll(/\bid="([^"]+)"/g))ids.set(id,new Element(id));
for(const s of ['header','footer','.controls'])special.set(s,new Element(s));
const by=id=>{assert.ok(ids.has(id),'missing DOM id '+id);return ids.get(id);};
const doc=Object.assign(new EventTarget(),{
  hidden:false,pointerLockElement:null,
  createElement:()=>new Element(''), getElementById:id=>ids.get(id)||null,
  querySelector:s=>special.get(s),querySelectorAll:s=>s==='[data-part]'?parts:[],
  exitPointerLock(){if(this.pointerLockElement){this.pointerLockElement=null;emit(this,'pointerlockchange');}}
});
let rejectLock=false;
by('field').requestPointerLock=()=>{
  if(rejectLock){emit(doc,'pointerlockerror');return Promise.resolve();}
  doc.pointerLockElement=by('field');emit(doc,'pointerlockchange');return Promise.resolve();
};
let frame=null,now=0;
Object.assign(globalThis,{
  document:doc,window:new EventTarget(),innerWidth:1280,innerHeight:720,devicePixelRatio:1,
  location:{search:'?seed=1234567'},ResizeObserver:class {observe(){}},
  requestAnimationFrame:fn=>{assert.equal(frame,null,'only one animation loop');frame=fn;}
});
await import('../src/main.js');
assert.ok(window.__AK2__,'successful application startup');
const snap=()=>window.__AK2__.getSnapshot();
const key=(type,code,repeat=false)=>emit(window,type,{code,repeat});
const down=code=>key('keydown',code),up=code=>key('keyup',code);
function draw(seconds=1/60){const f=frame;assert.ok(f);frame=null;now+=seconds*1000;f(now);}
function advance(t,fps=60){for(let i=0;i<Math.round(t*fps);i++)draw(1/fps);}
function choose(part,value){
 const node=parts.find(b=>b.dataset.part===part&&b.dataset.value===value);
 assert.ok(node);by('components').onclick({target:node});
}
draw();assert.equal(renderLog.at(-1),'bay');assert.equal(snap().state,'garage');
assert.equal(snap().seed,1234567);assert.equal(snap().enemies.length,45);
for(const fcs of ['narrow','wide','medium'])for(const generator of ['capacity','recovery','balanced'])for(const legs of ['quadruped','biped']){
 choose('fcs',fcs);choose('generator',generator);choose('legs',legs);
 assert.deepEqual(snap().loadout,{fcs,generator,legs});
}
draw();
by('guide').click();assert.ok(by('dialog').innerHTML.includes('36 EN'));actions[0].click();
rejectLock=true;by('deploy').click();assert.equal(snap().state,'garage');
assert.ok(by('dialog').innerHTML.includes('再試行'));advance(.5);assert.equal(snap().elapsedSeconds,0);
rejectLock=false;actions[0].click();assert.equal(snap().state,'playing');draw();
assert.equal(renderLog.at(-1),'field');assert.deepEqual(snap().recentPlayerShots,[]);
const detached=snap();detached.player.hp=0;detached.enemies[0].position[1]=999;
assert.equal(snap().player.hp,1000);assert.notEqual(snap().enemies[0].position[1],999);
down('KeyQ');draw(1/120);up('KeyQ');advance(89/120,120);
assert.equal(snap().player.movement.qbSuccessfulCount,1);
assert.ok(Math.abs(snap().player.position[2]+42.6)<1e-6);
assert.equal(snap().player.en,84);
down('KeyQ');draw(1/120); // held across pause
down('Escape');assert.equal(snap().state,'paused');
const frozen=snap();advance(1,30);assert.deepEqual(snap(),frozen);
actions[1].click();assert.ok(by('dialog').innerHTML.includes('操作ガイド'));actions[0].click();actions[0].click();draw();
key('keydown','KeyQ',true);advance(.4,120);assert.equal(snap().player.movement.qbSuccessfulCount,1);
up('KeyQ');up('Escape');
globalThis.innerWidth=1600;globalThis.innerHeight=900;emit(window,'resize');draw();
assert.equal(snap().lock.radiusCssPx,180);assert.equal(by('circle').style.width,'360px');
assert.equal(by('field').width,1600);
down('Digit2');up('Digit2');emit(by('field'),'mousedown',{button:0});advance(.05);emit(window,'mouseup',{button:0});
assert.equal(snap().recentPlayerShots.at(-1).weapon,'beam');
down('Digit3');up('Digit3');emit(by('field'),'mousedown',{button:0});advance(.05);emit(window,'mouseup',{button:0});
assert.equal(snap().player.ammo.missile,12);
assert.ok(by('feedback').textContent.includes('LOCK'));
for(const event of ['pointerlockchange','blur','visibilitychange']){
 if(event==='pointerlockchange')doc.exitPointerLock();
 else if(event==='blur')emit(window,'blur');
 else {doc.hidden=true;emit(doc,event);doc.hidden=false;}
 assert.equal(snap().state,'paused');const t=snap().elapsedSeconds;draw(1);assert.equal(snap().elapsedSeconds,t);
 actions[0].click();draw();assert.equal(snap().state,'playing');assert.equal(snap().elapsedSeconds,t);
}
// Reset at the menu, then expose the unit to ordinary combat until failure.
down('Escape');actions[2].click();up('Escape');
assert.equal(snap().state,'garage');by('deploy').click();draw();
down('KeyD');advance(2.58,60);up('KeyD');down('KeyW');advance(8.2,30);up('KeyW');
for(let i=0;i<180 && snap().state==='playing';i++)draw(.25);
assert.equal(snap().state,'failed','idle machine destroyed by actual AI');
assert.ok(snap().player.hp<=0);
const failure=snap();draw(1);assert.deepEqual(snap(),failure);
actions[0].click();draw();
assert.equal(snap().state,'playing');
assert.deepEqual(snap().player.position,[0,0,0]);assert.equal(snap().player.hp,1000);
assert.equal(snap().player.en,120);assert.equal(snap().player.movement.qbSuccessfulCount,0);
assert.deepEqual(snap().recentPlayerShots,[]);assert.equal(snap().objective.controlsDestroyed,0);
assert.equal(snap().enemies.filter(e=>e.alive&&e.shotsFired===0).length,45);
assert.equal(snap().elapsedSeconds,0);
console.log('Real entrypoint with mocked DOM/renderer:',renderLog.length,'scene renders. Loss and redeploy at',failure.elapsedSeconds.toFixed(3),'s.');
// Display cadence must not change input edges, simulation time or sweeps.
for (const leg of ['biped','quadruped']) {
 let reference;
 for (const fps of [30,60,120]) {
  down('Escape');actions[2].click();up('Escape');
  choose('legs',leg);by('deploy').click();draw();
  down('KeyQ');down('KeyW');advance(.1,fps);
  up('KeyQ');up('KeyW');advance(.9,fps);
  const first=snap();
  down('Space');advance(.3,fps);down('KeyD');advance(.1,fps);
  down('Digit2');up('Digit2');emit(by('field'),'mousedown',{button:0});advance(1.1,fps);
  emit(window,'mouseup',{button:0});up('Space');up('KeyD');
  down('ControlLeft');advance(.5,fps);up('ControlLeft');
  const observed=[first,snap()];
  assert.equal(observed[1].recentPlayerShots.length,5);
  if(reference)assert.deepEqual(observed,reference);
  else reference=observed;
 }
}
