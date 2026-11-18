import * as THREE from 'three';
import type { LegId } from '../core/config';

const MAT = {
  armor: new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.55, metalness: 0.35 }),
  armorDark: new THREE.MeshStandardMaterial({ color: 0x39424c, roughness: 0.6, metalness: 0.5 }),
  armorTrim: new THREE.MeshStandardMaterial({ color: 0xe08a2e, roughness: 0.45, metalness: 0.55 }),
  fur: new THREE.MeshStandardMaterial({ color: 0xa9b1bb, roughness: 0.95, metalness: 0.0 }),
  furDark: new THREE.MeshStandardMaterial({ color: 0x6d757f, roughness: 0.95, metalness: 0.0 }),
  nose: new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.35, metalness: 0.1 }),
  eye: new THREE.MeshStandardMaterial({ color: 0x8ef0ff, emissive: 0x1e6a80, roughness: 0.2 }),
  enemy: new THREE.MeshStandardMaterial({ color: 0x7a3a3a, roughness: 0.7, metalness: 0.4 }),
  enemyDark: new THREE.MeshStandardMaterial({ color: 0x2c2224, roughness: 0.8, metalness: 0.35 }),
  enemyEye: new THREE.MeshStandardMaterial({ color: 0xff4d4d, emissive: 0xaa1111, roughness: 0.2 }),
  thruster: new THREE.MeshStandardMaterial({ color: 0x2b3340, roughness: 0.5, metalness: 0.6 })
};

export interface MechRig {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  aim: THREE.Group;
  /** logical muzzle: fixed to the torso, independent of the arm pose */
  muzzleAnchor: THREE.Object3D;
  /** visual barrel tip */
  muzzle: THREE.Object3D;
  thrusters: THREE.Mesh[];
  legs: THREE.Group[];
  /** legs animated by the walk cycle */
  legPivots: THREE.Group[];
  weaponMuzzles: THREE.Object3D[];
}

/** Koala-head battle mech. */
export function buildMech(legKind: LegId): MechRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  // the rig root sits on the ground: the legs reach down to y = 0
  body.position.y = 1.3;
  root.add(body);

  // ---------------- torso ----------------
  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.35, 1.05), MAT.armor);
  torso.position.y = 0.15;
  body.add(torso);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.62, 0.22), MAT.armorDark);
  chest.position.set(0, 0.28, 0.56);
  body.add(chest);
  const chestTrim = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.1), MAT.armorTrim);
  chestTrim.position.set(0, 0.5, 0.7);
  body.add(chestTrim);
  const abdomen = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.55, 0.86), MAT.armorDark);
  abdomen.position.y = -0.72;
  body.add(abdomen);
  const hip = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.3, 0.92), MAT.armor);
  hip.position.y = -1.02;
  body.add(hip);

  // ---------------- koala head ----------------
  const head = new THREE.Group();
  head.position.set(0, 0.95, 0.06);
  body.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.52, 24, 18), MAT.fur);
  skull.scale.set(1.02, 0.94, 1.0);
  head.add(skull);
  const snout = new THREE.Mesh(new THREE.SphereGeometry(0.31, 18, 14), MAT.furDark);
  snout.scale.set(1.1, 0.8, 0.95);
  snout.position.set(0, -0.12, 0.36);
  head.add(snout);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), MAT.nose);
  nose.scale.set(1.25, 0.95, 1.0);
  nose.position.set(0, -0.04, 0.63);
  head.add(nose);
  // big round ears
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.33, 20, 16), MAT.fur);
    ear.scale.set(1.0, 1.0, 0.5);
    ear.position.set(s * 0.5, 0.24, -0.02);
    ear.rotation.z = s * 0.28;
    head.add(ear);
    const earIn = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), MAT.furDark);
    earIn.scale.set(1.0, 1.0, 0.35);
    earIn.position.set(s * 0.53, 0.24, 0.12);
    earIn.rotation.z = s * 0.28;
    head.add(earIn);
  }
  // eyes
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 10), MAT.nose);
    eye.position.set(s * 0.19, 0.06, 0.44);
    head.add(eye);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), MAT.eye);
    glint.position.set(s * 0.205, 0.09, 0.5);
    head.add(glint);
  }
  // brow ridge
  const brow = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.1, 0.3), MAT.armorDark);
  brow.position.set(0, 0.24, 0.32);
  head.add(brow);

  // ---------------- arms ----------------
  const aim = new THREE.Group();
  aim.position.set(0.62, 0.42, 0.05);
  body.add(aim);
  const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), MAT.armor);
  aim.add(shoulder);
  const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.86), MAT.armor);
  upperArm.position.set(0, 0, 0.43);
  aim.add(upperArm);
  const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 10), MAT.armorDark);
  elbow.position.set(0, 0, 0.86);
  aim.add(elbow);
  const foreArm = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.7), MAT.armor);
  foreArm.position.set(0, 0, 1.2);
  aim.add(foreArm);

  // weapon pod
  const pod = new THREE.Group();
  pod.position.set(0, 0.06, 1.35);
  aim.add(pod);
  const podBody = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.34, 0.86), MAT.armorDark);
  pod.add(podBody);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.95, 12), MAT.armor);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.04, 0.77);
  pod.add(barrel);
  const barrel2 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.6, 10), MAT.armorTrim);
  barrel2.rotation.x = Math.PI / 2;
  barrel2.position.set(0.14, -0.06, 0.64);
  pod.add(barrel2);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.04, 1.26);
  pod.add(muzzle);
  const weaponMuzzles = [muzzle];

  // The logical muzzle is anchored to the torso so that swinging the arm
  // never changes the point the shots leave from (the FCS range check and
  // the firing solution therefore stay consistent).
  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.position.set(0.62, 0.42 + 0.06, 0.05 + 1.35 + 1.26);
  body.add(muzzleAnchor);

  // missile rack on the left shoulder
  const leftShoulder = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), MAT.armor);
  leftShoulder.position.set(-0.62, 0.42, 0.05);
  body.add(leftShoulder);
  const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 1.0), MAT.armor);
  leftArm.position.set(-0.62, 0.42, 0.4);
  leftArm.rotation.x = 0.15;
  body.add(leftArm);
  for (let i = 0; i < 3; i++) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.8, 10), MAT.armorDark);
    tube.rotation.x = Math.PI / 2;
    tube.position.set(-0.62 + (i - 1) * 0.19, 0.72, 0.1);
    body.add(tube);
  }
  const missileMuzzle = new THREE.Object3D();
  missileMuzzle.position.set(-0.62, 0.72, 0.55);
  body.add(missileMuzzle);
  weaponMuzzles.push(missileMuzzle);

  // ---------------- thrusters ----------------
  const thrusters: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.24, 0.42, 12), MAT.thruster);
    t.rotation.x = Math.PI / 2;
    t.position.set(s * 0.42, 0.15, -0.72);
    body.add(t);
    thrusters.push(t);
  }
  const backPack = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.42), MAT.armorDark);
  backPack.position.set(0, 0.15, -0.72);
  body.add(backPack);

  // ---------------- legs ----------------
  const legPivots: THREE.Group[] = [];
  const legGroups: THREE.Group[] = [];
  const legCount = legKind === 'biped' ? 2 : 4;
  for (let i = 0; i < legCount; i++) {
    const pivot = new THREE.Group();
    if (legCount === 2) {
      pivot.position.set(i === 0 ? -0.4 : 0.4, -1.1, 0);
    } else {
      pivot.position.set(i < 2 ? -0.38 : 0.38, -1.1, i % 2 === 0 ? 0.42 : -0.42);
    }
    body.add(pivot);
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.6, 0.36), MAT.armor);
    thigh.position.y = -0.3;
    pivot.add(thigh);
    const knee = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 10), MAT.armorDark);
    knee.position.y = -0.62;
    pivot.add(knee);
    const shin = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.56, 0.3), MAT.armor);
    shin.position.y = -0.9;
    pivot.add(shin);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.56), MAT.armorDark);
    foot.position.set(0, -1.22, 0.08);
    pivot.add(foot);
    legPivots.push(pivot);
    legGroups.push(pivot);
  }

  root.position.y = 0;
  return { root, body, head, aim, muzzleAnchor, muzzle, thrusters, legs: legGroups, legPivots, weaponMuzzles };
}

