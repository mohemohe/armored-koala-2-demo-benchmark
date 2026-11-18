import * as T from 'three';
import {factoryReflections} from './surfaces.js';
import {buildMech,enemyMesh,metal} from './model.js';
import {createHangar} from './hangar.js';
import {createWorld} from './stage.js';
import {createCombat} from './combat.js';
import {createPlayer,stepMovement,KeyInput,FCS} from './movement.js';
import {$,configure,dialog,hideDialog,manual} from './ui.js';

const V=T.Vector3, DT=1/120, weaponNames={machinegun:'MACHINE GUN',beam:'BEAM RIFLE',missile:'HAND MISSILE'};
const val=new URLSearchParams(location.search).get('seed');
const seed=val!==null&&/^\d+$/.test(val)&&Number(val)<=0xffffffff?Number(val):20260908;
const loadout={fcs:'medium',generator:'balanced',legs:'biped'},keys=new KeyInput();
const bay=new T.Scene(),field=new T.Scene();
field.background=new T.Color(0x252f34);field.fog=new T.FogExp2(0x344048,.0039);
const camera=new T.PerspectiveCamera(62,1,.09,280);
const showroomCamera=new T.OrthographicCamera(-4,4,2.4,-2.4,.08,95);
let bayRenderer,fieldRenderer;
function renderer(canvas){
 const r=new T.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
 r.setPixelRatio(Math.min(devicePixelRatio,1.65));r.outputColorSpace=T.SRGBColorSpace;r.toneMapping=T.ACESFilmicToneMapping;r.toneMappingExposure=1.1;
 return r;
}
let state='garage',requested=null,elapsed=0,acc=0,lastFrame=null,visited=new Set(),currentSector=null;
let yaw=0,pitch=-.07,shoot=false,gameMech,showMech,enemyModels=[],autoRotate=false,drag=null,rotation=0,gateEvent='',gateEventAt=0;
let player,combat,world,effectNodes=new Map(),garageDirty=true;
const flatForward=new V(),eye=new V(),muzzle=new V(),pivot=new V(),third=new V(),look=new V(),right=new V(),quat=new T.Quaternion();
const particleGeo=new T.IcosahedronGeometry(1,1),shotGeo=new T.CylinderGeometry(1,1,1,8);
const yAxis=new V(0,1,0);
const missileNose=new T.ConeGeometry(.17,.38,8), exhaustCone=new T.ConeGeometry(.115,.82,8);
function missileVisual(){
 const body=new T.Group(),tube=new T.Mesh(shotGeo,metal(0x9babae));
 tube.scale.set(.17,.68,.17);body.add(tube);
 const nose=new T.Mesh(missileNose,metal(0xe58a47));nose.position.y=.48;body.add(nose);
 const exhaust=new T.Mesh(exhaustCone,metal(0xffbd56,true));
 exhaust.rotation.z=Math.PI;exhaust.position.y=-.73;body.add(exhaust);
 return body;
}
const colors={machinegun:0xffd774,beam:0x63ffeb,missile:0xff982e,enemyGuard:0xff443e,enemyTurret:0xff762f,impact:0xffeba8,explosion:0xff7e30};

