import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const mats = {
  armor: new THREE.MeshStandardMaterial({ color: 0x52646c, roughness: 0.52, metalness: 0.72 }),
  armorDark: new THREE.MeshStandardMaterial({ color: 0x202b32, roughness: 0.65, metalness: 0.75 }),
  plate: new THREE.MeshStandardMaterial({ color: 0x8b9ba0, roughness: 0.5, metalness: 0.62 }),
  joint: new THREE.MeshStandardMaterial({ color: 0x171d22, roughness: 0.4, metalness: 0.9 }),
  koala: new THREE.MeshStandardMaterial({ color: 0x879399, roughness: 0.88, metalness: 0.08 }),
  koalaLight: new THREE.MeshStandardMaterial({ color: 0xb4bec0, roughness: 0.9, metalness: 0.03 }),
  earInner: new THREE.MeshStandardMaterial({ color: 0x5f666c, roughness: 0.95, metalness: 0.02 }),
  nose: new THREE.MeshStandardMaterial({ color: 0x101419, roughness: 0.35, metalness: 0.25 }),
  eye: new THREE.MeshStandardMaterial({ color: 0x071014, emissive: 0x4ee6d0, emissiveIntensity: 0.7, roughness: 0.2 }),
  glow: new THREE.MeshStandardMaterial({ color: 0x56d9e9, emissive: 0x1eafc8, emissiveIntensity: 2 }),
  enemy: new THREE.MeshStandardMaterial({ color: 0x6e4a42, roughness: 0.65, metalness: 0.7 }),
  enemyDark: new THREE.MeshStandardMaterial({ color: 0x2b2528, roughness: 0.7, metalness: 0.65 }),
  enemyGlow: new THREE.MeshStandardMaterial({ color: 0xff643c, emissive: 0xff2400, emissiveIntensity: 2 }),
  control: new THREE.MeshStandardMaterial({ color: 0xffb32b, emissive: 0xff6a00, emissiveIntensity: 1.8 }),
};

function mesh(geometry, material, position = [0, 0, 0], parent = null) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(...position); m.castShadow = true; m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}
function box(size, material, position, parent) { return mesh(new THREE.BoxGeometry(...size), material, position, parent); }
function sphere(radius, material, position, parent, scale = null) {
  const m = mesh(new THREE.SphereGeometry(radius, 24, 16), material, position, parent);
  if (scale) m.scale.set(...scale);
  return m;
}
function cylinder(radius, length, material, position, parent, rotation = null) {
  const m = mesh(new THREE.CylinderGeometry(radius, radius, length, 12), material, position, parent);
  if (rotation) m.rotation.set(...rotation);
  return m;
}

function batchStaticMeshes(root, recursive = true) {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const batches = new Map();
  const candidates = [];
  if (recursive) root.traverse(o => { if (o.isMesh && !o.userData.dynamic) candidates.push(o); });
  else root.children.forEach(o => { if (o.isMesh && !o.userData.dynamic) candidates.push(o); });
  for (const mesh of candidates) {
    const key = mesh.material.uuid;
    if (!batches.has(key)) batches.set(key, { material: mesh.material, meshes: [] });
    batches.get(key).meshes.push(mesh);
  }
  for (const { material, meshes } of batches.values()) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map(mesh => mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld)));
    const merged = mergeGeometries(geometries, false); geometries.forEach(g => g.dispose());
    if (!merged) continue;
    meshes.forEach(mesh => mesh.parent.remove(mesh));
    root.add(new THREE.Mesh(merged, material));
  }
}

function createLeg(x, z, parent, four = false) {
  const hip = new THREE.Group(); hip.position.set(x, 1.65, z); parent.add(hip);
  sphere(0.27, mats.joint, [0, 0, 0], hip);
  const upper = box([four ? 0.32 : 0.48, 0.85, 0.45], mats.armor, [0, -0.43, 0], hip);
  const knee = new THREE.Group(); knee.position.set(0, -0.83, 0); hip.add(knee);
  sphere(0.23, mats.joint, [0, 0, 0], knee);
  box([0.38, 0.72, 0.38], mats.plate, [0, -0.35, four ? -0.15 : 0], knee);
  box([0.64, 0.28, 0.9], mats.armorDark, [0, -0.74, -0.18], knee);
  cylinder(0.08, 0.8, mats.glow, [x > 0 ? -0.26 : 0.26, -0.4, 0.15], hip);
  hip.userData.knee = knee; hip.userData.upper = upper;
  return hip;
}

