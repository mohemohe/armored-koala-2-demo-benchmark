import * as THREE from 'three';
import { boxFromCenterSize } from './collision.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONTROL_TURRETS, BARRIER_FOR_CONTROL } from './config.js';

export const MAIN_ROUTE = Object.freeze(Array.from({ length: 18 }, (_, i) => `S${String(i).padStart(2, '0')}`));
export const SECTOR_NAMES = [
  '搬入格納庫', '資材ヤード', '圧延制御室', '圧延棟・上層', 'ロール保守室', '第一搬出制御',
  '組立ライン', '組立上層', '検査棟', '精密検査室', '検査上層', '第二搬出制御',
  '地下搬送区画', '動力上層', '動力制御室', '主製造ホール', '冷却制御室', '最終搬出ホール',
  '資材迂回路', '組立迂回路', '動力迂回路',
];
const KINDS = [' garage', 'yard', 'control', 'mill', 'maintenance', 'control', 'assembly', 'upper', 'inspection', 'laboratory', 'upper', 'control', 'underground', 'power', 'control', 'hall', 'cooling', 'shipping', 'warehouse', 'pipe', 'warehouse'];
const HEIGHTS = [0, 0, 0, 16, 8, 0, 0, 8, 0, 0, 16, 8, 0, 8, 0, 16, 8, 16];

function sectorDefinitions() {
  const result = [];
  for (let i = 0; i < 18; i++) {
    let x, z;
    if (i <= 5) { x = i * 100; z = 0; }
    else if (i <= 11) { x = (11 - i) * 100; z = 120; }
    else { x = (i - 12) * 100; z = 240; }
    const wide = [1, 3, 6, 9, 12, 15].includes(i);
    result.push({
      id: MAIN_ROUTE[i], name: SECTOR_NAMES[i], kind: KINDS[i].trim(), index: i,
      center: [x, HEIGHTS[i], z], floorY: HEIGHTS[i],
      width: wide ? 88 : 80, depth: wide ? 76 : 68,
    });
  }
  result.push(
    { id: 'A18', name: SECTOR_NAMES[18], kind: 'warehouse', index: 18, center: [150, 0, -78], floorY: 0, width: 50, depth: 38 },
    { id: 'A19', name: SECTOR_NAMES[19], kind: 'pipe', index: 19, center: [450, 0, 198], floorY: 0, width: 50, depth: 38 },
    { id: 'A20', name: SECTOR_NAMES[20], kind: 'warehouse', index: 20, center: [50, 0, 318], floorY: 0, width: 50, depth: 38 },
  );
  for (const s of result) {
    s.minX = s.center[0] - s.width / 2; s.maxX = s.center[0] + s.width / 2;
    s.minZ = s.center[2] - s.depth / 2; s.maxZ = s.center[2] + s.depth / 2;
    s.roofY = s.floorY + 22;
    s.openings = { north: [], south: [], east: [], west: [] };
  }
  return result;
}

