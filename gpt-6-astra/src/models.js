import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// All surface detail is made from geometry. No downloaded models or textures.
const geometries = new Map();
function boxGeometry(x, y, z, radius = 0.04) {
  const key = `b:${x}:${y}:${z}:${radius}`;
  if (!geometries.has(key)) {
    const geometry = new RoundedBoxGeometry(x, y, z, 2, Math.min(radius, x / 3, y / 3, z / 3));
    geometry.userData.shared = true;
    geometries.set(key, geometry);
  }
  return geometries.get(key);
}
function cylinderGeometry(top, bottom, height, segments = 12) {
  const key = `c:${top}:${bottom}:${height}:${segments}`;
  if (!geometries.has(key)) {
    const geometry = new THREE.CylinderGeometry(top, bottom, height, segments);
    geometry.userData.shared = true;
    geometries.set(key, geometry);
  }
  return geometries.get(key);
}
const sphereGeometry = new THREE.SphereGeometry(1, 20, 12);
sphereGeometry.userData.shared = true;
const torusGeometries = new Map();
const materials = {
  armor: new THREE.MeshStandardMaterial({ color: 0x9baba0, roughness: .48, metalness: .43 }),
  pale: new THREE.MeshStandardMaterial({ color: 0xd4d7bc, roughness: .48, metalness: .32 }),
  edge: new THREE.MeshStandardMaterial({ color: 0x617169, roughness: .53, metalness: .55 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x202b2b, roughness: .57, metalness: .67 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x101719, roughness: .67, metalness: .15 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x7f8f8c, roughness: .35, metalness: .8 }),
  orange: new THREE.MeshStandardMaterial({ color: 0xe97434, roughness: .48, metalness: .33 }),
  glow: new THREE.MeshStandardMaterial({ color: 0xffbd70, emissive: 0xff902a, emissiveIntensity: 2.4, roughness: .4 }),
  blue: new THREE.MeshStandardMaterial({ color: 0x83e0ec, emissive: 0x45aabc, emissiveIntensity: 2.2 }),
  warning: new THREE.MeshStandardMaterial({ color: 0xfa5938, emissive: 0xc62b0b, emissiveIntensity: 1.5 }),
  enemy: new THREE.MeshStandardMaterial({ color: 0x605b50, roughness: .6, metalness: .47 }),
  enemyPale: new THREE.MeshStandardMaterial({ color: 0x968c71, roughness: .6, metalness: .4 }),
};
for (const material of Object.values(materials)) material.userData.shared = true;

function mesh(parent, geometry, material, x = 0, y = 0, z = 0, rotation) {
  const part = new THREE.Mesh(geometry, typeof material === 'string' ? materials[material] : material);
  part.position.set(x, y, z);
  if (rotation) part.rotation.set(...rotation);
  part.castShadow = true;
  part.receiveShadow = true;
  parent.add(part);
  return part;
}
function box(parent, size, position, material, radius = .04, rotation) {
  return mesh(parent, boxGeometry(...size, radius), material, ...position, rotation);
}
function sphere(parent, size, position, material) {
  const part = mesh(parent, sphereGeometry, material, ...position);
  part.scale.set(...size);
  return part;
}
function cylinder(parent, radii, position, material, rotation, segments = 12) {
  return mesh(parent, cylinderGeometry(...radii, segments), material, ...position, rotation);
}
function ring(parent, radius, thickness, position, material, rotation) {
  const key = `${radius}:${thickness}`;
  if (!torusGeometries.has(key)) {
    const geometry = new THREE.TorusGeometry(radius, thickness, 6, 32);
    geometry.userData.shared = true;
    torusGeometries.set(key, geometry);
  }
  return mesh(parent, torusGeometries.get(key), material, ...position, rotation);
}
function group(parent, position = [0, 0, 0]) {
  const part = new THREE.Group();
  part.position.set(...position);
  parent.add(part);
  return part;
}
function beam(parent, a, b, radius, material) {
  const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b);
  const length = av.distanceTo(bv);
  const part = cylinder(parent, [radius, radius, length], av.add(bv).multiplyScalar(.5).toArray(), material);
  part.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...b).sub(new THREE.Vector3(...a)).normalize());
  return part;
}
function bolts(parent, positions, radius = .035) {
  for (const p of positions) cylinder(parent, [radius, radius, .035], p, 'steel', [Math.PI / 2, 0, 0], 6);
}
function vents(parent, position, count, width, spacing, material = 'dark') {
  for (let i = 0; i < count; i++) box(parent, [width, .036, .025], [position[0], position[1] + i * spacing, position[2]], material, .006);
}