export function createPlayerModel(legs = 'biped') {
  const group = new THREE.Group(); group.name = 'Armored Koala player';
  const body = new THREE.Group(); group.add(body);
  // Heavy mechanical torso and layered armor.
  box([1.75, 1.35, 1.15], mats.armor, [0, 2.35, 0], body);
  box([1.35, 0.72, 0.28], mats.plate, [0, 2.48, -0.68], body).rotation.x = -0.12;
  box([1.05, 0.34, 0.18], mats.armorDark, [0, 1.82, -0.67], body);
  for (const x of [-0.42, 0.42]) box([0.22, 0.58, 0.12], mats.glow, [x, 2.42, -0.85], body);
  cylinder(0.38, 0.3, mats.joint, [0, 3.12, 0], body);

  // Koala head: volumetric skull, muzzle, two large circular ears, inner ears, nose and eyes.
  const head = new THREE.Group(); head.position.set(0, 3.73, -0.03); body.add(head);
  sphere(0.77, mats.koala, [0, 0, 0], head, [1.0, 1.02, 0.88]);
  sphere(0.48, mats.koalaLight, [0, -0.20, -0.52], head, [1.05, 0.70, 0.55]);
  for (const side of [-1, 1]) {
    sphere(0.53, mats.koala, [side * 0.75, 0.25, 0.03], head, [0.72, 1.0, 0.48]);
    sphere(0.36, mats.earInner, [side * 0.78, 0.25, -0.19], head, [0.65, 0.90, 0.28]);
    sphere(0.105, mats.eye, [side * 0.29, 0.10, -0.65], head, [0.8, 1.05, 0.45]);
    box([0.31, 0.10, 0.12], mats.armorDark, [side * 0.30, 0.29, -0.61], head).rotation.z = side * -0.12;
  }
  sphere(0.30, mats.nose, [0, -0.16, -0.78], head, [0.86, 1.12, 0.62]);
  box([0.30, 0.055, 0.08], mats.nose, [0, -0.43, -0.68], head);
  // Mechanical helmet crest and jaw brackets keep it an armored machine, not a textured cube.
  box([0.24, 0.22, 1.0], mats.armor, [0, 0.68, 0.04], head);
  for (const side of [-1, 1]) box([0.14, 0.48, 0.48], mats.armor, [side * 0.66, -0.28, 0.12], head);

  const leftArm = new THREE.Group(); leftArm.position.set(-1.13, 2.72, 0); body.add(leftArm);
  sphere(0.43, mats.armor, [0, 0, 0], leftArm);
  cylinder(0.26, 0.85, mats.armorDark, [0, -0.54, 0], leftArm);
  sphere(0.27, mats.joint, [0, -0.96, 0], leftArm);
  box([0.52, 0.72, 0.58], mats.plate, [0, -1.28, -0.12], leftArm);

  const rightArm = new THREE.Group(); rightArm.position.set(1.13, 2.72, 0); body.add(rightArm);
  sphere(0.43, mats.armor, [0, 0, 0], rightArm);
  cylinder(0.26, 0.78, mats.armorDark, [0, -0.48, 0], rightArm);
  box([0.48, 0.62, 0.58], mats.plate, [0, -0.92, -0.1], rightArm);

  // The weapon rotates around its actual muzzle, so aiming never changes the muzzle coordinate.
  const weaponPivot = new THREE.Group(); weaponPivot.position.set(1.13, 1.63, -0.52); body.add(weaponPivot);
  const muzzle = new THREE.Object3D(); weaponPivot.add(muzzle);
  const guns = {};
  const mg = new THREE.Group(); weaponPivot.add(mg); guns.machinegun = mg;
  box([0.38, 0.42, 1.35], mats.armorDark, [0, 0, 0.72], mg);
  for (const x of [-0.11, 0.11]) cylinder(0.065, 1.1, mats.joint, [x, 0.07, 0.12], mg, [Math.PI / 2, 0, 0]);
  box([0.12, 0.36, 0.4], mats.armor, [0, -0.34, 0.65], mg);
  const beam = new THREE.Group(); weaponPivot.add(beam); guns.beam = beam;
  box([0.44, 0.46, 1.42], mats.armor, [0, 0, 0.76], beam);
  cylinder(0.13, 1.35, mats.glow, [0, 0, 0.35], beam, [Math.PI / 2, 0, 0]);
  for (const z of [0.15, 0.65, 1.1]) box([0.62, 0.10, 0.12], mats.plate, [0, 0, z], beam);
  const missile = new THREE.Group(); weaponPivot.add(missile); guns.missile = missile;
  box([0.68, 0.62, 1.28], mats.armorDark, [0, 0, 0.69], missile);
  for (const x of [-0.18, 0.18]) for (const y of [-0.16, 0.16]) cylinder(0.12, 1.15, mats.plate, [x, y, 0.3], missile, [Math.PI / 2, 0, 0]);
  const muzzleFlash = sphere(0.19, mats.glow, [0, 0, -0.08], weaponPivot); muzzleFlash.visible = false;

  const boosters = [];
  for (const x of [-0.58, 0.58]) {
    const booster = cylinder(0.27, 0.75, mats.armorDark, [x, 2.30, 0.80], body, [Math.PI / 2, 0, 0]);
    const flame = mesh(new THREE.ConeGeometry(0.23, 1.5, 12), mats.glow, [x, 2.30, 1.75], body);
    flame.rotation.x = -Math.PI / 2; flame.visible = false; boosters.push(flame);
  }

  let legRoot = null, legPivots = [];
  function setLegs(type) {
    if (legRoot) body.remove(legRoot);
    legRoot = new THREE.Group(); body.add(legRoot); legPivots = [];
    if (type === 'biped') {
      for (const x of [-0.58, 0.58]) legPivots.push(createLeg(x, 0, legRoot));
    } else {
      for (const x of [-0.78, 0.78]) for (const z of [-0.42, 0.48]) {
        const leg = createLeg(x, z, legRoot, true); leg.scale.set(0.88, 0.88, 0.88); leg.rotation.z = x * -0.15; legPivots.push(leg);
      }
      box([1.75, 0.38, 1.45], mats.armorDark, [0, 1.55, 0], legRoot);
    }
  }
  setLegs(legs);

  return {
    group, body, head, weaponPivot, muzzle, muzzleFlash, guns, boosters,
    setLegs,
    setWeapon(weapon) { for (const [key, gun] of Object.entries(guns)) gun.visible = key === weapon; },
    setAimDirection(worldDirection, yaw) {
      const local = worldDirection.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw).normalize();
      weaponPivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), local);
    },
    animate(time, horizontalSpeed, grounded, verticalMode, movementMode) {
      const stride = Math.min(1, horizontalSpeed / 8);
      legPivots.forEach((leg, i) => {
        const phase = time * (5 + horizontalSpeed * 0.22) + i * Math.PI;
        leg.rotation.x = grounded ? Math.sin(phase) * 0.48 * stride : (i % 2 ? -0.28 : 0.28);
        leg.userData.knee.rotation.x = grounded ? Math.max(0, -Math.sin(phase)) * 0.5 * stride : 0.38;
      });
      body.position.y = grounded ? Math.abs(Math.sin(time * 7)) * 0.035 * stride : 0.05;
      const boosting = movementMode === 'quickboost' || verticalMode === 'flying' || horizontalSpeed > 24;
      boosters.forEach((b, i) => { b.visible = boosting; b.scale.y = boosting ? 0.8 + 0.25 * Math.sin(time * 38 + i) : 0.1; });
    },
  };
}

