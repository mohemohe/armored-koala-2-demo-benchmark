/** Physical stage definition. Coordinates are metres, Y is up. */
const ROOM_LENGTH = 160;
const EPSILON = 1e-7;
const ROOM_DEFINITIONS = [
  ['搬入口 / Intake Bay', 'bay', 110, 0, 30],
  ['資材ヤード / Materials Yard', 'yard', 110, 8, 28],
  ['圧延棟 / Rolling Mill', 'manufacturing', 110, 16, 32],
  ['搬送縦坑 / Lift Shaft', 'shaft', 64, 16, 34],
  ['組立ライン / Assembly Line', 'assembly', 110, 8, 28],
  ['検査棟 / Inspection Hall', 'inspection', 110, 0, 28],
  ['保守配管 / Pipe Service', 'pipes', 46, 0, 22],
  ['動力棟 / Power House', 'power', 110, 8, 30],
  ['冷却設備 / Cooling Plant', 'cooling', 110, 16, 30],
  ['排気縦坑 / Exhaust Shaft', 'shaft', 64, 16, 34],
  ['地下搬送 / Underground Transit', 'underground', 54, 8, 22],
  ['主製造ホール / Main Foundry', 'foundry', 120, 0, 34],
  ['出荷倉庫 / Shipping Warehouse', 'warehouse', 110, 0, 30],
  ['外周搬送 / Perimeter Transfer', 'service', 46, 8, 22],
  ['搬出ゲート / Export Gate', 'export', 110, 16, 30],
];
const CONTROL_SECTORS = new Set([1, 3, 5, 7, 10, 13]);
const FOUR_ENEMY_SECTORS = new Set([0, 2, 5, 8, 11]);
const THREE_ENEMY_SECTORS = new Set([1, 4, 7, 10, 13]);
const SPLIT_SECTORS = new Set([1, 4, 12]);
const PALETTE = ['#243b40', '#403f2c', '#384653', '#343d49', '#34434a', '#3d4a4b', '#314348', '#45443b', '#354c4a', '#3f424b', '#344047', '#4a4440', '#414947', '#36464b', '#414b4c'];