function createHead(parent) {
  const head = group(parent, [0, 3.95, .07]);
  // Layered circular acoustic antennae retain the unmistakable koala silhouette.
  for (const side of [-1, 1]) {
    const ear = group(head, [side * .85, .24, -.05]);
    ear.rotation.z = side * -.10;
    cylinder(ear, [.47, .49, .24], [0, 0, 0], 'dark', [Math.PI / 2, 0, 0], 24);
    cylinder(ear, [.435, .45, .23], [0, 0, .07], 'armor', [Math.PI / 2, 0, 0], 24);
    ring(ear, .392, .041, [0, 0, .21], 'pale');
    cylinder(ear, [.34, .34, .03], [0, 0, .209], 'edge', [Math.PI / 2, 0, 0], 24);
    sphere(ear, [.285, .285, .065], [0, 0, .24], 'pale');
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      cylinder(ear, [.019, .019, .036], [Math.sin(a) * .41, Math.cos(a) * .41, .247], 'steel', [Math.PI / 2, 0, 0], 6);
    }
    box(ear, [.07, .16, .12], [side * .425, -.04, .05], 'orange', .02);
  }
  sphere(head, [.70, .59, .48], [0, .08, 0], 'armor');
  box(head, [1.11, .77, .56], [0, .06, .02], 'armor', .18);
  box(head, [.98, .43, .14], [0, -.055, .401], 'pale', .14);
  box(head, [.86, .095, .045], [0, .19, .467], 'dark', .027);
  box(head, [.7, .078, .08], [0, .39, .339], 'pale', .026);
  box(head, [.16, .045, .06], [0, .46, .345], 'orange', .009);
  // Small optical sensors set back beside a three-dimensional graphite nose.
  for (const side of [-1, 1]) {
    box(head, [.23, .072, .052], [side * .287, .188, .499], 'rubber', .028);
    box(head, [.128, .025, .015], [side * .30, .19, .529], 'glow', .008);
    box(head, [.19, .29, .13], [side * .491, -.085, .408], 'armor', .05, [0, side * .28, side * -.20]);
    bolts(head, [[side * .498, -.23, .451]], .024);
  }
  sphere(head, [.203, .285, .19], [0, .015, .525], 'rubber');
  sphere(head, [.07, .16, .02], [-.052, .071, .703], 'dark');
  box(head, [.31, .034, .045], [0, -.29, .409], 'dark', .01);
  box(head, [.12, .048, .056], [0, -.405, .30], 'orange', .008);
  vents(head, [-.38, .292, .383], 3, .15, .044);
  return head;
}

