import * as T from 'three';
import {armorFinish} from './surfaces.js';

const materials = new Map();
export function metal(color, emissive=false) {
  const key=color+':'+emissive;
  if (!materials.has(key)) materials.set(key, emissive ? new T.MeshBasicMaterial({color}) :
    new T.MeshStandardMaterial({color,map:armorFinish(),roughness:0.52,metalness:0.46,flatShading:true}));
  return materials.get(key);
}
const iron=0x303b40, graphite=0x1c2326, steel=0x76838a, silver=0xaeb7b7, paint=0xe78332, gold=0xffb153, light=0xffe5b2, ivory=0xcccdc1;
const plume=new T.ConeGeometry(.21,.92,12);
const cube=new T.BoxGeometry(), ball=new T.IcosahedronGeometry(1,2), cylinder=new T.CylinderGeometry(1,1,1,14), parts=new Map();
function mesh(parent,geo,mat,x,y,z,w,h,d){
 const o=new T.Mesh(geo,mat);parent.add(o);o.position.set(x,y,z);o.scale.set(w,h,d);o.castShadow=true;o.receiveShadow=true;return o;
}
export function box(p,x,y,z,w,h,d,c){return mesh(p,cube,metal(c),x,y,z,w,h,d)}
function ell(p,x,y,z,w,h,d,c){return mesh(p,ball,metal(c),x,y,z,w,h,d)}
export function tube(p,x,y,z,r,h,c){return mesh(p,cylinder,metal(c),x,y,z,r,h,r)}
function group(p,x=0,y=0,z=0){let g=new T.Group();p.add(g);g.position.set(x,y,z);return g}
function plate(p,x,y,z,w,h,d,c,taper=.86,cut=.17){
 const k=[taper,cut].join();let geo=parts.get(k);
 if(!geo){
   const outline=[[-.5+cut,-.5],[.5-cut,-.5],[.5,-.5+cut],[.5,.5-cut],[.5-cut,.5],[-.5+cut,.5],[-.5,.5-cut],[-.5,-.5+cut]];
   let vertices=[],indices=[];
   for(const [y,s] of [[-.5,taper*.86],[-.36,taper],[.34,1],[.5,.85]])for(const [x,z] of outline)vertices.push(x*s,y,z*s);
   for(let j=0;j<3;j++)for(let i=0;i<8;i++){const a=j*8+i,b=j*8+(i+1)%8;indices.push(a,a+8,b,b,a+8,b+8)}
   for(let i=1;i<7;i++)indices.push(0,i,i+1,24,25+i,24+i);
   geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(vertices,3));geo.setIndex(indices);geo=geo.toNonIndexed();geo.computeVertexNormals();
   const positions=geo.attributes.position,normals=geo.attributes.normal,uv=[];
   for(let i=0;i<positions.count;i++){
     const nx=Math.abs(normals.getX(i)),ny=Math.abs(normals.getY(i)),nz=Math.abs(normals.getZ(i));
     const u=nx>nz&&nx>ny?positions.getZ(i):positions.getX(i);
     const v=ny>nx&&ny>nz?positions.getZ(i):positions.getY(i);
     uv.push(u+.5,v+.5);
   }
   geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));parts.set(k,geo);
 }
 return mesh(p,geo,metal(c),x,y,z,w,h,d);
}
function strut(p,a,b,r,c){
 let start=new T.Vector3(...a),end=new T.Vector3(...b),dir=end.clone().sub(start);
 let o=tube(p,...start.clone().lerp(end,.5).toArray(),r,dir.length(),c);
 o.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),dir.normalize());return o;
}
export function decal(p,txt,x,y,z,w,h,color='#ece7d6'){
 let cv=document.createElement('canvas');cv.width=512;cv.height=128;let ctx=cv.getContext('2d');ctx.font='bold 96px sans-serif';ctx.fillStyle=color;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(txt,256,68,500);
 const tex=new T.CanvasTexture(cv);tex.colorSpace=T.SRGBColorSpace;
 const o=new T.Mesh(new T.PlaneGeometry(w,h),new T.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2}));p.add(o);o.position.set(x,y,z);return o;
}
const muzzleBand = new T.TorusGeometry(.173,.027,7,28);
const bore = new T.CylinderGeometry(1,1,1,12);
function forwardDisc(p,x,y,z,r,length,mat){
 const disc=mesh(p,bore,metal(mat),x,y,z,r,length,r);
 disc.rotation.x=Math.PI/2;
 return disc;
}
function bolt(p,x,y,z,r=.027){forwardDisc(p,x,y,z,r,.029,steel)}
function joint(p,x,y,z,r){
 const j=tube(p,x,y,z,r,.43,graphite);j.rotation.z=Math.PI/2;
 for(const side of [-1,1]){let cap=tube(p,x+side*.23,y,z,r*.73,.06,steel);cap.rotation.z=Math.PI/2;}
}
function vents(p,x,y,z,n,width){
 for(let i=0;i<n;i++){let slat=box(p,x,y+i*.085,z,width,.044,.08,graphite);slat.rotation.x=.17}
}
export function buildMech(legs='biped'){
 const root=new T.Group(),body=group(root),legParts=[],flames=[];
 const quad=legs==='quadruped';
 for(const side of [-1,1]) for(const row of quad?[-1,1]:[0]){
   const x=side*(quad?.73:.52), hip=group(body,x,2.05,row*.64);
   legParts.push(hip);hip.rotation.z=side*.08;
   joint(hip,0,-.05,0,.28);
   plate(hip,side*.05,-.45,-.02,.64,.79,.7,iron);
   plate(hip,side*.05,-.43,.24,.58,.64,.37,ivory);
   strut(hip,[side*.31,-.22,-.09],[side*.31,-.81,.10],.085,steel);
   joint(hip,side*.10,-.89,.13,.28);
   plate(hip,side*.10,-.89,.34,.61,.41,.38,paint);
   plate(hip,side*.14,-1.37,0,.66,.80,.69,graphite,1.18);
   plate(hip,side*.14,-1.37,.18,.67,.78,.58,ivory,1.20);
   plate(hip,side*.15,-1.42,.45,.34,.54,.13,paint,1.25);
   for(const sign of [-1,1]) bolt(hip,side*.15+sign*.119,-1.27,.517,.025);
   for (let i=0;i<3;i++) box(hip,side*.15,-1.42-i*.061,.518,.195,.024,.022,graphite);
   plate(hip,side*.15,-.85,.531,.279,.162,.06,graphite);
   box(hip,side*.15,-.85,.562,.122,.029,.018,light).material=metal(light,true);
   for(const k of [-1,1])strut(hip,[side*.15+k*.22,-1.15,-.2],[side*.15+k*.22,-1.78,-.13],.06,silver);
   plate(hip,side*.15,-1.86,.15,.82,.31,1.08,iron,1.24);
   plate(hip,side*.15,-1.93,.32,.86,.21,1.06,graphite,1.1);
   plate(hip,side*.15,-1.83,.56,.71,.23,.50,ivory,1.15);
 }
 plate(body,0,2.03,0,1.63,.53,.96,graphite);
 plate(body,0,2.08,.30,1.27,.40,.67,steel);
 for(const s of [-1,1])plate(body,s*.7,2.03,.06,.48,.67,.93,paint,.72).rotation.z=s*.16;
 for(let i=0;i<3;i++)plate(body,0,2.34+i*.13,.01,1.04,.12,.80,iron);
 plate(body,0,2.99,-.03,1.96,1.01,1.08,graphite,.75);
 for(const s of [-1,1]){
   plate(body,s*.53,3.05,.30,.97,.76,.78,ivory,.76).rotation.z=-s*.10;
   plate(body,s*.52,3.14,.65,.76,.34,.24,paint,.82);
   vents(body,s*.49,2.82,.657,3,.42);
   box(body,s*.78,3.23,.63,.19,.07,.04,light).material=metal(light,true);
   plate(body,s*.58,2.98,-.65,.61,1.22,.73,steel);
   tube(body,s*.58,2.38,-.69,.23,.27,graphite);
   const jet=group(body,s*.58,2.33,-.80);
   jet.rotation.x=.67;
   tube(jet,0,-.025,0,.224,.115,graphite);
   tube(jet,0,-.095,0,.167,.038,steel);
   const f=mesh(jet,plume,metal(0x42dff6,true),0,-.54,0,1,1,1);
   f.rotation.z=Math.PI;flames.push(f);f.visible=false;
   const core=mesh(jet,plume,metal(0xdbfeff,true),0,-.32,.056,.73,.50,.73);
   core.rotation.z=Math.PI;flames.push(core);core.visible=false;
 }
 for(const s of [-1,1]){
  forwardDisc(body,s*.75,3.19,.717,.055,.035,steel);
  box(body,s*.76,3.19,.741,.036,.013,.012,graphite);
  for(let i=0;i<3;i++){
    const blade=box(body,s*(.31+i*.095),3.11,.781,.048,.21,.019,iron);
    blade.rotation.z=-s*.31;
  }
  strut(body,[s*.46,2.22,.28],[s*.60,2.64,.33],.053,steel);
 }
 plate(body,0,3.00,.53,.69,.68,.46,iron,.76);decal(body,'AK2',0,3.03,.768,.46,.16);
 // Mechanical collar supporting a sculpted, faceted koala head.
 tube(body,0,3.48,0,.46,.25,iron);
 const head=group(body,0,3.99,.04);
 for(const s of [-1,1]){
   ell(head,s*.67,.18,-.04,.38,.40,.24,0x9aa3a4);
   ell(head,s*.70,.18,.06,.26,.29,.20,0xcec9bb);
   ell(head,s*.72,.19,.15,.17,.20,.11,0x7b7c77);
   for(let k=0;k<3;k++)ell(head,s*(.92-k*.04),.22-k*.12,-.02,.12,.10,.14,0xabafb0);
 }
 ell(head,0,.01,0,.70,.58,.51,0x9da7a8);
 ell(head,-.25,-.20,.33,.33,.26,.245,0xd5d7ce);ell(head,.25,-.20,.33,.33,.26,.245,0xd5d7ce);
 for(const s of [-1,1]){
   ell(head,s*.32,.06,.437,.094,.10,.072,0x161d20);
   ell(head,s*.32-.018,.093,.502,.024,.024,.014,0xf5efd7);
 }
 ell(head,0,-.053,.53,.207,.26,.15,0x202427);
 plate(head,0,.45,-.09,.83,.21,.75,iron);box(head,.28,.49,.25,.15,.055,.045,paint);
 const gunPivot=group(body,1.30,2.42,2.03);
 // Anchor weapon at its actual muzzle. Rotation keeps the emission point invariant.
 const gun=group(gunPivot,0,0,0);
 for(const s of [-1,1]){
   const a=group(body,s*1.10,3.09,0);
   joint(a,0,0,0,.31);
   plate(a,s*.05,.10,0,.94,.59,.96,paint,.90);
   plate(a,s*.05,.28,-.02,.81,.21,.82,ivory);
   decal(a,s===1?'02':'AK',0,.10,.494,.33,.15);
   for(const ax of [-.32,.32]) bolt(a,ax+s*.05,.15,.491,.038);
   box(a,s*.06,-.018,.470,.51,.035,.036,graphite);
   for(let k=0;k<3;k++) {
     const band=box(a,s*(.14+k*.097),.29,.356,.052,.040,.193,iron);band.rotation.y=s*.38;
   }
   plate(a,s*.38,-.29,-.10,.16,.34,.46,steel);
   if(s===1) continue;
   plate(a,s*.10,-.43,0,.54,.54,.61,iron);
   joint(a,s*.14,-.66,.07,.21);
   const fore=plate(a,s*.16,-.83,.19,.61,.64,.69,ivory);fore.rotation.x=-.32;
   plate(a,s*.17,-.88,.49,.48,.38,.20,iron);
   for(let k=0;k<3;k++)box(a,s*.16+(k-1)*.13,-1.16,.30,.10,.23,.25,graphite);
 }
 // The model faces local +Z. Long rifle extends from the right gauntlet.
 plate(gun,0,0,-1.12,.48,.39,1.32,graphite);
 plate(gun,0,.09,-1.05,.54,.27,.90,steel);
 box(gun,0,.19,-1.13,.23,.10,.52,iron);
 plate(gun,0,-.26,-1.32,.30,.48,.39,iron);
 for(const x of [-.10,.10])for(const y of [-.07,.07]){
  let barrel=tube(gun,x,y,-.43,.067,.79,graphite);barrel.rotation.x=Math.PI/2;
 }
 for(const z of [-.69,-.21,-.06]) mesh(gun,muzzleBand,metal(steel),0,0,z,1,1,1);
 for (const x of [-.09,.09]) for(const y of [-.065,.065]) {
   forwardDisc(gun,x,y,-.026,.069,.048,steel);
   forwardDisc(gun,x,y,-.0005,.046,.003,0x111616);
 }
 decal(gun,'M / 100',0,.09,-.586,.32,.09);
 for(let k=0;k<4;k++)box(gun,0,.246,-.86-k*.12,.46,.033,.044,graphite);
 const arm=group(body),connector=group(body);
 const elbow=new T.Vector3(),shoulder=new T.Vector3(1.16,2.99,.025),up=new T.Vector3(0,1,0);
 const forwardAxis=new T.Vector3(0,0,1);
 plate(arm,0,0,-.16,.55,.49,.73,ivory);
 joint(arm,0,.02,-.46,.201);
 plate(arm,0,-.026,.164,.50,.38,.31,iron);
 for(let k=0;k<3;k++)box(arm,-.155+k*.142,-.12,.23,.11,.185,.23,graphite);
 plate(connector,0,0,0,.41,1,.41,iron);
 for(const side of [-1,1])tube(connector,side*.20,.07,.12,.059,.77,steel);
 function aimArm(localDir) {
    gunPivot.quaternion.setFromUnitVectors(forwardAxis,localDir);
    arm.quaternion.copy(gunPivot.quaternion);
    arm.position.set(0,-.24,-1.30).applyQuaternion(arm.quaternion).add(gunPivot.position);
    elbow.set(0,.02,-.46).applyQuaternion(arm.quaternion).add(arm.position);
    connector.position.copy(shoulder).lerp(elbow,.5);
    elbow.sub(shoulder);
    connector.scale.y=elbow.length();
    if(connector.scale.y>1e-6) connector.quaternion.setFromUnitVectors(up,elbow.normalize());
 }
 aimArm(forwardAxis);
 // Rear-mounted spares move into the gauntlet when selected.
 const beamHousing=group(body),missileHousing=group(body);
 plate(beamHousing,0,0,-1.05,.45,.35,1.25,iron);
 for(const sid of [-1,1]){
   plate(beamHousing,sid*.128,0,-.43,.14,.26,.81,ivory,.80);
   box(beamHousing,sid*.127,.145,-.43,.064,.034,.71,0x47cfdc).material=metal(0x47cfdc,true);
   for(let i=0;i<4;i++)box(beamHousing,sid*.247,0,-.88-i*.095,.075,.37,.042,steel);
 }
 forwardDisc(beamHousing,0,0,-.07,.086,.085,0x46dfec).material=metal(0x46dfec,true);
 plate(missileHousing,0,0,-.75,.62,.55,1.49,graphite);
 plate(missileHousing,0,.035,-.72,.66,.50,.82,paint);
 for(let i=0;i<2;i++)for(let j=0;j<2;j++){
   forwardDisc(missileHousing,(i-.5)*.245,(j-.5)*.218,-.05,.117,.09,steel);
   forwardDisc(missileHousing,(i-.5)*.245,(j-.5)*.218,-.004,.085,.02,iron);
   forwardDisc(missileHousing,(i-.5)*.245,(j-.5)*.218,.004,.048,.015,paint);
 }
 const armaments={machinegun:gun,beam:beamHousing,missile:missileHousing};
 let active=null;
 function setWeapon(type) {
   if(type===active || !armaments[type])return;
   active=type;
   // Both unused weapons bolt into sockets on opposite sides of the backpack.
   const stowed=Object.values(armaments).filter(w=>w!==armaments[type]);
   for(let i=0;i<stowed.length;i++){
     const w=stowed[i],side=i===0?-1:1;
     body.add(w);
     w.rotation.set(-1.18,0,side*.27);
     w.position.set(side*.96,3.91,-.71);
   }
   const w=armaments[type];gunPivot.add(w);w.position.set(0,0,0);w.rotation.set(0,0,0);
 }
 setWeapon('machinegun');
 // Rack stand-offs and folded telemetry antenna.
 for(const sid of [-1,1])plate(body,sid*.82,3.19,-.64,.41,.65,.66,graphite);
 strut(body,[-.95,3.36,-.56],[-1.02,4.12,-.59],.035,steel);
 root.scale.setScalar(.725);
 const muzzleLocal=gunPivot.position.clone();
 const tip=new T.Vector3(),mount=new T.Vector3();
 function positionMuzzle(feet,yaw,world,result){
   root.position.copy(feet);
   root.rotation.y=yaw+Math.PI;
   gunPivot.position.copy(muzzleLocal);
   tip.copy(muzzleLocal);body.localToWorld(tip);
   mount.copy(feet);mount.y+=1.78;
   const fraction=world.hit(mount,tip,.035);
   if(fraction<=1){
     tip.lerpVectors(mount,tip,Math.max(0,fraction-.045));
     gunPivot.position.copy(body.worldToLocal(tip));
   }
   return gunPivot.getWorldPosition(result);
 }
 return {root,body,legs:legParts,flames,gunPivot,aimArm,setWeapon,positionMuzzle,animate(t,speed,boost){
  legParts.forEach((leg,i)=>{leg.rotation.x=Math.sin(t*8+i*Math.PI*(quad?.5:1))*Math.min(.28,speed*.036)});
  flames.forEach((f,i)=>{
   f.visible=Boolean(boost);
   const thrust=boost==='quickboost'?1.55:boost==='flying'?1.08:.73;
   f.scale.y=(i%2?.5:1)*thrust*(.98+Math.sin(t*80)*.06);
   f.position.y=-.11-f.scale.y*.46;
  });
 }};
}
export function enemyMesh(kind,control){
 const g=new T.Group(),tone=control?0xff9d33:0x98534a;
 if(kind==='guard'){
  for(const s of [-1,1]){
   plate(g,s*.51,-.72,-.07,.46,.73,.57,iron);
   joint(g,s*.57,-1.08,.06,.19);
   plate(g,s*.58,-1.49,-.07,.42,.82,.50,steel);
   plate(g,s*.58,-1.974,.15,.60,.252,.82,iron);
   plate(g,s*.85,.20,0,.42,.53,.62,tone);
  }
  plate(g,0,.08,0,1.52,1.18,1.03,steel);plate(g,0,.74,0,.87,.59,.78,graphite);
 }else{
  tube(g,0,-1.83,0,1.69,.34,iron);
  tube(g,0,-1.287,0,1.08,.75,steel);
  for(const s of [-1,1])box(g,s*.96,-1.27,.47,.25,.70,.32,graphite);
  tube(g,0,-.78,0,1.51,.58,graphite);tube(g,0,-.42,0,1.12,.37,steel);plate(g,0,.16,0,2.34,1.09,1.83,tone);
 }
 const lamp=box(g,0,kind==='guard'?.75:.36,kind==='guard'?.41:.93,kind==='guard'?.57:.82,.13,.08,0xff6f4d);lamp.material=metal(0xff4935,true);
 for(const s of [-1,1]){let b=tube(g,s*.52,.04,.86,.12,1.50,iron);b.rotation.x=Math.PI/2}
 return {root:g,lamp}
}
