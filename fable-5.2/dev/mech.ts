/**
 * Visual test harness for src/render/mechModel.ts.
 *
 *   /dev/mech.html?legs=biped|quadruped
 *                 &state=idle|walk|glide|qb|fly|fall|rise|brake|land
 *                 &weapon=machinegun|beam|missile
 *                 &view=front|back|side|left|play|top|front34|back34|backleft34|head
 *                   (front = hangar view, play = the in-game chase camera built from CAMERA in src/config.ts)
 *                 &aim=up|down|left|right|upleft|...   (or &aimyaw=<deg>&aimpitch=<deg>, &aimdeg=<magnitude>)
 *                 &dir=f|b|l|r|fl|fr|bl|br              movement direction in the body frame
 *                 &t=<seconds to pre-simulate>           (default 1.2)
 *                 &pre=<state>&pret=<s>                  lead-in state until `pret` seconds before the end (blend checks)
 *                 &landt=<s>                             state=land: touch down this long before the end
 *                 &hmode=glide                           state=fly: horizontal mode while flying
 *                 &fire=1                                fire on the last pre-simulated step (muzzle flash)
 *                 &speed=<m/s>  &zoom=<factor>  &look=<target height>  &pitch=<deg, play view>
 *                 &gyaw=<deg, rotates the whole model>  &lift=<m, airborne states>
 *                 &marker=0  &box=1 (collision box)  &light=factory  &live=1 (keep animating in real time)
 *
 * The magenta cross marks the muzzle contract point returned by MechModel.getMuzzleWorld().
 * `window.__mech.check()` returns numeric evidence that the barrel tip coincides with it, plus the exact
 * vertex bounds of the model and the renderer statistics.
 */
import * as THREE from 'three';
import { CAMERA, PLAYER } from '../src/config';
import type { LegsId, Weapon } from '../src/sim/types';
import { MECH_MUZZLE_LOCAL, MechModel, type MechAnimInput } from '../src/render/mechModel';

const q = new URLSearchParams(location.search);
const str = (k: string, d: string): string => q.get(k) ?? d;
const num = (k: string, d: number): number => {
  const v = q.get(k);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const DEG = Math.PI / 180;

const legs = (str('legs', 'biped') === 'quadruped' ? 'quadruped' : 'biped') as LegsId;
const state = str('state', 'idle');
const weapon = (['machinegun', 'beam', 'missile'].includes(str('weapon', 'machinegun')) ? str('weapon', 'machinegun') : 'machinegun') as Weapon;
const view = str('view', 'front');
const preT = num('t', 1.2);
const live = str('live', '0') === '1';

// ── renderer / scene ──
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const factory = str('light', 'neutral') === 'factory';
scene.background = new THREE.Color(factory ? 0x1c2126 : 0x59626c);

const hemi = new THREE.HemisphereLight(factory ? 0x8fa3b0 : 0xe6edf5, factory ? 0x3a3128 : 0x4f4a44, factory ? 1.1 : 1.9);
scene.add(hemi);
const key = new THREE.DirectionalLight(factory ? 0xffc890 : 0xfff3e2, factory ? 2.2 : 2.9);
scene.add(key);
scene.add(key.target);
const rim = new THREE.DirectionalLight(factory ? 0x4fd8e8 : 0xbcd8ff, factory ? 1.2 : 1.1);
scene.add(rim);
scene.add(rim.target);

// ground with 1 m grid lines (canvas texture, procedural)
{
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = factory ? '#2c3136' : '#474e56';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = factory ? '#3b4249' : '#5a626b';
  g.lineWidth = 3;
  g.strokeRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
}

// ── model ──
const model = new MechModel(legs);
const airborne = ['fly', 'fall', 'rise'].includes(state);
const lift = airborne ? num('lift', 2.5) : 0;
model.group.position.set(0, lift, 0);
model.group.rotation.y = num('gyaw', 0) * DEG;
scene.add(model.group);

// collision box (2.6 × 4.0 × 2.6)
if (str('box', '0') === '1') {
  const b = new THREE.Box3(
    new THREE.Vector3(-PLAYER.half.x, 0, -PLAYER.half.z),
    new THREE.Vector3(PLAYER.half.x, PLAYER.half.y * 2, PLAYER.half.z),
  );
  const helper = new THREE.Box3Helper(b, 0xffd24a);
  model.group.add(helper);
}

// muzzle contract marker (always drawn on top)
const marker = new THREE.Group();
{
  const mat = new THREE.LineBasicMaterial({ color: 0xff2bd6, depthTest: false, transparent: true });
  const pts: number[] = [];
  const L = 0.22;
  pts.push(-L, 0, 0, L, 0, 0, 0, -L, 0, 0, L, 0, 0, 0, -L, 0, 0, L);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 999;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2bd6, depthTest: false, transparent: true }));
  dot.renderOrder = 999;
  marker.add(lines, dot);
  marker.visible = str('marker', '1') !== '0';
  scene.add(marker);
}