function createTorso(parent) {
  const torso = group(parent);
  cylinder(torso, [.28, .3, .25], [0, 3.51, 0], 'dark', undefined, 16);
  ring(torso, .25, .035, [0, 3.59, 0], 'steel', [Math.PI / 2, 0, 0]);
  box(torso, [1.28, 1.12, .84], [0, 2.95, -.04], 'dark', .15);
  box(torso, [1.39, .65, .74], [0, 3.19, .02], 'armor', .14);
  box(torso, [1.15, .38, .20], [0, 3.24, .45], 'pale', .075, [-.10, 0, 0]);
  box(torso, [.50, .24, .055], [0, 3.30, .571], 'dark', .025);
  vents(torso, [0, 3.235, .609], 4, .38, .044);
  box(torso, [.075, .18, .059], [-.47, 3.25, .582], 'orange', .015);
  box(torso, [.10, .05, .056], [.47, 3.33, .58], 'blue', .008);
  box(torso, [.98, .36, .29], [0, 2.85, .38], 'armor', .058, [.18, 0, 0]);
  box(torso, [.30, .24, .03], [-.25, 2.845, .55], 'pale', .025);
  // An original geometric unit insignia, rather than an existing franchise logo.
  box(torso, [.024, .13, .018], [-.29, 2.85, .575], 'edge', .003, [0, 0, -.25]);
  box(torso, [.024, .13, .018], [-.22, 2.85, .575], 'edge', .003, [0, 0, .25]);
  box(torso, [.096, .024, .018], [-.255, 2.826, .575], 'edge', .003);
  bolts(torso, [[-.49, 3.10, .52], [.49, 3.10, .52], [-.46, 2.74, .56], [.46, 2.74, .56]]);
  for (const side of [-1, 1]) {
    box(torso, [.28, .60, .70], [side * .674, 2.97, -.015], 'edge', .07, [0, 0, side * -.08]);
    for (let i = 0; i < 3; i++) box(torso, [.26, .06, .08], [side * .672, 2.87 + i * .11, .365], 'dark', .009);
    beam(torso, [side * .45, 2.52, .23], [side * .56, 2.88, .23], .04, 'steel');
  }
  cylinder(torso, [.42, .45, .20], [0, 2.38, 0], 'dark');
  box(torso, [1.03, .35, .65], [0, 2.22, 0], 'armor', .08);
  box(torso, [.30, .29, .24], [0, 2.14, .40], 'pale', .045, [.08, 0, 0]);
  for (const side of [-1, 1]) box(torso, [.38, .42, .13], [side * .52, 2.10, .40], 'edge', .04, [.15, 0, side * .12]);
  return torso;
}

function createArms(parent) {
  for (const side of [-1, 1]) {
    cylinder(parent, [.24, .24, .31], [side * .83, 3.29, 0], 'dark', [0, 0, Math.PI / 2]);
    box(parent, [.66, .50, .87], [side * 1.015, 3.34, -.02], 'armor', .095, [0, 0, side * -.08]);
    box(parent, [.55, .145, .76], [side * 1.018, 3.59, -.02], 'pale', .025, [0, 0, side * -.08]);
    box(parent, [.055, .28, .73], [side * 1.358, 3.34, -.01], 'edge', .015);
    box(parent, [.11, .16, .06], [side * 1.21, 3.365, .43], 'orange', .009);
    box(parent, [.19, .032, .05], [side * .99, 3.41, .441], 'dark', .005);
    box(parent, [.30, .65, .37], [side * 1.10, 2.98, -.025], 'dark', .065, [0, 0, side * -.08]);
    cylinder(parent, [.198, .198, .40], [side * 1.125, 2.70, .01], 'steel', [0, 0, Math.PI / 2]);
    box(parent, [.41, .52, .48], [side * 1.15, 2.52, .16], 'armor', .075, [-.22, 0, 0]);
    box(parent, [.28, .27, .075], [side * 1.15, 2.59, .415], 'pale', .025);
    vents(parent, [side * 1.15, 2.49, .459], 3, .18, .064);
    box(parent, [.29, .23, .30], [side * 1.17, 2.26, .24], 'dark', .044);
    if (side === 1) {
      beam(parent, [1.16, 2.45, .28], [1.30, 3.0, .38], .10, 'dark');
      cylinder(parent, [.19, .19, .27], [1.31, 3.04, .38], 'steel', [0, 0, Math.PI / 2]);
    } else {
      box(parent, [.25, .24, .16], [-1.17, 2.18, .39], 'edge', .033);
      for (let i = 0; i < 3; i++) box(parent, [.043, .17, .085], [-1.25 + i * .08, 2.18, .49], 'dark', .01);
    }
  }
}