function resize(){
 const w=innerWidth,h=innerHeight;
 camera.aspect=w/h;camera.updateProjectionMatrix();
 fieldRenderer?.setSize(w,h,false);
 if(combat)combat.lock.radiusCssPx=Math.min(w,h)*FCS[loadout.fcs].radius;
 if(state==='garage'){
  const ww=$('viewer').clientWidth,hh=$('viewer').clientHeight;
  let height=4.65;const aspect=ww/Math.max(hh,1);
  showroomCamera.left=-height*aspect/2;showroomCamera.right=-showroomCamera.left;showroomCamera.top=height/2;showroomCamera.bottom=-height/2;
  showroomCamera.setViewOffset(ww,hh,-ww*.075,0,ww,hh);showroomCamera.updateProjectionMatrix();
  bayRenderer?.setSize(ww,hh,false);garageDirty=true;
 }
}
function rebuildShowMech(){
 if(showMech){bay.remove(showMech.root);releaseDecals(showMech.root)}
 showMech=buildMech(loadout.legs);bay.add(showMech.root);garageDirty=true;
}
function releaseDecals(root){root.traverse(o=>{if(o.material?.isMeshBasicMaterial&&o.material.map){o.material.map.dispose();o.material.dispose();o.geometry.dispose()}})}
function reset(){
 if(world)world.dispose();if(gameMech){field.remove(gameMech.root);releaseDecals(gameMech.root)}
 for(const e of enemyModels)field.remove(e.root);
 for(const n of effectNodes.values())field.remove(n);effectNodes.clear();
 world=createWorld(field);player=createPlayer(loadout,world.spawn);combat=createCombat(world,player,loadout);
 combat.lock.radiusCssPx=Math.min(innerWidth,innerHeight)*FCS[loadout.fcs].radius;
 gameMech=buildMech(loadout.legs);field.add(gameMech.root);
 enemyModels=world.enemies.map(e=>{const model=enemyMesh(e.kind,e.isGateControl);field.add(model.root);return model});
 elapsed=0;acc=0;yaw=0;pitch=-.07;shoot=false;keys.clear();visited.clear();currentSector=world.sector(player.pos);visited.add(currentSector);gateEvent='';
 updateCamera();posePlayer();
}
function garage(){
 requested=null;state='garage';hideDialog();document.exitPointerLock?.();keys.clear();shoot=false;
 $('garage').hidden=false;$('field').hidden=$('hud').hidden=true;
 document.querySelector('header').hidden=document.querySelector('footer').hidden=false;reset();resize();
}
function acquire(mode){
 if(requested)return;
 requested=mode;
 $('field').hidden=false;
 try{
  const p=$('field').requestPointerLock();
  if(p?.catch)p.catch(()=>lockError());
 } catch{lockError()}
}
function lockError(){
 if(!requested)return;
 const mode=requested;requested=null;
 if(state==='garage')$('field').hidden=true;
 dialog('INPUT / POINTER LOCK','マウスの取得に失敗しました','<p>このタブをアクティブにして、再試行してください。埋め込み表示では、ゲームを独立したタブで開いてください。</p>',[['再試行',()=>acquire(mode)],['格納庫へ戻る',garage]]);
}
function pause(){
 if(state!=='playing')return;
 state='paused';shoot=false;keys.clear();acc=0;lastFrame=null;
 if(document.pointerLockElement)document.exitPointerLock();
 pauseMenu();
}
function pauseMenu(){
 dialog('MISSION / STANDBY','一時停止','<p>'+currentSector+'　'+world.sectors.find(s=>s.id===currentSector)?.name+'　｜　制御砲台 '+world.objective.controlsDestroyed+' / 6</p>',[['作戦を再開',()=>acquire('resume')],['操作ガイド',()=>guide(true)],['格納庫へ戻る',garage]]);
}
function guide(paused=false){dialog('REFERENCE / OPERATIONS','操作ガイド',manual(),[['戻る',paused?pauseMenu:hideDialog]])}
function finish(result){
 state=result;keys.clear();shoot=false;requested=null;document.exitPointerLock?.();acc=0;
 dialog(result==='cleared'?'MISSION COMPLETE':'UNIT OFFLINE',result==='cleared'?'脱出成功':'機体大破','<p>作戦時間 '+clock(elapsed)+'　｜　制御砲台 '+world.objective.controlsDestroyed+' / 6<br>撃破数 '+world.enemies.filter(e=>!e.alive).length+' / 45</p>',[['同じ構成で再出撃',()=>acquire('deploy')],['格納庫へ戻る',garage]]);
}
document.addEventListener('pointerlockchange',()=>{
 if(document.pointerLockElement===$('field')&&requested){
  if(requested==='deploy')reset();requested=null;state='playing';hideDialog();keys.clear();shoot=false;lastFrame=null;acc=0;
  $('garage').hidden=true;document.querySelector('header').hidden=document.querySelector('footer').hidden=true;
  $('field').hidden=$('hud').hidden=false;resize();
 }else if(!document.pointerLockElement)pause();
 else if(state!=='playing')document.exitPointerLock?.();
});
document.addEventListener('pointerlockerror',lockError);
window.addEventListener('blur',()=>{if(requested)lockError();pause();keys.clear()});
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(requested)lockError();pause()}});
window.addEventListener('keydown',e=>{
 if(state==='playing')e.preventDefault();
 keys.down(e.code,state==='playing',e.repeat);
 if(e.code==='Escape'&&state==='playing')pause();
 if(state==='playing'&&!e.repeat&&/^Digit[123]$/.test(e.code))player.weapon=['machinegun','beam','missile'][+e.code.slice(-1)-1];
});
window.addEventListener('keyup',e=>keys.up(e.code));
$('field').addEventListener('mousedown',e=>{if(!e.button&&state==='playing')shoot=true});
window.addEventListener('mouseup',e=>{if(!e.button)shoot=false});
window.addEventListener('mousemove',e=>{if(state==='playing'){yaw-=e.movementX*.0022;pitch=T.MathUtils.clamp(pitch-e.movementY*.002,-1.22,1.12)}});
$('bay').addEventListener('pointerdown',e=>{drag=e.clientX;$('bay').setPointerCapture(e.pointerId)});
$('bay').addEventListener('pointermove',e=>{if(drag!==null){rotation+=(e.clientX-drag)*.012;drag=e.clientX;garageDirty=true}});
$('bay').addEventListener('pointerup',()=>drag=null);$('bay').addEventListener('pointercancel',()=>drag=null);
$('rotate').onclick=()=>{autoRotate=!autoRotate;$('rotateLabel').textContent=autoRotate?'STOP':'ROTATE';$('rotate').setAttribute('aria-pressed',autoRotate)};
$('guide').onclick=()=>guide();$('deploy').onclick=()=>acquire('deploy');