// ── animation input from the query ──
const dirMap: Record<string, [number, number]> = {
  f: [0, 1], b: [0, -1], l: [-1, 0], r: [1, 0], fl: [-0.7071, 0.7071], fr: [0.7071, 0.7071], bl: [-0.7071, -0.7071], br: [0.7071, -0.7071],
};
const dir = dirMap[str('dir', 'f')] ?? dirMap.f;
const legMul = legs === 'quadruped' ? 0.8 : 1;

let aimYaw = num('aimyaw', 0) * DEG; // + = left
let aimPitch = num('aimpitch', 0) * DEG; // + = up
{
  const a = str('aim', '');
  const mag = num('aimdeg', 0);
  if (a.includes('up')) aimPitch = (mag || 35) * DEG;
  if (a.includes('down')) aimPitch = -(mag || 35) * DEG;
  if (a.includes('left')) aimYaw = (mag || 25) * DEG;
  if (a.includes('right')) aimYaw = -(mag || 25) * DEG;
}
const aimDir = {
  x: -Math.sin(aimYaw) * Math.cos(aimPitch),
  y: Math.sin(aimPitch),
  z: -Math.cos(aimYaw) * Math.cos(aimPitch),
};

const input: MechAnimInput = {
  dt: 1 / 60,
  time: 0,
  grounded: true,
  horizontalSpeed: 0,
  moveDirLocal: { x: 0, z: 0 },
  horizontalMode: 'walk',
  verticalMode: 'grounded',
  braking: false,
  weapon,
  aimDirLocal: aimDir,
  fired: null,
};

function applyState(s: string, tLeft: number): void {
  input.grounded = true;
  input.verticalMode = 'grounded';
  input.horizontalMode = 'walk';
  input.braking = false;
  input.horizontalSpeed = 0;
  input.moveDirLocal.x = 0;
  input.moveDirLocal.z = 0;
  const move = (speed: number): void => {
    input.horizontalSpeed = num('speed', speed * legMul);
    input.moveDirLocal.x = dir[0];
    input.moveDirLocal.z = dir[1];
  };
  switch (s) {
    case 'walk':
      move(PLAYER.walkSpeed);
      break;
    case 'glide':
      input.horizontalMode = 'glide';
      move(PLAYER.glideSpeed);
      break;
    case 'qb':
      input.horizontalMode = 'quickboost';
      move(PLAYER.qbSpeed);
      break;
    case 'fly':
      input.grounded = false;
      input.verticalMode = 'flying';
      input.horizontalMode = str('hmode', 'walk') === 'glide' ? 'glide' : 'walk';
      move(PLAYER.airSpeed);
      break;
    case 'fall':
      input.grounded = false;
      input.verticalMode = 'falling';
      move(6);
      break;
    case 'rise':
      input.grounded = false;
      input.verticalMode = 'rising';
      move(6);
      break;
    case 'brake':
      input.braking = true;
      move(12);
      break;
    case 'land':
      // fall, then touch down `landt` seconds before the end of the pre-simulation
      if (tLeft > num('landt', 0.1)) {
        input.grounded = false;
        input.verticalMode = 'falling';
      }
      break;
    default:
      break;
  }
}

// pre-simulate
{
  const steps = Math.max(1, Math.round(preT * 60));
  const pre = str('pre', '');
  for (let i = 0; i < steps; i++) {
    const tLeft = (steps - 1 - i) / 60;
    // optional lead-in state (e.g. pre=walk then state=idle for blending checks)
    applyState(pre && tLeft > num('pret', 0.2) ? pre : state, tLeft);
    input.time += input.dt;
    input.fired = str('fire', '0') === '1' && i === steps - 1 ? weapon : null;
    model.update(input);
  }
  input.fired = null;
}