function createBipedLegs(parent) {
  const legs = [];
  for (const side of [-1, 1]) {
    const hip = group(parent, [side * .46, 2.15, -.025]);
    cylinder(hip, [.21, .21, .39], [0, 0, 0], 'steel', [0, 0, Math.PI / 2]);
    box(hip, [.44, .73, .45], [0, -.40, 0], 'dark', .08);
    box(hip, [.49, .63, .40], [0, -.37, .12], 'armor', .085, [.10, 0, 0]);
    box(hip, [.23, .32, .049], [0, -.28, .344], 'pale', .025);
    beam(hip, [side * .19, -.12, -.18], [side * .19, -.81, -.18], .048, 'steel');
    const knee = group(hip, [0, -.89, .01]);
    cylinder(knee, [.205, .205, .53], [0, 0, 0], 'dark', [0, 0, Math.PI / 2]);
    cylinder(knee, [.135, .135, .56], [0, 0, 0], 'steel', [0, 0, Math.PI / 2]);
    box(knee, [.46, .38, .24], [0, .04, .32], 'pale', .071, [.16, 0, 0]);
    box(knee, [.32, .74, .39], [0, -.43, -.02], 'dark', .035);
    box(knee, [.49, .68, .49], [0, -.43, .04], 'armor', .081, [-.08, 0, 0]);
    box(knee, [.16, .38, .055], [side * .12, -.43, .314], 'pale', .021);
    box(knee, [.11, .09, .055], [-side * .115, -.46, .317], 'orange', .009);
    vents(knee, [0, -.67, .299], 3, .30, .063);
    const foot = group(knee, [0, -1.10, .15]);
    box(foot, [.63, .24, 1.02], [0, 0, .12], 'dark', .066);
    box(foot, [.57, .20, .83], [0, .11, .17], 'edge', .051, [.10, 0, 0]);
    box(foot, [.46, .13, .30], [0, .075, .58], 'pale', .030);
    for (const t of [-.17, .17]) box(foot, [.032, .11, .32], [t, .11, .55], 'dark', .004);
    bolts(knee, [[-.16, -.12, .427], [.16, -.12, .427]], .026);
    legs.push({ hip, knee, foot, side, phase: side < 0 ? 0 : Math.PI });
  }
  return legs;
}

function createQuadrupedLegs(parent) {
  const legs = [];
  box(parent, [1.44, .37, 1.64], [0, 1.99, -.10], 'dark', .12);
  for (const side of [-1, 1]) for (const fore of [-1, 1]) {
    const hip = group(parent, [side * .67, 1.76, fore * .62]);
    cylinder(hip, [.22, .22, .32], [0, 0, 0], 'steel', [0, 0, Math.PI / 2]);
    const upper = group(hip);
    upper.rotation.z = side * .38;
    box(upper, [.43, .84, .44], [0, -.39, 0], 'armor', .09, [.10 * fore, 0, 0]);
    box(upper, [.27, .57, .11], [0, -.37, .25], 'pale', .028);
    beam(upper, [side * .19, -.10, -.20], [side * .19, -.71, -.20], .05, 'steel');
    const knee = group(upper, [0, -.83, 0]);
    cylinder(knee, [.21, .21, .47], [0, 0, 0], 'dark', [0, 0, Math.PI / 2]);
    cylinder(knee, [.14, .14, .50], [0, 0, 0], 'steel', [0, 0, Math.PI / 2]);
    knee.rotation.z = side * -.16;
    box(knee, [.36, .70, .37], [0, -.37, -.015], 'dark', .06);
    box(knee, [.47, .65, .42], [0, -.32, .12], 'armor', .069);
    box(knee, [.13, .33, .038], [side * .11, -.32, .353], 'pale', .015);
    box(knee, [.11, .10, .04], [-side * .12, -.33, .351], 'orange', .009);
    const foot = group(knee, [0, -.87, .08]);
    foot.rotation.z = side * -.22;
    box(foot, [.66, .24, .87], [0, 0, .12], 'dark', .06);
    box(foot, [.58, .17, .70], [0, .13, .13], 'edge', .05);
    box(foot, [.44, .14, .26], [0, .13, .43], 'pale', .026);
    legs.push({ hip, knee, foot, side, fore, phase: side * fore < 0 ? 0 : Math.PI, baseKneeZ: side * -.16 });
  }
  return legs;
}