function updateCamera(){
 flatForward.set(-Math.sin(yaw),0,-Math.cos(yaw));right.set(Math.cos(yaw),0,-Math.sin(yaw));
 look.copy(flatForward).multiplyScalar(Math.cos(pitch));look.y=Math.sin(pitch);
 pivot.copy(player.pos);pivot.y+=2.35;
 third.copy(pivot).addScaledVector(right,1.36).addScaledVector(look,-6.9);third.y+=.65;
 const f=world.hit(pivot,third,.16);camera.position.lerpVectors(pivot,third,Math.min(1,Math.max(.002,f-.015)));
 camera.lookAt(eye.copy(camera.position).add(look));camera.updateMatrixWorld();
}
function posePlayer(){
 gameMech.positionMuzzle(player.pos,yaw,world,muzzle);
}
function orientGun(){
 gameMech.setWeapon(player.weapon);
 gameMech.aimArm(combat.direction.clone().applyQuaternion(gameMech.root.getWorldQuaternion(quat).invert()));
}
function tick(){
 updateCamera();posePlayer();
 const before=world.objective.controlsDestroyed;
 stepMovement(player,keys.sample(flatForward),DT,elapsed,world,()=>combat.step(DT,elapsed,camera,innerWidth,innerHeight,muzzle,shoot));
 orientGun();elapsed+=DT;world.update();
 currentSector=world.sector(player.pos);if(currentSector)visited.add(currentSector);
 if(world.objective.controlsDestroyed>before){gateEvent='隔壁開放　'+world.objective.openBarrierIds.at(-1);gateEventAt=elapsed}
 if(player.hp<=0||player.pos.y < -45)finish('failed');else if(world.escaped(player.pos))finish('cleared');
}

