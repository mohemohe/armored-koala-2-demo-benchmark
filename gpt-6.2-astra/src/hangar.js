import * as T from 'three';

const TAU = Math.PI * 2;
function seededRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function canvasTexture(width, height, draw) {
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  draw(el.getContext('2d'), width, height);
  const tex = new T.CanvasTexture(el);
  tex.colorSpace = T.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
function steelPaint() {
  return canvasTexture(512, 512, (ctx,w,h) => {
    const rand = seededRandom(18031);
    ctx.fillStyle = '#bec1bb';
    ctx.fillRect(0,0,w,h);
    for (let i=0;i<15000;i++) {
      const a = rand() * 0.10;
      ctx.fillStyle = i%3 ? 'rgba(28,24,21,'+a+')' : 'rgba(254,245,218,'+a+')';
      ctx.fillRect(rand()*w,rand()*h,1+rand()*2,1+rand()*3);
    }
    for (let i=0;i<95;i++) {
      let x=rand()*w,y=rand()*h;
      ctx.strokeStyle = i%3 ? '#827f742c' : '#e8e3d26b';
      ctx.lineWidth=0.4+rand();
      ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+rand()*29-12,y+rand()*7);ctx.stroke();
    }
  });
}

// All repeated fittings share geometry and draw calls. The ring and markings
// are genuine floor surfaces, so the camera can orbit the assembled chassis.
export function createHangar(scene) {
  const group = new T.Group();
  group.name = 'Maintenance bay 07';
  scene.add(group);
  scene.background = new T.Color(0x202425);
  scene.fog = new T.FogExp2(0x25292a,0.032);
  const paint = steelPaint(), mats = new Map(), batches = new Map();
  const cube = new T.BoxGeometry(), pipe = new T.CylinderGeometry(1,1,1,20);
  const dummy = new T.Object3D(), axis = new T.Vector3(0,1,0), delta = new T.Vector3();
  const quat = new T.Quaternion();
  const materials = {
    floor:0x495050, panel:0x3c4141, edge:0x606868, lightmetal:0x7b8382,
    iron:0x252d2f, abyss:0x151c1f, trim:0x96998d, rust:0x796448,
    yellow:0xc3914f, ink:0x282c2a, marked:0xaeaa91
  };
  function material(color,lit=false) {
    const key=color+'|'+lit;
    if (!mats.has(key)) mats.set(key, lit ? new T.MeshBasicMaterial({color})
      : new T.MeshStandardMaterial({color,metalness:0.36,roughness:0.78,map:paint}));
    return mats.get(key);
  }
  function instance(geom, mat, x,y,z, w,h,d, rotation) {
    if (!batches.has(geom)) batches.set(geom,new Map());
    const byMaterial=batches.get(geom);
    if (!byMaterial.has(mat)) byMaterial.set(mat,[]);
    dummy.position.set(x,y,z);
    dummy.scale.set(w,h,d);
    if (rotation?.isQuaternion) dummy.quaternion.copy(rotation);
    else dummy.rotation.set(...(rotation || [0,0,0]));
    dummy.updateMatrix();
    byMaterial.get(mat).push(dummy.matrix.clone());
  }
  function box(x,y,z,w,h,d,color,rot,lit=false) {
    instance(cube,material(color,lit),x,y,z,w,h,d,rot);
  }
  function cyl(x,y,z,r,h,color,rot,lit=false){
    instance(pipe,material(color,lit),x,y,z,r,h,r,rot);
  }
  function bar(a,b,r,color) {
    delta.set(b[0]-a[0],b[1]-a[1],b[2]-a[2]);
    const length = delta.length();
    quat.setFromUnitVectors(axis,delta.normalize());
    cyl((a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2,r,length,color,quat);
  }
  function structural(a,b,width,depth,color) {
    delta.set(b[0]-a[0],b[1]-a[1],b[2]-a[2]);
    const length=delta.length();
    quat.setFromUnitVectors(axis,delta.normalize());
    box((a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2,width,length,depth,color,quat);
  }
  function surface(geometry, mat,x,y,z,rx=0) {
    const mesh=new T.Mesh(geometry,mat);
    mesh.position.set(x,y,z);mesh.rotation.x=rx;
    mesh.receiveShadow=true;
    group.add(mesh);
    return mesh;
  }
  function placard(x,y,z,w,h,draw) {
    const tex=canvasTexture(1024,512,draw);
    const mat=new T.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false});
    return surface(new T.PlaneGeometry(w,h),mat,x,y,z);
  }
  const M=materials;
  // Recessed drive drum, deck plates, expansion gaps, and removable floor tiles.
  box(0,-.49,0,26,.25,26,M.abyss);
  for(let ix=-4;ix<=4;ix++) for(let iz=-4;iz<=4;iz++){
    const x=ix*2.5,z=iz*2.5;
    if (Math.hypot(x,z)<2.45) continue;
    box(x,-.357,z,2.483,.05,2.483,(ix+iz)%4?M.floor:0x515756);
    if ((ix+iz)%3===0) {
      for(const dx of [-1.05,1.05])for(const dz of [-1.05,1.05])cyl(x+dx,-.328,z+dz,.033,.012,M.iron);
    }
  }
  for (const side of [-1,1]) {
    const x=side*4.36;
    box(x,-.310,0,.74,.07,20,M.abyss);
    for (let i=-50;i<50;i++) box(x,-.26,i*.20,.71,.07,.047,M.edge);
    box(x-side*.50,-.315,0,.055,.05,20,M.yellow);
    for(let i=-9;i<=9;i++)box(x+side*.54,-.312,i,.17,.05,.47,M.yellow,[0,-side*.5,0]);
  }
  const deck=new T.CylinderGeometry(1,1,1,112);
  function drum(r,y,h,color){instance(deck,material(color),0,y,0,r,h,r);}
  function ring(inner,outer,y,color,start=0,span=TAU,lit=false){
    return surface(new T.RingGeometry(inner,outer,100,1,start,span),material(color,lit),0,y,0,-Math.PI/2);
  }
  drum(3.46,-.25,.28,M.iron);
  drum(3.37,-.11,.13,M.edge);
  drum(3.30,-.058,.086,M.abyss);
  drum(3.24,-.045,.08,M.floor);
  ring(3.18,3.225,-.002,M.trim);
  ring(2.53,2.548,-.002,M.abyss);
  ring(1.98,1.993,-.002,M.edge);
  ring(2.90,2.926,-.002,M.abyss);
  const deckMat=canvasTexture(1024,1024,(ctx,w,h)=>{
    const r=w/2, rand=seededRandom(7011);
    ctx.clearRect(0,0,w,h);
    ctx.translate(r,r);
    for(let i=0;i<12;i++) {
      ctx.save();ctx.rotate(i*TAU/12);
      ctx.strokeStyle='#131b1d';ctx.lineWidth=2.0;
      ctx.beginPath();ctx.moveTo(0,0.615*r);ctx.lineTo(0,.735*r);ctx.lineTo(0.044*r,.78*r);ctx.lineTo(.044*r,r);ctx.stroke();
      ctx.lineWidth=1;ctx.translate(2,0);ctx.strokeStyle='#a7b2a03a';ctx.stroke();
      ctx.restore();
    }
    for(let i=0;i<720;i++) {
      const th=rand()*TAU,rr=Math.sqrt(rand())*.98*r;
      ctx.strokeStyle= i%2 ? '#0d121859' : '#f4ebca39'; ctx.lineWidth=.5+rand();
      ctx.beginPath();ctx.moveTo(Math.cos(th)*rr,Math.sin(th)*rr);ctx.lineTo(Math.cos(th)*rr+rand()*22-11,Math.sin(th)*rr+rand()*19-9);ctx.stroke();
    }
    // Outer ring carries alternating painted chevrons in four small groups.
    for(let k=0;k<4;k++) {
      ctx.save();
      ctx.rotate(k*Math.PI/2 + .23);
      for(let j=0;j<7;j++) {
        ctx.rotate(.046);ctx.fillStyle='#c49c5b';ctx.beginPath();
        ctx.moveTo(0,.917*r);ctx.lineTo(8,.917*r);ctx.lineTo(15,.97*r);ctx.lineTo(7,.97*r);ctx.closePath();ctx.fill();
      }
      ctx.restore();
    }
    ctx.fillStyle='#cbcaba';ctx.globalAlpha=.80;
    ctx.textAlign='center';ctx.font='bold 22px monospace';
    ctx.fillText('AK2  /  SERVICE',0,.86*r);
    ctx.font='bold 9px monospace';ctx.fillText('LOAD LIMIT   12.8 T',0,.886*r);
  });
  surface(new T.CircleGeometry(3.22,96),new T.MeshBasicMaterial({
    transparent:true,map:deckMat,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1
  }),0,.001,0,-Math.PI/2);
  for(let i=0;i<36;i++){
    const a=i*TAU/36;
    const x=Math.sin(a)*3.07,z=Math.cos(a)*3.07;
    cyl(x,.004,z,.049,.017,M.abyss);cyl(x,.014,z,.029,.012,M.lightmetal);
    if(i%3===0) {
      const dir=[0,a,0],rx=Math.sin(a)*3.418,rz=Math.cos(a)*3.418;
      box(rx,-.179,rz,.40,.13,.095,M.abyss,dir);
      box(rx,-.17,rz,.26,.025,.11,0xecad65,dir,true);
    }
  }
  // Local ambient occlusion stays under the feet even when real-time shadows are off.
  const occlusion=canvasTexture(128,128,(ctx,w,h)=>{
    const grad=ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,w*.5);
    grad.addColorStop(0,'rgba(4,8,10,.61)');grad.addColorStop(.38,'rgba(5,8,10,.48)');
    grad.addColorStop(.75,'rgba(5,8,10,.20)');grad.addColorStop(1,'rgba(5,8,10,0)');
    ctx.fillStyle=grad;ctx.fillRect(0,0,w,h);
  });
  surface(new T.PlaneGeometry(3.5,2.4),new T.MeshBasicMaterial({map:occlusion,transparent:true,depthWrite:false}),0,.009,0,-Math.PI/2);
  // Rear maintenance bulkhead. Recessed metal panels are framed by heavy girts.
  box(0,4.15,-6.8,24,9.0,.7,M.abyss);
  for(let i=-3;i<=3;i++) {
    const x=i*3.14;
    box(x,3.86,-6.28,3.09,7.8,.32,(i%2?0x4b5150:0x535653));
    box(x,1.20,-6.00,2.93,2.2,.28,M.panel);
    box(x,.81,-5.80,2.45,.86,.1,M.iron);
    for(let j=0;j<9;j++) box(x-1.02+j*.25,.82,-5.727,.074,.62,.047,M.edge,[0,0,-.24]);
    box(x,2.33,-5.99,3.15,.18,.28,M.iron);
    box(x+1.5,3.80,-5.99,.15,8.2,.44,M.iron);
    box(x+1.50,3.80,-5.70,.27,8.2,.09,M.edge);
    if(i%2===0) {
      for(const dy of [2.58,4.68]) for(const dx of [-1.30,1.30])
        cyl(x+dx,dy,-6.03,.033,.12,M.lightmetal,[Math.PI/2,0,0]);
    }
  }
  // Exposed utility returns and electrical cabinets under the upper deck.
  for(const [y,r,col] of [[.32,.099,M.rust],[.58,.082,M.edge]]) {
    bar([-10,y,-5.60],[.11,y,-5.60],r,col);
    for(let i=-4;i<=0;i++)cyl(i*2.26,y,-5.60,r*1.37,.086,M.iron,[0,0,Math.PI/2]);
  }
  for (let i=0;i<3;i++) {
    const x=-4.76+i*.19;
    bar([x,3.25,-5.68],[x,1.90+i*.07,-5.68],.042,M.edge);
    bar([x,1.90+i*.07,-5.68],[x-.26,1.63+i*.07,-5.68],.042,M.edge);
    bar([x-.26,1.63+i*.07,-5.68],[x-.26,.60,-5.68],.042,M.edge);
  }
  box(-2.62,.91,-5.43,1.26,1.78,.59,M.iron);
  box(-2.62,1.02,-5.098,1.10,1.43,.10,M.panel);
  box(-2.62,1.48,-5.033,.79,.25,.05,M.abyss);
  for(let i=0;i<3;i++)box(-2.87+i*.22,1.49,-5.00,.116,.031,.022,i===0?0xdb985e:M.edge,undefined,i===0);
  for(let i=0;i<5;i++)box(-2.64,.70+i*.075,-5.035,.54,.026,.047,M.iron);
  // A shutter with a vertical amber travel strip, and a caged service ladder.
  box(1.72,2.18,-5.75,3.03,4.62,.38,M.abyss);
  for(let i=0;i<27;i++)box(1.72,.01+.161*i,-5.50,2.65,.144,.08,i%3?M.panel:M.edge);
  for(const x of [.24,3.20])box(x,2.14,-5.48,.18,4.77,.36,M.iron);
  box(.27,2.20,-5.267,.044,4.37,.020,0xffbc79,undefined,true);
  for(let i=0;i<4;i++) {
    box(-6.45+i*.165,4.41,-5.74,.106,.063,.11,M.yellow,[0,0,.43]);
  }
  box(-1.02,1.93,-5.76,1.87,1.12,.12,M.panel);
  box(-1.02,2.52,-5.75,2.0,.13,.16,M.iron);
  placard(-.98,1.93,-5.693,1.86,1.10,(ctx,w,h)=>{
    ctx.fillStyle='#b6b6a6';ctx.fillRect(74,64,12,348);
    ctx.fillStyle='#cfa878';ctx.font='bold 339px sans-serif';
    ctx.textAlign='left';ctx.fillText('07',106,402,805);
    ctx.fillStyle='#bbc0b4';ctx.font='bold 38px monospace';ctx.fillText('SERVICE BAY',111,469);
    // Cutouts through paint create the number's sprayed stencil.
    ctx.clearRect(253,90,15,330);ctx.clearRect(517,90,15,330);
    const r=seededRandom(721);
    for(let i=0;i<1900;i++)ctx.clearRect(r()*w,r()*h,r()*4,1+r()*3);
  });
  for(const x of [4.4,5.04])bar([x,0,-5.29],[x,6.45,-5.29],.048,M.rust);
  for(let i=0;i<18;i++)bar([4.4,.14+.34*i,-5.29],[5.04,.14+.34*i,-5.29],.026,M.lightmetal);
  // Pipe headers with flanged unions and suspension straps.
  for(let i=0;i<3;i++) {
    const y=5.00+i*.34,z=-5.62+i*.03,r=.088+i*.028;
    bar([-11,y,z],[11,y,z],r,i===1?M.rust:M.edge);
    for(let k=-4;k<=4;k++)cyl(k*2.3,y,z,r*1.39,.093,M.iron,[0,0,Math.PI/2]);
  }
  for (const side of [-1,1]) {
    box(side*8.92,4.1,.9,.45,8.8,17.3,M.panel);
    for(let i=-1;i<=3;i++) {
      const z=i*3.35-2.16,x=side*8.37;
      box(x,3.96,z,.60,8.56,.34,M.iron);
      box(x-side*.34,3.96,z,.12,8.56,.63,M.edge);
      structural([x,4.36,z],[x-side*2.54,6.78,z],.23,.28,M.edge);
      for(let k=0;k<2;k++) box(x-side*.17,1.60,z+.44+k*.20,.14,3.75,.12,M.rust);
    }
    for(let i=0;i<3;i++) {
      const x=side*(8.0-i*.26), y=4.23+i*.32;
      bar([x,y,-6.27],[x,y,9.14],.10+i*.04,i%2?M.rust:M.edge);
    }
  }
  // A narrow inspection catwalk behind the model, with railings, toe board and grating.
  box(-4.97,1.44,-4.67,4.0,.22,1.04,M.iron);
  box(-4.97,1.55,-4.14,4.0,.09,.06,M.rust);
  for(let i=0;i<18;i++)box(-6.90+i*.226,1.574,-4.66,.038,.034,.96,M.edge);
  for(let i=0;i<4;i++)bar([-6.85+i*1.22,1.50,-4.18],[-6.85+i*1.22,2.34,-4.18],.031,M.rust);
  for(let i=0;i<2;i++)bar([-6.92,1.99+i*.35,-4.18],[-3.19,1.99+i*.35,-4.18],.032,M.rust);
  for (const x of [-6.66,-3.48]) structural([x-.39,.12,-5.6],[x,1.40,-4.35],.18,.21,M.edge);
  // Low practicals illuminate the walkway and the painted perimeter.
  function lamp(x,y,z,w,h) {
    box(x,y,z,w+.18,h+.14,.24,M.iron);
    box(x,y,z+.136,w,h,.055,0xffcf95,undefined,true);
    for(const s of [-1,1])box(x+s*w*.32,y,z+.184,.025,h+.035,.03,M.iron);
  }
  lamp(-5.65,1.98,-5.63,.13,1.45);
  lamp(3.64,3.54,-5.75,.13,1.36);
  for(const z of [-4.7,-.5,3.7]) {
    box(0,6.78,z,17.4,.29,.40,M.iron);
    box(0,7.41,z,17.4,.18,.33,M.edge);
    for(let i=-5;i<5;i++){
      const x=i*1.64;
      structural([x,6.91,z],[x+.82,7.36,z],.105,.19,M.edge);
      structural([x+.82,7.36,z],[x+1.64,6.91,z],.105,.19,M.edge);
    }
    for(const x of [-3.6,3.6]) {
      box(x,6.54,z,2.6,.23,.55,M.panel);
      box(x,6.39,z,2.36,.04,.33,0xffdeb1,undefined,true);
    }
  }
  // Stack of locked service cases and a freestanding electrical cabinet.
  for(const [x,z,w,h] of [[4.22,-3.58,1.53,.64],[4.24,-3.58,1.38,.57],[5.61,-3.05,1.12,.76],[-5.46,-1.86,1.18,.76]]) {
    const y=(w===1.38?.34:-.315)+h/2;
    box(x,y,z,w,h,.89,M.iron);box(x,y+h*.48,z,w+.05,.07,.94,M.edge);
    for(const sign of [-1,1]) {
      box(x+sign*w*.33,y,z+.459,.073,h,.035,M.lightmetal);
      box(x+sign*w*.33,y,z-.458,.073,h,.035,M.edge);
    }
    box(x,y,z+.462,.30,.105,.038,M.rust);
  }
  box(-6.8,.94,-3.04,1.37,2.50,.94,M.edge);
  box(-6.80,1.13,-2.53,1.15,1.91,.085,M.panel);
  box(-6.41,1.23,-2.46,.075,.35,.085,M.abyss);
  for(let i=0;i<5;i++)box(-6.86,1.79+i*.064,-2.47,.75,.027,.06,M.iron);
  for (const [geom,byMaterial] of batches) for(const [mat,matrices] of byMaterial) {
    const batch=new T.InstancedMesh(geom,mat,matrices.length);
    matrices.forEach((matrix,i)=>batch.setMatrixAt(i,matrix));
    batch.receiveShadow=true;
    batch.computeBoundingSphere();
    group.add(batch);
  }
  // Broad lights define the armor's planes; a warm rim separates the ears and the backpack.
  const hemisphere=new T.HemisphereLight(0xe5ebe6,0x787467,1.24);
  group.add(hemisphere);
  function sun(hex,intensity,x,y,z) {
    const light=new T.DirectionalLight(hex,intensity);
    light.position.set(x,y,z);group.add(light);
    const focus=new T.Object3D();focus.position.set(0,1,0);group.add(focus);
    light.target=focus;
    return light;
  }
  const key=sun(0xffe8c8,3.36,-3.8,7.5,5.9);
  key.castShadow=true;key.shadow.mapSize.set(1024,1024);
  Object.assign(key.shadow.camera,{left:-5,right:5,top:6,bottom:-4,near:.2,far:22});
  key.shadow.bias=-.0006;key.shadow.normalBias=.018;
  sun(0xc6dce5,1.34,5.4,3.7,3.2);
  sun(0xffb264,2.65,-3.3,4.8,-5.4);
  const bounce=new T.PointLight(0xe49d52,26,11,2);
  bounce.position.set(-4.9,2.6,-5.2);group.add(bounce);
  return group;
}