function createThrusters(parent) {
  const flames = [];
  box(parent, [1.03, .81, .52], [0, 3.08, -.6], 'dark', .07);
  for (const side of [-1, 1]) {
    const pod = group(parent, [side * .55, 3.02, -.67]);
    box(pod, [.42, .89, .56], [0, 0, 0], 'edge', .07);
    box(pod, [.34, .47, .045], [0, .13, -.305], 'armor', .023);
    vents(pod, [0, .10, -.334], 4, .26, .078);
    cylinder(pod, [.20, .27, .29], [0, -.53, 0], 'dark', undefined, 12);
    cylinder(pod, [.17, .20, .12], [0, -.71, 0], 'steel', undefined, 12);
    cylinder(pod, [.12, .12, .013], [0, -.778, 0], 'blue', undefined, 12);
    const flame = mesh(pod, new THREE.ConeGeometry(.15, .8, 12), new THREE.MeshBasicMaterial({ color: 0x71daec, transparent: true, opacity: .7, depthWrite: false }), 0, -1.17, 0);
    flame.rotation.z = Math.PI;
    flame.visible = false;
    flames.push(flame);
    const jet = mesh(pod, new THREE.ConeGeometry(.14, 1.2, 12), new THREE.MeshBasicMaterial({ color: 0xffab51, transparent: true, opacity: .78, depthWrite: false }), 0, -.15, -.86);
    jet.rotation.x = -Math.PI / 2;
    jet.visible = false;
    flames.push(jet);
    cylinder(pod, [.16, .20, .21], [0, -.15, -.34], 'steel', [Math.PI / 2, 0, 0]);
    cylinder(pod, [.125, .125, .012], [0, -.15, -.453], 'glow', [Math.PI / 2, 0, 0]);
  }
  return flames;
}

function createGun(parent) {
  // The origin is the actual muzzle. The entire assembly extends backwards.
  // Keeping this anchor fixed removes the circular aim/muzzle dependency.
  const mount = group(parent, [1.35, 3.1, 1.4]);
  mount.name = 'muzzle';
  const gun = group(mount);
  box(gun, [.38, .41, .89], [0, 0, -.82], 'dark', .043);
  box(gun, [.36, .26, .72], [0, .11, -.87], 'armor', .047);
  box(gun, [.19, .12, .32], [0, .28, -.79], 'dark', .014);
  box(gun, [.04, .035, .05], [0, .315, -.6], 'glow', .004);
  box(gun, [.28, .39, .24], [.13, -.24, -.9], 'edge', .028, [.10, 0, -.15]);
  for (let i = 0; i < 5; i++) box(gun, [.065, .075, .043], [.211, -.08, -.70 - i * .09], 'steel', .008);
  cylinder(gun, [.127, .127, .67], [0, -.01, -.38], 'steel', [Math.PI / 2, 0, 0]);
  cylinder(gun, [.17, .17, .14], [0, -.01, -.10], 'dark', [Math.PI / 2, 0, 0]);
  cylinder(gun, [.105, .105, .016], [0, 0, -.001], 'rubber', [Math.PI / 2, 0, 0]);
  ring(gun, .111, .021, [0, 0, 0], 'orange');
  for (const offset of [-.1, .1]) cylinder(gun, [.025, .025, .59], [offset, .06, -.37], 'dark', [Math.PI / 2, 0, 0], 8);
  box(gun, [.39, .036, .095], [0, .226, -.64], 'orange', .005);
  mount.userData.weapon = 'machinegun';
  const beamWeapon = group(mount);
  beamWeapon.visible = false;
  box(beamWeapon, [.44, .33, 1.12], [0, .015, -.59], 'pale', .068);
  box(beamWeapon, [.34, .23, .47], [0, .01, -.26], 'dark', .035);
  ring(beamWeapon, .115, .031, [0, 0, 0], 'blue');
  for (const side of [-1, 1]) box(beamWeapon, [.028, .08, .67], [side * .234, .01, -.65], 'blue', .008);
  const missileWeapon = group(mount);
  missileWeapon.visible = false;
  cylinder(missileWeapon, [.28, .28, 1.25], [0, 0, -.6], 'edge', [Math.PI / 2, 0, 0]);
  cylinder(missileWeapon, [.20, .20, .022], [0, 0, -.005], 'rubber', [Math.PI / 2, 0, 0]);
  ring(missileWeapon, .252, .036, [0, 0, 0], 'pale');
  box(missileWeapon, [.12, .12, .54], [0, .32, -.72], 'dark', .026);
  box(missileWeapon, [.3, .13, .21], [0, -.31, -.82], 'dark', .023);
  mount.userData.variants = { machinegun: gun, beam: beamWeapon, missile: missileWeapon };
  return mount;
}

