/** Procedural, locally generated player mech. Front is +Z, feet are at y=0. */
export function createMech(THREE, legs = 'biped') {
  const group = new THREE.Group();
  const armor = new THREE.MeshStandardMaterial({color:0xb4c4bd, metalness:.65, roughness:.45});
  const armorDark = new THREE.MeshStandardMaterial({color:0x40535a, metalness:.7, roughness:.42});
  const joints = new THREE.MeshStandardMaterial({color:0x1d2b30, metalness:.75, roughness:.4});
  const light = new THREE.MeshStandardMaterial({color:0x8ce4d1, emissive:0x19887c, emissiveIntensity:.7, metalness:.25});
  const amber = new THREE.MeshStandardMaterial({color:0xf4ad3c, emissive:0x68420b, emissiveIntensity:.5});
  const grey = new THREE.MeshStandardMaterial({color:0x9da7a2, roughness:.85});
  const ear = new THREE.MeshStandardMaterial({color:0xd0aaa1, roughness:.9});
  const black = new THREE.MeshStandardMaterial({color:0x151e20, roughness:.5});
  const white = new THREE.MeshStandardMaterial({color:0xd5dfd4, roughness:.65});
  const box = (parent,mat,x,y,z,sx,sy,sz) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),mat); o.position.set(x,y,z); parent.add(o); return o;
  };
  const sphere = (parent,mat,x,y,z,sx,sy,sz) => {
    const o = new THREE.Mesh(new THREE.SphereGeometry(1,16,12),mat); o.position.set(x,y,z); o.scale.set(sx,sy,sz); parent.add(o); return o;
  };
  const cylinder = (parent,mat,x,y,z,r1,r2,h) => {
    const o = new THREE.Mesh(new THREE.CylinderGeometry(r1,r2,h,12),mat); o.position.set(x,y,z); parent.add(o); return o;
  };
  // Torso and layered plates.
  box(group,joints,0,3.18,0,2.15,1.8,1.4);
  box(group,armor,0,3.35,.16,2.6,1.75,1.5);
  box(group,armorDark,0,3.37,.99,2.05,1.17,.22);
  box(group,armor,0,3.65,1.13,1.4,.65,.18);
  box(group,light,0,3.35,1.11,1.05,.12,.12);
  for (const x of [-.75,.75]) {
    box(group,amber,x,3.03,1.12,.28,.11,.13);
    box(group,joints,x,2.53,0,.6,.4,1.3);
    // Rear drive units and glowing nozzles.
    box(group,armorDark,x,3.12,-.99,.65,1.15,.55);
    const nozzle=cylinder(group,joints,x,2.65,-1.05,.23,.32,.5); nozzle.rotation.x=Math.PI/2;
    sphere(group,light,x,2.65,-1.36,.16,.16,.06);
  }
  // Actual volumetric koala head with separate ear rims, ear pads, eyes and nose.
  sphere(group,grey,0,4.75,.16,1.07,.86,.78);
  for (const x of [-1.04,1.04]) {
    sphere(group,grey,x,5.08,.05,.62,.64,.38);
    sphere(group,ear,x,5.08,.36,.43,.46,.10);
    sphere(group,white,x*.85,4.43,.43,.28,.29,.26);
    sphere(group,black,x*.43,4.91,.84,.12,.14,.09);
    sphere(group,white,x*.43-.035,4.96,.918,.035,.035,.02);
  }
  sphere(group,black,0,4.56,.96,.29,.37,.22);
  box(group,armorDark,0,4.13,.1,1.2,.23,1.2);
  // Shoulder armor and articulated arms. Weapon points along +Z at rest.
  const armPivots=[]; let gunPivot=null;
  for (const sign of [-1,1]) {
    const pivot = new THREE.Group(); pivot.position.set(sign*1.52,3.65,0); group.add(pivot); armPivots.push(pivot);
    sphere(pivot,joints,0,0,0,.38,.38,.38);
    box(pivot,armorDark,0,-.38,0,.68,.95,.65);
    box(pivot,armor,sign*.06,.03,0,.9,.43,1.03);
    if(sign===1) {
      // Rotate the barrel about its actual muzzle: the launch position stays fixed.
      gunPivot=new THREE.Group();gunPivot.position.set(0,-.48,1.86);pivot.add(gunPivot);
      box(gunPivot,armorDark,0,.03,-1.20,.7,.57,1.5);
      box(gunPivot,armor,0,.23,-1.19,.8,.32,1.35);
      box(gunPivot,joints,0,0,-.31,.48,.42,.62);
      box(gunPivot,amber,0,.32,-.91,.18,.08,.5);
    } else {
      box(pivot,armor,0,-.96,.22,.62,.8,.68);
      box(pivot,joints,0,-1.4,.35,.48,.32,.5);
    }
  }
  const legPivots=[];
  const legZ = legs === 'quadruped' ? [-.75,.75] : [0];
  for(const z of legZ) for(const side of [-1,1]) {
    const pivot=new THREE.Group(); pivot.position.set(side*.72,2.48,z); group.add(pivot); legPivots.push({pivot,phase:(side<0?0:Math.PI)+(z<0?Math.PI:0)});
    sphere(pivot,joints,0,0,0,.36,.36,.36);
    box(pivot,armorDark,0,-.65,0,.68,1.25,.72);
    box(pivot,armor,side*.05,-.55,.11,.78,.94,.75);
    sphere(pivot,joints,0,-1.3,0,.31,.31,.31);
    box(pivot,armorDark,0,-1.72,-.03,.55,.82,.58);
    box(pivot,armor,0,-1.88,.25,.73,.66,.87);
    box(pivot,joints,0,-2.33,.20,.88,.26,1.25);
    box(pivot,amber,0,-2.33,.76,.54,.08,.08);
  }
  const localAim = new THREE.Vector3(), inverse = new THREE.Quaternion();
  const zaxis = new THREE.Vector3(0,0,1);
  return {
    group,
    update(time, speed=0, aimDirection=null) {
      const amplitude=Math.min(.45,Math.abs(speed)*.035);
      for(const l of legPivots) l.pivot.rotation.x=Math.sin(time*8+l.phase)*amplitude;
      if (aimDirection) {
        group.getWorldQuaternion(inverse).invert();
        localAim.set(aimDirection.x,aimDirection.y,aimDirection.z).applyQuaternion(inverse).normalize();
        if(localAim.lengthSq()>.1) gunPivot.quaternion.setFromUnitVectors(zaxis,localAim);
      }
    }
  };
}