function buildStage() {
  const sectors = ROOM_DEFINITIONS.map(([name, type, width, floorY, height], index) => ({
    id: `S${String(index + 1).padStart(2, '0')}`,
    index, name, type, floorY, ceilingY: floorY + height,
    color: PALETTE[index],
    bounds: { min: [index * ROOM_LENGTH, floorY, -width / 2], max: [(index + 1) * ROOM_LENGTH, floorY + height, width / 2] },
  }));
  const boxes = [];
  const barriers = [];
  const connections = [];
  const route = [];
  const branches = [];
  const ascents = [];
  let serial = 0;
  const addBox = (sector, kind, min, max, extra = {}) => {
    const box = { id: `${sector.id}-${kind}-${++serial}`, min, max, kind, sectorId: sector.id, ...extra };
    boxes.push(box);
    return box;
  };
  const doorZ = (boundary) => {
    if (boundary === 0 || boundary === sectors.length) return 0;
    const width = Math.min(ROOM_DEFINITIONS[boundary - 1][2], ROOM_DEFINITIONS[boundary][2]);
    return Math.min(14, width / 2 - 10) * (boundary % 2 ? -1 : 1);
  };
  sectors.forEach((sector, i) => {
    const [x0, y, z0] = sector.bounds.min;
    const [x1, roof, z1] = sector.bounds.max;
    sector.entry = [x0 + 5, y + 2.1, doorZ(i)];
    sector.exit = [x1 - 5, y + 2.1, doorZ(i + 1)];
    addBox(sector, 'floor', [x0 - 1, y - 3, z0 - 2], [x1 + 1, y, z1 + 2]);
    addBox(sector, 'roof', [x0 - 1, roof, z0 - 2], [x1 + 1, roof + 2, z1 + 2]);
    addBox(sector, 'wall', [x0 - 1, y - 3, z0 - 2], [x1 + 1, roof + 2, z0]);
    addBox(sector, 'wall', [x0 - 1, y - 3, z1], [x1 + 1, roof + 2, z1 + 2]);
    route.push({ sectorId: sector.id, entry: sector.entry, exit: sector.exit, floorY: y });
    const block = (kind, xa, xb, za, zb, height, extra = {}) => addBox(sector, kind, [x0 + xa, y, za], [x0 + xb, y + height, zb], extra);

    if (SPLIT_SECTORS.has(i)) {
      // The divider reaches the roof: these are two real traversable routes,
      // not a painted fork that flight can erase.
      block('machine', 52, 116, -12, 10, roof - y, { routeDivider: true });
      block('cover', 55, 65, 26, 38, 6);
      block('cover', 90, 104, 31, 45, 7);
      block('cover', 126, 138, 18, 31, 5);
      branches.push({
        sectorId: sector.id,
        split: [x0 + 34, y + 2.1, -14],
        rejoin: [x0 + 140, y + 2.1, -14],
        exposed: [[x0 + 34, y + 2.1, -14], [x0 + 45, y + 2.1, -22], [x0 + 124, y + 2.1, -22], [x0 + 140, y + 2.1, -14]],
        covered: [[x0 + 34, y + 2.1, -14], [x0 + 43, y + 2.1, 18], [x0 + 79, y + 2.1, 22], [x0 + 119, y + 2.1, 22], [x0 + 140, y + 2.1, -14]],
        loop: true,
      });
    } else if (FOUR_ENEMY_SECTORS.has(i)) {
      // The rectangle x=30..100, z=-25..25 is deliberately unobstructed.
      sector.combatRectangle = { min: [x0 + 30, y, -25], max: [x0 + 100, y, 25] };
      block('machine', 106, 124, -16, 10, i === 11 ? 14 : 8);
      block('machine', 45, 68, 34, 45, 7);
      block('cover', 116, 130, 28, 41, 5);
      block('cover', 120, 138, -43, -30, 5);
      if (i === 8) {
        block('pillar', 100, 108, -37, -28, 18);
        block('pillar', 132, 140, 17, 26, 18);
      }
    } else if (sector.type === 'shaft') {
      block('machine', 42, 64, -20, 1, 12);
      block('platform', 67, 88, 8, 26, 8);
      block('pillar', 104, 116, -8, 5, roof - y);
      block('cover', 131, 143, 17, 29, 5);
    } else if (sector.type === 'pipes') {
      block('machine', 42, 74, -23, -4, 11);
      block('machine', 94, 122, 5, 23, 10);
      block('pillar', 130, 136, -14, -7, roof - y);
    } else if (sector.type === 'power') {
      block('machine', 38, 58, -12, 15, 11);
      block('machine', 76, 96, 18, 42, 13);
      block('cover', 113, 129, -40, -22, 7);
      block('platform', 117, 135, 17, 38, 7);
    } else if (sector.type === 'underground') {
      block('machine', 34, 72, -27, -5, roof - y);
      block('machine', 88, 124, 6, 27, roof - y);
      block('cover', 137, 149, -21, -12, 4);
    } else if (sector.type === 'service') {
      block('machine', 39, 73, -23, -4, roof - y);
      block('machine', 96, 123, 5, 23, roof - y);
      block('cover', 137, 149, -18, -9, 5);
    } else if (sector.type === 'export') {
      block('machine', 38, 57, -38, -19, 9);
      block('machine', 78, 99, 20, 43, 9);
      block('cover', 109, 121, -24, -10, 5);
      block('pillar', 132, 138, 31, 39, roof - y);
    }
    if (i === 0) {
      // An enclosed L-shaped start alcove blocks every initial hostile LOS.
      block('wall', 25, 28, -14, 15, 14);
      block('wall', 0, 25, -16, -13, 14);
      block('wall', 0, 13, 15, 18, 14);
      addBox(sector, 'roof', [0, y + 14, -16], [28, y + 16, 18]);
      // Exit around the northern end of the L; no invisible immunity.
      sector.shelter = { min: [1, y, -13], max: [25, y + 14, 15], exit: [20, y + 2.1, 23] };
    }
  });

  // Solid bulkheads connect neighbouring enclosed buildings. All higher-floor
  // changes have a visible eight-metre sill and a broad landing either side.
  sectors.forEach((sector, i) => {
    if (i === 0) addBox(sector, 'wall', [-2, -3, -57], [0, sector.ceilingY + 2, 57]);
    if (i >= sectors.length - 1) return;
    const next = sectors[i + 1];
    const x = sector.bounds.max[0];
    const z = doorZ(i + 1);
    const loZ = Math.min(sector.bounds.min[2], next.bounds.min[2]) - 2;
    const hiZ = Math.max(sector.bounds.max[2], next.bounds.max[2]) + 2;
    const baseY = Math.min(sector.floorY, next.floorY) - 3;
    const sillY = Math.max(sector.floorY, next.floorY);
    const topY = Math.max(sector.ceilingY, next.ceilingY) + 2;
    const doorTop = Math.min(sector.ceilingY, next.ceilingY) - 2;
    addBox(sector, 'wall', [x - 1, baseY, loZ], [x + 1, topY, z - 8]);
    addBox(sector, 'wall', [x - 1, baseY, z + 8], [x + 1, topY, hiZ]);
    addBox(sector, 'wall', [x - 1, doorTop, z - 8], [x + 1, topY, z + 8]);
    if (sillY > baseY) addBox(sector, 'wall', [x - 1, baseY, z - 8], [x + 1, sillY, z + 8]);
    const connection = { id: `${sector.id}-${next.id}`, from: sector.id, to: next.id, position: [x, sillY + 2.1, z], width: 16, sillY, doorTop };
    connections.push(connection);
    if (next.floorY > sector.floorY) {
      ascents.push({ connectionId: connection.id, from: sector.id, to: next.id, rise: next.floorY - sector.floorY, takeoff: [x - 9, sector.floorY + 2.1, z], landing: [x + 9, next.floorY + 2.1, z], clearHeight: doorTop - sillY });
    }
    if (CONTROL_SECTORS.has(i)) {
      const barrier = { id: `B${String(barriers.length + 1).padStart(2, '0')}`, controlId: `T${String(i + 1).padStart(2, '0')}`, sectorId: sector.id, min: [x - 0.9, sillY, z - 8], max: [x + 0.9, doorTop, z + 8] };
      barriers.push(barrier);
      connection.barrierId = barrier.id;
      addBox(sector, 'barrier', barrier.min, barrier.max, { barrierId: barrier.id, controlId: barrier.controlId });
    }
  });

  const finalSector = sectors.at(-1);
  const fy = finalSector.floorY;
  const finalGate = { id: 'FINAL-GATE', controlId: null, sectorId: finalSector.id, min: [2399, fy, -8], max: [2401, fy + 24, 8] };
  barriers.push(finalGate);
  addBox(finalSector, 'wall', [2399, fy - 3, -57], [2401, fy + 32, -8]);
  addBox(finalSector, 'wall', [2399, fy - 3, 8], [2401, fy + 32, 57]);
  addBox(finalSector, 'wall', [2399, fy + 24, -8], [2401, fy + 32, 8]);
  addBox(finalSector, 'barrier', finalGate.min, finalGate.max, { barrierId: finalGate.id });
  addBox(finalSector, 'floor', [2400, fy - 3, -12], [2440, fy, 12]);
  addBox(finalSector, 'roof', [2400, fy + 26, -14], [2442, fy + 28, 14]);
  addBox(finalSector, 'wall', [2400, fy - 3, -14], [2442, fy + 28, -12]);
  addBox(finalSector, 'wall', [2400, fy - 3, 12], [2442, fy + 28, 14]);
  addBox(finalSector, 'wall', [2440, fy - 3, -14], [2442, fy + 28, 14]);

  const enemies = [];
  let guardId = 0;
  sectors.forEach((sector, i) => {
    const x = sector.bounds.min[0];
    const y = sector.floorY + 2.1;
    let placements;
    if (FOUR_ENEMY_SECTORS.has(i)) placements = [[70, -20], [86, 21], [101, -24]];
    else if (SPLIT_SECTORS.has(i)) placements = i === 12 ? [[128, -27]] : [[76, -27], [119, 34]];
    else if (i === 3 || i === 9) placements = [[93, -18]];
    else if (i === 6) placements = [[82, -11]];
    else if (i === 7) placements = [[70, -24], [104, 4]];
    else if (i === 10 || i === 13) placements = [[79, -12], [130, 13]];
    else placements = [[101, -29]];
    const wanted = FOUR_ENEMY_SECTORS.has(i) ? 3 : THREE_ENEMY_SECTORS.has(i) ? 2 : 1;
    placements.slice(0, wanted).forEach(([px, pz]) => enemies.push({ id: `G${String(++guardId).padStart(2, '0')}`, kind: 'guard', isGateControl: false, sectorId: sector.id, position: [x + px, y, pz], velocity: [0, 0, 0], hp: 120 }));
    const turretZ = i === 6 || i === 13 ? 15 : i === 10 ? 17 : i === 8 ? 30 : 27;
    const turretX = i === 3 || i === 9 ? 127 : i === 8 ? 94 : 143;
    enemies.push({ id: `T${String(i + 1).padStart(2, '0')}`, kind: 'turret', isGateControl: CONTROL_SECTORS.has(i), sectorId: sector.id, position: [x + turretX, y, turretZ], velocity: [0, 0, 0], hp: 240 });
  });
  return { sectors, boxes, enemies, barriers, connections, ascents, branches, route, startPosition: [10, 2.1, 0], escapeBounds: { min: [2425, fy, -8], max: [2438, fy + 26, 8] }, shortestPathLowerBound: 2415, requiredSectorIds: sectors.map((s) => s.id) };
}