export function createKoalaMech(legs = 'biped') {
  const mech = new THREE.Group();
  mech.name = `AK2-${legs}`;
  createTorso(mech);
  createHead(mech);
  createArms(mech);
  const legParts = legs === 'quadruped' ? createQuadrupedLegs(mech) : createBipedLegs(mech);
  const flames = createThrusters(mech);
  const gun = createGun(mech);
  // A short sensor mast and routed hydraulic lines add an asymmetric silhouette.
  cylinder(mech, [.014, .028, .76], [-.71, 3.83, -.53], 'steel', [0, 0, -.11], 8);
  sphere(mech, [.045, .05, .045], [-.751, 4.218, -.53], 'orange');
  mech.userData = { legs, legParts, flames, gun, muzzle: gun, baseY: 0 };
  return mech;
}

const localDirection = new THREE.Vector3();
const forward = new THREE.Vector3(0, 0, 1);
const up = new THREE.Vector3(0, 1, 0);
export function animateMech(mech, { time = 0, speed = 0, glide = false, flying = false, quickboost = false, yaw = 0, aimDirection, weapon = 'machinegun' } = {}) {
  const data = mech.userData;
  if (!data.legParts) return;
  const moving = Math.min(Math.abs(speed) / 9, 1);
  const airborne = Boolean(flying);
  for (const leg of data.legParts) {
    const phase = time * (5.8 + Math.min(speed, 12) * .25) + leg.phase;
    const stride = Math.sin(phase) * moving;
    leg.hip.rotation.x = airborne ? -.18 : glide || quickboost ? -.12 : stride * .38;
    leg.knee.rotation.x = airborne ? .43 : glide || quickboost ? .21 : Math.max(0, -stride) * .46;
    leg.foot.rotation.x = -leg.hip.rotation.x * .30 - leg.knee.rotation.x * .35;
  }
  data.flames.forEach((flame, i) => {
    const down = i % 2 === 0;
    flame.visible = down ? airborne : Boolean(quickboost || glide);
    flame.scale.y = (quickboost ? 2.1 : airborne ? 1.1 : .26) * (1 + .16 * Math.sin(time * 57 + i));
  });
  if (aimDirection?.isVector3 && aimDirection.lengthSq() > .01) {
    localDirection.copy(aimDirection).applyAxisAngle(up, -yaw).normalize();
    data.gun.quaternion.setFromUnitVectors(forward, localDirection);
  } else data.gun.quaternion.identity();
  for (const [key, variant] of Object.entries(data.gun.userData.variants)) variant.visible = key === weapon;
}

