import * as THREE from 'three';

const _dir = new THREE.Vector3();
const _point = new THREE.Vector3();

export function boxFromCenterSize(center, size, extra = {}) {
  const c = Array.isArray(center) ? center : center.toArray();
  const s = Array.isArray(size) ? size : size.toArray();
  return {
    min: [c[0] - s[0] / 2, c[1] - s[1] / 2, c[2] - s[2] / 2],
    max: [c[0] + s[0] / 2, c[1] + s[1] / 2, c[2] + s[2] / 2],
    active: true,
    ...extra,
  };
}

export function makeAABB(min, max) {
  return new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
}

/** Ray/AABB slab intersection. Direction need not be normalized when maxDistance=1 for a segment. */
export function rayBox(origin, direction, maxDistance, box) {
  if (box.active === false) return null;
  const min = box.min, max = box.max;
  let near = 0, far = maxDistance;
  for (let i = 0; i < 3; i++) {
    const o = origin.getComponent(i);
    const d = direction.getComponent(i);
    if (Math.abs(d) < 1e-12) {
      if (o < min[i] || o > max[i]) return null;
      continue;
    }
    let a = (min[i] - o) / d;
    let b = (max[i] - o) / d;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return null;
  }
  if (near < -1e-8 || near > maxDistance) return null;
  return Math.max(0, near);
}

export function raycastBoxes(origin, direction, maxDistance, boxes, filter = null) {
  let best = null;
  let bestDistance = maxDistance;
  for (const box of boxes) {
    if (box.active === false || (filter && !filter(box))) continue;
    const distance = rayBox(origin, direction, bestDistance, box);
    if (distance !== null && distance <= bestDistance) {
      bestDistance = distance;
      best = { box, distance, point: origin.clone().addScaledVector(direction, distance) };
    }
  }
  return best;
}

export function segmentBox(start, end, boxes, filter = null) {
  _dir.subVectors(end, start);
  const distance = _dir.length();
  if (distance < 1e-10) return null;
  _dir.multiplyScalar(1 / distance);
  return raycastBoxes(start, _dir, distance, boxes, filter);
}

export function hasLineOfSight(start, end, boxes, filter = null) {
  const hit = segmentBox(start, end, boxes, filter);
  return !hit || hit.distance >= start.distanceTo(end) - 0.05;
}

/** Continuous relative-motion test against a sphere whose center also moves over this interval. */
export function sweptSphere(start0, start1, center0, center1, radius) {
  const rx = start0.x - center0.x, ry = start0.y - center0.y, rz = start0.z - center0.z;
  const dx = (start1.x - start0.x) - (center1.x - center0.x);
  const dy = (start1.y - start0.y) - (center1.y - center0.y);
  const dz = (start1.z - start0.z) - (center1.z - center0.z);
  const a = dx * dx + dy * dy + dz * dz;
  const c = rx * rx + ry * ry + rz * rz - radius * radius;
  if (c <= 0) return 0;
  if (a < 1e-16) return null;
  const b = 2 * (rx * dx + ry * dy + rz * dz);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const t0 = (-b - root) / (2 * a);
  const t1 = (-b + root) / (2 * a);
  if (t0 >= 0 && t0 <= 1) return t0;
  if (t1 >= 0 && t1 <= 1) return t1;
  return null;
}

function overlapsBodyAt(position, radius, height, box) {
  if (box.active === false) return false;
  const e = 1e-7;
  return position.x + radius > box.min[0] + e && position.x - radius < box.max[0] - e &&
    position.z + radius > box.min[2] + e && position.z - radius < box.max[2] - e &&
    position.y + height / 2 > box.min[1] + e && position.y - height / 2 < box.max[1] - e;
}

function moveAxis(position, amount, axis, radius, height, boxes) {
  if (Math.abs(amount) < 1e-12) return false;
  position[axis] += amount;
  let collided = false;
  // Multiple passes resolve corners without injecting energy.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const box of boxes) {
      if (!overlapsBodyAt(position, radius, height, box)) continue;
      collided = true;
      changed = true;
      if (axis === 'y') {
        position.y = amount > 0 ? box.min[1] - height / 2 : box.max[1] + height / 2;
      } else {
        position[axis] = amount > 0 ? box.min[axis === 'x' ? 0 : 2] - radius : box.max[axis === 'x' ? 0 : 2] + radius;
      }
    }
    if (!changed) break;
  }
  return collided;
}

/**
 * Move a vertical cylindrical body using short axis-separated sweeps.
 * Returns actual displacement and contact flags. No bounced velocity is added.
 */
export function moveBody(position, velocity, dt, radius, height, boxes) {
  const start = position.clone();
  const maxTravel = Math.max(Math.abs(velocity.x), Math.abs(velocity.y), Math.abs(velocity.z)) * dt;
  const steps = Math.max(1, Math.ceil(maxTravel / Math.max(0.25, radius * 0.45)));
  const stepDt = dt / steps;
  let grounded = false, hitX = false, hitY = false, hitZ = false;
  for (let i = 0; i < steps; i++) {
    if (moveAxis(position, velocity.x * stepDt, 'x', radius, height, boxes)) { velocity.x = 0; hitX = true; }
    if (moveAxis(position, velocity.z * stepDt, 'z', radius, height, boxes)) { velocity.z = 0; hitZ = true; }
    if (moveAxis(position, velocity.y * stepDt, 'y', radius, height, boxes)) {
      if (velocity.y < 0) grounded = true;
      velocity.y = 0;
      hitY = true;
    }
  }
  return { displacement: position.clone().sub(start), grounded, hitX, hitY, hitZ };
}

export function isGrounded(position, radius, height, boxes) {
  _point.copy(position);
  _point.y -= 0.09;
  const foot = position.y - height / 2;
  for (const box of boxes) {
    if (box.active === false) continue;
    if (position.x + radius <= box.min[0] || position.x - radius >= box.max[0] ||
        position.z + radius <= box.min[2] || position.z - radius >= box.max[2]) continue;
    if (Math.abs(foot - box.max[1]) <= 0.12 || (_point.y - height / 2 < box.max[1] && foot >= box.max[1])) return true;
  }
  return false;
}

export function pointInsideBox(point, box, margin = 0) {
  return point.x >= box.min[0] - margin && point.x <= box.max[0] + margin &&
    point.y >= box.min[1] - margin && point.y <= box.max[1] + margin &&
    point.z >= box.min[2] - margin && point.z <= box.max[2] + margin;
}
