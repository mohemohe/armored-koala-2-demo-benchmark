// Distances run from the receiving dock along -Z. Each row defines a physical bay
// bounded by side walls, roof and a bulkhead with a single visible doorway.
import * as THREE from 'three';

const V = THREE.Vector3;
const layout = [
// Japanese display name, stencil, design, length, centre X, width, exit X, roof clearance, step, enemies
  ['搬入口', 'RECEIVING DOCK', 'dock', 118, 0, 88, 22, 28, 0, 1, 0],
  ['資材ヤード', 'MATERIAL YARD', 'yard', 138, 9, 106, -12, 36, 0, 3, 1],
  ['圧延棟', 'ROLLING MILL', 'mill', 112, -8, 86, -23, 29, 9, 2, 1],
  ['給水幹線', 'WATER MAINS', 'pipes', 91, -19, 57, 0, 22, 0, 1, 1],
  ['組立ライン', 'ASSEMBLY', 'line', 135, 8, 109, 32, 38, 11, 3, 1],
  ['部品倉庫', 'PARTS DEPOT', 'stores', 107, 25, 74, 11, 27, 0, 2, 1],
  ['搬送縦坑', 'FREIGHT LIFT', 'shaft', 95, 7, 61, -9, 33, 10, 1, 1],
  ['動力棟', 'POWER HALL', 'power', 137, -10, 110, -25, 40, 0, 3, 1],
  ['保守配管区', 'SERVICE GALLERY', 'pipes', 100, -18, 64, -3, 27, 8, 1, 1],
  ['冷却設備', 'COOLING WORKS', 'chillers', 132, 4, 101, 21, 35, 0, 3, 1],
  ['排気縦坑', 'EXHAUST STACK', 'shaft', 91, 17, 62, 1, 36, 12, 1, 1],
  ['主製造ホール', 'FOUNDRY', 'mill', 139, -6, 112, -30, 38, 0, 3, 1],
  ['検査棟', 'TEST CELL', 'lab', 103, -22, 76, -12, 26, 0, 2, 1],
  ['上層搬送路', 'HIGH TRANSFER', 'bridge', 105, -2, 61, 14, 31, 10, 1, 1],
  ['出荷倉庫', 'DISPATCH', 'stores', 125, 18, 104, -7, 32, 0, 2, 1],
  ['搬出ゲート', 'EXTRACTION', 'exit', 102, -5, 66, 0, 26, 0, 1, 1]
];
const controls = [1,4,7,9,12,14];
const splitRooms = [1,5,7,9,14];
let distance = -12, elevation = 0;
export const STAGE = layout.map(([name,english,design,length,x,width,doorX,head,rise,guards,turrets],i)=>{
  const start=distance, base=elevation;
  distance+=length; elevation+=rise;
  return {id:'S'+String(i+1).padStart(2,'0'),i,name,english,design,start,end:distance,
    xMin:x-width/2,xMax:x+width/2,x,width,doorX,head,rise,base,top:elevation,
    step:start+Math.round(length*.52),ceiling:elevation+head,guards,turrets,
    control:controls.includes(i),branch:splitRooms.includes(i)};
});
const COLORS = {
  floor:0x46505a, lower:0x3a4751, wall:0x56626a, ceiling:0x313e49,
  plate:0x6a7478, frame:0x323e48, dark:0x242d35, steel:0x899398,
  amber:0xc98724, copper:0x93543d, marine:0x486a73, crate:0x677269,
  warning:0xf28e29, white:0xe2e5cf, cyan:0x6bd7e4, red:0xff452b
};
const CELL=20, EPS=1e-7;
function intersect(a,dx,dy,dz,b,pad=0) {
  let lo=0, hi=1;
  for (let i=0;i<3;i++){
    const p=i===0?a.x:i===1?a.y:a.z, d=i===0?dx:i===1?dy:dz;
    const min=b.min[i]-pad, max=b.max[i]+pad;
    if(Math.abs(d)<1e-12){if(p<min||p>max)return Infinity;continue;}
    let x=(min-p)/d, y=(max-p)/d;
    if(x>y){const swap=x;x=y;y=swap;}
    lo=Math.max(x,lo);hi=Math.min(y,hi);
    if(lo>hi)return Infinity;
  }
  return hi<1e-8?Infinity:lo;
}
function makeSecurityGrid(){
  const bins=new Map();
  let iteration=0;
  function visit(minX,maxX,minZ,maxZ,fn) {
    for(let i=Math.floor(minX/CELL);i<=Math.floor(maxX/CELL);i++)
      for(let j=Math.floor(minZ/CELL);j<=Math.floor(maxZ/CELL);j++)fn(i*65536+j);
  }
  return {
    add(b){visit(b.min[0],b.max[0],b.min[2],b.max[2],k=>{
      if(!bins.has(k))bins.set(k,[]);bins.get(k).push(b);
    });},
    query(x0,x1,z0,z1,fn){
      const serial=++iteration;
      visit(x0,x1,z0,z1,k=>{
        const items=bins.get(k);
        if(items)for(const b of items)if(b.stamp!==serial&&b.enabled){b.stamp=serial;fn(b);}
      });
    }
  };
}
function floorAt(s,d){return s.base+(d>=s.step?s.rise:0);}
function floorFor(s, d){return floorAt(s,Math.max(s.start,Math.min(s.end,d)));}
function sectorAt(p){const d=-p.z;return STAGE.find(s=>d>=s.start&&d<=s.end&&p.x>=s.xMin-0.01&&p.x<=s.xMax+.01);}