export function createEnemyModel(kind = 'guard', isControl = false) {
  const enemy = new THREE.Group();
  enemy.name = isControl ? 'barrier-control-turret' : kind;
  const armor = isControl ? 'orange' : 'enemy';
  const light = isControl ? 'glow' : 'warning';
  if (kind === 'guard') {
    enemy.userData.legs = [];
    for (const side of [-1, 1]) {
      const leg = group(enemy, [side * .48, -.55, 0]);
      box(leg, [.42, 1.1, .46], [0, -.53, 0], 'dark', .07);
      box(leg, [.49, .66, .48], [0, -.67, .07], armor, .07);
      box(leg, [.62, .28, .80], [0, -1.30, .13], 'dark', .05);
      cylinder(leg, [.21, .21, .54], [0, -.05, 0], 'steel', [0, 0, Math.PI / 2]);
      enemy.userData.legs.push(leg);
      box(enemy, [.53, .54, .65], [side * .89, .44, -.04], armor, .06);
      box(enemy, [.28, .64, .35], [side * .96, -.07, .02], 'dark', .06);
    }
    box(enemy, [1.20, 1.07, .68], [0, .10, 0], armor, .12);
    box(enemy, [.74, .38, .12], [0, .24, .39], 'enemyPale', .04);
    vents(enemy, [0, -.25, .364], 4, .73, .085);
    box(enemy, [.71, .49, .66], [0, .91, 0], 'dark', .08);
    box(enemy, [.73, .16, .075], [0, .96, .37], 'rubber', .014);
    box(enemy, [.43, .048, .03], [0, .97, .42], light, .007);
    box(enemy, [.39, .39, .61], [0, .45, .77], 'dark', .04);
    cylinder(enemy, [.13, .13, .88], [0, .45, 1.33], 'steel', [Math.PI / 2, 0, 0]);
    ring(enemy, .14, .028, [0, .45, 1.80], light);
  } else {
    cylinder(enemy, [1.20, 1.44, .35], [0, -1.82, 0], 'dark', undefined, 8);
    for (const x of [-1, 1]) for (const z of [-1, 1]) {
      beam(enemy, [x * .65, -1.02, z * .45], [x * 1.31, -1.81, z * .88], .12, 'steel');
      box(enemy, [.34, .18, .41], [x * 1.30, -1.88, z * .88], 'enemyPale', .035);
    }
    cylinder(enemy, [.56, .65, .91], [0, -1.13, 0], armor, undefined, 12);
    cylinder(enemy, [.76, .76, .19], [0, -.60, 0], 'steel', undefined, 12);
    box(enemy, [1.51, 1.16, 1.15], [0, .01, 0], armor, .14);
    box(enemy, [1.25, .27, .98], [0, .69, -.10], 'enemyPale', .045);
    box(enemy, [.75, .18, .13], [0, .42, .62], 'dark', .02);
    box(enemy, [.44, .065, .03], [0, .44, .70], light, .008);
    cylinder(enemy, [.20, .20, 1.20], [0, .45, 1.46], 'steel', [Math.PI / 2, 0, 0]);
    cylinder(enemy, [.28, .28, .32], [0, .45, .95], 'dark', [Math.PI / 2, 0, 0]);
    ring(enemy, .206, .03, [0, .45, 2.1], light);
    for (const side of [-1, 1]) {
      box(enemy, [.28, .65, .85], [side * .88, .12, -.10], 'dark', .04);
      vents(enemy, [side * .88, -.1, .35], 5, .21, .095);
    }
    if (isControl) {
      cylinder(enemy, [.045, .045, 1.2], [.75, 1.05, -.30], 'steel', undefined, 8);
      sphere(enemy, [.14, .14, .14], [.75, 1.69, -.30], 'glow');
      const beacon = ring(enemy, .42, .025, [0, 1.28, 0], 'glow', [Math.PI / 2, 0, 0]);
      enemy.userData.beacon = beacon;
      box(enemy, [.51, .29, .03], [0, -.26, .588], 'dark', .02);
      box(enemy, [.27, .043, .02], [0, -.27, .612], 'glow', .004);
    }
  }
  const chargeMaterial = materials[light].clone();
  chargeMaterial.userData.shared = false;
  chargeMaterial.emissiveIntensity = .4;
  enemy.traverse(child => {
    if (child.material === materials[light]) {
      child.material = chargeMaterial;
      child.userData.telegraph = true;
    }
  });
  return enemy;
}