export const STAGE = buildStage();

/** Slab intersection against a box expanded by a body half extent. */
export function segmentBox(a, b, box, half = [0, 0, 0]) {
  let enter = -Infinity;
  let leave = Infinity;
  let normal = [0, 0, 0];
  let inside = true;
  for (let axis = 0; axis < 3; axis++) {
    const low = box.min[axis] - half[axis];
    const high = box.max[axis] + half[axis];
    const delta = b[axis] - a[axis];
    if (a[axis] <= low + EPSILON || a[axis] >= high - EPSILON) inside = false;
    if (Math.abs(delta) < EPSILON) {
      // Parallel contact is sliding, not penetration.
      if (a[axis] <= low + EPSILON || a[axis] >= high - EPSILON) return null;
      continue;
    }
    let near = (low - a[axis]) / delta;
    let far = (high - a[axis]) / delta;
    const sign = delta > 0 ? -1 : 1;
    if (near > far) [near, far] = [far, near];
    if (near > enter) {
      enter = near;
      normal = [0, 0, 0];
      normal[axis] = sign;
    }
    leave = Math.min(leave, far);
    if (enter > leave + EPSILON) return null;
  }
  if (leave < 0 || enter > 1 || (!inside && leave <= EPSILON && enter < 0)) return null;
  const fraction = Math.max(0, enter);
  if (inside) {
    let axis = 0;
    for (let i = 1; i < 3; i++) if (Math.abs(b[i] - a[i]) > Math.abs(b[axis] - a[axis])) axis = i;
    normal = [0, 0, 0];
    normal[axis] = b[axis] >= a[axis] ? -1 : 1;
  }
  return { fraction, point: a.map((v, i) => v + (b[i] - v) * fraction), normal, box };
}

