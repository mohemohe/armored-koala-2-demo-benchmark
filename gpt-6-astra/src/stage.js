import * as THREE from 'three';

// Every structural solid is built once here, then used for both collision and rendering.
// +Z is the direction of escape. No teleports or hidden boundary planes are used.
const ROOM_SPECS = [
  ['receiving', '北搬入口', 'loading dock', 64, 95, 0, 0, 0],
  ['salvage', '資材ヤード', 'salvage arena', 100, 125, 0, 3, 1],
  ['rolling', '圧延棟', 'rolling mill', 110, 130, 0, 3, 2],
  ['lift-a', '第一搬送縦坑', 'lift shaft', 36, 80, 8, 1, 0],
  ['assembly', '組立ライン', 'assembly arena', 94, 120, 8, 3, 1],
  ['inspection', '検査棟', 'inspection hall', 70, 100, 8, 1, 2],
  ['pipeworks', '保守配管区画', 'pipe gallery', 44, 115, 16, 2, 0],
  ['power', '動力棟', 'generator arena', 106, 135, 16, 3, 1],
  ['cooling', '冷却設備', 'cooling arena', 100, 125, 16, 3, 2],
  ['lift-b', '排気縦坑', 'exhaust shaft', 36, 90, 24, 1, 0],
  ['conveyor', '下層搬送区画', 'conveyor tunnel', 60, 115, 24, 2, 1],
  ['foundry', '主製造ホール', 'foundry arena', 110, 145, 24, 3, 2],
  ['warehouse', '出荷倉庫', 'warehouse', 96, 130, 32, 2, 0],
  ['crane', 'クレーン移送室', 'crane hall', 76, 105, 32, 1, 1],
  ['perimeter', '外周搬送路', 'transfer gallery', 54, 120, 40, 1, 0],
  ['dispatch', '搬出管制室', 'dispatch hall', 80, 110, 40, 1, 2],
  ['escape', '最終搬出ゲート', 'evacuation bay', 64, 100, 48, 0, 0],
];
const CONTROL_INDICES = [2, 5, 8, 11, 13, 15];
const ARENA_INDICES = [1, 2, 4, 7, 8, 11];
const LOOP_INDICES = [2, 4, 8];
const CELL = 4;
const BIN = 32;
const EPS = 1e-6;
const UP = new THREE.Vector3(0, 1, 0);

function segmentBox(start, end, min, max, ignoreInside = false) {
  let enter = -Infinity, leave = Infinity;
  const normal = new THREE.Vector3();
  for (const axis of ['x', 'y', 'z']) {
    const d = end[axis] - start[axis];
    if (Math.abs(d) < 1e-12) {
      // A tangent resting on an expanded face cannot block a parallel movement.
      if (ignoreInside ? start[axis] <= min[axis] + EPS || start[axis] >= max[axis] - EPS : start[axis] < min[axis] || start[axis] > max[axis]) return null;
      continue;
    }
    let near = (min[axis] - start[axis]) / d, far = (max[axis] - start[axis]) / d;
    let sign = -1;
    if (near > far) { [near, far] = [far, near]; sign = 1; }
    if (near > enter) { enter = near; normal.set(0, 0, 0); normal[axis] = sign; }
    leave = Math.min(leave, far);
    if (enter > leave + EPS) return null;
  }
  if (leave < 0 || enter > 1 || (ignoreInside && enter < -EPS)) return null;
  return { t: Math.max(0, enter), normal };
}