// The authored assembly below emits the collider and its mesh in the same call.
// Small surface fittings, paint and the light strips are cosmetic.
function industrialFinish() {
  // Tileable paint grain, rolled-steel streaks and chipped paint. Generated
  // with its own deterministic stream, independent of combat or stage state.
  const size=256, data=new Uint8Array(size*size*4);
  let value=48271;
  const random=()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value/4294967296;};
  const streaks=Array.from({length:size},()=>random()*7);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const index=(y*size+x)*4;
    const cloud=5*Math.sin(2*Math.PI*x/size)+4*Math.cos(4*Math.PI*y/size+Math.sin(6*Math.PI*x/size));
    const grey=Math.round(241+cloud-streaks[y]+random()*8);
    data.set([grey,grey-1,grey-3,255],index);
  }
  for(let n=0;n<70;n++){
    const x=random()*size|0,y=random()*size|0,length=2+(random()*17|0);
    for(let j=0;j<length;j++){
      const offset=(y*size+(x+j)%size)*4;
      for(let c=0;c<3;c++)data[offset+c]-=8+(n%9);
    }
  }
  const texture=new THREE.DataTexture(data,size,size);
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
  texture.repeat.set(3,2);texture.generateMipmaps=true;
  texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearMipmapLinearFilter;
  texture.needsUpdate=true;return texture;
}
export function createWorld(scene=null){
  const root=new THREE.Group(), grid=makeSecurityGrid(), batches=new Map(), signs=[],enemies=[], barriers=[];
  root.name='Kestrel industrial facility'; if(scene)scene.add(root);
  const spawn=new V(0,0,0), objective={controlsDestroyed:0,controlsRequired:6,openBarrierIds:[],gateOpen:false};
  let region=0;
  const cube=new THREE.BoxGeometry(1,1,1), tube=new THREE.CylinderGeometry(.5,.5,1,14), round=new THREE.CylinderGeometry(.5,.5,1,30);
  const matrix=new THREE.Matrix4(),q=new THREE.Quaternion(),unit=new THREE.Vector3(),scale=new V();
  const mats = {
    solid:new THREE.MeshStandardMaterial({roughness:.83,metalness:.22,map:scene?industrialFinish():null}),
    lit:new THREE.MeshBasicMaterial({toneMapped:false})
  };
  function addVis(x,y,z,w,h,d,color,geometry='cube',rotation=null,lit=false){
    if(!scene)return;
    const key=[region,geometry,lit].join('/');
    let batch=batches.get(key);
    if(!batch){batch={geo:geometry==='cube'?cube:geometry==='tube'?tube:round,mat:lit?mats.lit:mats.solid,entries:[]};batches.set(key,batch);}
    if(rotation)q.setFromEuler(new THREE.Euler(...rotation));else q.identity();
    matrix.compose(unit.set(x,y,z),q,scale.set(w,h,d));
    batch.entries.push([matrix.clone(),color]);
  }
  function box(x,y,d,w,h,l,paint='wall',solid=true,rot=null,lit=false){
    const color=COLORS[paint]??paint;
    addVis(x,y,-d,w,h,l,color,'cube',rot,lit);
    if(!solid)return;
    const b={min:[x-w/2,y-h/2,-d-l/2],max:[x+w/2,y+h/2,-d+l/2],enabled:true};
    grid.add(b);return b;
  }
  function pipe(x,y,d,width,length,color,rot){
    addVis(x,y,-d,width,length,width,COLORS[color]??color,'tube',rot);
  }
  function cylinder(x,y,d,width,height,paint='marine'){
    addVis(x,y,-d,width,height,width,COLORS[paint],'round');
  }
  function sign(x,y,d,w,h,title,sub,bg,angle=0){
    if(!scene||typeof document==='undefined')return;
    const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=256;
    const ctx=canvas.getContext('2d');
    if(!ctx)return;
    ctx.fillStyle=bg;ctx.fillRect(0,0,1024,256);
    ctx.fillStyle='#f4a735';ctx.fillRect(20,22,7,210);
    ctx.fillStyle='#afc1c1';ctx.font='bold 30px monospace';ctx.fillText(sub,51,65,920);
    ctx.fillStyle='#e3e5d9';ctx.font='bold 106px sans-serif';ctx.fillText(title,43,193,924);
    ctx.fillStyle='#a67639';ctx.fillRect(49,216,848,4);
    for(let k=0;k<9;k++)ctx.fillRect(920+k*8,205,k%2?4:2,30);
    const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:tex}));
    mesh.position.set(x,y,-d);mesh.rotation.y=angle;root.add(mesh);signs.push(mesh);
  }
  const gatesById=new Map();
  function shutter(s,id,x,d,bottom,height,w) {
    const b={min:[x-w/2,bottom,-d-.7],max:[x+w/2,bottom+height,-d+.7],enabled:true};
    grid.add(b);
    const g=new THREE.Group();
    if(scene){
      const slab=new THREE.Mesh(cube,new THREE.MeshStandardMaterial({color:0x705543,metalness:.3,roughness:.68}));
      slab.position.set(x,bottom+height/2,-d);slab.scale.set(w,height,1.4);g.add(slab);
      for(let i=1;i<height;i+=1.7){
        const strip=new THREE.Mesh(cube,mats.solid);strip.material=new THREE.MeshStandardMaterial({color:0x29343a});
        strip.scale.set(w,.12,.14);strip.position.set(x,bottom+i,-d+.72);g.add(strip);
      }
      for(let i=-3;i<=3;i++){
        const dash=new THREE.Mesh(cube,new THREE.MeshBasicMaterial({color:0xff982c}));
        dash.position.set(x+i*1.75,bottom+height*.42,-d+.76);dash.scale.set(.7,1.05,.08);dash.rotation.z=-.45;g.add(dash);
      }
      root.add(g);
    }
    const gate={id,sectorId:s.id,box:b,mesh:g};barriers.push(gate);gatesById.set(id,gate);
  }
  function crate(x,d,f,w,h,l,paint='crate') {
    box(x,f+h/2,d,w,h,l,paint);
    box(x,f+.2,d,w+.1,.4,l+.1,'dark',false);
    box(x,f+h-.16,d,w+.07,.32,l+.08,'frame',false);
    for(const edge of [-1,1]){
      box(x+edge*w*.4,f+h*.5,d,w*.045,h,l+.08,'steel',false);
      box(x,f+h*.68,d+edge*l*.501,w*.23,.35,.03,'amber',false);
    }
  }
  function tank(x,d,f,w,h) {
    // Pressure-vessel enclosure with a solid rectangular skid and inset vessel.
    box(x,f+h*.42,d,w,h*.84,w,'marine');
    cylinder(x,f+h*.85,d,w*.94,h*.3,'marine');
    for(const k of [.12,.59,.79])box(x,f+h*k,d,w+.1,.23,w+.1,'steel',false);
    box(x-w*.26,f+h*.51,d-w*.505,.28,h*.67,.07,'white',false,null,true);
    box(x+w*.25,f+h*.15,d-w*.51,w*.21,.27,.07,'warning',false);
    pipe(x,f+h*1.04,d,w*.24,h*.24,'copper');
  }
  function machine(x,d,f,w,l,h){
    box(x,f+h/2,d,w,h,l,'frame');
    box(x,f+h*.77,d,w+.18,h*.33,l+.15,'marine',false);
    for(const k of [-1,0,1])box(x+w*.1,f+h*.44,d+k*l*.29,w*.83,h*.48,l*.12,'plate',false);
    box(x-w*.32,f+h*.83,d-l*.508,w*.18,.3,.08,'warning',false,null,true);
    pipe(x+w*.25,f+h+.35,d,.7,l*.91,'copper',[Math.PI/2,0,0]);
  }
  function arrow(x,d,f){
    box(x-.54,f+.035,d,.29,.035,1.73,'amber',false,[0,-.61,0]);
    box(x+.54,f+.035,d,.29,.035,1.73,'amber',false,[0,.61,0]);
  }
  function bulkhead(s,neighbor,d,doorX,gate,first=false){
    const floor=first?s.base:s.top, head=first?s.ceiling:Math.max(s.ceiling,neighbor?.ceiling??0);
    const xl=Math.min(s.xMin,neighbor?.xMin??s.xMin)-.8,xr=Math.max(s.xMax,neighbor?.xMax??s.xMax)+.8;
    const w=18, h=14, low=Math.min(s.base,neighbor?.base??s.base)-2;
    if(first){box((xl+xr)/2,(head+low)/2,d,xr-xl,head-low,1.5,'wall');return;}
    for(const [a,b] of [[xl,doorX-w/2],[doorX+w/2,xr]])if(b>a)
      box((a+b)/2,(low+head)/2,d,b-a,head-low,1.6,'wall');
    box(doorX,(head+floor+h)/2,d,w,head-floor-h,1.6,'frame');
    if(gate)shutter(s,gate,doorX,d,floor,h,w);
    for(const side of [-1,1]){
      const x=doorX+side*(w/2+.58);
      box(x,floor+h/2,d,1.1,h,2.2,'dark');
      box(x,floor+h/2,d-1.15,.28,h-.5,.13,'cyan',false,null,true);
      for(let i=0;i<7;i++)box(x,floor+i*1.8+.6,d-1.16,.93,.35,.13,'amber',false);
    }
    box(doorX,floor+h+.5,d-1.05,w+3,.8,.7,'steel',false);
    sign(doorX,floor+h+3.0,d-.83,17,4,neighbor?.english??'EXTRACTION',gate?'SECURITY  /  '+gate:'TRANSFER  /  '+(neighbor?.id??'OUT'),'#303a3d');
  }
  // The main rooms have different silhouettes, machinery, overhead bridges and floor elevations.
  for(const s of STAGE){
    const {i,start,end,x,xMin,xMax,width,base,top,ceiling,step,rise}=s;
    region=i;const len=end-start,mid=(start+end)/2;
    if(rise){
      const thick=1.4;
      box(x,base-thick/2,(start+step)/2,width,thick,step-start,'floor');
      box(x,(base+top)/2-.7,(end+step)/2,width,rise+1.4,end-step,'floor');
      box(x,top-.27,step+.02,width,.49,.12,'amber',false);
      for(let k=0;k<width-3;k+=4.5)
        box(xMin+k+2,base+rise*.52,step-.08,.46,rise*.53,.1,'warning',false);
      sign(x,base+rise*.52,step-.15,12,3,'ASCEND','LIFT SHAFT   /   HOLD SPACE','#49483e');
    }else box(x,base-.7,mid,width,1.4,len,'floor');
    box(x,ceiling+.8,mid,width+2,1.6,len,'ceiling');
    for(const edge of [xMin-.5,xMax+.5]){
      const inside=edge<x?1:-1;
      box(edge,(base+ceiling)/2,mid,1,ceiling-base+1.6,len,'wall');
      box(edge+inside*.65,top+2.3,mid,.3,4.6,len,'lower',false);
      box(edge+inside*.68,top+4.85,mid,.4,.18,len,'amber',false);
      for(let d=start+10;d<end-4;d+=18){
        const f=floorAt(s,d),span=ceiling-f;
        box(edge+inside*.87,f+span/2,d,.85,span,1.3,'frame');
        box(edge+inside*1.2,ceiling-4.1,d,.8,1.2,4.1,'steel',false);
        box(edge+inside*1.64,ceiling-4.1,d,.1,.39,3.7,'cyan',false,null,true);
        box(edge+inside*.7,f+1.0,d,.54,.23,3.4,'amber',false);
        if(d+11<end){
          box(edge+inside*.64,f+9.6,d+8,.1,5.2,9.7,'lower',false);
          for(let k=-3;k<=3;k++)box(edge+inside*.76,f+9.6,d+8+k*1.2,.18,4.8,.28,'plate',false);
        }
      }
    }
    for(let d=start+8;d<end;d+=18){
      box(x,ceiling-.86,d,width,1.55,.74,'frame');
      box(x,ceiling-1.65,d,width,.16,1.3,'steel',false);
      box(x,ceiling-.73,d,width*.46,.13,3.3,'white',false,null,true);
      for(let k=0;k<3;k++){
        const px=xMin+2.6+k*1.1;
        pipe(px,ceiling-3.4,d,.74,Math.min(18,end-d)*1.01,'copper',[Math.PI/2,0,0]);
      }
    }
    for(let d=start+2;d<end;d+=8){
      const f=floorAt(s,d);
      box(x,f+.013,d,width-.3,.02,.067,'dark',false);
      if(Math.abs(d-step)>3||!rise){
        for(const side of [-1,1]){
          box(x+side*width*.365,f+.015,d,.14,.021,6.0,'amber',false);
          box(x+side*width*.35,f+.013,d,.13,.02,7.93,'dark',false);
        }
      }
    }
    for(let k=-2;k<=2;k++){
      const fx=x+k*width*.147;
      if(rise){
        box(fx,base+.012,(start+step)/2,.06,.015,step-start,'dark',false);
        box(fx,top+.012,(step+end)/2,.06,.015,end-step,'dark',false);
      }else box(fx,base+.012,mid,.06,.015,len,'dark',false);
    }
    // Ruptured high-pressure return with a sagging joint, exposed dark bores
    // and a torn wall access panel. The main wall remains structurally intact.
    if([0,3,6,8,11,14].includes(i)){
      const bx=xMin+3, bd=start+len*.36, by=top+15;
      pipe(bx,by,bd-5.5,1.4,8.5,'copper',[Math.PI/2,0,0]);
      pipe(bx,by,bd-1.3,1.61,.27,'steel',[Math.PI/2,0,0]);
      pipe(bx,by,bd-1.13,1.05,.04,'dark',[Math.PI/2,0,0]);
      pipe(bx,by-1.3,bd+4.7,1.4,7.0,'copper',[Math.PI/2+.22,0,0]);
      box(xMin+.68,by-.9,bd,.18,5.4,10,'dark',false);
      for(let k=0;k<5;k++)box(xMin+.82,by-1.2,bd-3.5+k*1.45,.16,4.15,.29,'copper',false,[(k-2)*.07,0,0]);
      box(xMin+.92,by-2.7,bd+.9,.16,1.1,6.3,'plate',false,[-.13,0,0]);
    }
    if(i===0){
      bulkhead(s,null,start,0,null,true);
      // A blast screen creates a physically protected launch lane.
      machine(-2,52,0,38,5.6,7.4);
      sign(-2,4.5,49.12,22,4.5,'DOCK  01','A K 2     /     RECEIVING   FACILITY','#354346');
      for(const side of [-1,1]){
        for(let k=0;k<3;k++)crate(side*32+(k%2)*2,16+19*k,0,8,5+k,10,side<0?'copper':'crate');
        box(side*14,.026,17,.29,.022,37,'amber',false);
      }
      for(const d of [6,17,28])arrow(0,d,0);
      arrow(26,55,0);
    }else if(s.branch){
      // Continuous machinery core forces a 36–63 m split. Both corridors rejoin.
      const bx=x+width*(width<90?.23:.28), coreWidth=width*.2, a=start+len*.25,b=start+len*.70;
      const high=ceiling-base;
      box(bx,base+high/2,(a+b)/2,coreWidth,high,b-a,'lower');
      sign(bx,base+8,a-.05,Math.min(coreWidth-2,24),5,s.english,s.id+' / INDUSTRIAL BLOCK','#3b4849');
      for(let d=a+3;d<b-1;d+=8){
        const f=floorAt(s,d);
        for(const side of [-1,1]){
          box(bx+side*(coreWidth/2+.15),f+4,d,.45,7,1.0,'frame');
          box(bx+side*(coreWidth/2+.42),f+7.3,d,.13,.3,2.1,'white',false,null,true);
        }
      }
      for(let k=0;k<3;k++){
        const d=a-3+k*(b-a)/2, px=xMax-3.5;
        crate(px,d,floorAt(s,d),5.5,3.4+(k%2)*1.4,6.5);
      }
      if(s.design==='power'||s.design==='chillers')
        for(let k=0;k<3;k++)tank(xMin+3.4,start+26+k*25,base,5.1,8.6);
      else for(let k=0;k<2;k++)crate(xMin+6,start+27+k*29,base,8,4.5,9,'copper');
    }else if(s.design==='shaft'||s.design==='bridge'){
      for(const side of [-1,1]){
        const px=x+side*(width*.5-3.1);
        for(let k=0;k<3;k++)
          pipe(px+(k-1)*1.3,base+(ceiling-base)/2,step-2,1.05,ceiling-base,'copper');
        box(px,top+2.8,step+10,4.5,5.6,9,'frame');
      }
      // Side mezzanine leaves floor and space underneath traversable.
      box(xMin+5.4,top+5.6,step+19,10.8,.9,24,'plate');
      for(const d of [step+8,step+30])box(xMin+9,top+2.8,d,1.4,5.6,1.4,'frame');
    }else if(s.design==='pipes'){
      for(let k=0;k<5;k++){
        const d=start+11+k*16, side=k%2?1:-1;
        tank(x+side*(width/2-5),d,floorAt(s,d),6.8,5.7);
        pipe(x+side*(width/2-2.5),top+9,d,1.05,16,'copper',[Math.PI/2,0,0]);
      }
    }else if(s.design==='mill'||s.design==='line'){
      for(const side of [-1,1])for(let k=0;k<3;k++){
        const d=start+18+k*39, f=floorAt(s,d);
        machine(x+side*(width*.37),d,f,12,14,4.6+k*.7);
      }
      box(x,ceiling-8,mid,width-5,1.35,3.7,'amber');
      box(x+8,ceiling-9.7,mid,7,2.0,4.1,'dark');
      for(const offset of [-1,1])pipe(x+8+offset*1.1,ceiling-13.3,mid,.16,5.2,'steel');
      box(x+8,ceiling-15.9,mid,3.5,1.05,1.5,'steel');
    }else if(s.design==='lab'){
      for(let k=0;k<3;k++)for(const side of [-1,1]){
        const d=start+17+k*28;
        machine(x+side*(width*.33),d,base,7.5,12,4.1);
      }
    }else if(s.design==='exit'){
      for(let k=0;k<4;k++)for(const side of [-1,1]){
        const d=start+14+k*21;
        box(x+side*19,base+7,d,3,14,3.2,'frame');
        box(x+side*19,base+7,d-1.65,.43,9,.07,'cyan',false,null,true);
      }
    }
    const coming=STAGE[i+1];
    if(coming)bulkhead(s,coming,end,s.doorX,s.control?'B-'+s.id:null);
    else{
      bulkhead(s,null,end-13,s.doorX,'FINAL');
      bulkhead(s,null,end,s.doorX,null,true);
      box(s.doorX,top+.03,end-7,17,.04,10,'marine',false);
      for(const px of [-8,8])box(s.doorX+px,top+.06,end-7,.18,.04,10,'cyan',false,null,true);
    }
    for(const a of [end-19,end-10,end-4])arrow(s.doorX,a,top);
    // Unique asymmetric positions. Guards spawn on level floors clear of equipment;
    // the obstacle query below resolves the small number of authoring overlaps.
    const insert=(kind,k,offset,d)=>{
      let px=x+offset;
      const radius=kind==='guard'?1.48:1.95, footOffset=kind==='guard'?2.1:2.0;
      const floor=floorFor(s,d), y=floor+footOffset;
      function free(cx,cd){
        if(cx<=xMin+3||cx>=xMax-3||cd<=start+4||cd>=end-4||Math.abs(floorAt(s,cd)-floor)>.1)return false;
        let clear=true;
        grid.query(cx-radius,cx+radius,-cd-radius,-cd+radius,b=>{
          if(cx+radius>b.min[0]&&cx-radius<b.max[0]&&-cd+radius>b.min[2]&&-cd-radius<b.max[2]&&floor+.2<b.max[1]&&y+radius>b.min[1])clear=false;
        });
        return clear&&enemies.every(e=>e.pos.distanceToSquared(new V(cx,y,-cd))>30);
      }
      const bx=px,bd=d;
      if(!free(px,d))outer:for(let r=2;r<width;r+=2)for(let j=0;j<24;j++){
        const angle=j*Math.PI/12;
        const nx=bx+Math.cos(angle)*r,nd=bd+Math.sin(angle)*r;
        if(free(nx,nd)){px=nx;d=nd;break outer;}
      }
      const isGateControl=kind==='turret'&&s.control;
      const id=(kind==='guard'?'GR-':'TR-')+s.id.slice(1)+'-'+(k+1);
      enemies.push({id,kind,isGateControl,barrierId:isGateControl?'B-'+s.id:null,sectorId:s.id,pos:new V(px,y,-d),
        vel:new V(),radius,footOffset,hp:kind==='guard'?120:240,alive:true,alert:false,hasLineOfSight:false,shotsFired:0,lastShotAtSeconds:null});
    };
    for(let k=0;k<s.guards;k++){
      const offsets=s.branch?[-.33,-.09,.32]:[-.22,.21,-.06];
      const location=s.i===0?start+94:start+len*((s.branch?[.37,.70,.80]:[.30,.68,.44])[k]);
      insert('guard',k,width*offsets[k],location);
    }
    if(s.turrets)insert('turret',0,(s.branch?-.22:.13)*width,start+len*(s.i===15?.73:.82));
  }
  if(scene){
    for(const b of batches.values()){
      const mesh=new THREE.InstancedMesh(b.geo,b.mat,b.entries.length);
      b.entries.forEach(([matrix,color],i)=>{mesh.setMatrixAt(i,matrix);mesh.setColorAt(i,new THREE.Color(color));});
      mesh.computeBoundingSphere();root.add(mesh);
    }
    const sky=new THREE.HemisphereLight(0xd6ecff,0xa69c8a,1.75);
    const sun=new THREE.DirectionalLight(0xffedcf,2.3);sun.position.set(-47,70,35);
    const rim=new THREE.DirectionalLight(0x93c3db,.82);rim.position.set(35,28,-43);
    root.add(sky,sun,rim);
  }
  function hit(a,b,pad=0){
    const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z;let first=Infinity;
    grid.query(Math.min(a.x,b.x)-pad,Math.max(a.x,b.x)+pad,Math.min(a.z,b.z)-pad,Math.max(a.z,b.z)+pad,box=>{
      const t=intersect(a,dx,dy,dz,box,pad);if(t<first)first=t;
    });return first;
  }
  function move(p,d,v,r=1.2,h=4){
    if(!Number.isFinite(r))r=1.2;
    let grounded=false;
    const boxes=[];
    grid.query(Math.min(p.x,p.x+d.x)-r-1,Math.max(p.x,p.x+d.x)+r+1,Math.min(p.z,p.z+d.z)-r-1,Math.max(p.z,p.z+d.z)+r+1,b=>boxes.push(b));
    for(const axis of [0,2,1]){
      const key=['x','y','z'][axis];
      const wanted=d[key];let amt=wanted;
      const min=[p.x-r,p.y,p.z-r],max=[p.x+r,p.y+h,p.z+r];
      for(const b of boxes){
        const otherA=(axis+1)%3,otherB=(axis+2)%3;
        if(min[otherA]>=b.max[otherA]-EPS||max[otherA]<=b.min[otherA]+EPS||
          min[otherB]>=b.max[otherB]-EPS||max[otherB]<=b.min[otherB]+EPS)continue;
        if(wanted>0&&max[axis]<=b.min[axis]+EPS)amt=Math.min(amt,Math.max(0,b.min[axis]-max[axis]));
        if(wanted<0&&min[axis]>=b.max[axis]-EPS)amt=Math.max(amt,Math.min(0,b.max[axis]-min[axis]));
      }
      p[key]+=amt;if(Math.abs(amt-wanted)>1e-10)v[key]=0;
    }
    if(v.y<=EPS)for(const b of boxes){
      if(Math.abs(p.y-b.max[1])<1e-5&&p.x-r<b.max[0]-EPS&&p.x+r>b.min[0]+EPS&&p.z-r<b.max[2]-EPS&&p.z+r>b.min[2]+EPS){grounded=true;v.y=0;break;}
    }
    return grounded;
  }
  function update(){
    let n=0;
    for(const e of enemies)if(e.isGateControl&&!e.alive){
      n++; const g=gatesById.get(e.barrierId);
      if(g.box.enabled){g.box.enabled=false;g.mesh.visible=false;objective.openBarrierIds.push(g.id);}
    }
    objective.controlsDestroyed=n;objective.gateOpen=n===controls.length;
    if(objective.gateOpen){const gate=gatesById.get('FINAL');gate.box.enabled=false;gate.mesh.visible=false;}
  }
  function escaped(p){
    const s=STAGE.at(-1);return objective.gateOpen&&-p.z>s.end-11&&-p.z<s.end&&p.y>=s.top-.001&&p.y<s.ceiling&&Math.abs(p.x-s.doorX)<9;
  }
  function nextTarget(p){
    const e=enemies.find(e=>e.isGateControl&&e.alive), s=p&&sectorAt(p);
    if(s&&e?.sectorId!==s.id){
      if(s.rise&&-p.z<s.step-1)return new V(s.doorX,s.top+3,-s.step-4);
      return new V(s.doorX,s.top+2,-s.end+(s.i===15?7:0));
    }
    return e?e.pos.clone():new V(STAGE.at(-1).doorX,STAGE.at(-1).top+2,-STAGE.at(-1).end+7);
  }
  function dispose(){
    if(scene)scene.remove(root);
    const geos=new Set([cube,tube,round]),materials=new Set(Object.values(mats));
    root.traverse(obj=>{if(obj.geometry)geos.add(obj.geometry);if(obj.material)materials.add(obj.material);if(obj.isInstancedMesh)obj.dispose();});
    for(const material of materials){if(material.map)material.map.dispose();material.dispose();}
    for(const geom of geos)geom.dispose();
    root.clear();
  }
  return {root,spawn,enemies,sectors:STAGE,objective,barriers,hit,move,update,escaped,nextTarget,dispose,
    sector:p=>sectorAt(p)?.id??null,walkPath:(a,b,budget=130)=>findWalkPath(a,b,budget,hit)};
}