/** Security robot (guard). */
export function buildGuard(): {
  root: THREE.Group;
  head: THREE.Group;
  muzzle: THREE.Object3D;
  legs: THREE.Group[];
  lamp: THREE.Mesh;
} {
  const root = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.85, 0.8), MAT.enemy);
  torso.position.y = 0.45;
  root.add(torso);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.4, 0.2), MAT.enemyDark);
  chest.position.set(0, 0.5, 0.48);
  root.add(chest);
  const head = new THREE.Group();
  head.position.set(0, 1.02, 0.05);
  root.add(head);
  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.4, 0.5), MAT.enemyDark);
  head.add(skull);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), MAT.enemyEye);
  eye.position.set(0, 0.02, 0.26);
  head.add(eye);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.9), MAT.enemy);
  gun.position.set(0.42, 0.5, 0.45);
  root.add(gun);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.6, 10), MAT.enemyDark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0.42, 0.5, 1.0);
  root.add(barrel);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0.42, 0.5, 1.32);
  root.add(muzzle);
  // telegraph lamp (lit while the guard prepares its next burst)
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshStandardMaterial({ color: 0x552222, emissive: 0x220000, roughness: 0.3 }));
  lamp.position.set(0.42, 0.72, 0.7);
  root.add(lamp);
  const legs: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.3, 0.05, 0);
    root.add(pivot);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.6, 0.28), MAT.enemy);
    leg.position.y = -0.3;
    pivot.add(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.5), MAT.enemyDark);
    foot.position.set(0, -0.62, 0.05);
    pivot.add(foot);
    legs.push(pivot);
  }
  return { root, head, muzzle, legs, lamp };
}

/** Fixed turret. */
export function buildTurret(): { root: THREE.Group; head: THREE.Group; muzzle: THREE.Object3D; muzzle2: THREE.Object3D } {
  const root = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.15, 0.55, 12), MAT.enemyDark);
  base.position.y = 0.28;
  root.add(base);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 0.3, 12), MAT.enemy);
  collar.position.y = 0.68;
  root.add(collar);
  const head = new THREE.Group();
  head.position.y = 0.95;
  root.add(head);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 0.9), MAT.enemy);
  head.add(housing);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), MAT.enemyEye);
  eye.position.set(0, 0.12, 0.46);
  head.add(eye);
  const barrels: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.95, 10), MAT.enemyDark);
    b.rotation.x = Math.PI / 2;
    b.position.set(s * 0.2, -0.08, 0.62);
    head.add(b);
    const m = new THREE.Object3D();
    m.position.set(s * 0.2, -0.08, 1.12);
    head.add(m);
    barrels.push(m);
  }
  return { root, head, muzzle: barrels[0], muzzle2: barrels[1] };
}
