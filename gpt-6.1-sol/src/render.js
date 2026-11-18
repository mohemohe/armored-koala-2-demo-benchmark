import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const V = (a) => new THREE.Vector3(...a);
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const TEMP = new THREE.Vector3();
const COLORS = { dark: 0x182527, shell: 0x576c69, edge: 0x819b92, mint: 0xb1eed2, orange: 0xf2ac4e, steel: 0x9da9a5, black: 0x121919, red: 0xeb6557 };

// This endpoint is shared by the simulation and the visible barrel. A ballistic
// correction changes the barrel's orientation, never the source of the shot.
export function muzzlePosition(position, yaw = 0) {
  const p = Array.isArray(position) ? position : position.position;
  return [p[0] + Math.cos(yaw) * 1.3 - Math.sin(yaw) * 1.4, p[1] + 1, p[2] + Math.sin(yaw) * 1.3 + Math.cos(yaw) * 1.4];
}

function material(color, metalness = .65, roughness = .48, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
}
function mesh(geometry, mat, parent, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const m = new THREE.Mesh(geometry, mat);
  m.position.set(...position); m.rotation.set(...rotation);
  m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
function box(parent, mat, size, position, rotation) { return mesh(new THREE.BoxGeometry(...size), mat, parent, position, rotation); }
function sphere(parent, mat, radius, position, scale = [1, 1, 1]) { const m = mesh(new THREE.SphereGeometry(radius, 28, 20), mat, parent, position); m.scale.set(...scale); return m; }
function cylinder(parent, mat, radius, length, position, axis = 'y', radius2 = radius, sides = 20) {
  const m = mesh(new THREE.CylinderGeometry(radius, radius2, length, sides), mat, parent, position);
  if (axis === 'x') m.rotation.z = -Math.PI / 2;
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  return m;
}
function torus(parent, mat, radius, tube, position, axis = 'x') {
  const m = mesh(new THREE.TorusGeometry(radius, tube, 10, 64), mat, parent, position);
  if (axis === 'x') m.rotation.y = Math.PI / 2;
  if (axis === 'y') m.rotation.x = Math.PI / 2;
  return m;
}
function beamBetween(parent, a, b, width, mat) {
  const av = V(a), bv = V(b), delta = bv.clone().sub(av);
  const m = cylinder(parent, mat, width, delta.length(), av.clone().add(bv).multiplyScalar(.5).toArray());
  m.quaternion.setFromUnitVectors(Y, delta.normalize()); return m;
}
function labelTexture(text, fg = '#d4e3da', bg = 'rgba(0,0,0,0)', width = 512, height = 128) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = fg; ctx.font = `700 ${height * .52}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}
function decal(parent, text, position, size, orientation = 'front', color) {
  const mat = new THREE.MeshBasicMaterial({ map: labelTexture(text, color), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
  const m = mesh(new THREE.PlaneGeometry(...size), mat, parent, position);
  if (orientation === 'front') m.rotation.y = Math.PI / 2;
  if (orientation === 'floor') m.rotation.x = -Math.PI / 2;
  return m;
}
function bevelGeometry(w, h, d, bevel = .08) {
  const shape = new THREE.Shape(); const b = Math.min(bevel, w / 4, h / 4);
  shape.moveTo(-w / 2 + b, -h / 2); shape.lineTo(w / 2 - b, -h / 2); shape.lineTo(w / 2, -h / 2 + b);
  shape.lineTo(w / 2, h / 2 - b); shape.lineTo(w / 2 - b, h / 2); shape.lineTo(-w / 2 + b, h / 2);
  shape.lineTo(-w / 2, h / 2 - b); shape.lineTo(-w / 2, -h / 2 + b); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: d - b * 2, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: b * .45, bevelThickness: b });
  g.translate(0, 0, -d / 2 + b); return g;
}
function plate(parent, mat, size, position, rotation = [0, 0, 0]) { return mesh(bevelGeometry(...size), mat, parent, position, rotation); }

function buildKoala(loadout, mats) {
  const group = new THREE.Group();
  const { shell, dark, edge, mint, steel, black, orange, rubber, eye } = mats;
  // The exposed actuator frame remains visible between the armor panels.
  box(group, dark, [.87, 1.6, .95], [-.2, .28, 0]);
  plate(group, shell, [1.34, 1.3, 1.62], [0, .63, 0]);
  plate(group, edge, [.16, .95, 1.32], [.77, .67, 0]);
  plate(group, dark, [.17, .46, .7], [.88, .72, 0]);
  box(group, mint, [.025, .055, .61], [.98, .97, 0]);
  box(group, mint, [.03, .08, .22], [.98, .57, -.38]);
  box(group, mint, [.03, .08, .22], [.98, .57, .38]);
  decal(group, 'AK / 02', [.978, .75, 0], [.54, .2]);
  plate(group, shell, [.65, .4, .85], [.16, -.24, 0]);
  cylinder(group, steel, .26, .72, [0, 1.39, 0]);
  torus(group, dark, .29, .06, [0, 1.5, 0], 'y');

  // Real rounded koala head: separate ears, inset dishes, eyes and black nose.
  const head = new THREE.Group(); group.add(head); head.position.set(.02, 2.01, 0);
  sphere(head, steel, .79, [0, .04, 0], [.98, 1.04, 1.0]);
  sphere(head, edge, .78, [-.09, .03, 0], [.91, 1.02, 1.02]);
  sphere(head, steel, .7, [.16, .075, 0], [.98, .99, .97]);
  for (const side of [-1, 1]) {
    sphere(head, shell, .54, [-.05, .35, side * .93], [.46, 1, 1]);
    torus(head, steel, .415, .085, [.22, .35, side * .93]);
    sphere(head, rubber, .37, [.26, .35, side * .93], [.12, .96, .96]);
    torus(head, edge, .305, .022, [.316, .35, side * .93]);
    for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3;
      cylinder(head, dark, .028, .025, [.335, .35 + Math.cos(angle) * .412, side * .93 + Math.sin(angle) * .412], 'x', .028, 6);
    }
    sphere(head, black, .145, [.70, .20, side * .345], [.37, .80, 1]);
    sphere(head, eye, .032, [.765, .213, side * .345], [.38, .62, 1]);
    plate(head, dark, [.14, .075, .30], [.67, .38, side * .36], [0, 0, side * .1]);
    // Engraved segmented cheeks catch the light without hiding the face.
    box(head, dark, [.025, .018, .22], [.61, -.23, side * .40], [0, side * .5, 0]);
    box(head, dark, [.025, .018, .16], [.60, -.29, side * .36], [0, side * .5, 0]);
  }
  sphere(head, black, .36, [.755, -.05, 0], [.63, 1.27, .83]);
  sphere(head, black, .16, [.875, -.20, 0], [.61, .66, 1.18]);
  box(head, dark, [.036, .05, .20], [.677, -.50, 0]);
  plate(head, shell, [.17, .19, .6], [.19, -.67, 0]);
  box(head, mint, [.06, .025, .31], [.285, -.73, 0]);
  decal(head, 'K-02', [-.02, .63, -.48], [.21, .09], 'front', '#202e2b');

  const arms = [];
  for (const side of [-1, 1]) {
    cylinder(group, dark, .31, .58, [-.05, .82, side * 1.0], 'z');
    torus(group, steel, .27, .057, [-.05, .82, side * 1.28], 'z');
    plate(group, shell, [.91, .68, .72], [-.1, 1.05, side * 1.06]);
    plate(group, edge, [.11, .37, .5], [.4, 1.05, side * 1.06]);
    box(group, mint, [.025, .045, .39], [.467, 1.18, side * 1.06]);
    decal(group, side < 0 ? '02' : 'AK', [.469, .98, side * 1.06], [.26, .20]);
    const arm = new THREE.Group(); group.add(arm); arm.position.set(.0, .55, side * 1.17); arms.push(arm);
    if (side === 1) {
      // Independent shoulder and elbow pivots let the hand hold the actual
      // cannon grip while its barrel follows the current shooting direction.
      const upper = new THREE.Group(), lower = new THREE.Group(); arm.add(upper, lower);
      cylinder(upper, steel, .16, .44, [0, 0, 0], 'z');
      box(upper, dark, [.23, .70, .25], [0, -.35, 0]);
      plate(upper, shell, [.48, .59, .45], [.02, -.33, 0]);
      beamBetween(upper, [-.19, -.10, .21], [-.19, -.72, .21], .039, steel);
      cylinder(lower, steel, .16, .46, [0, 0, 0], 'z');
      box(lower, dark, [.27, .70, .27], [0, -.35, 0]);
      plate(lower, shell, [.49, .60, .45], [.025, -.39, 0]);
      box(lower, orange, [.034, .12, .26], [.276, -.38, 0]);
      box(lower, dark, [.35, .22, .35], [0, -.85, 0]);
      arm.userData.ik = { upper, lower };
      continue;
    }
    box(arm, dark, [.27, .70, .31], [0, -.26, 0]);
    plate(arm, shell, [.47, .62, .46], [.07, -.31, 0]);
    cylinder(arm, steel, .17, .48, [.08, -.65, 0], 'z');
    plate(arm, shell, [.53, .7, .46], [.20, -.94, 0], [0, 0, -.26]);
    box(arm, dark, [.40, .30, .40], [.32, -1.31, 0]);
    beamBetween(arm, [-.18, -.24, side * .21], [-.15, -.90, side * .20], .043, steel);
    cylinder(arm, dark, .075, .36, [-.17, -.28, side * .21]);
    box(arm, orange, [.07, .13, .28], [.49, -.9, 0]);
  }

  // Three carried weapons are visible, including the inactive energy carbine.
  box(group, dark, [.50, 1.25, .32], [-.52, .55, -1.16]);
  box(group, edge, [.48, .16, .39], [-.50, 1.27, -1.16]);
  for (let i = 0; i < 3; i++) cylinder(group, black, .08, .22, [-.50, 1.38, -1.29 + i * .13]);
  box(group, mint, [.025, .43, .14], [-.239, .50, -1.16]);
  box(group, dark, [.43, 1.39, .75], [-.91, .62, 0]);
  for (const side of [-1, 1]) {
    cylinder(group, shell, .23, .72, [-1.07, .41, side * .50], 'x');
    cylinder(group, dark, .17, .06, [-1.45, .41, side * .50], 'x');
    torus(group, edge, .165, .04, [-1.49, .41, side * .5]);
    const flame = mesh(new THREE.ConeGeometry(.14, .8, 16), mats.flame, group, [-1.83, .41, side * .5], [0, 0, -Math.PI / 2]);
    flame.visible = false; flame.name = 'thruster'; flame.userData.kind = 'horizontal';
    cylinder(group, dark, .19, .28, [-1.07, .0, side * .5]);
    torus(group, edge, .17, .034, [-1.07, -.16, side * .5], 'y');
    const verticalFlame = mesh(new THREE.ConeGeometry(.17, 1.3, 16), mats.flame, group, [-1.07, -.81, side * .5], [0, 0, Math.PI]);
    verticalFlame.visible = false; verticalFlame.name = 'thruster'; verticalFlame.userData.kind = 'vertical';
  }
  const legPivots = [];
  if (loadout.legs === 'quadruped') {
    plate(group, shell, [1.80, .48, 1.70], [-.10, -.48, 0]);
    for (const x of [-.65, .65]) for (const side of [-1, 1]) {
      const leg = new THREE.Group(); group.add(leg); leg.position.set(x, -.53, side * .66);
      cylinder(leg, dark, .20, .46, [0, 0, 0], 'z');
      beamBetween(leg, [0, -.1, 0], [x * .36, -.76, side * .37], .13, dark);
      plate(leg, shell, [.54, .71, .44], [x * .18, -.38, side * .18], [x * .12, 0, x * .21]);
      cylinder(leg, steel, .17, .41, [x * .36, -.76, side * .37], 'z');
      plate(leg, shell, [.41, .72, .40], [x * .30, -1.13, side * .40]);
      box(leg, mint, [.025, .27, .11], [x * .30 + .22, -1.12, side * .40]);
      plate(leg, dark, [.86, .23, .54], [x * .31 + .10, -1.46, side * .40]);
      plate(leg, edge, [.72, .08, .45], [x * .31 + .10, -1.32, side * .40]);
      legPivots.push(leg);
    }
  } else {
    for (const side of [-1, 1]) {
      const leg = new THREE.Group(); group.add(leg); leg.position.set(-.02, -.42, side * .45);
      cylinder(leg, dark, .22, .48, [0, 0, 0], 'z');
      box(leg, dark, [.30, .67, .30], [-.1, -.41, 0]);
      plate(leg, shell, [.57, .68, .55], [.00, -.38, 0]);
      cylinder(leg, steel, .18, .58, [.04, -.77, 0], 'z');
      plate(leg, shell, [.51, .82, .52], [-.08, -1.16, 0], [0, 0, -.09]);
      plate(leg, edge, [.08, .5, .39], [.203, -1.15, 0]);
      box(leg, mint, [.012, .27, .10], [.254, -1.14, 0]);
      beamBetween(leg, [-.29, -.65, side * .25], [-.32, -1.42, side * .25], .04, steel);
      plate(leg, dark, [1.02, .28, .60], [.23, -1.53, 0]);
      plate(leg, shell, [.94, .14, .54], [.24, -1.34, 0]);
      box(leg, orange, [.025, .07, .22], [.715, -1.48, 0]);
      legPivots.push(leg);
    }
  }
  group.userData = { legPivots, arms, head, thrusters: [] };
  group.traverse((m) => { if (m.name === 'thruster') group.userData.thrusters.push(m); });
  return group;
}

function buildWeapon(kind, mats) {
  const g = new THREE.Group();
  const { dark, edge, shell, steel, orange, mint } = mats;
  if (kind === 'beam') {
    plate(g, dark, [1.42, .42, .43], [-1.06, 0, 0]);
    plate(g, shell, [.54, .50, .55], [-1.71, 0, 0]);
    for (let i = 0; i < 4; i++) {
      box(g, mint, [.09, .43, .025], [-1.22 + i * .17, 0, .23]);
      box(g, mint, [.09, .43, .025], [-1.22 + i * .17, 0, -.23]);
    }
    cylinder(g, edge, .16, .55, [-.27, 0, 0], 'x');
    cylinder(g, mats.beam, .085, .025, [-.01, 0, 0], 'x');
  } else if (kind === 'missile') {
    plate(g, shell, [1.43, .55, .72], [-1.11, 0, 0]);
    plate(g, dark, [.27, .64, .84], [-.41, 0, 0]);
    for (const y of [-.17, .17]) for (const z of [-.20, .20]) {
      cylinder(g, steel, .145, .58, [-.28, y, z], 'x');
      cylinder(g, dark, .106, .018, [.004, y, z], 'x');
      cylinder(g, orange, .055, .02, [.014, y, z], 'x');
    }
    decal(g, 'M / 12', [-1.15, .289, 0], [.55, .14], 'floor', '#e6ad5d');
  } else {
    plate(g, dark, [1.27, .42, .41], [-1.22, -.03, 0]);
    plate(g, shell, [.53, .48, .48], [-1.82, -.02, 0]);
    box(g, steel, [.71, .19, .33], [-1.14, .20, 0]);
    cylinder(g, dark, .112, 1.1, [-.56, 0, 0], 'x');
    for (let i = 0; i < 5; i++) torus(g, edge, .131, .027, [-.37 - i * .14, 0, 0]);
    cylinder(g, steel, .14, .21, [-.11, 0, 0], 'x');
    cylinder(g, dark, .092, .015, [.003, 0, 0], 'x');
    box(g, orange, [.39, .04, .06], [-1.12, .32, 0]);
    plate(g, shell, [.38, .68, .26], [-1.10, -.41, 0], [0, 0, .17]);
  }
  box(g, dark, [.28, .42, .24], [-1.55, -.34, 0], [0, 0, -.2]);
  return g;
}

function buildEnemy(enemy, mats) {
  const g = new THREE.Group(); const s = mats.enemyShell, d = mats.dark, steel = mats.steel;
  const accent = (enemy.isGateControl ? mats.orangeGlow : mats.enemyGlow).clone();
  if (enemy.kind === 'turret') {
    cylinder(g, d, 1.23, .31, [0, -1.7, 0], 'y', 1.45, 12);
    cylinder(g, s, .92, 1.02, [0, -1.08, 0], 'y', 1.14, 12);
    torus(g, steel, .91, .08, [0, -.52, 0], 'y');
    plate(g, s, [1.86, .87, 1.58], [0, -.11, 0]);
    cylinder(g, d, .21, 1.55, [1.01, .40, 0], 'x');
    cylinder(g, steel, .26, .35, [1.62, .40, 0], 'x');
    cylinder(g, accent, .145, .025, [1.7875, .40, 0], 'x');
    for (const z of [-.55, .55]) box(g, steel, [.78, .16, .18], [.54, .4, z]);
    box(g, accent, [.025, .09, 1.20], [.947, -.17, 0]);
    if (enemy.isGateControl) {
      torus(g, mats.orangeGlow, 1.57, .055, [0, -1.92, 0], 'y');
      const antenna = box(g, steel, [.075, .95, .075], [-.50, .75, -.46]);
      sphere(g, mats.orangeGlow, .13, [-.50, 1.25, -.46]);
      decal(g, 'GATE CTRL', [.96, -.04, 0], [.99, .20]);
    }
  } else {
    plate(g, s, [1.01, .96, .89], [0, .07, 0]);
    plate(g, d, [.20, .53, .67], [.60, .14, 0]);
    box(g, accent, [.025, .095, .62], [.71, .31, 0]);
    sphere(g, s, .43, [0, .94, 0], [1, .79, 1]);
    box(g, accent, [.045, .09, .53], [.41, .97, 0]);
    for (const side of [-1, 1]) {
      cylinder(g, d, .17, .43, [0, .2, side * .68], 'z');
      plate(g, s, [.45, .55, .47], [0, .20, side * .70]);
      box(g, d, [.25, .77, .23], [.12, -.45, side * .68]);
      plate(g, s, [.44, .52, .36], [.15, -.73, side * .68]);
      const leg = new THREE.Group(); g.add(leg); leg.position.set(0, -.50, side * .3); leg.name = 'leg';
      plate(leg, s, [.39, .58, .41], [0, -.3, 0]);
      cylinder(leg, steel, .13, .40, [.02, -.65, 0], 'z');
      plate(leg, d, [.34, .78, .35], [-.06, -1.03, 0]);
      plate(leg, s, [.63, .2, .45], [.12, -1.46, 0]);
    }
    plate(g, d, [.5, .35, .46], [.50, .25, 0]);
    cylinder(g, d, .115, .69, [.89, .25, 0], 'x');
    cylinder(g, accent, .085, .03, [1.235, .25, 0], 'x');
  }
  g.userData.warningMaterial = accent;
  g.userData.warning = new THREE.PointLight(0xff8550, 0, 7, 2); g.userData.warning.position.set(enemy.kind === 'turret' ? 1.8 : 1.25, enemy.kind === 'turret' ? .4 : .25, 0); g.add(g.userData.warning);
  return g;
}

function floorTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#515b58'; ctx.fillRect(0, 0, 512, 512);
  let s = 17; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 7000; i++) { const g = Math.round(60 + rnd() * 60); ctx.fillStyle = `rgba(${g},${g},${g},.09)`; ctx.fillRect(rnd() * 512, rnd() * 512, rnd() * 3 + 1, rnd() * 3 + 1); }
  ctx.strokeStyle = 'rgba(10,18,18,.25)'; ctx.lineWidth = 3;
  for (let i = 0; i < 512; i += 128) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(172,192,183,.13)'; ctx.lineWidth = 1; ctx.strokeRect(2, 2, 506, 506);
  const t = new THREE.CanvasTexture(canvas); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}

function hazardMaterial(width = 8) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#bd8b45'; ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#25302b';
  for (let x = -64; x < 320; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 32, 0); ctx.lineTo(x - 32, 64); ctx.lineTo(x - 64, 64); ctx.closePath(); ctx.fill(); }
  const map = new THREE.CanvasTexture(canvas); map.wrapS = THREE.RepeatWrapping; map.repeat.x = Math.max(1, width / 4); map.colorSpace = THREE.SRGBColorSpace;
  return material(0xffffff, .35, .71, { map });
}

function rayBox(origin, delta, min, max) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(delta[i]) < 1e-8) { if (origin[i] < min[i] || origin[i] > max[i]) return null; }
    else { const a = (min[i] - origin[i]) / delta[i], b = (max[i] - origin[i]) / delta[i]; lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b)); if (lo > hi) return null; }
  }
  return lo;
}

export class GameRenderer {
  constructor(canvas, stage) {
    this.canvas = canvas; this.stage = stage; this.width = canvas.clientWidth || innerWidth; this.height = canvas.clientHeight || innerHeight;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setSize(this.width, this.height, false); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.13;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x102025); this.scene.fog = new THREE.FogExp2(0x152b31, .0048);
    this.camera = new THREE.PerspectiveCamera(60, this.width / this.height, .1, 650);
    this.mats = {
      dark: material(COLORS.dark, .78, .43), shell: material(COLORS.shell, .69, .40), edge: material(COLORS.edge, .74, .33), mint: material(COLORS.mint, .35, .32, { emissive: 0x619c80, emissiveIntensity: .43 }),
      steel: material(COLORS.steel, .87, .37), black: material(COLORS.black, .27, .23), rubber: material(0x414b45, .1, .91), orange: material(COLORS.orange, .36, .55), eye: material(0xffc071, .1, .25, { emissive: 0xffa42b, emissiveIntensity: 1.1 }),
      floor: material(0x526663, .35, .83), wall: material(0x445858, .42, .74), roof: material(0x293b3c, .49, .72), machine: material(0x4e6763, .70, .51), cover: material(0x6e8175, .55, .63), pillar: material(0x485e5d, .67, .51), barrier: material(0x4c5857, .70, .59),
      enemyShell: material(0x766e63, .68, .49), enemyGlow: material(0xff785d, .1, .2, { emissive: 0xff4228, emissiveIntensity: 1.5 }), orangeGlow: material(0xfac070, .2, .3, { emissive: 0xff922e, emissiveIntensity: 1.1 }),
      beam: new THREE.MeshBasicMaterial({ color: 0xacffe6, transparent: true, opacity: .88, depthWrite: false }), flame: new THREE.MeshBasicMaterial({ color: 0x9bffe9, transparent: true, opacity: .8, depthWrite: false }), shot: new THREE.MeshBasicMaterial({ color: 0xffecb6 }), enemyShot: new THREE.MeshBasicMaterial({ color: 0xff8359 }),
    };
    this.world = new THREE.Group(); this.scene.add(this.world); this.garage = new THREE.Group(); this.scene.add(this.garage);
    this.hemi = new THREE.HemisphereLight(0xb5d5d2, 0x233332, 2.0); this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffefce, 3.25); this.key.position.set(20, 45, 20); this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048); this.key.shadow.camera.left = -55; this.key.shadow.camera.right = 55; this.key.shadow.camera.top = 55; this.key.shadow.camera.bottom = -55; this.key.shadow.camera.near = 1; this.key.shadow.camera.far = 145; this.key.shadow.bias = -.0004; this.key.shadow.normalBias = .14;
    this.scene.add(this.key, this.key.target);
    this.fill = new THREE.DirectionalLight(0x87c2c5, 1.8); this.fill.position.set(-12, 12, -15); this.scene.add(this.fill);
    this.rim = new THREE.PointLight(0x8ddcb8, 60, 28, 2); this.rim.position.set(-6, 8, -4); this.garage.add(this.rim);
    this.warm = new THREE.PointLight(0xffb05b, 65, 25, 2); this.warm.position.set(2, 6, 6); this.garage.add(this.warm);
    this.sectorGroups = []; this.barrierMeshes = new Map(); this.enemyMeshes = new Map(); this.projectileMeshes = new Map(); this.effectMeshes = new Map();
    this.loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' }; this.setLoadout(this.loadout);
    this.buildHangar(); this.buildStage(); this.time = 0; this.garageTime = 0; this.lastState = '';
  }

  setLoadout(loadout) {
    this.loadout = { ...loadout }; if (this.playerMesh) this.removeObject(this.playerMesh);
    this.playerMesh = buildKoala(loadout, this.mats); this.scene.add(this.playerMesh);
    if (this.weaponMesh) this.removeObject(this.weaponMesh); this.weaponKind = 'machinegun'; this.weaponMesh = buildWeapon(this.weaponKind, this.mats); this.scene.add(this.weaponMesh);
  }

  removeObject(object) {
    this.scene.remove(object);
    const shared = new Set(Object.values(this.mats));
    const disposedMaterials = new Set(), disposedTextures = new Set();
    object.traverse(m => {
      if (!m.isMesh) return;
      m.geometry.dispose();
      const materials = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of materials) if (!shared.has(mat) && !disposedMaterials.has(mat)) {
        if (mat.map && !disposedTextures.has(mat.map)) { mat.map.dispose(); disposedTextures.add(mat.map); }
        mat.dispose(); disposedMaterials.add(mat);
      }
    });
  }

  buildHangar() {
    const g = this.garage, m = this.mats;
    const ft = floorTexture(); ft.repeat.set(12, 12); const deck = m.floor.clone(); deck.map = ft; deck.color.set(0x273633);
    box(g, deck, [52, .35, 46], [0, -.35, 0]);
    cylinder(g, m.dark, 4.38, .16, [0, -.045, 0], 'y', 4.5, 96);
    cylinder(g, material(0x40524e, .68, .64), 4.15, .06, [0, .055, 0], 'y', 4.15, 96);
    torus(g, m.edge, 4.30, .026, [0, .056, 0], 'y'); torus(g, m.mint, 4.10, .016, [0, .09, 0], 'y'); torus(g, m.dark, 3.76, .016, [0, .09, 0], 'y');
    for (let i = 0; i < 52; i++) {
      const a = i / 52 * Math.PI * 2;
      box(g, i % 4 === 0 ? m.orange : m.dark, [.035, .014, i % 4 === 0 ? .34 : .16], [Math.cos(a) * 4.34, .051, Math.sin(a) * 4.34], [0, -a + Math.PI / 2, 0]);
    }
    decal(g, 'AK2   /   ASSEMBLY BAY 04', [2.6, .10, 2.0], [3.8, .40], 'floor', '#879e91');
    for (const z of [-9, 9]) {
      box(g, m.dark, [.35, 13, .6], [-8, 6, z]); box(g, m.dark, [.35, 13, .6], [-16, 6, z]);
      box(g, m.dark, [12, .3, .45], [-12, 9, z]); box(g, m.dark, [12, .3, .45], [-12, 12, z]);
      for (const x of [-8, -12, -16]) {
        beamBetween(g, [x - 3, 1, z], [x + 3, 9, z], .11, m.pillar);
        cylinder(g, m.steel, .15, 11, [x, 6, z - Math.sign(z) * .7]);
      }
    }
    box(g, m.roof, [1, 14, 27], [-18, 6.7, 0]);
    for (let z = -12; z <= 12; z += 3) {
      box(g, m.dark, [.15, 13, .12], [-17.40, 6.3, z]);
      box(g, m.pillar, [.16, .12, 2.6], [-17.38, 4.5, z]);
    }
    const door = box(g, material(0x334640, .61, .62), [.12, 7.0, 7.2], [-17.30, 3.8, -.1]);
    for (let y = .4; y <= 7; y += .45) box(g, m.dark, [.03, .025, 7.1], [-17.21, y, -.1]);
    decal(g, '04', [-17.20, 5.1, -.1], [3.4, 2.25], 'front', '#9aaca0');
    decal(g, 'SERVICE / LOCKDOWN', [-17.18, 2.2, -.1], [4.5, .30], 'front', '#b3beaf');
    for (const z of [-4.1, 4.1]) {
      box(g, m.dark, [.22, 7.5, .28], [-17.0, 3.8, z]);
      box(g, m.mint, [.025, 1.5, .035], [-16.87, 5.2, z]);
    }
    for (const z of [-5, 5]) {
      cylinder(g, m.dark, .43, 2.8, [-6.3, 1.3, z], 'y');
      torus(g, m.edge, .43, .042, [-6.3, 2.6, z], 'y');
      box(g, m.dark, [3.2, .30, 1.6], [-8.2, 2.0, z]);
      box(g, m.cover, [2.3, 1.8, 1.3], [-11, .85, z]);
      box(g, m.mint, [.032, .035, .73], [-9.83, 1.27, z]);
    }
    for (let i = 0; i < 5; i++) {
      box(g, m.dark, [.16, .18, 28], [-15 + i * 4, 10.0, 0]);
      box(g, m.mint, [.04, .025, 3.3], [-15 + i * 4, 9.88, -3.8]);
    }
    const positions = [];
    let s = 42; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 130; i++) positions.push((rnd() - .5) * 34, rnd() * 11, (rnd() - .5) * 25);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.dust = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xa0c1b2, size: .025, transparent: true, opacity: .30, depthWrite: false })); g.add(this.dust);
  }

  buildStage() {
    const m = this.mats;
    for (const sector of this.stage.sectors || []) {
      const group = new THREE.Group(); this.world.add(group); this.sectorGroups.push({ group, sector });
      const boxes = (this.stage.boxes || []).filter(b => b.sectorId === sector.id);
      for (const b of boxes) {
        const size = b.max.map((n, i) => n - b.min[i]), pos = b.min.map((n, i) => (n + b.max[i]) / 2);
        let mat = m[b.kind] || m.wall;
        if (b.kind === 'floor' || b.kind === 'platform') {
          const t = floorTexture(); t.repeat.set(Math.max(1, size[0] / 18), Math.max(1, size[2] / 18));
          mat = m.floor.clone(); mat.map = t;
        }
        const object = box(group, mat, size, pos);
        object.name = b.id; object.userData.box = b;
        if (b.kind === 'barrier') this.barrierMeshes.set(b.barrierId || b.id, object);
        if (['machine', 'cover'].includes(b.kind)) {
          box(group, m.dark, [size[0] + .08, .16, size[2] + .08], [pos[0], b.min[1] + .12, pos[2]]);
          box(group, m.dark, [.11, Math.max(.1, size[1] - .3), size[2] + .04], [b.max[0] + .04, pos[1], pos[2]]);
          if (size[1] > 2) {
            box(group, m.edge, [.15, .18, Math.max(.5, size[2] - .5)], [b.max[0] + .12, b.max[1] - .6, pos[2]]);
            box(group, m.orange, [.035, .12, Math.min(size[2] * .55, 4)], [b.max[0] + .14, b.max[1] - .76, pos[2]]);
            for (let i = 0; i < Math.min(5, size[2] / 1.2); i++) box(group, m.dark, [.04, .5, .10], [b.max[0] + .15, pos[1], b.min[2] + .7 + i * .38]);
            if (b.kind === 'machine') {
              cylinder(group, m.pillar, Math.min(1.3, size[2] / 4), Math.min(1.3, size[0]), [pos[0], b.max[1] - .45, pos[2]], 'x');
              sphere(group, m.orangeGlow, .13, [b.max[0] + .18, b.max[1] - 1.1, b.min[2] + .65]);
            }
          }
        }
        if (b.kind === 'barrier') {
          for (let z = b.min[2] + .5; z < b.max[2]; z += 1.25) box(object, m.dark, [size[0] + .025, .08, .16], [0, -.05, z - pos[2]], [.0, 0, .0]);
          const p = [.51 * size[0], .2, 0]; decal(object, 'INTERLOCK / SEALED', p, [Math.min(size[2] - .4, 8), .56]);
          for (const side of [-1, 1]) mesh(new THREE.PlaneGeometry(size[2] - .3, .42), hazardMaterial(size[2]), object, [size[0] / 2 + .025, side * (size[1] / 2 - .5), 0], [0, Math.PI / 2, 0]);
        }
      }
      this.decorateSector(group, sector);
      this.mergeStaticMeshes(group);
    }
  }

  mergeStaticMeshes(group) {
    // Keep each room independently culled while reducing its steelwork from
    // hundreds of draw calls to one draw per material. Interlocks stay dynamic.
    group.updateMatrixWorld(true);
    const batches = new Map();
    group.traverse(m => {
      if (!m.isMesh || m.material.transparent) return;
      let parent = m;
      while (parent && parent !== group) { if (parent.userData?.box?.kind === 'barrier') return; parent = parent.parent; }
      if (!batches.has(m.material)) batches.set(m.material, []);
      batches.get(m.material).push(m);
    });
    for (const [mat, meshes] of batches) {
      if (meshes.length < 3) continue;
      const geometries = meshes.map(m => {
        const clone = m.geometry.clone().applyMatrix4(m.matrixWorld);
        if (!clone.index) return clone;
        const result = clone.toNonIndexed(); clone.dispose(); return result;
      });
      const merged = mergeGeometries(geometries, false);
      geometries.forEach(g => g.dispose());
      if (!merged) continue;
      meshes.forEach(m => { m.parent.remove(m); m.geometry.dispose(); });
      mesh(merged, mat, group);
    }
  }

  decorateSector(g, s) {
    const m = this.mats, min = s.bounds.min, max = s.bounds.max, y = s.floorY, width = max[2] - min[2], length = max[0] - min[0], ceiling = s.ceilingY || max[1];
    const x0 = min[0], x1 = max[0], z0 = min[2], z1 = max[2];
    // Ceiling trusses, conduits and light strips make the scale readable.
    for (let x = x0 + 14; x < x1; x += 28) {
      box(g, m.dark, [.48, .55, Math.max(1, width - 1)], [x, ceiling - 1.25, (z0 + z1) / 2]);
      for (const z of [z0 + 1.2, z1 - 1.2]) box(g, m.pillar, [.48, Math.max(1, ceiling - y), .48], [x, (ceiling + y) / 2, z]);
      box(g, m.mint, [3.9, .09, .24], [x, ceiling - 1.57, (z0 + z1) / 2]);
      for (const z of [z0 + 1.6, z1 - 1.6]) {
        const girder = box(g, m.dark, [5.0, .13, .14], [x + 1.9, ceiling - 2.40, z], [0, 0, Math.PI / 8]);
        girder.castShadow = false;
      }
    }
    for (const z of [z0 + 1, z1 - 1]) {
      cylinder(g, m.pillar, .23, Math.max(1, length - 4), [(x0 + x1) / 2, ceiling - 3.2, z], 'x');
      cylinder(g, m.dark, .12, Math.max(1, length - 4), [(x0 + x1) / 2, ceiling - 3.9, z], 'x');
      for (let x = x0 + 5; x < x1 - 2; x += 14) torus(g, m.edge, .25, .055, [x, ceiling - 3.2, z]);
      box(g, m.orange, [Math.max(1, length - 4), .025, .14], [(x0 + x1) / 2, y + .025, z]);
    }
    // Door frames and wayfinding are physical surfaces rather than overlays.
    const door = s.entry || [x0 + 4, y + 2.1, 0];
    const sign = new THREE.Group(); g.add(sign); sign.position.set(x0 + 1.45, y + 9.4, door[2]);
    box(sign, m.dark, [.14, 1.5, 12], [0, 0, 0]);
    decal(sign, `${s.id}  /  ${s.name || s.type}`, [.08, .15, 0], [10.8, .75], 'front', '#b9d5c4');
    box(sign, m.orange, [.015, .08, 10.9], [.09, -.47, 0]);
    for (let x = x0 + 22; x < x1 - 12; x += 40) {
      decal(g, `→ ${s.id}  EXIT`, [x, y + .035, 0], [7, 1.3], 'floor', '#8ea494');
      for (let i = 0; i < 3; i++) box(g, m.edge, [2.1, .015, .14], [x + i * 2.7, y + .03, -.90]);
    }
    const type = (s.type || '').toLowerCase();
    if (type.includes('pipe') || type.includes('power') || type.includes('cool')) {
      for (let i = 0; i < 4; i++) {
        const z = z0 + 3 + i * 1.35;
        cylinder(g, i % 2 ? m.dark : m.pillar, .32 + i * .07, length - 6, [(x0 + x1) / 2, ceiling - 5.0 - i * .8, z], 'x');
        for (let x = x0 + 6; x < x1 - 4; x += 20) torus(g, m.edge, .36 + i * .07, .065, [x, ceiling - 5.0 - i * .8, z]);
      }
    }
    for (let x = x0 + 22; x < x1 - 10; x += 40) {
      const z = s.index % 2 ? z1 - 1.05 : z0 + 1.05;
      box(g, m.dark, [.7, .7, .25], [x, y + 5, z]);
      sphere(g, m.orangeGlow, .16, [x, y + 5, z + (s.index % 2 ? -.16 : .16)]);
    }
  }

  resize(width, height) {
    this.width = width; this.height = height; this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.renderer.setSize(width, height, false);
  }

  setGameCamera(game) {
    const p = game.player?.position || this.stage.startPosition || [10, 2.1, 0];
    if (game.state === 'garage') {
      this.camera.fov = 37; this.camera.position.set(9.2, 5.45, 6.65);
      this.camera.lookAt(-.49, 2.13, .69); this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld(); return;
    }
    this.camera.fov = 60;
    const yaw = game.yaw || 0, pitch = game.pitch || 0, forward = [Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)], right = [-Math.sin(yaw), 0, Math.cos(yaw)];
    const anchor = [p[0], p[1] + 1.15, p[2]], desired = [p[0] - Math.cos(yaw) * 9.5 + right[0] * 1.9, p[1] + 3.0 - Math.sin(pitch) * 5, p[2] - Math.sin(yaw) * 9.5 + right[2] * 1.9];
    const delta = desired.map((n, i) => n - anchor[i]); let t = 1;
    const open = game.objective?.openBarrierIds || [];
    for (const b of this.stage.boxes || []) {
      if (b.kind === 'barrier' && open.includes(b.barrierId || b.id)) continue;
      if (b.min[0] > p[0] + 25 || b.max[0] < p[0] - 25) continue;
      const hit = rayBox(anchor, delta, b.min.map(n => n - .3), b.max.map(n => n + .3));
      if (hit !== null) t = Math.min(t, Math.max(0, hit - .04));
    }
    this.camera.position.set(...anchor.map((n, i) => n + delta[i] * t));
    this.camera.lookAt(this.camera.position.clone().add(V(forward))); this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld();
  }

  getCameraInfo(game) {
    this.setGameCamera(game); const f = this.camera.getWorldDirection(new THREE.Vector3()).toArray(), pos = this.camera.position.toArray(), camera = this.camera, width = this.width, height = this.height;
    return { position: pos, forward: f, width, height, project: (p) => {
      const vector = V(p); const depth = vector.clone().sub(camera.position).dot(V(f)); vector.project(camera);
      return { x: (vector.x + 1) * .5 * width, y: (1 - vector.y) * .5 * height, depth };
    } };
  }
  getMuzzle(game) { return muzzlePosition(game.player.position, game.yaw || 0); }

  render(game, dt = 0) {
    this.time = game.elapsedSeconds || 0; const garage = game.state === 'garage'; this.world.visible = !garage; this.garage.visible = garage;
    this.setGameCamera(game);
    this.scene.background.set(garage ? 0x14211c : 0x162e33); this.scene.fog.color.copy(this.scene.background); this.scene.fog.density = garage ? .029 : .0048;
    this.hemi.intensity = garage ? 1.6 : 2.15; this.key.intensity = garage ? 3.6 : 2.5; this.fill.intensity = garage ? 2.0 : 1.45;
    const p = garage ? [0, 2.1, 0] : game.player.position;
    this.playerMesh.position.set(...p); this.playerMesh.rotation.y = -(garage ? .035 : game.yaw || 0);
    if (garage) { this.garageTime += dt; this.dust.rotation.y = this.garageTime * .004; }
    const velocity = game.player?.velocity || [0, 0, 0], speed = Math.hypot(velocity[0], velocity[2]);
    const walking = !garage && game.player.grounded && game.player.movement?.horizontalMode === 'walk';
    const anim = walking ? Math.min(1, speed / 9) : 0;
    this.playerMesh.userData.legPivots.forEach((leg, i) => { leg.rotation.z = Math.sin(this.time * (this.loadout.legs === 'quadruped' ? 11 : 9) + i * Math.PI) * .32 * anim; });
    const boosted = !garage && (game.player.movement?.horizontalMode === 'quickboost' || game.player.movement?.verticalMode === 'flying' || game.player.movement?.horizontalMode === 'glide');
    this.playerMesh.userData.thrusters.forEach((flame, i) => {
      flame.visible = flame.userData.kind === 'vertical' ? !garage && game.player.movement?.verticalMode === 'flying' : boosted;
      flame.scale.y = (flame.userData.kind === 'horizontal' && game.player.movement?.horizontalMode === 'quickboost' ? 3.3 : 1) * (1 + Math.sin(this.time * 57 + i) * .12);
    });
    const weapon = garage ? 'machinegun' : game.player.weapon;
    if (weapon !== this.weaponKind) { this.removeObject(this.weaponMesh); this.weaponMesh = buildWeapon(weapon, this.mats); this.weaponKind = weapon; this.scene.add(this.weaponMesh); }
    const muzzle = garage ? muzzlePosition(p, .035) : this.getMuzzle(game);
    const direction = garage ? [1, .015, 0] : game.weaponAimDirection || game.fireControl?.launchDirection || game.freeDirection?.(muzzle) || [Math.cos(game.yaw || 0) * Math.cos(game.pitch || 0), Math.sin(game.pitch || 0), Math.sin(game.yaw || 0) * Math.cos(game.pitch || 0)];
    this.weaponMesh.position.set(...muzzle); this.weaponMesh.quaternion.setFromUnitVectors(X, V(direction).normalize());
    this.poseWeaponArm();
    this.key.position.set(p[0] + 25, p[1] + 50, p[2] + 25); this.key.target.position.set(...p); this.key.target.updateMatrixWorld();
    const open = game.objective?.openBarrierIds || [];
    for (const [id, object] of this.barrierMeshes) object.visible = !open.includes(id);
    this.sectorGroups.forEach(({ group, sector }) => { group.visible = Math.abs((sector.bounds.min[0] + sector.bounds.max[0]) / 2 - p[0]) < 470; });
    this.updateEnemies(game, garage); this.updateProjectiles(game, garage); this.updateEffects(game, garage);
    this.renderer.render(this.scene, this.camera);
  }

  updateEnemies(game, garage) {
    const living = new Set();
    for (const e of game.enemies || []) {
      if (!e.alive) continue; living.add(e.id);
      let model = this.enemyMeshes.get(e.id); if (!model) { model = buildEnemy(e, this.mats); this.enemyMeshes.set(e.id, model); this.scene.add(model); }
      model.visible = !garage && Math.abs(e.position[0] - game.player.position[0]) < 350;
      if (!model.visible) continue;
      model.position.set(...e.position);
      const facing = e.facingDirection || [1, 0, 0]; model.rotation.y = -Math.atan2(facing[2], facing[0]);
      let legIndex = 0; model.children.forEach(c => { if (c.name === 'leg') c.rotation.z = Math.sin(this.time * 10 + legIndex++ * Math.PI) * Math.min(.36, Math.hypot(...(e.velocity || [0, 0, 0])) * .05); });
      const warning = Boolean(e.warning);
      model.userData.warning.visible = warning;
      model.userData.warning.intensity = warning ? 40 * (.65 + .35 * Math.sin(this.time * 37)) : 0;
      model.userData.warningMaterial.emissiveIntensity = warning ? 3.8 + Math.sin(this.time * 37) * .7 : .45;
    }
    for (const [id, model] of this.enemyMeshes) if (!living.has(id)) { this.removeObject(model); this.enemyMeshes.delete(id); }
  }

  poseWeaponArm() {
    this.playerMesh.updateMatrixWorld(true); this.weaponMesh.updateMatrixWorld(true);
    const arm = this.playerMesh.userData.arms.find(a => a.userData.ik); if (!arm) return;
    const target = this.playerMesh.worldToLocal(this.weaponMesh.localToWorld(new THREE.Vector3(-1.55, -.34, 0))).sub(arm.position);
    const d = target.length(), direction = target.clone().normalize();
    const upperLength = Math.max(.78, d * .54), lowerLength = Math.max(.85, d * .54);
    const a = (upperLength ** 2 - lowerLength ** 2 + d ** 2) / (2 * Math.max(d, .0001));
    const h = Math.sqrt(Math.max(0, upperLength ** 2 - a ** 2));
    const down = new THREE.Vector3(0, -1, 0).addScaledVector(direction, direction.y);
    if (down.lengthSq() < .001) down.set(-1, 0, 0); down.normalize();
    const elbow = direction.clone().multiplyScalar(a).addScaledVector(down, h);
    const { upper, lower } = arm.userData.ik;
    upper.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), elbow.clone().normalize()); upper.scale.y = upperLength / .78;
    lower.position.copy(elbow); lower.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), target.clone().sub(elbow).normalize()); lower.scale.y = lowerLength / .85;
  }

  updateProjectiles(game, garage) {
    const active = new Set();
    for (const p of game.projectiles || []) {
      active.add(p.id); let model = this.projectileMeshes.get(p.id);
      if (!model) {
        model = new THREE.Group();
        if (p.weapon === 'missile') {
          cylinder(model, this.mats.steel, .095, .72, [-.35, 0, 0], 'x');
          mesh(new THREE.ConeGeometry(.095, .24, 12), this.mats.orange, model, [.11, 0, 0], [0, 0, -Math.PI / 2]);
          box(model, this.mats.dark, [.2, .018, .39], [-.57, 0, 0]); box(model, this.mats.dark, [.2, .39, .018], [-.57, 0, 0]);
          mesh(new THREE.ConeGeometry(.16, 1.1, 12), this.mats.flame, model, [-1.2, 0, 0], [0, 0, Math.PI / 2]);
        } else {
          cylinder(model, p.owner === 'player' ? this.mats.shot : this.mats.enemyShot, .042, p.owner === 'player' ? 1.4 : .85, [-.4, 0, 0], 'x', .026, 6);
        }
        this.projectileMeshes.set(p.id, model); this.scene.add(model);
      }
      model.visible = !garage; model.position.set(...p.position);
      // The machinegun's stored initial velocity is not its current tangent.
      // Render its gravity-curved path with the same acceleration and age.
      const direction = p.velocity || p.direction || [1, 0, 0];
      const tangent = p.weapon === 'machinegun' && p.initialVelocity
        ? p.initialVelocity.map((n, i) => n + (p.acceleration?.[i] || 0) * (p.age || 0))
        : direction;
      model.quaternion.setFromUnitVectors(X, V(tangent).normalize());
    }
    for (const [id, model] of this.projectileMeshes) if (!active.has(id)) { this.removeObject(model); this.projectileMeshes.delete(id); }
  }

  updateEffects(game, garage) {
    const active = new Set();
    for (let index = 0; index < (game.effects || []).length; index++) {
      const e = game.effects[index], id = e.id ?? e; active.add(id); let model = this.effectMeshes.get(id);
      if (!model) {
        model = new THREE.Group(); const type = e.type || 'impact';
        if (type === 'beam' && e.end) {
          const mat = this.mats.beam.clone(); beamBetween(model, [0, 0, 0], e.end.map((n, i) => n - e.position[i]), .065, mat);
          sphere(model, mat, .22, e.end.map((n, i) => n - e.position[i]));
        } else if (type === 'explosion' || type === 'destroy' || type === 'enemyDestroyed') {
          const mat = new THREE.MeshBasicMaterial({ color: 0xe7aa5c, transparent: true, opacity: .5, depthWrite: false });
          sphere(model, mat, 1.65, [0, 0, 0]); torus(model, mat, 2.1, .07, [0, 0, 0], 'y');
          for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; beamBetween(model, [0, 0, 0], [Math.cos(a) * 2.8, (i % 3 - 1) * 1.3, Math.sin(a) * 2.8], .035, mat); }
        } else if (type === 'muzzle' || type === 'fire') {
          const mat = new THREE.MeshBasicMaterial({ color: 0xffe1a1, transparent: true, opacity: .9, depthWrite: false });
          sphere(model, mat, .22, [0, 0, 0], [1.8, .65, .65]);
        } else if (type === 'quickboost' || type === 'qb') {
          const mat = new THREE.MeshBasicMaterial({ color: 0x9effda, transparent: true, opacity: .5, depthWrite: false }); torus(model, mat, 1.8, .04, [0, -.8, 0], 'y');
        } else {
          const mat = new THREE.MeshBasicMaterial({ color: type === 'playerHit' || type === 'damage' ? 0xff7950 : 0xffd694, transparent: true, opacity: .9, depthWrite: false });
          sphere(model, mat, .18, [0, 0, 0]);
          for (let i = 0; i < 5; i++) { const a = i * 2.3; beamBetween(model, [0, 0, 0], [Math.cos(a) * .75, Math.sin(a) * .50, Math.sin(a * 1.7) * .75], .015, mat); }
        }
        this.effectMeshes.set(id, model); this.scene.add(model);
      }
      model.visible = !garage; model.position.set(...e.position);
      const remaining = e.remaining ?? e.remainingSeconds ?? .1;
      model.traverse((m) => { if (m.isMesh && m.material.transparent) m.material.opacity = Math.min(1, remaining * 6); });
    }
    for (const [id, model] of this.effectMeshes) if (!active.has(id)) { this.removeObject(model); this.effectMeshes.delete(id); }
  }

  dispose() { this.renderer.dispose(); }
}
