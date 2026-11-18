import * as THREE from 'three';
import { createKoalaMech, animateMech } from './models.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export function createGarageScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101917);
  scene.fog = new THREE.FogExp2(0x111917, .025);
  const camera = new THREE.PerspectiveCamera(31, 16 / 9, .1, 120);
  camera.position.set(7.7, 5.25, 11.6);
  camera.lookAt(0, 2.40, 0);
  const environment = new THREE.Group();
  scene.add(environment);
  const garageMaterials = {
    floor: new THREE.MeshStandardMaterial({ color: 0x28342f, metalness: .35, roughness: .66 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x24322c, metalness: .6, roughness: .6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x141e19, metalness: .45, roughness: .65 }),
    edge: new THREE.MeshStandardMaterial({ color: 0x617065, metalness: .55, roughness: .57 }),
    platform: new THREE.MeshStandardMaterial({ color: 0x4c5a4e, metalness: .56, roughness: .51 }),
    ivory: new THREE.MeshStandardMaterial({ color: 0xaaa98c, metalness: .32, roughness: .6 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xc96e37, metalness: .37, roughness: .6 }),
    amber: new THREE.MeshBasicMaterial({ color: 0xe8a15d }),
    light: new THREE.MeshBasicMaterial({ color: 0xcbd6b9 }),
    white: new THREE.MeshBasicMaterial({ color: 0xdce7d2 }),
  };
  const disposables = new Set(Object.values(garageMaterials));
  function part(geometry, material, position = [0, 0, 0], rotation) {
    const m = new THREE.Mesh(geometry, typeof material === 'string' ? garageMaterials[material] : material);
    m.position.set(...position);
    if (rotation) m.rotation.set(...rotation);
    m.castShadow = true;
    m.receiveShadow = true;
    environment.add(m);
    disposables.add(geometry);
    return m;
  }
  function box(size, p, material, rotation) { return part(new THREE.BoxGeometry(...size), material, p, rotation); }
  function cylinder(r1, r2, height, p, material, segments = 64) { return part(new THREE.CylinderGeometry(r1, r2, height, segments), material, p); }
  function beam(a, b, radius, material) {
    const av = V(...a), bv = V(...b);
    const m = cylinder(radius, radius, av.distanceTo(bv), av.clone().add(bv).multiplyScalar(.5).toArray(), material, 8);
    m.quaternion.setFromUnitVectors(V(0, 1, 0), bv.sub(av).normalize());
    return m;
  }
  function ring(radius, tube, p, material, arc = Math.PI * 2) {
    return part(new THREE.TorusGeometry(radius, tube, 6, 112, arc), material, p, [Math.PI / 2, 0, 0]);
  }
  function label(text, width, height, p, rotation, color = '#96a38f', size = 180) {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 1024, 256);
    ctx.fillStyle = color;
    ctx.font = `700 ${size}px Arial, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 512, 128);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    disposables.add(texture);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: .75 });
    disposables.add(material);
    return part(new THREE.PlaneGeometry(width, height), material, p, rotation);
  }

  const ambient = new THREE.HemisphereLight(0xb7c7c0, 0x2b3024, 2.1);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffe6bb, 4.3);
  key.position.set(4, 8, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -8; key.shadow.camera.right = 8;
  key.shadow.camera.top = 10; key.shadow.camera.bottom = -7;
  key.shadow.camera.near = .5; key.shadow.camera.far = 40;
  key.shadow.normalBias = .035; key.shadow.bias = -.00015;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x94bdc0, 1.7);
  fill.position.set(-5, 3, 4); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffb967, 3.7);
  rim.position.set(-3, 7, -6); scene.add(rim);
  const bayLamp = new THREE.PointLight(0xff9c50, 45, 12, 2);
  bayLamp.position.set(3.8, 3.7, -4.3); scene.add(bayLamp);

  // Service deck: inlaid tracks, radial indexing marks, inset running lights.
  box([100, .3, 100], [0, -.43, 0], 'floor');
  for (let i = -8; i <= 8; i++) {
    box([.018, .005, 42], [i * 3, -.272, -5], 'dark');
    box([46, .005, .018], [0, -.27, i * 3], 'dark');
  }
  cylinder(3.45, 3.60, .22, [0, -.16, 0], 'dark');
  cylinder(3.36, 3.45, .14, [0, -.04, 0], 'platform');
  cylinder(3.02, 3.02, .04, [0, .05, 0], 'floor');
  ring(3.16, .017, [0, .063, 0], 'ivory');
  ring(2.83, .012, [0, .076, 0], 'edge');
  ring(3.48, .025, [0, -.09, 0], 'amber');
  for (let i = 0; i < 48; i++) {
    const a = i / 48 * Math.PI * 2;
    const r = i % 4 === 0 ? 3.25 : 3.28;
    box([.016, .006, i % 4 === 0 ? .18 : .08], [Math.sin(a) * r, .077, Math.cos(a) * r], i % 4 === 0 ? 'ivory' : 'edge', [0, a, 0]);
  }
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    box([.11, .034, .39], [Math.sin(a) * 3.43, -.105, Math.cos(a) * 3.43], 'amber', [0, a, 0]);
  }
  for (const x of [-2.7, 2.7]) {
    box([.06, .01, 9], [x, -.263, 4.4], 'ivory');
    for (let i = 0; i < 6; i++) box([.35, .015, .12], [x, -.25, 4 + i * .4], 'orange', [0, .5, 0]);
  }
  label('02', 1.2, .45, [0, .081, 2.27], [-Math.PI / 2, 0, Math.PI], '#bec0a0');
  label('AUTHORIZED PERSONNEL ONLY', 3.3, .32, [0, -.248, 5.14], [-Math.PI / 2, 0, Math.PI], '#899381', 74);
  for (const z of [-.6, 1.1]) box([1.8, .006, .016], [0, .078, z], 'edge');

  // Shadow contact is procedural and remains legible if shadows are disabled.
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(64, 64, 9, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(5,10,8,.62)'); gradient.addColorStop(.50, 'rgba(5,10,8,.3)'); gradient.addColorStop(1, 'rgba(5,10,8,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(canvas); disposables.add(texture);
    const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }); disposables.add(mat);
    part(new THREE.PlaneGeometry(4.4, 3.5), mat, [0, .087, 0], [-Math.PI / 2, 0, 0]);
  }

  // Tall modular hangar backdrop, supporting trusses and an overhead gantry.
  box([38, 16, .5], [0, 7.5, -11], 'dark');
  for (let i = -4; i <= 4; i++) {
    const x = i * 4.2;
    box([.32, 14, .6], [x, 6.5, -10.65], 'frame');
    box([3.75, .05, .08], [x + 2.1, 5.9, -10.59], 'edge');
    box([3.75, .025, .08], [x + 2.1, 2.0, -10.59], 'edge');
    if (i > -2 && i < 3) {
      box([.16, 1.7, .06], [x - .33, 5.8, -10.54], 'light');
      box([.3, 1.91, .12], [x - .33, 5.8, -10.60], 'frame');
    }
  }
  box([6.5, 7.9, .27], [2.0, 3.8, -10.6], 'frame');
  for (let i = 0; i < 10; i++) box([6.3, .031, .07], [2.0, .4 + i * .72, -10.44], 'dark');
  label('BAY  02', 6.1, 1.5, [2, 5.95, -10.37], [0, 0, 0], '#7d8977', 166);
  label('KOALA HEAVY INDUSTRIES', 5.6, .33, [2, 4.99, -10.35], [0, 0, 0], '#7f8b78', 77);
  box([6.35, .075, .09], [2, 7.45, -10.4], 'amber');
  for (const x of [-5.6, 7.3]) {
    box([.50, 10.3, .65], [x, 4.65, -5.8], 'frame');
    box([.71, .72, .87], [x, .09, -5.8], 'dark');
    box([.60, .24, .81], [x, 8.8, -5.8], 'edge');
    box([.08, 2.9, .051], [x + .26, 3.5, -5.45], 'amber');
    for (let i = 0; i < 4; i++) box([.53, .15, .02], [x, .40 + i * .27, -5.459], 'orange', [0, 0, .32]);
  }
  box([14, .58, .64], [.7, 8.95, -5.8], 'orange');
  box([14, .09, .89], [.7, 9.28, -5.8], 'edge');
  for (let i = 0; i < 12; i++) beam([-5.6 + i, 8.70, -5.44], [-4.6 + i, 9.17, -5.44], .035, 'dark');
  box([1.55, .58, 1.0], [2.4, 8.75, -5.7], 'dark');
  beam([2.4, 8.6, -5.7], [2.4, 6.5, -5.7], .035, 'steel' in garageMaterials ? 'steel' : 'edge');
  const hook = part(new THREE.TorusGeometry(.22, .05, 8, 16, Math.PI * 1.6), 'edge', [2.52, 6.27, -5.7]);
  hook.rotation.z = -.4;
  for (const x of [-5.6, 7.3]) {
    beam([x, 7.1, -5.8], [x, 9.0, -8.5], .09, 'edge');
    beam([x, 9.0, -5.8], [x, 9.0, 8], .11, 'frame');
  }
  for (const z of [-8, -3, 2, 7]) {
    box([14, .25, .21], [.7, 10.2, z], 'frame');
    box([2.8, .07, .15], [1, 10.03, z], 'light');
  }

  // Dockside tooling, stacked chassis cases and suspended power leads.
  for (const p of [[-5.1, .46, -5], [-4.5, .45, -6.2], [5.2, .38, -6.7], [5.2, 1.15, -6.7]]) {
    box([1.13, .77, 1.08], p, 'frame');
    box([1.16, .12, 1.11], [p[0], p[1] + .34, p[2]], 'edge');
    for (const side of [-1, 1]) box([.10, .59, .041], [p[0] + side * .39, p[1], p[2] + .56], 'dark');
  }
  box([1.3, 1.83, .68], [-4.5, .64, -2.9], 'dark');
  box([1.19, .65, .05], [-4.5, 1.03, -2.535], 'frame');
  box([.82, .28, .025], [-4.5, 1.12, -2.499], 'edge');
  for (let i = 0; i < 5; i++) box([.035, .053, .02], [-4.8 + i * .13, .70, -2.49], i === 0 ? 'amber' : 'ivory');
  for (const x of [-4.83, -4.17]) cylinder(.13, .13, .1, [x, -.17, -2.9], 'dark', 12).rotation.x = Math.PI / 2;
  const cableCurve = new THREE.CatmullRomCurve3([V(-4.5, .2, -2.9), V(-3.9, -.23, -2.2), V(-2.8, -.24, -2.4), V(-2.3, -.23, -1.8), V(-2.4, .1, -1)]);
  part(new THREE.TubeGeometry(cableCurve, 36, .035, 6, false), 'dark');
  const hangingCurve = new THREE.CatmullRomCurve3([V(-1.8, 9, -4), V(-2, 7.3, -4), V(-1.6, 6.6, -3.9), V(-1.1, 7.1, -4), V(-1.0, 9, -4)]);
  part(new THREE.TubeGeometry(hangingCurve, 30, .025, 6, false), 'dark');
  for (const x of [4.7, 5.05, 5.4]) {
    cylinder(.085, .085, 8.5, [x, 4.0, -9.7], 'edge', 10);
    cylinder(.13, .13, .13, [x, 1, -9.7], 'dark', 10);
    cylinder(.13, .13, .13, [x, 3.6, -9.7], 'dark', 10);
  }

  const dustGeometry = new THREE.BufferGeometry();
  const positions = new Float32Array(60 * 3);
  for (let i = 0; i < 60; i++) {
    const n = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    const r = n - Math.floor(n);
    positions[i * 3] = (r - .5) * 15;
    positions[i * 3 + 1] = ((i * .618034) % 1) * 9;
    positions[i * 3 + 2] = ((i * .414214) % 1) * 10 - 7;
  }
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const dustMaterial = new THREE.PointsMaterial({ color: 0xc2c1a0, size: .012, transparent: true, opacity: .32, depthWrite: false });
  const dust = new THREE.Points(dustGeometry, dustMaterial); scene.add(dust);
  disposables.add(dustGeometry); disposables.add(dustMaterial);

  const mechs = { biped: createKoalaMech('biped'), quadruped: createKoalaMech('quadruped') };
  for (const mech of Object.values(mechs)) { mech.position.y = .08; scene.add(mech); }
  mechs.quadruped.visible = false;
  let activeLegs = 'biped';
  function resize(w, h) {
    camera.aspect = w / h;
    camera.setViewOffset(w, h, -.061 * w, -.013 * h, w, h);
    camera.updateProjectionMatrix();
  }
  resize(1280, 720);
  return {
    scene, camera,
    update(time, loadout = {}) {
      activeLegs = loadout.legs === 'quadruped' ? 'quadruped' : 'biped';
      for (const [key, mech] of Object.entries(mechs)) mech.visible = key === activeLegs;
      const mech = mechs[activeLegs];
      // Tiny turntable motion shows the model's depth without hiding its face.
      mech.rotation.y = -.11 + Math.sin(time * .16) * .055;
      animateMech(mech, { time, speed: 0, yaw: mech.rotation.y, weapon: 'machinegun' });
      dust.position.y = Math.sin(time * .065) * .15;
      bayLamp.intensity = 43 + Math.sin(time * 1.7) * 1.2;
    },
    resize,
    dispose() {
      for (const item of disposables) item.dispose?.();
      scene.clear();
    },
  };
}
