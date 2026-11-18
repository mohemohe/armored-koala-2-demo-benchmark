/**
 * Stage validator: geometry sanity, link validity, enemy budget and the
 * shortest executable route length.
 * Run with: node scripts/run-stage-check.mjs
 */
import { ZONES, LINKS, ENEMY_SPAWNS, ZONE_BY_ID, CLEAR_POINT } from '../src/game/stage.ts';

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exitCode = 1;
}

/* 1) no overlapping volumes between zones */
for (let i = 0; i < ZONES.length; i++) {
  for (let j = i + 1; j < ZONES.length; j++) {
    const a = ZONES[i];
    const b = ZONES[j];
    const px = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const pz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
    if (px > 0.001 && pz > 0.001) {
      // check whether some level pair is vertically disjoint
      let disjoint = false;
      for (const la of a.levels) {
        for (const lb of b.levels) {
          const ay0 = la.y, ay1 = la.y + la.h;
          const by0 = lb.y, by1 = lb.y + lb.h;
          if (ay1 <= by0 + 0.001 || by1 <= ay0 + 0.001) disjoint = true;
        }
      }
      if (!disjoint) fail(`zones ${a.id} and ${b.id} overlap in plan and in height`);
    }
  }
}

/* 2) every link shares an edge at a common level */
function sharedEdge(a, b) {
  const out = [];
  for (const la of a.levels) {
    for (const lb of b.levels) {
      const y0 = Math.max(la.y, lb.y);
      const y1 = Math.min(la.y + la.h, lb.y + lb.h);
      if (y1 - y0 <= 0.001) continue;
      if (Math.abs(a.x1 - b.x0) < 0.001 || Math.abs(b.x1 - a.x0) < 0.001) {
        const x = Math.abs(a.x1 - b.x0) < 0.001 ? a.x1 : b.x1;
        const z0 = Math.max(a.z0, b.z0);
        const z1 = Math.min(a.z1, b.z1);
        if (z1 - z0 > 0.001) out.push({ axis: 'x', at: x, from: z0, to: z1, y0, y1 });
      }
      if (Math.abs(a.z1 - b.z0) < 0.001 || Math.abs(b.z1 - a.z0) < 0.001) {
        const z = Math.abs(a.z1 - b.z0) < 0.001 ? a.z1 : b.z0;
        const x0 = Math.max(a.x0, b.x0);
        const x1 = Math.min(a.x1, b.x1);
        if (x1 - x0 > 0.001) out.push({ axis: 'z', at: z, from: x0, to: x1, y0, y1 });
      }
    }
  }
  return out;
}

for (const l of LINKS) {
  const a = ZONE_BY_ID.get(l.a);
  const b = ZONE_BY_ID.get(l.b);
  if (!a || !b) {
    fail(`link ${l.a}-${l.b} references unknown zone`);
    continue;
  }
  const edges = sharedEdge(a, b);
  if (edges.length === 0) fail(`link ${l.a}-${l.b} has no shared wall`);
}

/* 3) enemy budget */
const guards = ENEMY_SPAWNS.filter((e) => e.kind === 'guard');
const turrets = ENEMY_SPAWNS.filter((e) => e.kind === 'turret');
const controls = ENEMY_SPAWNS.filter((e) => e.control);
console.log(`guards=${guards.length} turrets=${turrets.length} controls=${controls.length} total=${ENEMY_SPAWNS.length}`);
if (guards.length !== 30) fail(`expected 30 guards, got ${guards.length}`);
if (turrets.length !== 15) fail(`expected 15 turrets, got ${turrets.length}`);
if (controls.length !== 6) fail(`expected 6 control turrets, got ${controls.length}`);
const ctrlZones = new Set(controls.map((e) => e.zone));
if (ctrlZones.size !== 6) fail('control turrets must be spread over 6 distinct zones');
const ids = new Set(ENEMY_SPAWNS.map((e) => e.id));
if (ids.size !== ENEMY_SPAWNS.length) fail('duplicate enemy ids');

/* 4) enemies must stand inside their zone */
for (const e of ENEMY_SPAWNS) {
  const z = ZONE_BY_ID.get(e.zone);
  if (!z) {
    fail(`enemy ${e.id} in unknown zone ${e.zone}`);
    continue;
  }
  if (e.x < z.x0 || e.x > z.x1 || e.z < z.z0 || e.z > z.z1) fail(`enemy ${e.id} outside zone ${e.zone}`);
  const lvl = e.level ?? 0;
  if (!z.levels[lvl]) fail(`enemy ${e.id} has no level ${lvl}`);
}

