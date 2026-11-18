// Ballistic intercept solvers — the heart of the FCS fire control.
// All values are world-space SI units (m, s, m/s).

const EPS = 1e-12;

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// ---------- polynomial helpers ----------

// Real roots of a0 + a1 t + a2 t^2 = 0 in ascending order.
export function rootsQuadratic(a0, a1, a2) {
  if (Math.abs(a2) < EPS) {
    if (Math.abs(a1) < EPS) return [];
    return [-a0 / a1];
  }
  const disc = a1 * a1 - 4 * a2 * a0;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  // numerically stable: q = -0.5*(a1 + sign(a1)*s)
  const q = -0.5 * (a1 + Math.sign(a1 || 1) * s);
  const r1 = q / a2;
  const r2 = Math.abs(q) < EPS ? 0 : a0 / q;
  return r1 <= r2 ? [r1, r2] : [r2, r1];
}

function evalPoly(co, t) {
  let v = 0;
  for (let i = co.length - 1; i >= 0; i--) v = v * t + co[i];
  return v;
}

function bisectRoot(co, lo, hi, flo, fhi) {
  // monotonic segment -> single crossing
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = evalPoly(co, mid);
    if (fm === 0 || hi - lo < 1e-11) return mid;
    if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else { hi = mid; fhi = fm; }
  }
  return 0.5 * (lo + hi);
}

// All real roots of a0 + a1 t + a2 t^2 + a3 t^3 = 0 within (lo, hi).
function rootsCubicIn(co, lo, hi) {
  const [a0, a1, a2, a3] = co;
  if (Math.abs(a3) < EPS) return rootsQuadratic(a0, a1, a2).filter(t => t > lo && t < hi);
  // derivative: a1 + 2 a2 t + 3 a3 t^2 = 0
  const crit = rootsQuadratic(a1, 2 * a2, 3 * a3)
    .filter(t => t > lo && t < hi).sort((x, y) => x - y);
  const bounds = [lo, ...crit, hi];
  const roots = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const fa = evalPoly(co, bounds[i]);
    const fb = evalPoly(co, bounds[i + 1]);
    if (fa === 0) roots.push(bounds[i]);
    else if (fa * fb < 0) roots.push(bisectRoot(co, bounds[i], bounds[i + 1], fa, fb));
  }
  for (const c of crit) if (Math.abs(evalPoly(co, c)) < 1e-9 * (1 + Math.abs(evalPoly(co, 0)))) roots.push(c);
  return roots;
}

// All real roots of a0 + a1 t + a2 t^2 + a3 t^3 + a4 t^4 = 0 within (lo, hi].
// Handles tangent double roots (at critical points) which sign-only search misses.
export function rootsQuarticIn(co, lo, hi) {
  const [a0, a1, a2, a3, a4] = co;
  if (Math.abs(a4) < EPS) return rootsCubicIn(co, lo, hi).filter(t => t > lo && t <= hi);
  // derivative: a1 + 2a2 t + 3a3 t^2 + 4a4 t^3
  const crit = rootsCubicIn([a1, 2 * a2, 3 * a3, 4 * a4], lo, hi);
  const bounds = [lo, ...crit.filter(c => c > lo && c < hi), hi];
  const roots = [];
  const scale = Math.abs(a0) + Math.abs(a1) + Math.abs(a2) + Math.abs(a3) + Math.abs(a4) + 1;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const fa = evalPoly(co, bounds[i]);
    const fb = evalPoly(co, bounds[i + 1]);
    if (fa === 0) { roots.push(bounds[i]); continue; }
    if (fa * fb < 0) roots.push(bisectRoot(co, bounds[i], bounds[i + 1], fa, fb));
  }
  // tangent double roots sit exactly on critical points
  for (const c of crit) {
    if (c > lo && c <= hi && Math.abs(evalPoly(co, c)) < 1e-7 * scale) roots.push(c);
  }
  return roots.sort((a, b) => a - b);
}

// ---------- intercept solvers ----------

// Machine gun: bullet leaves muzzle at speed s under gravity g=(0,-G,0),
// target moves at constant velocity v. Solve
//   |r + v t - 0.5 g t^2|^2 = s^2 t^2 ,  0 < t <= tMax
// r = p - m. Returns smallest positive t or null.
export function solveInterceptTimeGravity(r, v, s, G, tMax) {
  const rr = dot(r, r);
  if (rr < 1e-6) return 1e-4; // muzzle essentially on the target
  // |r + v t - 0.5 g t^2|^2 - s^2 t^2 = 0
  // expand with g = (0,-G,0):  r.g = -G*ry , v.g = -G*vy
  const rg = -G * r[1];
  const vg = -G * v[1];
  const vv = dot(v, v);
  const rv = dot(r, v);
  // a4 t^4 + a3 t^3 + a2 t^2 + a1 t + a0
  const co = [
    rr,
    2 * rv,
    vv - s * s - rg,
    -vg,
    0.25 * G * G,
  ];
  const roots = rootsQuarticIn(co, 0, tMax);
  for (const t of roots) {
    if (t <= 0 || t > tMax) continue;
    // verify: aim vector a = r + v t - 0.5 g t^2 must satisfy |a| = s t
    const ax = r[0] + v[0] * t;
    const ay = r[1] + v[1] * t + 0.5 * G * t * t;
    const az = r[2] + v[2] * t;
    const aim = Math.sqrt(ax * ax + ay * ay + az * az);
    if (Math.abs(aim - s * t) <= 0.005 * s * t + 1e-6) return t;
  }
  return null;
}