// Bounded A* for guards at their current floor level. Inflated solids prevent
// clipping corners, including when the cheapest connection is diagonal.
function findWalkPath(from,to,budget,hit){
  if(from.distanceTo(to)>budget+.01)return [];
  const gap=1.05,spacing=3.5,start=from.clone(),goal=new V(to.x,from.y,to.z);
  const clear=(a,b)=>hit(a,b,gap)===Infinity;
  if(clear(start,goal))return [goal];
  const heap=[],records=new Map(),key=(x,z)=>x+','+z;
  const h=(p)=>Math.hypot(p.x-goal.x,p.z-goal.z);
  function push(n){
    heap.push(n);let i=heap.length-1;
    while(i){const j=(i-1)>>1;if(heap[j].f<=n.f)break;heap[i]=heap[j];i=j;}heap[i]=n;
  }
  function pop(){
    const n=heap[0],last=heap.pop();
    if(heap.length){let i=0;while(i*2+1<heap.length){
      let j=i*2+1;if(j+1<heap.length&&heap[j+1].f<heap[j].f)j++;
      if(last.f<=heap[j].f)break;heap[i]=heap[j];i=j;
    }heap[i]=last;}return n;
  }
  const first={x:0,z:0,p:start,g:0,f:h(start),parent:null};push(first);records.set(key(0,0),first);
  for(let visits=0;heap.length&&visits<2100;visits++){
    const node=pop();if(node.done)continue;node.done=true;
    if(node.g+h(node.p)>budget)continue;
    if(node!==first&&clear(node.p,goal)){
      const chain=[goal];let n=node;while(n.parent){chain.push(n.p);n=n.parent;}
      return chain.reverse();
    }
    for(const [dx,dz] of [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]]){
      const x=node.x+dx,z=node.z+dz,k=key(x,z),old=records.get(k);
      const g=node.g+spacing*Math.hypot(dx,dz);
      if(old&&old.g<=g)continue;
      const p=new V(start.x+x*spacing,start.y,start.z+z*spacing),f=g+h(p);
      if(f>budget||!clear(node.p,p))continue;
      if(old)old.done=true;
      const n={x,z,p,g,f,parent:node};records.set(k,n);push(n);
    }
  }
  return [];
}