export function createStage() {
  const meshes = new THREE.Group(); meshes.name = 'ABANDONED / NORTH INDUSTRIAL COMPLEX';
  const sectors = [], colliders = [], enemySpawns = [], barriers = [];
  const connections = [], requiredAscents = [], branches = [], routePoints = [], arrowPositions = [];
  const bins = new Map(), batches = new Map(), navigationCache = new Map();
  let sequence = 0, guardCount = 0, turretCount = 0, z = 0, gateRevision = 0;
  const materials = {
    floor: new THREE.MeshStandardMaterial({ color: 0x46534e, roughness: 0.92, metalness: 0.16 }),
    wall: new THREE.MeshStandardMaterial({ color: 0x34433e, roughness: 0.9, metalness: 0.25 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x26332f, roughness: 0.8, metalness: 0.2 }),
    beam: new THREE.MeshStandardMaterial({ color: 0x55655d, roughness: 0.65, metalness: 0.5 }),
    machine: new THREE.MeshStandardMaterial({ color: 0x697669, roughness: 0.65, metalness: 0.5 }),
    crate: new THREE.MeshStandardMaterial({ color: 0x877a59, roughness: 0.9, metalness: 0.2 }),
    rust: new THREE.MeshStandardMaterial({ color: 0xb16a38, roughness: 0.82, metalness: 0.4 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1e2b28, roughness: 0.65, metalness: 0.55 }),
    light: new THREE.MeshStandardMaterial({ color: 0xcad7ac, emissive: 0xaec692, emissiveIntensity: 1.3 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xff8c44, emissive: 0xd76021, emissiveIntensity: 1.25 }),
    exit: new THREE.MeshStandardMaterial({ color: 0x8ef3b3, emissive: 0x5cda94, emissiveIntensity: 1.8 }),
    gate: new THREE.MeshStandardMaterial({ color: 0xae6439, roughness: 0.66, metalness: 0.7, emissive: 0x4a1608, emissiveIntensity: 0.3 }),
  };
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const v = (a) => new THREE.Vector3(...a);
  function addBox(sector, name, min, max, material = 'wall', options = {}) {
    const collider = { id: `${sector?.id || 'facility'}:${name}:${sequence++}`, name, sectorId: sector?.id || null, min: v(min), max: v(max), active: true, material, ...options };
    colliders.push(collider);
    if (sector) sector.colliders.push(collider);
    for (let bx = Math.floor(min[0] / BIN); bx <= Math.floor(max[0] / BIN); bx++) for (let bz = Math.floor(min[2] / BIN); bz <= Math.floor(max[2] / BIN); bz++) {
      const key = `${bx},${bz}`;
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(collider);
    }
    if (options.dynamic) {
      const mesh = new THREE.Mesh(boxGeometry, materials[material]);
      mesh.position.copy(collider.min).add(collider.max).multiplyScalar(0.5);
      mesh.scale.copy(collider.max).sub(collider.min); mesh.receiveShadow = true;
      mesh.name = collider.id; meshes.add(mesh); collider.mesh = mesh;
    } else {
      const key = `${sector?.id || 'facility'}:${material}`;
      if (!batches.has(key)) batches.set(key, { sector, material, solids: [] });
      batches.get(key).solids.push(collider);
    }
    return collider;
  }
  function solid(s, name, x, y, cz, width, height, depth, material = 'machine') {
    return addBox(s, name, [x - width / 2, y, cz - depth / 2], [x + width / 2, y + height, cz + depth / 2], material);
  }
  function label(s, text, x, y, cz, scale = 10, color = '#d4debb') {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 192;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.fillStyle = '#142b26'; ctx.fillRect(0, 0, 768, 192);
    ctx.fillStyle = '#f39453'; ctx.fillRect(0, 0, 16, 192);
    ctx.fillStyle = color; ctx.font = 'bold 58px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 390, 96, 730);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(scale * 4, scale), material);
    panel.position.set(x, y, cz); panel.rotation.y = Math.PI; panel.name = `sign:${s.id}`; meshes.add(panel);
  }
  function candidates(a, b, radius = 0) {
    const result = new Set();
    for (let bx = Math.floor((Math.min(a.x, b.x) - radius) / BIN); bx <= Math.floor((Math.max(a.x, b.x) + radius) / BIN); bx++) for (let bz = Math.floor((Math.min(a.z, b.z) - radius) / BIN); bz <= Math.floor((Math.max(a.z, b.z) + radius) / BIN); bz++) {
      for (const collider of bins.get(`${bx},${bz}`) || []) if (collider.active) result.add(collider);
    }
    return result;
  }

  for (let index = 0; index < ROOM_SPECS.length; index++) {
    const [id, name, type, width, length, floorY, guards, turrets] = ROOM_SPECS[index];
    const roofY = floorY + (ARENA_INDICES.includes(index) ? 29 : index === 3 || index === 9 ? 32 : 22);
    const s = { id, name, type, index, width, length, floorY, roofY, startZ: z, endZ: z + length, bounds: { min: [-width / 2, floorY, z], max: [width / 2, roofY, z + length] }, colliders: [], connections: [] };
    sectors.push(s); z += length;
    addBox(s, 'foundation', [-width / 2 - 2, -4, s.startZ], [width / 2 + 2, floorY, s.endZ], 'floor');
    addBox(s, 'west exterior', [-width / 2 - 2, -4, s.startZ], [-width / 2, roofY + 2, s.endZ], 'wall');
    addBox(s, 'east exterior', [width / 2, -4, s.startZ], [width / 2 + 2, roofY + 2, s.endZ], 'wall');
    addBox(s, 'continuous roof', [-width / 2 - 2, roofY, s.startZ], [width / 2 + 2, roofY + 2, s.endZ], 'roof');
    // Raised structural frames are tangible architecture, clear of the flight route.
    for (let zz = s.startZ + 18; zz < s.endZ - 12; zz += 30) {
      solid(s, 'roof truss', 0, roofY - 2, zz, width, 2, 1.1, 'beam');
      for (const x of [-width / 2 + 1.3, width / 2 - 1.3]) solid(s, 'frame column', x, floorY, zz, 2.5, roofY - floorY, 2.5, 'beam');
      solid(s, 'overhead luminaires', 0, roofY - 2.5, zz, 12, 0.3, 1.4, 'light');
    }
    // High wall conduits, luminous navigation edge strips, and overhead gantries.
    for (const side of [-1, 1]) {
      solid(s, 'trunk conduit', side * (width / 2 - 1.1), floorY + 12, (s.startZ + s.endZ) / 2, 0.7, 0.7, length - 10, 'rust');
      solid(s, 'edge light', side * (width / 2 - 0.2), floorY + 1, (s.startZ + s.endZ) / 2, 0.15, 0.16, length - 8, 'light');
    }
    routePoints.push([0, floorY, s.startZ + 7], [0, floorY, s.endZ - 8]);
    label(s, `${String(index + 1).padStart(2, '0')} / ${id.toUpperCase()}`, 0, floorY + 15, s.endZ - 2, 3.6);
  }

  function portal(s, next, zz, name) {
    const floor = Math.max(s.floorY, next.floorY), roof = Math.max(s.roofY, next.roofY);
    const width = Math.max(s.width, next.width);
    addBox(s, `${name} west pier`, [-width / 2 - 2, -4, zz - 1], [-9, roof + 2, zz + 1], 'beam');
    addBox(s, `${name} east pier`, [9, -4, zz - 1], [width / 2 + 2, roof + 2, zz + 1], 'beam');
    addBox(s, `${name} lintel`, [-9, floor + 12, zz - 1], [9, roof + 2, zz + 1], 'beam');
    for (const x of [-8.7, 8.7]) solid(s, 'portal guide', x, floor, zz - 1.05, 0.18, 11.5, 0.12, 'orange');
    return { min: [-9, floor, zz - 1], max: [9, floor + 12, zz + 1] };
  }
  addBox(sectors[0], 'sealed loading wall', [-34, -4, -2], [34, sectors[0].roofY + 2, 0], 'wall');
  addBox(sectors.at(-1), 'sealed evacuation end', [-34, -4, z], [34, 72, z + 2], 'wall');
  for (let i = 0; i < sectors.length - 1; i++) {
    const s = sectors[i], next = sectors[i + 1], opening = portal(s, next, s.endZ, 'intersector doorway');
    const connection = { from: s.id, to: next.id, opening, position: [0, next.floorY, s.endZ], barrierId: null };
    if (next.floorY > s.floorY) {
      const ascent = { id: `ascent-${requiredAscents.length + 1}`, from: s.id, to: next.id, rise: next.floorY - s.floorY, lower: [0, s.floorY, s.endZ - 7], upper: [0, next.floorY, s.endZ + 7], landingDepth: 14, opening };
      requiredAscents.push(ascent);
      label(s, `FLIGHT +${ascent.rise}M / SPACE`, 0, s.floorY + 5, s.endZ - 1.08, 2.15, '#ffa068');
    }
    if (CONTROL_INDICES.includes(i)) {
      const number = CONTROL_INDICES.indexOf(i) + 1;
      const barrier = { id: `barrier-${number}`, controlId: `control-${number}`, sectorId: s.id, open: false, position: [0, next.floorY + 6, s.endZ], opening };
      barrier.collider = addBox(s, barrier.id, opening.min, opening.max, 'gate', { dynamic: true, barrierId: barrier.id });
      barrier.mesh = barrier.collider.mesh; barriers.push(barrier); connection.barrierId = barrier.id;
    }
    connections.push(connection); s.connections.push(next.id); next.connections.push(s.id);
  }

  // Distinct machines and floor plans. Arenas retain broad clear firing courts.
  for (const s of sectors) {
    const f = s.floorY, mid = (s.startZ + s.endZ) / 2, w = s.width;
    if (s.index === 0) {
      // Protected receiving pocket; ninety metres of floor permits practicing movement.
      solid(s, 'shipping containers west', -22, f, mid, 12, 7, 52, 'crate');
      solid(s, 'shipping containers east', 22, f, mid, 12, 9, 60, 'dark');
      solid(s, 'spawn shielding baffle', 0, f, s.endZ - 15, 24, 9, 3, 'machine');
      label(s, 'NORTH / RECEIVING', 0, 12, 1, 3.7);
    } else if (s.index === 1) {
      for (const [x, dz, h] of [[-40, 20, 5], [39, 30, 7], [-40, 90, 9], [38, 102, 6]]) solid(s, 'scrap stacks', x, f, s.startZ + dz, 12, h, 13, 'crate');
      solid(s, 'suspended scrap magnet', -26, f + 16, mid + 8, 8, 4, 8, 'dark');
    } else if (LOOP_INDICES.includes(s.index)) {
      // Each island extends floor-to-roof: flying cannot collapse these branches.
      const dz = s.index === 4 ? 76 : 82, islandZ = s.startZ + dz;
      const islandWidth = s.index === 4 ? 12 : 16, islandDepth = 28;
      solid(s, 'branch machine core', 0, f, islandZ, islandWidth, s.roofY - f, islandDepth, s.index === 8 ? 'dark' : 'machine');
      for (const side of [-1, 1]) {
        solid(s, 'machine service panel', side * (islandWidth / 2 + 0.35), f + 2, islandZ, 0.7, 5, 17, 'rust');
        solid(s, 'machine status band', side * (islandWidth / 2 + 0.72), f + 8, islandZ, 0.08, 0.28, 17, 'light');
      }
      // West maintenance lane is longer and broken by cover; east lane is exposed.
      for (const d of [-9, 10]) solid(s, 'west maintenance cover', -30, f, islandZ + d, 9, 5, 6, 'crate');
      const split = [0, f, islandZ - 22], join = [0, f, islandZ + 23];
      branches.push({ id: `branch-${branches.length + 1}`, sectorId: s.id, split, join, exposed: [split, [18, f, islandZ - 21], [18, f, islandZ + 22], join], covered: [split, [-40, f, islandZ - 21], [-40, f, islandZ + 22], join], loop: true, island: { min: [-islandWidth / 2, f, islandZ - 14], max: [islandWidth / 2, s.roofY, islandZ + 14] } });
    } else if (s.index === 3 || s.index === 9) {
      for (const side of [-1, 1]) {
        solid(s, 'lift counterweight rail', side * 14, f, mid, 2, s.roofY - f, 3, 'rust');
        solid(s, 'counterweight', side * 14, f + 8, mid, 4, 9, 8, 'machine');
      }
      solid(s, 'shaft bridge', 0, f + 17, mid + 15, 36, 1.3, 7, 'beam');
    } else if (s.index === 5) {
      for (const side of [-1, 1]) for (const dz of [30, 63]) solid(s, 'inspection booth', side * 26, f, s.startZ + dz, 11, 7, 15, 'machine');
      solid(s, 'scan gantry', 0, f + 13, mid, 58, 2, 8, 'rust');
    } else if (s.index === 6) {
      for (const side of [-1, 1]) for (const dz of [25, 65, 95]) {
        solid(s, 'valve bank', side * 16, f, s.startZ + dz, 8, 9, 12, 'dark');
        solid(s, 'conduit riser', side * 15, f + 9, s.startZ + dz, 2, 10, 2, 'rust');
      }
    } else if (s.index === 7) {
      for (const side of [-1, 1]) for (const dz of [35, 95]) {
        solid(s, 'generator casing', side * 43, f, s.startZ + dz, 14, 9, 23, 'machine');
        solid(s, 'generator cooling crown', side * 43, f + 9, s.startZ + dz, 12, 2, 19, 'rust');
      }
      // A real mezzanine with a traversable floor below and landing space above.
      const platformZ = s.startZ + 103;
      solid(s, 'service mezzanine', -31, f + 10, platformZ, 22, 1.2, 24, 'beam');
      for (const x of [-40, -22]) for (const dz of [-10, 10]) solid(s, 'mezzanine column', x, f, platformZ + dz, 1.5, 10, 1.5, 'beam');
      s.mezzanine = { min: [-42, f + 11.2, platformZ - 12], max: [-20, f + 11.2, platformZ + 12], underFloorY: f };
    } else if (s.index === 10) {
      for (const side of [-1, 1]) {
        solid(s, 'freight conveyor', side * 22, f, mid, 11, 2.5, 78, 'dark');
        for (let dz = 25; dz < s.length - 15; dz += 20) solid(s, 'conveyor cargo', side * 22, f + 2.5, s.startZ + dz, 8, 5, 9, 'crate');
      }
    } else if (s.index === 11) {
      for (const side of [-1, 1]) {
        solid(s, 'furnace vessel', side * 44, f, mid, 15, 17, 34, 'dark');
        solid(s, 'furnace glow', side * 35.9, f + 4, mid, 0.2, 6, 25, 'orange');
        solid(s, 'overhead service bridge', side * 35, f + 20, mid + 16, 30, 1.5, 6, 'rust');
      }
    } else if (s.index === 12) {
      for (const side of [-1, 1]) for (const dz of [27, 65, 103]) {
        solid(s, 'freight rack', side * 31, f, s.startZ + dz, 22, 12, 19, 'beam');
        solid(s, 'pallet faces', side * 19.8, f + 2, s.startZ + dz, 0.2, 7, 16, 'crate');
      }
    } else if (s.index === 13) {
      solid(s, 'crane trolley', -19, f + 13, mid, 13, 6, 15, 'rust');
      solid(s, 'crane gantry', 0, f + 19, mid, w, 2, 9, 'beam');
      solid(s, 'staged turbine', 23, f, mid - 12, 17, 11, 25, 'machine');
      solid(s, 'freight shelter', -24, f, mid + 20, 12, 6, 12, 'crate');
    } else if (s.index === 14) {
      for (const side of [-1, 1]) for (const dz of [28, 67, 95]) solid(s, 'ventilation cabinet', side * 20, f, s.startZ + dz, 10, 9, 16, 'machine');
      solid(s, 'roof cross brace', 0, f + 15, mid, w, 1, 8, 'rust');
    } else if (s.index === 15) {
      for (const side of [-1, 1]) {
        solid(s, 'control dais', side * 28, f, mid, 13, 2, 20, 'beam');
        solid(s, 'abandoned console', side * 28, f + 2, mid + 5, 12, 3, 4, 'dark');
        solid(s, 'console signal', side * 28, f + 4, mid + 2.9, 10, 0.2, 0.15, 'light');
      }
    } else if (s.index === 16) {
      for (const side of [-1, 1]) solid(s, 'evacuation signal', side * 10, f + 1, s.endZ - 12, 0.6, 8, 0.6, 'exit');
    }
    if (ARENA_INDICES.includes(s.index)) {
      // This measured court does not intersect machines or columns.
      s.arena = { min: [-31, f, s.startZ + 10], max: [31, f + 12, s.startZ + 60], width: 62, depth: 50, engagementPoint: [0, f + 2.2, s.startZ + 28] };
    }
    const [, , , , , , guards, turrets] = ROOM_SPECS[s.index];
    const guardPositions = [[-24, 41], [24, 45], [2, 55]];
    for (let j = 0; j < guards; j++) {
      let [x, dz] = guardPositions[j];
      if (w < 65) x = j === 0 ? -6 : 6;
      if (s.index === 12) x = j === 0 ? -8 : 8;
      if (s.index === 13 || s.index === 15) x = -7;
      enemySpawns.push({ id: `guard-${String(++guardCount).padStart(2, '0')}`, kind: 'guard', isGateControl: false, sectorId: s.id, position: [x, f + 2, s.startZ + dz] });
    }
    for (let j = 0; j < turrets; j++) {
      const control = CONTROL_INDICES.includes(s.index) && j === turrets - 1;
      const controlNumber = CONTROL_INDICES.indexOf(s.index) + 1;
      let x = j === 0 ? 25 : -24, dz = j === 0 ? 57 : 51;
      if (w < 65) { x = 7; dz = 77; }
      if (s.index === 5) { x = j === 0 ? 11 : -11; dz = 76; }
      if (s.index === 13) { x = 4; dz = 78; }
      if (s.index === 15) { x = j === 0 ? 12 : -12; dz = 78; }
      const id = control ? `control-${controlNumber}` : `turret-${String(++turretCount).padStart(2, '0')}`;
      enemySpawns.push({ id, kind: 'turret', isGateControl: control, sectorId: s.id, position: [x, f + 2, s.startZ + dz], ...(control ? { barrierId: `barrier-${controlNumber}` } : {}) });
      if (control) {
        solid(s, 'control turret direction marker', x, f + 7, s.startZ + dz + 3, 4, 0.25, 0.4, 'orange');
        label(s, `CONTROL 0${controlNumber}`, x, f + 10, s.startZ + dz + 3, 1.2, '#ffa068');
      }
    }
  }

  const last = sectors.at(-1), gateZ = last.endZ - 32;
  const finalOpening = portal(last, last, gateZ, 'final gate frame');
  const finalGate = { id: 'final-gate', controlId: null, open: false, position: [0, last.floorY + 6, gateZ] };
  finalGate.collider = addBox(last, 'final-gate', finalOpening.min, finalOpening.max, 'gate', { dynamic: true, barrierId: 'final-gate' }); finalGate.mesh = finalGate.collider.mesh;
  label(last, 'EVACUATION / NORTH', 0, last.floorY + 13.5, gateZ - 1.1, 2.7, '#a4ffc0');
  const spawn = new THREE.Vector3(0, 0, 12);
  const escape = { min: new THREE.Vector3(-27, 48, last.endZ - 16), max: new THREE.Vector3(27, 66, last.endZ - 3) };
  // Explicit physically usable walkthrough: steer around the receiving baffle
  // and each machine island, then rise before translating across a raised sill.
  routePoints.length = 0; routePoints.push(spawn.toArray());
  for (const s of sectors) {
    if (s.index === 0) routePoints.push([0, 0, 65], [14, 0, 65], [14, 0, 89], [0, 0, 90]);
    else routePoints.push([0, s.floorY, s.startZ + 7]);
    const branch = branches.find(item => item.sectorId === s.id);
    if (branch) routePoints.push(...branch.exposed.map(point => [...point]));
    const ascent = requiredAscents.find(item => item.from === s.id);
    if (ascent) routePoints.push([...ascent.lower], [0, s.floorY + 8.15, s.endZ - 7], [0, s.floorY + 8.15, s.endZ + 7]);
    else routePoints.push([0, s.floorY, s.index === 16 ? escape.min.z + 3 : s.endZ - 8]);
  }
  for (let i = 1; i < routePoints.length; i++) {
    const a = v(routePoints[i - 1]), b = v(routePoints[i]);
    const distance = Math.hypot(b.x - a.x, b.z - a.z);
    if (distance < 2) continue;
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    for (let offset = 3; offset < distance; offset += 14) {
      const point = a.clone().lerp(b, offset / distance);
      const floor = sectors.find(s => point.z >= s.startZ && point.z < s.endZ)?.floorY ?? a.y;
      point.y = floor + 0.025; arrowPositions.push({ point, yaw });
    }
  }

  const matrix = new THREE.Matrix4(), center = new THREE.Vector3(), scale = new THREE.Vector3(), rotation = new THREE.Quaternion();
  const arrowMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.8, 2.5, 3), materials.orange, arrowPositions.length);
  const flatArrow = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  arrowPositions.forEach(({ point, yaw }, i) => { const arrowRotation = new THREE.Quaternion().setFromAxisAngle(UP, yaw).multiply(flatArrow); matrix.compose(point, arrowRotation, new THREE.Vector3(1, 1, 0.015)); arrowMesh.setMatrixAt(i, matrix); });
  arrowMesh.instanceMatrix.needsUpdate = true; arrowMesh.computeBoundingSphere(); arrowMesh.name = 'painted route arrows'; meshes.add(arrowMesh);
  for (const { material, solids } of batches.values()) {
    const mesh = new THREE.InstancedMesh(boxGeometry, materials[material], solids.length);
    solids.forEach((c, i) => { center.copy(c.min).add(c.max).multiplyScalar(0.5); scale.copy(c.max).sub(c.min); matrix.compose(center, rotation, scale); mesh.setMatrixAt(i, matrix); });
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); mesh.receiveShadow = true; mesh.name = `${solids[0].sectorId}:${material}`; meshes.add(mesh);
  }

  function sectorAt(position) {
    return sectors.find(s => position.x >= s.bounds.min[0] - EPS && position.x <= s.bounds.max[0] + EPS && position.z >= s.startZ - EPS && position.z < s.endZ + EPS && position.y >= s.floorY - 0.15 && position.y <= s.roofY + EPS) || null;
  }
  function sectorXZ(position) { return sectors.find(s => position.x >= -s.width / 2 && position.x <= s.width / 2 && position.z >= s.startZ && position.z <= s.endZ) || null; }
  function raycast(start, end, radius = 0) {
    let best = null;
    for (const c of candidates(start, end, radius)) {
      const min = c.min.clone().addScalar(-radius), max = c.max.clone().addScalar(radius);
      const hit = segmentBox(start, end, min, max);
      if (hit && (!best || hit.t < best.t)) best = { ...hit, point: start.clone().lerp(end, hit.t), collider: c };
    }
    return best;
  }
  function moveBody(position, velocity, dt, radius = 1.15, height = 4.5) {
    let remaining = velocity.clone().multiplyScalar(dt), grounded = false;
    for (let iteration = 0; iteration < 5 && remaining.lengthSq() > 1e-15; iteration++) {
      const end = position.clone().add(remaining);
      let best = null;
      for (const c of candidates(position, end, radius)) {
        const min = c.min.clone().sub(new THREE.Vector3(radius, height, radius));
        const max = c.max.clone().add(new THREE.Vector3(radius, 0, radius));
        const hit = segmentBox(position, end, min, max, true);
        if (hit && (!best || hit.t < best.t)) best = hit;
      }
      if (!best) { position.copy(end); break; }
      const travel = Math.max(0, best.t - 1e-7 / Math.max(1, remaining.length()));
      position.addScaledVector(remaining, travel);
      remaining.multiplyScalar(1 - travel);
      const dot = remaining.dot(best.normal); if (dot < 0) remaining.addScaledVector(best.normal, -dot);
      const velocityDot = velocity.dot(best.normal); if (velocityDot < 0) velocity.addScaledVector(best.normal, -velocityDot);
      if (best.normal.y > 0.5) grounded = true;
    }
    if (!grounded && velocity.y <= EPS) {
      for (const c of candidates(position, position, radius)) {
        if (position.x + radius > c.min.x + EPS && position.x - radius < c.max.x - EPS && position.z + radius > c.min.z + EPS && position.z - radius < c.max.z - EPS && Math.abs(position.y - c.max.y) < 0.015) { grounded = true; break; }
      }
    }
    return { grounded };
  }
  function setGate(gate, open) {
    if (gate.open === open) return;
    gate.open = open; gate.collider.active = !open; gate.mesh.visible = !open;
    gateRevision++; navigationCache.clear();
  }
  function updateControls(enemies) {
    const states = new Map(enemies.map(enemy => [enemy.id, enemy]));
    for (const gate of barriers) {
      const control = states.get(gate.controlId);
      setGate(gate, !!control && control.alive === false && control.hp <= 0);
    }
    setGate(finalGate, barriers.every(gate => gate.open));
  }

  // A* over actual body-clear cells. Nodes are reconstructed at the room's real
  // floor height; a non-flying guard cannot navigate up an eight-metre riser.
  function cellPosition(ix, iz) {
    const position = new THREE.Vector3(ix * CELL, 0, iz * CELL);
    const sector = sectorXZ(position); if (!sector) return null;
    position.y = sector.floorY + 2; return position;
  }
  function clearBody(centerPoint, radius) {
    for (const c of candidates(centerPoint, centerPoint, radius)) {
      if (c.max.y <= centerPoint.y - 1.8 + EPS || c.min.y >= centerPoint.y + 2 - EPS) continue;
      if (centerPoint.x + radius > c.min.x && centerPoint.x - radius < c.max.x && centerPoint.z + radius > c.min.z && centerPoint.z - radius < c.max.z) return false;
    }
    return true;
  }
  function closestCell(point, radius) {
    const ix = Math.round(point.x / CELL), iz = Math.round(point.z / CELL);
    let best = null;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const pos = cellPosition(ix + dx, iz + dz);
      if (!pos || Math.abs(pos.y - point.y) > 5 || !clearBody(pos, radius) || raycast(point, pos, radius)) continue;
      const distance = pos.distanceToSquared(point);
      if (!best || distance < best.distance) best = { ix: ix + dx, iz: iz + dz, pos, distance, key: `${ix + dx},${iz + dz}` };
    }
    return best;
  }
  function findPath(from, to, radius = 1.5, maxDistance = Infinity) {
    const a = closestCell(from, radius), b = closestCell(to, radius);
    if (!a || !b || Math.abs(a.pos.y - b.pos.y) > 0.1) return null;
    const key = `${a.key}/${b.key}/${radius}/${gateRevision}/${maxDistance}`;
    if (navigationCache.has(key)) return navigationCache.get(key);
    const heuristic = n => Math.hypot(n.ix - b.ix, n.iz - b.iz) * CELL;
    const frontier = [{ ...a, g: 0, f: heuristic(a) }], best = new Map([[a.key, 0]]), previous = new Map(), nodeMap = new Map([[a.key, a]]);
    let result = null, visited = 0;
    while (frontier.length && visited++ < 4500) {
      let pick = 0; for (let i = 1; i < frontier.length; i++) if (frontier[i].f < frontier[pick].f) pick = i;
      const current = frontier.splice(pick, 1)[0];
      if (current.g > best.get(current.key) + EPS) continue;
      if (current.key === b.key) {
        const path = [current.pos]; let cursor = current.key;
        while (previous.has(cursor)) { cursor = previous.get(cursor); path.unshift(nodeMap.get(cursor).pos); }
        result = { points: path, distance: current.g }; break;
      }
      if (current.g > maxDistance + CELL * 4) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const ix = current.ix + dx, iz = current.iz + dz, nextKey = `${ix},${iz}`;
        const pos = cellPosition(ix, iz); if (!pos || Math.abs(pos.y - current.pos.y) > 0.1 || !clearBody(pos, radius)) continue;
        // Swept LOS prevents diagonal corner cutting and crossing closed gates.
        if (raycast(current.pos, pos, radius)) continue;
        const g = current.g + CELL * Math.hypot(dx, dz);
        if (g >= (best.get(nextKey) ?? Infinity) - EPS) continue;
        const node = { ix, iz, key: nextKey, pos, g }; node.f = g + heuristic(node);
        best.set(nextKey, g); previous.set(nextKey, current.key); nodeMap.set(nextKey, node); frontier.push(node);
      }
    }
    if (navigationCache.size > 400) navigationCache.clear();
    navigationCache.set(key, result); return result;
  }
  function navigationDirection(from, to, radius = 1.5) {
    const flatTarget = to.clone(); flatTarget.y = from.y;
    const direct = flatTarget.clone().sub(from); direct.y = 0;
    if (direct.lengthSq() < 0.01) return new THREE.Vector3();
    if (!raycast(from, flatTarget, radius) && clearBody(flatTarget, radius)) return direct.normalize();
    const path = findPath(from, flatTarget, radius); if (!path) return new THREE.Vector3();
    let next = null;
    for (const point of path.points.slice(0, 8)) { if (!raycast(from, point, radius)) next = point; }
    if (!next) return new THREE.Vector3();
    const direction = next.clone().sub(from); direction.y = 0; return direction.normalize();
  }
  function pathDistance(from, to, maxDistance = Infinity) {
    if (from.distanceTo(to) > maxDistance) return Infinity;
    if (!raycast(from, to, 1.5)) return from.distanceTo(to);
    const path = findPath(from, to, 1.5, maxDistance);
    return path ? from.distanceTo(path.points[0]) + path.distance + to.distanceTo(path.points.at(-1)) : Infinity;
  }

  return {
    meshes, sectors, enemySpawns, barriers, finalGate, colliders, connections, requiredAscents, branches, routePoints, spawn, escape,
    shortestDistanceLowerBound: escape.min.z - spawn.z,
    get gateOpen() { return finalGate.open; },
    raycast, lineOfSight: (a, b) => !raycast(a, b), moveBody, sectorAt, updateControls, navigationDirection, pathDistance,
    isConnectedWithin: (a, b, distance) => pathDistance(a, b, distance) <= distance,
    isEscape: (position) => finalGate.open && position.x >= escape.min.x && position.x <= escape.max.x && position.y >= escape.min.y - 0.1 && position.y <= escape.max.y && position.z >= escape.min.z && position.z <= escape.max.z,
    reset() { for (const gate of [...barriers, finalGate]) setGate(gate, false); },
    dispose() { meshes.traverse(object => { if (object.isMesh && object.geometry !== boxGeometry) { object.geometry.dispose(); if (object.material.map) { object.material.map.dispose(); object.material.dispose(); } } }); boxGeometry.dispose(); Object.values(materials).forEach(material => material.dispose()); },
  };
}