// Straight-line lead (missile at speed s, or enemy guns): smallest positive
// root of  (v.v - s^2) t^2 + 2 (r.v) t + r.r = 0 in (0, tMax], or null.
export function solveLeadTime(r, v, s, tMax) {
  const rr = dot(r, r);
  if (rr < 1e-6) return 1e-4;
  const a = dot(v, v) - s * s;
  const b = 2 * dot(r, v);
  const c = rr;
  const roots = rootsQuadratic(c, b, a);
  for (const t of roots) {
    if (t > 0 && t <= tMax && Number.isFinite(t)) return t;
  }
  return null;
}

// ---------- full fire-control solutions ----------

// Result shape mirrors the snapshot fireControl payload.
export function solveMachinegun(muzzle, pos, vel) {
  const r = [pos[0] - muzzle[0], pos[1] - muzzle[1], pos[2] - muzzle[2]];
  const t = solveInterceptTimeGravity(r, vel, 100, 18, 2.0);
  if (t === null || !Number.isFinite(t)) {
    const d = norm(r);
    return {
      status: 'no_solution',
      launchDirection: d, aimPoint: pos.slice(),
      predictedFlightSeconds: null, predictedInterceptPosition: null,
      initialVelocity: null, residualMeters: null,
    };
  }
  const aim = [
    r[0] + vel[0] * t,
    r[1] + vel[1] * t + 0.5 * 18 * t * t,
    r[2] + vel[2] * t,
  ];
  const aimLen = Math.sqrt(dot(aim, aim));
  const d = [aim[0] / aimLen, aim[1] / aimLen, aim[2] / aimLen];
  const v0 = [d[0] * 100, d[1] * 100, d[2] * 100];
  const intercept = [pos[0] + vel[0] * t, pos[1] + vel[1] * t, pos[2] + vel[2] * t];
  // residual: distance between bullet and target at time t
  const bx = muzzle[0] + v0[0] * t, by = muzzle[1] + v0[1] * t - 9 * t * t, bz = muzzle[2] + v0[2] * t;
  const residual = Math.sqrt((bx - intercept[0]) ** 2 + (by - intercept[1]) ** 2 + (bz - intercept[2]) ** 2);
  const aimPoint = [muzzle[0] + aim[0], muzzle[1] + aim[1], muzzle[2] + aim[2]];
  return {
    status: 'solved',
    launchDirection: d, aimPoint,
    predictedFlightSeconds: t, predictedInterceptPosition: intercept,
    initialVelocity: v0, residualMeters: residual,
  };
}

export function solveBeam(muzzle, pos, vel) {
  const r = [pos[0] - muzzle[0], pos[1] - muzzle[1], pos[2] - muzzle[2]];
  const len = Math.sqrt(dot(r, r));
  if (len < 1e-6) {
    return { status: 'solved', launchDirection: [0, 0, 1], aimPoint: pos.slice(),
      predictedFlightSeconds: 0, predictedInterceptPosition: pos.slice(),
      initialVelocity: null, residualMeters: 0 };
  }
  const d = [r[0] / len, r[1] / len, r[2] / len];
  return {
    status: 'solved', launchDirection: d, aimPoint: pos.slice(),
    predictedFlightSeconds: 0, predictedInterceptPosition: pos.slice(),
    initialVelocity: null, residualMeters: 0,
  };
}

export function solveMissile(muzzle, pos, vel, tMax = 4.0) {
  const r = [pos[0] - muzzle[0], pos[1] - muzzle[1], pos[2] - muzzle[2]];
  const t = solveLeadTime(r, vel, 45, tMax);
  if (t === null || !Number.isFinite(t)) {
    return {
      status: 'no_solution',
      launchDirection: norm(r), aimPoint: pos.slice(),
      predictedFlightSeconds: null, predictedInterceptPosition: null,
      initialVelocity: null, residualMeters: null,
    };
  }
  const tgt = [r[0] + vel[0] * t, r[1] + vel[1] * t, r[2] + vel[2] * t];
  const d = norm(tgt);
  return {
    status: 'solved',
    launchDirection: d,
    aimPoint: [muzzle[0] + tgt[0], muzzle[1] + tgt[1], muzzle[2] + tgt[2]],
    predictedFlightSeconds: t,
    predictedInterceptPosition: [pos[0] + vel[0] * t, pos[1] + vel[1] * t, pos[2] + vel[2] * t],
    initialVelocity: [d[0] * 45, d[1] * 45, d[2] * 45],
    residualMeters: 0,
  };
}

function norm(v) {
  const l = Math.sqrt(dot(v, v));
  if (l < 1e-9) return [0, 0, 1];
  return [v[0] / l, v[1] / l, v[2] / l];
}

// Rotate `from` toward `to` by at most maxAngle radians. Both unit vectors.
export function rotateToward(from, to, maxAngle) {
  const c = Math.max(-1, Math.min(1, dot(from, to)));
  const ang = Math.acos(c);
  if (ang < 1e-9 || ang <= maxAngle) return to.slice();
  // perpendicular component of `to` relative to `from`
  const px = to[0] - c * from[0], py = to[1] - c * from[1], pz = to[2] - c * from[2];
  const pl = Math.sqrt(px * px + py * py + pz * pz);
  if (pl < 1e-9) return to.slice();
  const k = Math.sin(maxAngle) / pl;
  const ca = Math.cos(maxAngle);
  return [
    ca * from[0] + k * px,
    ca * from[1] + k * py,
    ca * from[2] + k * pz,
  ];
}