function normalizeHorizontal(a, b) {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const d = Math.hypot(dx, dz);
  return d > 1e-6 ? [dx / d, 0, dz / d] : [0, 0, 0];
}

class MinHeap {
  constructor() { this.values = []; }
  push(item) {
    const a = this.values;
    let i = a.length;
    a.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].score <= item.score) break;
      a[i] = a[p]; i = p;
    }
    a[i] = item;
  }
  pop() {
    const a = this.values;
    const out = a[0];
    const end = a.pop();
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1;
        if (c + 1 < a.length && a[c + 1].score < a[c].score) c++;
        if (a[c].score >= end.score) break;
        a[i] = a[c]; i = c;
      }
      a[i] = end;
    }
    return out;
  }
}

/** Shared renderer/physics collision source. Opening a gate removes its mesh
 * and collision using the same ID, while every other box stays physical. */
export function createWorld(stage = STAGE) {
  const openBarrierIds = new Set();
  let activeSignature = null;
  let activeBoxes = [];
  let buckets = new Map();
  const navGrids = new Map();
  const pathCache = new Map();
  const sync = () => {
    const signature = [...openBarrierIds].sort().join('|');
    if (signature === activeSignature) return;
    activeSignature = signature;
    activeBoxes = stage.boxes.filter((box) => !box.barrierId || !openBarrierIds.has(box.barrierId));
    buckets = new Map();
    for (const box of activeBoxes) {
      for (let x = Math.floor(box.min[0] / 80); x <= Math.floor(box.max[0] / 80); x++) {
        if (!buckets.has(x)) buckets.set(x, []);
        buckets.get(x).push(box);
      }
    }
    navGrids.clear(); pathCache.clear();
  };
  const getBoxes = () => { sync(); return activeBoxes; };
  const nearby = (a, b, half) => {
    sync();
    const out = new Set();
    for (let x = Math.floor((Math.min(a[0], b[0]) - half[0]) / 80); x <= Math.floor((Math.max(a[0], b[0]) + half[0]) / 80); x++) {
      for (const box of buckets.get(x) ?? []) out.add(box);
    }
    return out;
  };
  const traceBody = (a, b, half) => {
    let closest = null;
    for (const box of nearby(a, b, half)) {
      const hit = segmentBox(a, b, box, half);
      if (hit && (!closest || hit.fraction < closest.fraction)) closest = hit;
    }
    return closest;
  };
  const traceSegment = (a, b, radius = 0) => traceBody(a, b, [radius, radius, radius]);
  const lineOfSight = (a, b) => {
    const hit = traceSegment(a, b);
    return !hit || hit.fraction >= 1 - EPSILON;
  };
  const bodyRouteClear = (a, b) => {
    const hit = traceBody(a, b, [1.3, 2.1, 1.3]);
    return !hit || hit.fraction >= 1 - EPSILON;
  };
  const sectorAt = (p) => stage.sectors.find((s) => p[0] >= s.bounds.min[0] - EPSILON && p[0] < s.bounds.max[0] && p[2] >= s.bounds.min[2] && p[2] <= s.bounds.max[2] && p[1] >= s.floorY - 3 && p[1] <= s.ceilingY + 2) ?? null;
  const moveBody = (position, velocity, dt, halfExtents = [1.2, 2.1, 1.2]) => {
    let p = [...position];
    const v = [...velocity];
    let remaining = Math.max(0, dt);
    let grounded = false;
    const collisionNormals = [];
    for (let attempt = 0; attempt < 6 && remaining > EPSILON; attempt++) {
      const end = p.map((value, i) => value + v[i] * remaining);
      const hit = traceBody(p, end, halfExtents);
      if (!hit) { p = end; remaining = 0; break; }
      p = hit.point.map((value, i) => value + hit.normal[i] * 1e-5);
      collisionNormals.push(hit.normal);
      const inward = v.reduce((sum, value, i) => sum + value * hit.normal[i], 0);
      if (inward < 0) for (let i = 0; i < 3; i++) v[i] -= hit.normal[i] * inward;
      if (hit.normal[1] > 0.5) grounded = true;
      remaining *= 1 - hit.fraction;
      if (Math.hypot(...v) < EPSILON) break;
    }
    if (v[1] <= EPSILON) {
      const support = traceBody(p, [p[0], p[1] - 0.025, p[2]], halfExtents);
      if (support?.normal[1] > 0.5) {
        grounded = true;
        p[1] = support.point[1] + 1e-5;
        v[1] = 0;
        if (!collisionNormals.some((normal) => normal[1] > 0.5)) collisionNormals.push(support.normal);
      }
    }
    return { position: p, velocity: v, grounded, collisionNormals };
  };

  const gridFor = (sector) => {
    sync();
    if (navGrids.has(sector.id)) return navGrids.get(sector.id);
    const step = 4;
    const minX = sector.bounds.min[0] + 3;
    const minZ = sector.bounds.min[2] + 3;
    const nx = Math.floor((sector.bounds.max[0] - 3 - minX) / step) + 1;
    const nz = Math.floor((sector.bounds.max[2] - 3 - minZ) / step) + 1;
    const cells = new Uint8Array(nx * nz);
    const points = Array.from({ length: nx * nz }, (_, index) => [minX + (index % nx) * step, sector.floorY + 2.1, minZ + Math.floor(index / nx) * step]);
    const localBoxes = getBoxes().filter((box) => box.max[0] >= sector.bounds.min[0] && box.min[0] <= sector.bounds.max[0] && box.kind !== 'floor' && box.kind !== 'roof');
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      cells[i] = localBoxes.some((box) => p[0] > box.min[0] - 1.35 && p[0] < box.max[0] + 1.35 && p[1] > box.min[1] - 2.1 + EPSILON && p[1] < box.max[1] + 2.1 - EPSILON && p[2] > box.min[2] - 1.35 && p[2] < box.max[2] + 1.35) ? 0 : 1;
    }
    const grid = { sector, step, minX, minZ, nx, nz, cells, points };
    navGrids.set(sector.id, grid);
    return grid;
  };
  const nearestCell = (grid, p) => {
    const x = Math.max(0, Math.min(grid.nx - 1, Math.round((p[0] - grid.minX) / grid.step)));
    const z = Math.max(0, Math.min(grid.nz - 1, Math.round((p[2] - grid.minZ) / grid.step)));
    const candidate = z * grid.nx + x;
    if (grid.cells[candidate]) return candidate;
    let best = -1, d = Infinity;
    for (let i = 0; i < grid.cells.length; i++) {
      if (!grid.cells[i]) continue;
      const point = grid.points[i];
      const distance = Math.hypot(point[0] - p[0], point[2] - p[2]);
      if (distance < d) { best = i; d = distance; }
    }
    return best;
  };
  const findPath = (sector, a, b) => {
    const grid = gridFor(sector);
    const start = nearestCell(grid, a), target = nearestCell(grid, b);
    if (start < 0 || target < 0) return null;
    const cacheKey = `${sector.id}:${start}:${target}`;
    if (pathCache.has(cacheKey)) return pathCache.get(cacheKey);
    const heap = new MinHeap();
    const scores = new Float64Array(grid.cells.length).fill(Infinity);
    const previous = new Int32Array(grid.cells.length).fill(-1);
    const closed = new Uint8Array(grid.cells.length);
    const heuristic = (n) => Math.hypot(grid.points[n][0] - grid.points[target][0], grid.points[n][2] - grid.points[target][2]);
    scores[start] = 0;
    heap.push({ index: start, score: heuristic(start) });
    let found = false;
    while (heap.values.length) {
      const current = heap.pop().index;
      if (closed[current]) continue;
      if (current === target) { found = true; break; }
      closed[current] = 1;
      const cx = current % grid.nx, cz = Math.floor(current / grid.nx);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const x = cx + dx, z = cz + dz;
        if (x < 0 || x >= grid.nx || z < 0 || z >= grid.nz) continue;
        const next = z * grid.nx + x;
        if (!grid.cells[next] || closed[next]) continue;
        if (dx && dz && (!grid.cells[cz * grid.nx + x] || !grid.cells[z * grid.nx + cx])) continue;
        const cost = scores[current] + grid.step * Math.hypot(dx, dz);
        if (cost >= scores[next]) continue;
        scores[next] = cost; previous[next] = current;
        heap.push({ index: next, score: cost + heuristic(next) });
      }
    }
    const path = found ? [] : null;
    if (found) {
      for (let n = target; n >= 0; n = previous[n]) { path.push(grid.points[n]); if (n === start) break; }
      path.reverse();
    }
    if (pathCache.size > 256) pathCache.clear();
    pathCache.set(cacheKey, path);
    return path;
  };
  const localTarget = (sector, target) => {
    if (target[0] >= sector.bounds.min[0] && target[0] < sector.bounds.max[0]) return [target[0], sector.floorY + 2.1, target[2]];
    const nextIndex = target[0] < sector.bounds.min[0] ? sector.index - 1 : sector.index + 1;
    const other = stage.sectors[nextIndex];
    if (!other) return null;
    const connection = stage.connections.find((c) => (c.from === sector.id && c.to === other.id) || (c.to === sector.id && c.from === other.id));
    if (!connection || (connection.barrierId && !openBarrierIds.has(connection.barrierId))) return null;
    return [connection.position[0] + (nextIndex < sector.index ? -4 : 4), sector.floorY + 2.1, connection.position[2]];
  };
  const navDirection = (position, target, sectorId) => {
    const sector = sectorAt(position) ?? stage.sectors.find((s) => s.id === sectorId);
    if (!sector) return normalizeHorizontal(position, target);
    const goal = localTarget(sector, target);
    if (!goal) return [0, 0, 0];
    if (bodyRouteClear(position, goal)) return normalizeHorizontal(position, goal);
    const path = findPath(sector, position, goal);
    if (!path?.length) return [0, 0, 0];
    let waypoint = path[Math.min(1, path.length - 1)];
    for (let i = 1; i < Math.min(path.length, 7); i++) {
      if (!bodyRouteClear(position, path[i])) break;
      waypoint = path[i];
    }
    return normalizeHorizontal(position, waypoint);
  };
  const localPathDistance = (sector, a, b) => {
    if (bodyRouteClear(a, b)) return Math.hypot(b[0] - a[0], b[2] - a[2]);
    const path = findPath(sector, a, b);
    if (!path?.length) return Infinity;
    let d = Math.hypot(a[0] - path[0][0], a[2] - path[0][2]);
    for (let i = 1; i < path.length; i++) d += Math.hypot(path[i][0] - path[i - 1][0], path[i][2] - path[i - 1][2]);
    return d + Math.hypot(b[0] - path.at(-1)[0], b[2] - path.at(-1)[2]);
  };
  const pathDistance = (a, b) => {
    const sa = sectorAt(a), sb = sectorAt(b);
    if (!sa || !sb) return Infinity;
    if (sa.id === sb.id) return localPathDistance(sa, a, b);
    if (Math.abs(sa.index - sb.index) !== 1 || sa.floorY !== sb.floorY) return Infinity;
    const connection = stage.connections.find((c) => (c.from === sa.id && c.to === sb.id) || (c.to === sa.id && c.from === sb.id));
    if (!connection || (connection.barrierId && !openBarrierIds.has(connection.barrierId))) return Infinity;
    const sign = sb.index > sa.index ? 1 : -1;
    const sideA = [connection.position[0] - sign * 3, sa.floorY + 2.1, connection.position[2]];
    const sideB = [connection.position[0] + sign * 3, sb.floorY + 2.1, connection.position[2]];
    if (traceBody(sideA, sideB, [1.3, 2.1, 1.3])) return Infinity;
    return localPathDistance(sa, a, sideA) + 6 + localPathDistance(sb, sideB, b);
  };
  return { stage, openBarrierIds, getBoxes, traceSegment, lineOfSight, moveBody, sectorAt, navDirection, pathDistance };
}