/* 5) shortest route over the zone graph (barriers included) */
const barrierLinks = LINKS.filter((l) => l.barrier);
const graph = new Map();
const doorPos = new Map();
for (const l of LINKS) {
  const edges = sharedEdge(ZONE_BY_ID.get(l.a), ZONE_BY_ID.get(l.b));
  if (!edges.length) continue;
  const e = edges[0];
  const cx = e.axis === 'x' ? e.at : (e.from + e.to) / 2;
  const cz = e.axis === 'z' ? e.at : (e.from + e.to) / 2;
  const cy = (e.y0 + e.y1) / 2;
  doorPos.set(l.a + '|' + l.b, { x: cx, y: cy, z: cz });
  const blocked = !!l.barrier;
  if (!graph.has(l.a)) graph.set(l.a, []);
  if (!graph.has(l.b)) graph.set(l.b, []);
  graph.get(l.a).push({ to: l.b, x: cx, z: cz, y: cy, blocked });
  graph.get(l.b).push({ to: l.a, x: cx, z: cz, y: cy, blocked });
}

/** Dijkstra over (zone, arrival-door) states; cost = distance between the
 *  door we entered through and the door we leave through. */
function shortest(from, to, allowBlocked) {
  const start = from + '@start';
  const d = new Map([[start, 0]]);
  const q = [start];
  const vis = new Set();
  while (q.length) {
    q.sort((a, b) => (d.get(a) ?? Infinity) - (d.get(b) ?? Infinity));
    const cur = q.shift();
    if (vis.has(cur)) continue;
    vis.add(cur);
    const at = cur.lastIndexOf('@');
    const zone = cur.slice(0, at);
    const entry = cur.slice(at + 1);
    if (zone === to) return d.get(cur);
    const entryPos = entry === 'start' ? null : doorPos.get(entry);
    for (const e of graph.get(zone) ?? []) {
      if (e.blocked && !allowBlocked) continue;
      const linkKey = zone + '|' + e.to;
      const dp = doorPos.get(linkKey);
      const w = entryPos && dp ? Math.hypot(dp.x - entryPos.x, dp.y - entryPos.y, dp.z - entryPos.z) : 0;
      const key = e.to + '@' + linkKey;
      const nd = (d.get(cur) ?? Infinity) + w;
      if (nd < (d.get(key) ?? Infinity)) {
        d.set(key, nd);
        q.push(key);
      }
    }
  }
  return null;
}

// Route: intake -> BR1 -> BR2 -> ... -> BR6 -> escape (barrier links are the
// only way forward, so each barrier is a cut edge).
let total = 0;
let node = 'intake';
let ok = true;
const visitedZones = ['intake'];
for (const bl of barrierLinks) {
  const seg = shortest(node, bl.a, false);
  if (seg == null) {
    fail(`cannot reach ${bl.a} before barrier ${bl.barrier}`);
    ok = false;
    break;
  }
  total += seg;
  visitedZones.push(bl.a, bl.b);
  node = bl.b;
}
if (ok) {
  const seg = shortest(node, 'escape', false);
  if (seg == null) {
    fail('cannot reach escape');
  } else {
    total += seg;
    visitedZones.push('escape');
    // distance from the evacuation door to the clear point
    const esc = ZONE_BY_ID.get('escape');
    const door = doorPos.get('exitgate|escape');
    total += Math.hypot(
      CLEAR_POINT.x - door.x,
      24 - door.y,
      CLEAR_POINT.z - door.z
    );
  }
}
console.log(`shortest barrier-complete route (lower bound) = ${total.toFixed(1)} m, zones touched = ${visitedZones.length}`);
if (total < 1500) fail(`shortest route ${total.toFixed(1)}m < 1500m`);
if (visitedZones.length < 12) fail(`route touches only ${visitedZones.length} zones`);

/* 6) zone count */
console.log(`zones = ${ZONES.length}`);
if (ZONES.length < 15) fail('fewer than 15 zones');

/* 7) big combat rooms >= 60 x 50 */
const big = ZONES.filter(
  (z) => z.kind !== 'corridor' && z.kind !== 'shaft' && z.x1 - z.x0 >= 60 && z.z1 - z.z0 >= 50
);
console.log(`combat zones >= 60x50: ${big.length} (${big.map((z) => z.id).join(', ')})`);
if (big.length < 5) fail('fewer than 5 large combat zones');

/* 8) branch / loop count : independent cycles = E - V + 1 */
const adj = new Map();
for (const l of LINKS) {
  if (!adj.has(l.a)) adj.set(l.a, []);
  if (!adj.has(l.b)) adj.set(l.b, []);
  adj.get(l.a).push(l.b);
  adj.get(l.b).push(l.a);
}
const cycles = LINKS.length - ZONES.length + 1;
console.log(`independent cycles (branch/loop structures) = ${cycles}`);
if (cycles < 3) fail('fewer than 3 branch/loop structures');

if (process.exitCode) console.error('\nSTAGE CHECK FAILED');
else console.log('\nSTAGE CHECK PASSED');