export function createGuardModel() {
  const group = new THREE.Group(); group.name = 'Guard robot';
  box([1.5, 1.15, 1.1], mats.enemy, [0, 0.20, 0], group);
  box([1.0, 0.55, 0.75], mats.enemyDark, [0, 1.0, -0.08], group);
  for (const x of [-0.28, 0.28]) sphere(0.12, mats.enemyGlow, [x, 1.08, -0.48], group);
  for (const x of [-0.52, 0.52]) {
    const hip = new THREE.Group(); hip.position.set(x, -0.45, 0); group.add(hip);
    box([0.38, 0.85, 0.42], mats.enemyDark, [0, -0.42, 0], hip);
    box([0.55, 0.25, 0.78], mats.enemy, [0, -0.90, -0.12], hip);
  }
  const gun = new THREE.Group(); gun.position.set(0.85, 0.35, -0.2); group.add(gun);
  box([0.4, 0.45, 1.4], mats.enemyDark, [0, 0, -0.35], gun);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, -1.12); gun.add(muzzle);
  const flash = sphere(0.28, mats.enemyGlow, [0, 0, -1.15], gun); flash.visible = false; flash.userData.dynamic = true;
  batchStaticMeshes(group, true);
  return { group, muzzle, flash, gun, aim(direction) { group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction.clone().normalize()); } };
}

export function createTurretModel(isControl) {
  const group = new THREE.Group(); group.name = isControl ? 'Barrier control turret' : 'Fixed turret';
  cylinder(1.25, 0.5, mats.enemyDark, [0, -1.40, 0], group);
  cylinder(0.65, 1.8, mats.enemy, [0, -0.50, 0], group);
  const head = new THREE.Group(); head.position.y = 0.55; group.add(head);
  box([2.0, 1.15, 1.65], isControl ? mats.control : mats.enemy, [0, 0, 0], head);
  for (const x of [-0.48, 0.48]) cylinder(0.16, 2.25, mats.enemyDark, [x, 0.05, -1.25], head, [Math.PI / 2, 0, 0]);
  sphere(0.19, mats.enemyGlow, [0, 0.30, -0.86], head);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.05, -2.42); head.add(muzzle);
  const flash = sphere(0.42, mats.enemyGlow, [0, 0.05, -2.45], head); flash.visible = false; flash.userData.dynamic = true;
  batchStaticMeshes(head, true); batchStaticMeshes(group, false);
  return { group, head, muzzle, flash, aim(direction) { head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction.clone().normalize()); } };
}

export function disposeModel(group) {
  group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
}