function renderEffects(){
 const live=new Set();
 function node(key,geo,c,factory=null){
  live.add(key);
  if(!effectNodes.has(key)){const n=factory?factory():new T.Mesh(geo,metal(c,true));field.add(n);effectNodes.set(key,n)}
  return effectNodes.get(key);
 }
 function line(key,a,b,r,c){const n=node(key,shotGeo,c);const dir=b.clone().sub(a);n.position.copy(a).lerp(b,.5);n.scale.set(r,Math.max(.02,dir.length()),r);n.quaternion.setFromUnitVectors(yAxis,dir.normalize())}
 for(const b of combat.bullets){
  const dir=b.velocity.clone();if(b.kind==='machinegun')dir.y-=18*b.age;dir.normalize();
  if(b.kind==='missile'){
   const missile=node(b,null,0,missileVisual);
   missile.position.copy(b.pos);missile.quaternion.setFromUnitVectors(yAxis,dir);
   missile.children[2].scale.y=.9+Math.sin(b.age*83)*.12;
  }else{
   const end=b.pos.clone().addScaledVector(dir,-.73);
   line(b,b.pos,end,b.kind==='enemyTurret'?.15:.08,colors[b.kind]);
  }
 }
 for(const e of combat.effects){
  if(e.a.distanceToSquared(e.b)>.001)line(e,e.a,e.b,e.kind==='beam'?.09:.16,colors[e.kind]);
  else{const n=node(e,particleGeo,colors[e.kind]);n.position.copy(e.a);const f=e.life/e.duration;n.scale.setScalar(e.kind==='explosion'?.2+2.8*Math.sin(Math.PI*f):.1+.32*f)}
 }
 for(const [key,n] of effectNodes)if(!live.has(key)){field.remove(n);effectNodes.delete(key)}
}
function clock(s){return String(Math.floor(s/60)).padStart(2,'0')+':'+String(Math.floor(s)%60).padStart(2,'0')}
function project(el,p,clamp=false){
 let a=p.clone().project(camera);
 if(a.z>1||a.z< -1){if(!clamp){el.hidden=true;return}a.multiplyScalar(-1);a.y=-.7}
 el.hidden=false;el.style.left=T.MathUtils.clamp((1+a.x)*50,2,98)+'%';el.style.top=T.MathUtils.clamp((1-a.y)*50,5,94)+'%';
}
const bar=p=>'<div class="bar"><i style="width:'+Math.min(100,Math.max(0,p))+'%"></i></div>';
function hud(){
 const o=world.objective,m=player.movement,sector=world.sectors.find(s=>s.id===currentSector),l=combat.lock,fc=combat.fireControl;
 $('sectorId').textContent=currentSector||'—';$('sectorName').textContent=(sector?.name||'')+' / '+(sector?.english||'');
 $('objective').textContent=(o.gateOpen?'搬出ゲート開放　脱出せよ':'隔壁の制御砲台を破壊')+'　'+o.controlsDestroyed+' / 6';
 $('gateNotice').textContent=elapsed-gateEventAt<4?gateEvent:'';$('gameTime').textContent='MISSION　'+clock(elapsed);
 $('circle').style.width=$('circle').style.height=2*l.radiusCssPx+'px';
 $('lockstate').style.top='calc(50% + '+(l.radiusCssPx+12)+'px)';
 $('lockstate').textContent=l.state==='locked'?'◆ LOCKED　'+l.targetId+'　'+(fc.status==='solved'?'補正中':'補正解なし'):l.state==='acquiring'?'ACQUIRING　'+Math.round(l.progress*100)+'%':'FCS　/　SEARCH';
 const target=world.enemies.find(e=>e.id===l.targetId);
 if(target)project($('targetMark'),target.pos);else $('targetMark').hidden=true;
 if(fc.aimPoint)project($('solutionMark'),new V(...fc.aimPoint),true);else $('solutionMark').hidden=true;
 const wp=world.nextTarget(player.pos);project($('waypoint'),wp,true);
 const targetControl=world.enemies.find(e=>e.isGateControl&&e.alive);
 $('waypoint').textContent='◇ '+(targetControl&&targetControl.pos.distanceToSquared(wp)<.1?'CONTROL':'ROUTE')+'　'+Math.round(wp.distanceTo(player.pos))+' m';
 $('feedback').textContent=combat.notice;
 $('weaponInfo').innerHTML='<small>WEAPON / 0'+(['machinegun','beam','missile'].indexOf(player.weapon)+1)+'</small><strong>'+weaponNames[player.weapon]+'</strong>'+(player.weapon==='beam'?'∞　/　8 EN':player.ammo[player.weapon]+' ROUNDS');
 $('energy').innerHTML='<small>GENERATOR / EN</small><strong>'+Math.floor(player.en)+' / '+player.stats.maxEn+'</strong>'+bar(player.en/player.stats.maxEn*100);
 $('health').innerHTML='<small>ARMOR / HP</small><strong>'+player.hp+' / 1000</strong>'+bar(player.hp/10);
 $('motion').textContent=m.horizontalMode.toUpperCase()+' / '+m.verticalMode.toUpperCase()+'　 QB '+(m.qbCooldownRemainingSeconds>.001?m.qbCooldownRemainingSeconds.toFixed(2)+' s':player.en<36?'LOW EN':'READY');
 const d=combat.hitDirection;$('damage').style.opacity=Math.max(0,1-(elapsed-combat.hitAt)*2.7);$('damage').style.transform='translate(-50%,-50%) rotate('+Math.atan2(d.dot(right),d.dot(flatForward))+'rad)';
}
function renderGame(){
 updateCamera();posePlayer();orientGun();
 gameMech.animate(elapsed,player.movement.horizontalMode==='walk'&&player.grounded?Math.hypot(player.vel.x,player.vel.z):0,player.movement.horizontalMode==='quickboost'?'quickboost':player.movement.verticalMode==='flying'?'flying':player.movement.glideEnabled?'glide':false);
 world.enemies.forEach((e,i)=>{const model=enemyModels[i];model.root.visible=e.alive&&e.pos.distanceToSquared(player.pos)<220**2;if(!model.root.visible)return;model.root.position.copy(e.pos);model.root.rotation.y=Math.atan2(e.facing.x,e.facing.z);model.lamp.scale.y=e.warning?.35:.13;model.lamp.material=metal(e.warning?0xffeb8b:0xff4935,true)});
 renderEffects();hud();fieldRenderer.render(field,camera);
}
function frame(now){
 const delta=lastFrame===null?0:Math.max(0,(now-lastFrame)/1000);lastFrame=now;
 if(state==='playing'){
  acc+=delta;while(acc+1e-10>=DT&&state==='playing'){acc-=DT;tick()}
  renderGame();
 }else if(state==='garage'&&(garageDirty||autoRotate)){
  if(autoRotate)rotation+=Math.min(delta,.1)*.46;showMech.root.rotation.y=rotation;bayRenderer.render(bay,showroomCamera);garageDirty=false;
 }
 requestAnimationFrame(frame);
}
function snapshot(){
 return structuredClone({version:'AK2-1.2-candidate',seed,state,elapsedSeconds:elapsed,loadout,player:{position:player.pos.toArray(),velocity:player.vel.toArray(),grounded:player.grounded,hp:player.hp,en:player.en,weapon:player.weapon,ammo:player.ammo,movement:player.movement},effectiveStats:player.stats,lock:combat.lock,fireControl:combat.fireControl,recentPlayerShots:combat.recentPlayerShots,enemies:world.enemies.map(e=>({id:e.id,kind:e.kind,isGateControl:e.isGateControl,sectorId:e.sectorId,position:e.pos.toArray(),velocity:e.vel.toArray(),hp:e.hp,alive:e.alive,alert:e.alert,hasLineOfSight:e.hasLineOfSight,shotsFired:e.shotsFired,lastShotAtSeconds:e.lastShotAtSeconds})),objective:world.objective,stage:{sectorCount:world.sectors.length,currentSectorId:currentSector,visitedSectorIds:[...visited],totalEnemies:world.enemies.length}});
}
configure(loadout,key=>{
 if(key==='legs')rebuildShowMech();
 player=createPlayer(loadout,world.spawn);combat=createCombat(world,player,loadout);resize();
});
try{
 bayRenderer=renderer($('bay'));bayRenderer.shadowMap.enabled=true;bayRenderer.shadowMap.type=T.PCFSoftShadowMap;
 fieldRenderer=renderer($('field'));bay.environment=field.environment=factoryReflections();createHangar(bay);rebuildShowMech();
 const target=new V(-.4,1.61,0);showroomCamera.position.copy(target).add(new V(3.3,2.6,8.5));showroomCamera.lookAt(target);
 reset();resize();window.addEventListener('resize',resize);
 new ResizeObserver(()=>{if(state==='garage')resize()}).observe($('viewer'));
 window.__AK2__=Object.freeze({getSnapshot:snapshot});requestAnimationFrame(frame);
}catch(err){console.error(err);dialog('DISPLAY / ERROR','描画を開始できません','<p>WebGLを有効にしたデスクトップブラウザーで開いてください。</p><p>'+String(err.message).replace(/[<>]/g,'')+'</p>',[['再読み込み',()=>location.reload()]])}
