/** The facility is expressed in metres. +Z is the direction of escape. */
export const SECTOR_NAMES = [
  '搬入口', '資材ヤード', '圧延棟', '搬送縦坑', '組立ライン', '検査棟',
  '保守配管区画', '動力棟', '冷却設備', '排気縦坑', '地下搬送区画',
  '主製造ホール', '出荷倉庫', '外周搬送路', '積載場', '搬出ゲート'
];

export function createStage(THREE, scene) {
  const group = new THREE.Group();
  scene.add(group);
  const colliders = [], barriers = [], sectors = [], enemies = [];
  const floors = [0, 0, 8, 8, 16, 16, 24, 24, 32, 32, 40, 40, 48, 48, 48, 48];
  const colors = [0x536468, 0x49565b, 0x625e50, 0x465b5d, 0x575d59, 0x4d555c, 0x4e5c54, 0x5b5550, 0x455d60, 0x4d545a, 0x514f48, 0x5e5b51, 0x5c574e, 0x4d5955, 0x5c5a50, 0x4f5e5d];
  const material = (color, extra = {}) => new THREE.MeshStandardMaterial({color, roughness: .85, metalness: .22, ...extra});
  const steel = material(0x3d4b50), dark = material(0x252f34), roof = material(0x303b3e);
  const machinery = material(0x69716a), yellow = material(0xe6ad45), red = material(0xd14e35, {emissive: 0x641906});
  const stripe = material(0xa8b7a8, {emissive: 0x263631});
  const cube = new THREE.BoxGeometry(1, 1, 1);
  function box(id, x, y, z, sx, sy, sz, mat, type = 'solid', solid = true) {
    const mesh = new THREE.Mesh(cube, mat);
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
    mesh.castShadow = false; mesh.receiveShadow = true;
    group.add(mesh);
    if (solid) {
      const c = {id, type, mesh, min: new THREE.Vector3(x-sx/2,y-sy/2,z-sz/2), max: new THREE.Vector3(x+sx/2,y+sy/2,z+sz/2)};
      colliders.push(c); return c;
    }
    return mesh;
  }
  // A solid floor and roof, plus an exterior shell, prevent bypassing the partitions.
  for (let i = 0; i < 16; i++) {
    const z0 = i * 110, z1 = z0 + 110, f = floors[i], mid = z0 + 55;
    const id = `S${String(i+1).padStart(2,'0')}`;
    sectors.push({id, name: SECTOR_NAMES[i], minZ:z0, maxZ:z1, floorY:f, minX:-40, maxX:40});
    box(`${id}-floor`,0,(f-12)/2,mid,80,f+12,110,material(colors[i]),'floor');
    box(`${id}-roof`,0,f+29,mid,80,2,110,roof,'ceiling');
    box(`${id}-wall-l`,-41,(f+29-12)/2,mid,2,f+41,110,steel,'wall');
    box(`${id}-wall-r`,41,(f+29-12)/2,mid,2,f+41,110,steel,'wall');
    // Fixed framing and surface detail; each collider corresponds to a visible object.
    for (const zz of [z0+20,z0+55,z0+90]) {
      box(`${id}-beam-l`,-38,f+13,zz,3,26,2,dark,'structure');
      box(`${id}-beam-r`,38,f+13,zz,3,26,2,dark,'structure');
      box(`${id}-ceiling-beam`,0,f+27.5,zz,78,1,1.2,steel,'decoration',false);
      box(`${id}-lamp`,0,f+27,zz,8,.15,.35,stripe,'decoration',false);
    }
    // Different sizes and placements of equipment produce alternate routes and cover.
    const variant = i % 6;
    if (variant === 0) {
      for (const [x,z] of [[-22,z0+42],[22,z0+69]]) box(`${id}-crate-${x}`,x,f+3.5,z,14,7,12,machinery,'cover');
    } else if (variant === 1) {
      for (const [x,z] of [[-20,z0+40],[20,z0+40],[-20,z0+72],[20,z0+72]]) box(`${id}-rack-${x}-${z}`,x,f+4,z,10,8,13,dark,'cover');
    } else if (variant === 2) {
      box(`${id}-press-a`,-14,f+6,z0+48,16,12,20,machinery,'cover');
      box(`${id}-press-b`,17,f+5,z0+72,14,10,16,steel,'cover');
    } else if (variant === 3) {
      box(`${id}-core`,0,f+12,z0+50,20,24,50,dark,'cover');
      box(`${id}-plinth-l`,-27,f+2,z0+45,10,4,12,machinery,'cover');
      box(`${id}-plinth-r`,27,f+2,z0+65,10,4,12,machinery,'cover');
    } else if (variant === 4) {
      for (const x of [-24,24]) box(`${id}-line-${x}`,x,f+2,z0+55,10,4,46,machinery,'cover');
    } else {
      box(`${id}-test-a`,-20,f+4,z0+53,12,8,28,steel,'cover');
      box(`${id}-test-b`,20,f+4,z0+58,12,8,28,steel,'cover');
      box(`${id}-console`,0,f+2,z0+78,8,4,5,machinery,'cover');
    }
    // Pipework and floor markings stay clear of traffic and identify the architecture.
    for (const x of [-34,34]) {
      box(`${id}-pipe-${x}`,x,f+21,mid,2,2,104,yellow,'decoration',false);
      box(`${id}-edge-${x}`,x,f+.04,mid,.18,.08,106,yellow,'decoration',false);
    }
    // Two guards and one turret per occupied sector, all on accessible ground.
    if (i < 15) {
      const turretId = `T${String(i+1).padStart(2,'0')}`;
      const control = [1,3,5,7,9,11].includes(i);
      const controlIndex = [1,3,5,7,9,11].indexOf(i);
      enemies.push({id:`G${String(i*2+1).padStart(2,'0')}`, kind:'guard', isGateControl:false, sectorId:id, position:[-29,f+2,z0+31], barrierId:null});
      enemies.push({id:`G${String(i*2+2).padStart(2,'0')}`, kind:'guard', isGateControl:false, sectorId:id, position:[29,f+2,z0+81], barrierId:null});
      enemies.push({id:turretId,kind:'turret',isGateControl:control,sectorId:id,position:[control ? 0 : (i%2?25:-25),f+2,z0+87],barrierId:control ? `B${String(controlIndex+1).padStart(2,'0')}` : null});
    }
    if (i < 15) {
      const high = Math.max(f,floors[i+1]), z=z1;
      // 22 m clear portal; the raised floor creates six real 8 m flight steps.
      box(`${id}-partition-l`,-25.5,(high+29-12)/2,z,29,high+41,2,steel,'wall');
      box(`${id}-partition-r`,25.5,(high+29-12)/2,z,29,high+41,2,steel,'wall');
      box(`${id}-lintel`,0,high+25,z,22,8,2,steel,'wall');
      box(`${id}-portal-l`,-11,high+9,z,1,18,2,yellow,'decoration',false);
      box(`${id}-portal-r`,11,high+9,z,1,18,2,yellow,'decoration',false);
      if ([1,3,5,7,9,11].includes(i)) {
        const n=[1,3,5,7,9,11].indexOf(i)+1, bid=`B${String(n).padStart(2,'0')}`;
        const c=box(bid,0,high+11,z,22,22,2,red,'barrier');
        barriers.push({id:bid, controlId:`T${String(i+1).padStart(2,'0')}`, sectorId:id, collider:c, open:false});
      }
    }
  }
  // Seven combat rooms receive a fourth independently acting enemy. Move
  // existing guards, keeping the sortie total and stable IDs exactly 30/15.
  for (let k=0; k<7; k++) {
    const guard=enemies.find(e=>e.id===`G${String(4*k+2).padStart(2,'0')}`);
    const sectorIndex=2*k+1;
    guard.sectorId=sectors[sectorIndex].id;
    guard.position=[-30,floors[sectorIndex]+2,sectorIndex*110+60];
  }
  // The final gate opens only after all six controls have been eliminated.
  const finalGate = box('FINAL',0,48+11,1730,22,22,2,red,'barrier');
  // Extend the enclosing wall on either side of the final gate.
  box('FINAL-L',-25.5,48+14,1730,29,28,2,steel,'wall');
  box('FINAL-R',25.5,48+14,1730,29,28,2,steel,'wall');
  box('FINAL-TOP',0,48+25,1730,22,6,2,steel,'wall');
  barriers.push({id:'FINAL',controlId:null,sectorId:'S16',collider:finalGate,open:false});
  box('exit-end',0,48+14,1760,80,28,2,steel,'wall');
  box('start-end',0,14,0,80,28,2,steel,'wall');
  // Spawn protection: two low pieces create a covered initial bay without a hidden invulnerability.
  box('spawn-cover-l',-10,3,20,14,6,3,dark,'cover');
  box('spawn-cover-r',10,3,20,14,6,3,dark,'cover');
  function removeBarrier(id) {
    const b=barriers.find(b=>b.id===id);
    if (!b || b.open) return false;
    b.open=true; group.remove(b.collider.mesh);
    const index=colliders.indexOf(b.collider); if(index>=0) colliders.splice(index,1);
    return true;
  }
  function sectorAt(position) {
    const z=Array.isArray(position)?position[2]:position.z;
    const x=Array.isArray(position)?position[0]:position.x;
    return x>=-40 && x<=40 ? sectors.find(s=>z>=s.minZ && z<s.maxZ) || null : null;
  }
  return {group,sectors,enemies,colliders,barriers,start:[0,0,8],exit:[0,48,1750],sectorAt,removeBarrier};
}