// ── camera ──
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 200);
{
  const zoom = num('zoom', 1);
  const cy = lift + num('look', 2.05);
  const target = new THREE.Vector3(0, cy, 0);
  const place = (x: number, y: number, z: number): void => {
    camera.position.set(x / zoom, cy + (y - 2.05) / zoom + (zoom !== 1 ? 0 : 0), z / zoom);
    camera.lookAt(target);
  };
  switch (view) {
    case 'back':
      place(0, 2.6, 9.5);
      break;
    case 'side':
      place(9.5, 2.3, 0);
      break;
    case 'left':
      place(-9.5, 2.3, 0);
      break;
    case 'top':
      place(0, 13, 0.01);
      break;
    case 'front34':
      place(5.2, 3.0, -7.6);
      break;
    case 'back34':
      place(5.6, 4.2, 7.2);
      break;
    case 'backleft34':
      place(-5.6, 4.2, 7.2);
      break;
    case 'head':
      target.set(0, lift + 3.5, 0);
      camera.position.set(num('hx', 0), lift + 3.6, -3.4);
      camera.lookAt(target);
      break;
    case 'play': {
      // identical to the game rig: pivot = box centre + pivotUp, camera = pivot - forward * boom
      camera.fov = CAMERA.fovYDeg;
      const pitch = num('pitch', -8) * DEG;
      const fwd = new THREE.Vector3(0, Math.sin(pitch), -Math.cos(pitch));
      const pivot = new THREE.Vector3(0, lift + PLAYER.half.y + CAMERA.pivotUp, 0);
      camera.position.copy(pivot).addScaledVector(fwd, -CAMERA.boomLength);
      camera.lookAt(pivot.clone().add(fwd));
      break;
    }
    default:
      place(0, 2.5, -9.5);
      break;
  }
  camera.updateProjectionMatrix();
  // lights relative to the camera side so every view is readable
  const front = camera.position.z < 0 ? -1 : 1;
  key.position.set(-5, 9, 6 * front);
  rim.position.set(6, 5, -7 * front);
}

// ── frame loop ──
const info = document.getElementById('info')!;
const muzzle = new THREE.Vector3();
let last = performance.now();
let frames = 0;
function frame(now: number): void {
  if (live) {
    input.dt = Math.min(0.1, (now - last) / 1000);
    input.time += input.dt;
    applyState(state, 0);
    model.update(input);
  }
  last = now;
  marker.position.copy(model.getMuzzleWorld(muzzle));
  renderer.render(scene, camera);
  if (frames++ < 3 || live) {
    info.textContent =
      `legs=${legs} state=${state} weapon=${weapon} view=${view} t=${preT}\n` +
      `draw calls ${renderer.info.render.calls}  triangles ${renderer.info.render.triangles}` +
      `  (ground + marker included: 3 calls / 2+ tris)`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ── numeric checks for the muzzle contract (used with tools/shot.mjs --eval) ──
function check(): Record<string, unknown> {
  scene.updateMatrixWorld(true);
  const w = model.group.getObjectByName(weapon) as THREE.Mesh;
  const pos = w.geometry.getAttribute('position');
  let minZ = Infinity;
  for (let i = 0; i < pos.count; i++) minZ = Math.min(minZ, pos.getZ(i));
  const tip = new THREE.Vector3(0, 0, 0).applyMatrix4(w.matrixWorld);
  const back = new THREE.Vector3(0, 0, 1).applyMatrix4(w.matrixWorld);
  const axis = tip.clone().sub(back).normalize();
  const contract = new THREE.Vector3(MECH_MUZZLE_LOCAL.x, MECH_MUZZLE_LOCAL.y, MECH_MUZZLE_LOCAL.z).applyMatrix4(model.group.matrixWorld);
  const aimWorld = new THREE.Vector3(aimDir.x, aimDir.y, aimDir.z).transformDirection(model.group.matrixWorld);
  // exact vertex bounds of every opaque mesh, in the model's own frame
  const full = new THREE.Box3();
  const inv = new THREE.Matrix4().copy(model.group.matrixWorld).invert();
  const toModel = new THREE.Matrix4();
  const v = new THREE.Vector3();
  model.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible || !(m.material as THREE.Material).depthWrite) return;
    let p: THREE.Object3D | null = m;
    let shown = true;
    while (p) {
      if (!p.visible) shown = false;
      p = p.parent;
    }
    if (!shown) return;
    toModel.multiplyMatrices(inv, m.matrixWorld);
    const a = m.geometry.getAttribute('position');
    for (let i = 0; i < a.count; i++) full.expandByPoint(v.fromBufferAttribute(a, i).applyMatrix4(toModel));
  });
  const r = (v: THREE.Vector3): number[] => [v.x, v.y, v.z].map((x) => Math.round(x * 1e5) / 1e5);
  return {
    weaponParentIsPivot: w.parent !== null && w.parent.parent === model.group,
    geometryMinZ: minZ,
    barrelTipWorld: r(tip),
    getMuzzleWorld: r(model.getMuzzleWorld(new THREE.Vector3())),
    contractWorld: r(contract),
    tipError: tip.distanceTo(contract),
    barrelAxisWorld: r(axis),
    aimDirWorld: r(aimWorld),
    axisErrorDeg: (axis.angleTo(aimWorld) * 180) / Math.PI,
    boundsMin: r(full.min),
    boundsMax: r(full.max),
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  };
}
(window as unknown as { __mech: unknown }).__mech = { model, input, check, renderer, scene, camera };