export class FactoryStage {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'Continuous abandoned factory — 21 sectors';
    scene.add(this.group);
    this.sectors = sectorDefinitions();
    this.sectorMap = new Map(this.sectors.map(s => [s.id, s]));
    this.colliders = [];
    this.barriers = new Map();
    this.connections = [];
    this.enemySpawns = [];
    // Conservative portal-to-portal lower bound; obstacles and 8–16 m ascents only add distance.
    this.shortestPathMeters = 1731.314884287121;
    this.escapeZone = { min: [580, 15, 224], max: [618, 43, 256] };
    this.materials = this.createMaterials();
    this.buildConnections();
    this.prepareSpecialOpenings();
    this.buildRooms();
    this.buildCorridors();
    this.buildBranches();
    this.buildEscape();
    this.buildSectorDetails();
    this.spawnEnemies();
    this.buildNavigationMarkers();
    this.batchStaticGeometry();
  }

  batchStaticGeometry() {
    const batches = new Map();
    for (const mesh of [...this.group.children]) {
      if (!mesh.isMesh || mesh.userData.dynamic || Array.isArray(mesh.material)) continue;
      const key = mesh.material.uuid;
      if (!batches.has(key)) batches.set(key, { material: mesh.material, meshes: [] });
      batches.get(key).meshes.push(mesh);
    }
    for (const { material, meshes } of batches.values()) {
      if (meshes.length < 2) continue;
      const geometries = meshes.map(mesh => {
        mesh.updateMatrix();
        return mesh.geometry.clone().applyMatrix4(mesh.matrix);
      });
      const merged = mergeGeometries(geometries, false);
      geometries.forEach(g => g.dispose());
      if (!merged) continue;
      for (const mesh of meshes) this.group.remove(mesh);
      const combined = new THREE.Mesh(merged, material);
      combined.name = `static-batch-${material.uuid}`; combined.receiveShadow = true;
      this.group.add(combined);
    }
  }

  createMaterials() {
    const standard = (color, roughness = 0.8, metalness = 0.25, emissive = 0x000000) => new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive });
    return {
      floor: standard(0x273138, 0.92, 0.35), floorAlt: standard(0x303a3c, 0.95, 0.2),
      wall: standard(0x38444b, 0.82, 0.45), wallDark: standard(0x202b32, 0.9, 0.4),
      roof: standard(0x1a242a, 0.95, 0.3), beam: standard(0x53616a, 0.65, 0.7),
      rust: standard(0x78442d, 0.9, 0.35), machine: standard(0x405e60, 0.75, 0.6),
      pipe: standard(0x587075, 0.55, 0.75), cover: standard(0x4d5553, 0.9, 0.4),
      warning: standard(0xd78b20, 0.55, 0.3, 0x5a2500), red: standard(0x8c2922, 0.6, 0.3, 0x450400),
      stripe: standard(0xe5b642, 0.75, 0.25), white: standard(0xb8c8c9, 0.7, 0.3),
    };
  }

  addBox(center, size, material = this.materials.wall, options = {}) {
    const collider = boxFromCenterSize(center, size, { id: options.id || `C${this.colliders.length}`, kind: options.kind || 'stage', active: true });
    const geometry = new THREE.BoxGeometry(...size);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...center);
    mesh.castShadow = !!options.castShadow;
    mesh.receiveShadow = true;
    mesh.name = collider.id;
    this.group.add(mesh);
    collider.mesh = mesh;
    if (options.collider !== false) this.colliders.push(collider);
    else collider.active = false;
    return collider;
  }

  addOpening(a, side, at, width = 14) {
    a.openings[side].push({ at, width });
  }

  connect(aId, bId, options = {}) {
    const a = this.sectorMap.get(aId), b = this.sectorMap.get(bId);
    const c = { a: aId, b: bId, ...options };
    this.connections.push(c);
    if (a.center[2] === b.center[2]) {
      if (a.center[0] < b.center[0]) { this.addOpening(a, 'east', a.center[2]); this.addOpening(b, 'west', b.center[2]); }
      else { this.addOpening(a, 'west', a.center[2]); this.addOpening(b, 'east', b.center[2]); }
    } else if (a.center[0] === b.center[0]) {
      if (a.center[2] < b.center[2]) { this.addOpening(a, 'south', a.center[0]); this.addOpening(b, 'north', b.center[0]); }
      else { this.addOpening(a, 'north', a.center[0]); this.addOpening(b, 'south', b.center[0]); }
    }
    return c;
  }

  buildConnections() {
    const gates = { 2: ['B0', 'T01'], 5: ['B1', 'T04'], 8: ['B2', 'T07'], 11: ['B3', 'T10'], 14: ['B4', 'T13'], 16: ['B5', 'T15'] };
    for (let i = 0; i < 17; i++) {
      const gate = gates[i];
      this.connect(MAIN_ROUTE[i], MAIN_ROUTE[i + 1], { id: `R${i}`, main: true, barrierId: gate?.[0] || null, controlId: gate?.[1] || null });
    }
    // Three genuine, roofed loop branches. Direct connectors remain available.
    this.connect('S01', 'A18', { id: 'L0a', branch: 0, bend: 'north' });
    this.connect('A18', 'S02', { id: 'L0b', branch: 0, bend: 'north' });
    this.connect('S06', 'A19', { id: 'L1a', branch: 1, bend: 'south' });
    this.connect('A19', 'S07', { id: 'L1b', branch: 1, bend: 'south' });
    this.connect('S12', 'A20', { id: 'L2a', branch: 2, bend: 'south' });
    this.connect('A20', 'S13', { id: 'L2b', branch: 2, bend: 'south' });
  }

  prepareSpecialOpenings() {
    const pairs = [['S01', 'A18'], ['A18', 'S02'], ['S06', 'A19'], ['A19', 'S07'], ['S12', 'A20'], ['A20', 'S13']];
    for (const [aId, bId] of pairs) {
      const a = this.sectorMap.get(aId), b = this.sectorMap.get(bId);
      const main = a.index < 18 ? a : b, branch = a.index < 18 ? b : a;
      this.addOpening(main, branch.center[2] < main.center[2] ? 'north' : 'south', main.center[0], 12);
      this.addOpening(branch, main.center[0] < branch.center[0] ? 'west' : 'east', branch.center[2], 12);
    }
    const s17 = this.sectorMap.get('S17');
    this.addOpening(s17, 'east', s17.center[2], 14);
  }

  buildRooms() {
    for (const s of this.sectors) {
      const mat = s.index % 3 === 0 ? this.materials.floorAlt : this.materials.floor;
      this.addBox([s.center[0], s.floorY - 0.6, s.center[2]], [s.width, 1.2, s.depth], mat, { id: `${s.id}-floor` });
      this.addBox([s.center[0], s.roofY + 0.6, s.center[2]], [s.width, 1.2, s.depth], this.materials.roof, { id: `${s.id}-roof` });
      this.buildWall(s, 'north'); this.buildWall(s, 'south'); this.buildWall(s, 'east'); this.buildWall(s, 'west');
      // Perimeter foundation prevents entering underneath raised floors.
      const foundationHeight = Math.max(1, s.floorY + 10);
      if (s.floorY > 0) {
        const cy = s.floorY - foundationHeight / 2;
        this.addBox([s.center[0], cy, s.minZ], [s.width, foundationHeight, 1.2], this.materials.wallDark);
        this.addBox([s.center[0], cy, s.maxZ], [s.width, foundationHeight, 1.2], this.materials.wallDark);
        this.addBox([s.minX, cy, s.center[2]], [1.2, foundationHeight, s.depth], this.materials.wallDark);
        this.addBox([s.maxX, cy, s.center[2]], [1.2, foundationHeight, s.depth], this.materials.wallDark);
      }
    }
  }

  buildWall(s, side) {
    const horizontal = side === 'north' || side === 'south';
    const length = horizontal ? s.width : s.depth;
    const centerAlong = horizontal ? s.center[0] : s.center[2];
    const minAlong = centerAlong - length / 2;
    const openings = s.openings[side].map(o => ({ start: Math.max(minAlong, o.at - o.width / 2), end: Math.min(minAlong + length, o.at + o.width / 2) })).sort((a, b) => a.start - b.start);
    const fixed = horizontal ? (side === 'north' ? s.minZ : s.maxZ) : (side === 'west' ? s.minX : s.maxX);
    const addSegment = (from, to, y, height, suffix, material = this.materials.wall) => {
      if (to - from < 0.2 || height <= 0) return;
      const along = (from + to) / 2;
      const center = horizontal ? [along, y, fixed] : [fixed, y, along];
      const size = horizontal ? [to - from, height, 1.2] : [1.2, height, to - from];
      this.addBox(center, size, material, { id: `${s.id}-${side}-${suffix}` });
    };
    let cursor = minAlong;
    for (const o of openings) {
      addSegment(cursor, o.start, s.floorY + 11, 22, `solid-${cursor}`);
      addSegment(o.start, o.end, s.floorY + 17, 10, `lintel-${o.start}`, this.materials.beam);
      cursor = Math.max(cursor, o.end);
    }
    addSegment(cursor, minAlong + length, s.floorY + 11, 22, `solid-${cursor}`);
  }

  corridorBox(a, b, id, barrierId = null, controlId = null) {
    const floor = Math.min(a.floorY, b.floorY);
    const roof = Math.max(a.floorY, b.floorY) + 14;
    let center, size, axis;
    if (a.center[2] === b.center[2]) {
      axis = 'x';
      const left = Math.min(a.center[0], b.center[0]);
      const start = left === a.center[0] ? a.maxX : b.maxX;
      const end = left === a.center[0] ? b.minX : a.minX;
      center = [(start + end) / 2, floor, a.center[2]]; size = [Math.max(1, end - start), 1, 14];
    } else {
      axis = 'z';
      const near = Math.min(a.center[2], b.center[2]);
      const start = near === a.center[2] ? a.maxZ : b.maxZ;
      const end = near === a.center[2] ? b.minZ : a.minZ;
      center = [a.center[0], floor, (start + end) / 2]; size = [14, 1, Math.max(1, end - start)];
    }
    this.addCorridorSegment(center, size, floor, roof, axis, id);
    if (barrierId) this.addBarrier(center, axis, floor, roof, barrierId, controlId);
  }

  addCorridorSegment(center, size, floor, roof, axis, id) {
    this.addBox([center[0], floor - 0.5, center[2]], [size[0], 1, size[2]], this.materials.floor, { id: `${id}-floor` });
    this.addBox([center[0], roof + 0.5, center[2]], [size[0], 1, size[2]], this.materials.roof, { id: `${id}-roof` });
    const h = roof - floor;
    if (axis === 'x') {
      this.addBox([center[0], floor + h / 2, center[2] - 7], [size[0], h, 1], this.materials.wallDark);
      this.addBox([center[0], floor + h / 2, center[2] + 7], [size[0], h, 1], this.materials.wallDark);
    } else {
      this.addBox([center[0] - 7, floor + h / 2, center[2]], [1, h, size[2]], this.materials.wallDark);
      this.addBox([center[0] + 7, floor + h / 2, center[2]], [1, h, size[2]], this.materials.wallDark);
    }
  }

  addBarrier(center, axis, floor, roof, id, controlId) {
    const size = axis === 'x' ? [1.4, roof - floor, 14] : [14, roof - floor, 1.4];
    const barrier = this.addBox([center[0], floor + (roof - floor) / 2, center[2]], size, this.materials.red, { id, kind: 'barrier' });
    barrier.barrierId = id;
    barrier.controlId = controlId;
    barrier.mesh.userData.dynamic = true;
    const decorations = [];
    this.barriers.set(id, { id, controlId, collider: barrier, open: false, decorations });
    for (let i = -2; i <= 2; i++) {
      const p = axis === 'x' ? [center[0] - 0.75, floor + 3 + i * 2 + 4, center[2]] : [center[2] * 0 + center[0], floor + 3 + i * 2 + 4, center[2] - 0.75];
      const stripeSize = axis === 'x' ? [0.12, 0.45, 12] : [12, 0.45, 0.12];
      const stripe = this.addBox(p, stripeSize, this.materials.stripe, { collider: false });
      stripe.mesh.userData.dynamic = true; decorations.push(stripe.mesh);
    }
  }

  buildCorridors() {
    for (const c of this.connections.filter(c => c.main)) {
      this.corridorBox(this.sectorMap.get(c.a), this.sectorMap.get(c.b), c.id, c.barrierId, c.controlId);
    }
  }

  buildBranches() {
    const defs = [
      { a: 'S01', b: 'A18', sign: -1, id: 'L0a' }, { a: 'A18', b: 'S02', sign: 1, id: 'L0b' },
      { a: 'S06', b: 'A19', sign: 1, id: 'L1a' }, { a: 'A19', b: 'S07', sign: 1, id: 'L1b' },
      { a: 'S12', b: 'A20', sign: 1, id: 'L2a' }, { a: 'A20', b: 'S13', sign: 1, id: 'L2b' },
    ];
    for (const d of defs) {
      const a = this.sectorMap.get(d.a), b = this.sectorMap.get(d.b);
      let main, branch;
      if (a.index < 18 && b.index >= 18) { main = a; branch = b; } else { main = b; branch = a; }
      const isFirst = d.a.index < 18;
      const x = main.center[0];
      const mainEdge = branch.center[2] < main.center[2] ? main.minZ : main.maxZ;
      const branchEdge = branch.center[2] < main.center[2] ? branch.maxZ : branch.minZ;
      const floor = Math.min(main.floorY, branch.floorY), roof = Math.max(main.floorY, branch.floorY) + 14;
      const corridorZ = branch.center[2];
      const zMid = (mainEdge + corridorZ) / 2;
      if (Math.abs(corridorZ - mainEdge) > 1) {
        this.addCorridorSegment([x, floor, zMid], [12, 1, Math.abs(corridorZ - mainEdge)], floor, roof, 'z', `${d.id}-vertical`);
      }
      const xStart = x, xEnd = x < branch.center[0] ? branch.minX : branch.maxX;
      if (Math.abs(xEnd - xStart) > 1) {
        this.addCorridorSegment([(xStart + xEnd) / 2, floor, corridorZ], [Math.abs(xEnd - xStart), 1, 12], floor, roof, 'x', `${d.id}-horizontal`);
      }
    }
  }

  buildEscape() {
    const s = this.sectorMap.get('S17');
    const floor = s.floorY, roof = floor + 16;
    this.addCorridorSegment([(s.maxX + 586) / 2, floor, 240], [586 - s.maxX, 1, 14], floor, roof, 'x', 'FINAL-CORRIDOR');
    this.addBarrier([552, floor, 240], 'x', floor, roof, 'FINAL', null);
    this.addBox([600, floor - 0.6, 240], [40, 1.2, 52], this.materials.floorAlt, { id: 'ESCAPE-floor' });
    this.addBox([600, floor + 22.6, 240], [40, 1.2, 52], this.materials.roof, { id: 'ESCAPE-roof' });
    this.addBox([620, floor + 12, 240], [1.2, 24, 52], this.materials.wall);
    this.addBox([600, floor + 12, 214], [40, 24, 1.2], this.materials.wall);
    this.addBox([600, floor + 12, 266], [40, 24, 1.2], this.materials.wall);
    const exitMat = new THREE.MeshStandardMaterial({ color: 0x4affc0, emissive: 0x0a8a5c, emissiveIntensity: 2, transparent: true, opacity: 0.32 });
    const exit = new THREE.Mesh(new THREE.BoxGeometry(1, 12, 28), exitMat);
    exit.position.set(598, floor + 6, 240); this.group.add(exit); this.exitVisual = exit;
  }

  buildSectorDetails() {
    const pipeGeo = new THREE.CylinderGeometry(0.55, 0.55, 18, 10);
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffb13b, emissive: 0xff5b0b, emissiveIntensity: 2 });
    for (const s of this.sectors) {
      // Collision covers are deliberately offset from doors and spawn marks.
      if (s.index < 18 && s.index !== 0) {
        const covers = [[-12, -11, 6, 3.6, 4], [13, 12, 7, 4.5, 4], [-16, 18, 4, 6, 5]];
        for (let j = 0; j < covers.length; j++) {
          const [x, z, w, h, d] = covers[j];
          if ((s.index + j) % 2 === 0 || j < 2) this.addBox([s.center[0] + x, s.floorY + h / 2, s.center[2] + z], [w, h, d], j === 2 ? this.materials.machine : this.materials.cover, { kind: 'equipment', castShadow: true });
        }
      }
      // Roof beams, pipes, damaged plates and warning lights make each space legible.
      for (const x of [-s.width * 0.28, s.width * 0.28]) {
        this.addBox([s.center[0] + x, s.roofY - 1, s.center[2]], [1.2, 2, s.depth - 3], this.materials.beam, { collider: false });
      }
      for (const side of [-1, 1]) {
        const pipe = new THREE.Mesh(pipeGeo, this.materials.pipe);
        pipe.rotation.z = Math.PI / 2;
        pipe.position.set(s.center[0] + side * (s.width / 2 - 3), s.floorY + 7, s.center[2] - s.depth * 0.25);
        this.group.add(pipe);
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 0.6), lampMat);
        lamp.position.set(s.center[0] + side * (s.width / 2 - 2), s.floorY + 5, s.center[2] + s.depth * 0.3);
        this.group.add(lamp);
      }
      const stripeCount = Math.floor(s.width / 8);
      for (let i = 0; i < stripeCount; i += 2) {
        this.addBox([s.minX + 4 + i * 8, s.floorY + 0.025, s.maxZ - 4], [4, 0.05, 1.2], this.materials.stripe, { collider: false });
      }
      if (['mill', 'assembly', 'power', 'hall'].includes(s.kind)) {
        for (const x of [-25, 25]) {
          this.addBox([s.center[0] + x, s.floorY + 6, s.center[2] - 23], [3, 12, 3], this.materials.rust, { kind: 'equipment' });
        }
      }
      if (s.kind === 'pipe' || s.kind === 'cooling') {
        for (let i = -2; i <= 2; i++) {
          const p = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 24, 12), this.materials.pipe);
          p.rotation.x = Math.PI / 2; p.position.set(s.center[0] + i * 4, s.floorY + 3 + Math.abs(i % 2) * 3, s.center[2]); this.group.add(p);
        }
      }
    }
  }

  spawnEnemies() {
    const guardsBySector = {
      S01: 4, S02: 1, S03: 4, S04: 1, S06: 4, S07: 1,
      S09: 4, S10: 1, S12: 4, S13: 1, S15: 4, S17: 1,
    };
    const offsets = [[-22, -15], [22, 15], [-22, 18], [22, -18]];
    let gi = 1;
    for (const [sectorId, count] of Object.entries(guardsBySector)) {
      const s = this.sectorMap.get(sectorId);
      for (let j = 0; j < count; j++) {
        const o = offsets[j];
        this.enemySpawns.push({ id: `G${String(gi++).padStart(2, '0')}`, kind: 'guard', sectorId, position: [s.center[0] + o[0], s.floorY + 1.55, s.center[2] + o[1]], isGateControl: false });
      }
    }
    const turrets = [
      ['T01', 'S02', 12, 0], ['T02', 'S01', 0, 22], ['T03', 'S03', 0, -22],
      ['T04', 'S05', -12, 0], ['T05', 'S06', 0, 22], ['T06', 'S07', 0, -20],
      ['T07', 'S08', -12, 0], ['T08', 'S09', 0, 22], ['T09', 'S10', 0, -20],
      ['T10', 'S11', 12, 0], ['T11', 'S12', 0, 22], ['T12', 'S13', 0, -20],
      ['T13', 'S14', 12, 0], ['T14', 'S15', 0, 22], ['T15', 'S16', 12, 0],
    ];
    for (const [id, sectorId, x, z] of turrets) {
      const s = this.sectorMap.get(sectorId);
      this.enemySpawns.push({ id, kind: 'turret', sectorId, position: [s.center[0] + x, s.floorY + 1.7, s.center[2] + z], isGateControl: CONTROL_TURRETS.includes(id) });
    }
  }

  buildNavigationMarkers() {
    // Physical objective beacons identify controls without requiring a HUD-only distinction.
    for (const spawn of this.enemySpawns.filter(e => e.isGateControl)) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(3.1, 0.15, 8, 32), new THREE.MeshBasicMaterial({ color: 0xffb32b }));
      ring.rotation.x = Math.PI / 2; ring.position.set(spawn.position[0], spawn.position[1] + 3.5, spawn.position[2]);
      ring.name = `control-beacon-${spawn.id}`; ring.userData.dynamic = true; this.group.add(ring); spawn.beacon = ring;
    }
  }

  openBarrierForControl(controlId) {
    const id = BARRIER_FOR_CONTROL[controlId];
    if (!id) return null;
    const barrier = this.barriers.get(id);
    if (barrier && !barrier.open) {
      barrier.open = true; barrier.collider.active = false; barrier.collider.mesh.visible = false;
      barrier.decorations.forEach(mesh => { mesh.visible = false; });
    }
    return id;
  }

  setFinalGateOpen(open) {
    const barrier = this.barriers.get('FINAL');
    if (barrier && barrier.open !== open) {
      barrier.open = open; barrier.collider.active = !open; barrier.collider.mesh.visible = !open;
      barrier.decorations.forEach(mesh => { mesh.visible = !open; });
    }
  }

  reset() {
    for (const barrier of this.barriers.values()) {
      barrier.open = false; barrier.collider.active = true; barrier.collider.mesh.visible = true;
      barrier.decorations.forEach(mesh => { mesh.visible = true; });
    }
    for (const spawn of this.enemySpawns) if (spawn.beacon) spawn.beacon.visible = true;
  }

  getSector(position) {
    for (const s of this.sectors) {
      if (position.x >= s.minX && position.x <= s.maxX && position.z >= s.minZ && position.z <= s.maxZ && position.y >= s.floorY && position.y <= s.roofY + 2) return s;
    }
    return null;
  }

  getSectorAt(x, z) {
    for (const s of this.sectors) if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ) return s;
    return null;
  }

  floorHeightAt(x, z, fallback = 0) {
    const s = this.getSectorAt(x, z);
    return s ? s.floorY : fallback;
  }

  isInsideEscape(position) {
    const b = this.escapeZone;
    return position.x >= b.min[0] && position.x <= b.max[0] && position.y >= b.min[1] && position.y <= b.max[1] && position.z >= b.min[2] && position.z <= b.max[2];
  }

  getObjectiveTarget(aliveEnemies, controlsDestroyed) {
    const controls = CONTROL_TURRETS.map(id => aliveEnemies.find(e => e.id === id));
    const next = controls.find(e => e && e.alive);
    if (next) return { id: next.id, position: next.position, label: `制御砲台 ${next.id} を破壊`, sectorId: next.sectorId };
    return { id: 'ESCAPE', position: [600, 18, 240], label: controlsDestroyed >= 6 ? '最終ゲート通過・脱出' : '搬出ゲートへ', sectorId: 'S17' };
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    Object.values(this.materials).forEach(m => m.dispose());
  }
}
