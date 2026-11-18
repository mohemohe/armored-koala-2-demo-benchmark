// Three.js rendering: stage meshes (from shared collision boxes), mech/enemy
// models, projectile/effect pools, TPS camera. All geometry is procedural —
// no external assets.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PARAMS } from '../core/params.js';

const KIND_COLORS = {
  floor: 0x3a4149, ceil: 0x272c33, wall: 0x4a525c, platform: 0x4f5a68,
  pillar: 0x565048, crate: 0x7a6a4a, machine: 0x4f5d6a, container: 0x66755a,
  scrap: 0x66584e, pipe: 0x75757e, tank: 0x746c76, belt: 0x3d3d3d,
  tower: 0x7d7d88, rail: 0x777777, obstacle: 0x606a72, barrier: 0xff8830,
};

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h >>> 0; }

// ---------- stage ----------
export function buildStageGroup(stage) {
  const group = new THREE.Group();
  const byKind = new Map();
  for (const b of stage.world.boxes) {
    const arr = byKind.get(b.kind) || [];
    arr.push(b); byKind.set(b.kind, arr);
  }
  for (const [kind, boxes] of byKind) {
    if (kind === 'barrier') continue; // rendered separately (toggleable)
    const geos = [];
    for (const b of boxes) {
      const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1], d = b.max[2] - b.min[2];
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(b.min[0] + w / 2, b.min[1] + h / 2, b.min[2] + d / 2);
      // subtle per-sector tint baked as vertex colors
      const tint = b.sectorId ? 0.9 + (hashStr(b.sectorId) % 20) / 100 : 1;
      const colors = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < colors.length; i += 3) { colors[i] = tint; colors[i + 1] = tint; colors[i + 2] = tint; }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geos.push(g);
    }
    if (!geos.length) continue;
    const merged = mergeGeometries(geos);
    const mat = new THREE.MeshLambertMaterial({ color: KIND_COLORS[kind] || 0x606a72, vertexColors: true });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = kind === 'floor' || kind === 'wall';
    group.add(mesh);
  }
  // barriers: separate meshes, toggled on open
  const barrierMeshes = {};
  for (const bd of stage.barriers) {
    const gparts = stage.barrierBoxes[bd.id].map(b => {
      const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1], d = b.max[2] - b.min[2];
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(b.min[0] + w / 2, b.min[1] + h / 2, b.min[2] + d / 2);
      return g;
    });
    const mat = new THREE.MeshBasicMaterial({ color: 0xff8830, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(mergeGeometries(gparts), mat);
    group.add(mesh);
    barrierMeshes[bd.id] = mesh;
  }
  return { group, barrierMeshes };
}

// ---------- player mech (koala-headed combat robot) ----------
export function buildPlayerModel(legs) {
  const g = new THREE.Group();
  const armor = new THREE.MeshLambertMaterial({ color: 0x8892a0 });
  const accent = new THREE.MeshLambertMaterial({ color: 0xd07030 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x3a3f46 });
  const fur = new THREE.MeshLambertMaterial({ color: 0x9aa0a8 });
  const nose = new THREE.MeshLambertMaterial({ color: 0x2a2d33 });
  const eyeM = new THREE.MeshBasicMaterial({ color: 0x22ddff });

  const bx = (w, h, d, m, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z); g.add(mesh); return mesh;
  };
  const sp = (r, m, x, y, z, s = 1) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), m);
    mesh.position.set(x, y, z); mesh.scale.setScalar(s); g.add(mesh); return mesh;
  };

  // torso (feet origin)
  bx(0.85, 0.62, 0.55, armor, 0, 1.18, 0);
  bx(0.6, 0.2, 0.4, accent, 0, 1.44, 0);          // chest plate
  bx(0.4, 0.18, 0.5, dark, 0, 0.82, 0);           // hip

  // koala head
  const head = new THREE.Group(); head.position.set(0, 1.72, 0); g.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 12), fur); head.add(skull);
  const snout = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), nose);
  snout.position.set(0, -0.05, 0.32); snout.scale.set(0.9, 1.15, 0.9); head.add(snout);
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), fur);
    ear.position.set(0.3 * s, 0.22, -0.02); ear.scale.set(0.75, 1, 0.5); head.add(ear);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), eyeM);
    eye.position.set(0.13 * s, 0.06, 0.3); head.add(eye);
    // shoulder
    bx(0.28, 0.16, 0.42, accent, 0.56 * s, 1.5, 0);
  }
  // arms (feet-origin group coords; right arm carries the gun)
  const armL = bx(0.16, 0.55, 0.2, armor, -0.56, 1.12, 0.05);
  const armR = new THREE.Group(); armR.position.set(0.56, 1.4, 0); g.add(armR);
  const armRm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.2), armor);
  armRm.position.set(0, -0.24, 0.05); armR.add(armRm);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.9), dark);
  gun.position.set(0, -0.35, 0.45); armR.add(gun);
  const muzzleTip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.08), accent);
  muzzleTip.position.set(0, -0.35, 0.9); armR.add(muzzleTip);
  // missile pod on left shoulder
  bx(0.3, 0.18, 0.5, dark, -0.56, 1.62, 0);

  // legs
  const legParts = [];
  if (legs === 'quadruped') {
    for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const hip = new THREE.Group(); hip.position.set(0.32 * sx, 0.85, 0.28 * sz); g.add(hip);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.45, 0.14), dark);
      upper.position.y = -0.22; hip.add(upper);
      const lower = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.42, 0.1), armor);
      lower.position.y = -0.62; lower.rotation.x = 0.25 * sz; hip.add(lower);
      legParts.push({ hip, phase: (sx * sz > 0 ? 0 : Math.PI), baseX: 0.32 * sx });
    }
  } else {
    for (const s of [-1, 1]) {
      const hip = new THREE.Group(); hip.position.set(0.22 * s, 0.85, 0); g.add(hip);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.45, 0.2), dark);
      upper.position.y = -0.22; hip.add(upper);
      const lower = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.16), armor);
      lower.position.y = -0.64; hip.add(lower);
      legParts.push({ hip, phase: (s > 0 ? 0 : Math.PI) });
    }
  }
  return { group: g, head, legParts, armR };
}

// ---------- enemy models ----------
export function buildEnemyModel(kind) {
  const g = new THREE.Group();
  if (kind === 'turret') {
    const base = new THREE.MeshLambertMaterial({ color: 0x5a626e });
    const head = new THREE.MeshLambertMaterial({ color: 0x4a5260 });
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.85, 0.5, 10), base);
    b.position.y = 0.25; g.add(b);
    const pivot = new THREE.Group(); pivot.position.y = 1.1; g.add(pivot);
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.9), head); pivot.add(h);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.2, 8), base);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.1, 0.7); pivot.add(barrel);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff4030 }));
    tip.position.set(0, 0.1, 1.3); tip.visible = false; pivot.add(tip);
    return { group: g, pivot, tip };
  }
  // guard robot ~1.7m
  const armor = new THREE.MeshLambertMaterial({ color: 0x6a727e });
  const dark = new THREE.MeshLambertMaterial({ color: 0x39404a });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.55, 0.45), armor);
  torso.position.y = 1.15; g.add(torso);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.3), dark);
  head.position.y = 1.55; g.add(head);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.05), new THREE.MeshBasicMaterial({ color: 0xff3020 }));
  visor.position.set(0, 1.55, 0.16); g.add(visor);
  const gunArm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.7), dark);
  gunArm.position.set(0.42, 1.2, 0.25); g.add(gunArm);
  const legs = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(0.18 * s, 0.88, 0); g.add(hip);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.85, 0.18), dark);
    leg.position.y = -0.44; hip.add(leg);
    legs.push({ hip, phase: s > 0 ? 0 : Math.PI });
  }
  return { group: g, visor, legs, torso };
}

// ---------- effects ----------
const FX_POOL = 96;
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = []; // {mesh, life, ttl, vel, grav, kind}
    this.geo = new THREE.SphereGeometry(1, 8, 6);
    this.mats = {
      spark: new THREE.MeshBasicMaterial({ color: 0xffc060, transparent: true }),
      boom: new THREE.MeshBasicMaterial({ color: 0xff7030, transparent: true }),
      smoke: new THREE.MeshBasicMaterial({ color: 0x555555, transparent: true }),
    };
  }
  _spawn(mat, pos, scale, ttl, vel = [0, 0, 0]) {
    if (this.items.length >= FX_POOL) { const it = this.items.shift(); this.scene.remove(it.mesh); }
    const mesh = new THREE.Mesh(this.geo, mat.clone());
    mesh.position.set(pos[0], pos[1], pos[2]); mesh.scale.setScalar(scale);
    this.scene.add(mesh);
    this.items.push({ mesh, life: 0, ttl, vel, s0: scale });
  }
  impact(pos) {
    for (let i = 0; i < 4; i++) {
      this._spawn(this.mats.spark, pos, 0.09, 0.3,
        [(Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8]);
    }
  }
  explosion(pos, big) {
    this._spawn(this.mats.boom, pos, big ? 0.8 : 0.5, 0.45);
    this._spawn(this.mats.smoke, pos, big ? 0.9 : 0.5, 0.8, [0, 2, 0]);
    for (let i = 0; i < 6; i++) {
      this._spawn(this.mats.spark, pos, 0.12, 0.4,
        [(Math.random() - 0.5) * 14, Math.random() * 9, (Math.random() - 0.5) * 14]);
    }
  }
  update(dt) {
    for (const it of this.items) {
      it.life += dt;
      const k = it.life / it.ttl;
      it.mesh.position.x += it.vel[0] * dt;
      it.mesh.position.y += it.vel[1] * dt;
      it.mesh.position.z += it.vel[2] * dt;
      it.vel[1] -= 12 * dt;
      it.mesh.material.opacity = Math.max(0, 1 - k);
      it.mesh.scale.setScalar(it.s0 * (1 + k * 2.5));
    }
    this.items = this.items.filter(it => {
      if (it.life >= it.ttl) { this.scene.remove(it.mesh); it.mesh.material.dispose(); return false; }
      return true;
    });
  }
}

// ---------- projectile meshes ----------
export class ProjectileView {
  constructor(scene) {
    this.scene = scene;
    this.tracerGeo = new THREE.BoxGeometry(0.06, 0.06, 1.4);
    this.tracerMat = new THREE.MeshBasicMaterial({ color: PARAMS.colors.mgTracer });
    this.ebGeo = new THREE.BoxGeometry(0.09, 0.09, 0.9);
    this.ebMat = new THREE.MeshBasicMaterial({ color: PARAMS.colors.enemyBullet });
    this.msGeo = new THREE.ConeGeometry(0.12, 0.5, 6);
    this.msMat = new THREE.MeshLambertMaterial({ color: 0xccbbaa });
    this.beamMat = new THREE.MeshBasicMaterial({ color: PARAMS.colors.beam, transparent: true, opacity: 0.85 });
    this.pools = { mg: [], eb: [], ms: [], beam: [] };
  }
  _mesh(pool, geo, mat) {
    const p = this.pools[pool];
    for (const m of p) if (!m.visible) { m.visible = true; return m; }
    const m = new THREE.Mesh(geo, mat); this.scene.add(m); p.push(m); return m;
  }
  _orient(m, from, velOrDir, len) {
    const d = new THREE.Vector3(velOrDir[0], velOrDir[1], velOrDir[2]).normalize();
    m.position.set(from[0], from[1], from[2]);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
    if (len) m.scale.z = len;
  }
  update(projectiles) {
    for (const k in this.pools) for (const m of this.pools[k]) m.visible = false;
    for (const b of projectiles.playerBullets) this._orient(this._mesh('mg', this.tracerGeo, this.tracerMat), b.pos, b.v0);
    for (const b of projectiles.enemyBullets) this._orient(this._mesh('eb', this.ebGeo, this.ebMat), b.pos, b.vel);
    for (const ms of projectiles.missiles) {
      const m = this._mesh('ms', this.msGeo, this.msMat);
      const d = new THREE.Vector3(...ms.vel).normalize();
      m.position.set(ms.pos[0], ms.pos[1], ms.pos[2]);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    }
    for (const f of projectiles.fx) {
      if (f.kind !== 'beam') continue;
      const a = f.from, b = f.to;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const geo = new THREE.CylinderGeometry(0.06, 0.06, len, 6);
      const m = this._mesh('beam', geo, this.beamMat);
      m.geometry.dispose(); m.geometry = geo;
      m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    }
  }
}

// ---------- main renderer ----------
export class Renderer {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x11151c);
    this.scene.fog = new THREE.Fog(0x11151c, 60, 260);

    this.camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.1, 600);
    this.camYaw = 0; this.camPitch = -0.08;
    this.camPos = new THREE.Vector3();

    const hemi = new THREE.HemisphereLight(0x9db2cc, 0x3d3830, 1.15);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xfff2dd, 1.1);
    dir.position.set(60, 120, 40);
    this.scene.add(dir);

    this.effects = new Effects(this.scene);
    this.projView = new ProjectileView(this.scene);
    this.enemyModels = new Map();
    this.playerModel = null;
    this.muzzleFlash = 0;
    this._v = new THREE.Vector3();
  }

  setStage(stage) {
    if (this.stageGroup) this.scene.remove(this.stageGroup);
    const { group, barrierMeshes } = buildStageGroup(stage);
    this.stageGroup = group; this.barrierMeshes = barrierMeshes;
    this.scene.add(group);
  }

  setPlayerModel(legs) {
    if (this.playerModel) this.scene.remove(this.playerModel.group);
    this.playerModel = buildPlayerModel(legs);
    this.scene.add(this.playerModel.group);
  }

  syncEnemies(enemies) {
    const seen = new Set();
    for (const en of enemies) {
      seen.add(en.id);
      let m = this.enemyModels.get(en.id);
      if (!m) {
        m = buildEnemyModel(en.kind);
        this.enemyModels.set(en.id, m);
        this.scene.add(m.group);
      }
      m.group.position.set(en.pos[0], en.pos[1], en.pos[2]);
      m.group.rotation.y = en.aimYaw;
      m.group.visible = en.alive;
      if (en.kind === 'turret' && m.pivot) {
        m.pivot.rotation.y = 0; // group yaw already aims
        m.tip.visible = en.telegraph;
      }
      if (en.kind === 'guard') {
        m.visor.material.color.setHex(en.telegraph ? 0xffff30 : 0xff3020);
        const sp = Math.hypot(en.vel[0], en.vel[2]);
        m._ph = (m._ph || 0) + sp * 0.016 * 1.8;
        for (const l of m.legs) l.hip.rotation.x = Math.sin(m._ph + l.phase) * Math.min(1, sp / 6) * 0.6;
      }
    }
    for (const [id, m] of this.enemyModels) {
      if (!seen.has(id)) { this.scene.remove(m.group); this.enemyModels.delete(id); }
    }
  }

  updatePlayer(player, dt) {
    const m = this.playerModel; if (!m) return;
    m.group.position.set(player.pos[0], player.pos[1], player.pos[2]);
    m.group.rotation.y = player.yaw;
    const sp = Math.hypot(player.vel[0], player.vel[2]);
    player.walkPhase += dt * sp * (player.grounded ? 1.0 : 0.3);
    for (const l of m.legParts) {
      l.hip.rotation.x = Math.sin(player.walkPhase * 0.9 + l.phase) * Math.min(1, sp / 8) * 0.55;
    }
    // lean: glide/QB tilts forward
    const lean = player.horizontalMode === 'quickboost' ? 0.35 : player.horizontalMode === 'glide' ? 0.18 : 0;
    m.group.rotation.x += (lean - m.group.rotation.x) * Math.min(1, dt * 8);
    m.armR.rotation.x = -0.15;
  }

  // TPS camera: behind+right shoulder, collision-clamped. Returns view for FCS/input.
  updateCamera(player, world, dt, mouse) {
    this.camYaw -= mouse.dx * 0.0024;
    this.camPitch -= mouse.dy * 0.0022;
    this.camPitch = Math.max(-1.2, Math.min(0.9, this.camPitch));
    const yaw = this.camYaw, pitch = this.camPitch;
    const fwd = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const head = [player.pos[0], player.pos[1] + 1.65, player.pos[2]];
    const dist = 6.2;
    const desired = new THREE.Vector3(
      head[0] - fwd.x * dist + Math.cos(yaw) * 0.9,
      head[1] - fwd.y * dist + 0.5,
      head[2] - fwd.z * dist - Math.sin(yaw) * 0.9,
    );
    // camera collision: shorten boom on hit
    const hit = world.raycastSegment(head, [desired.x, desired.y, desired.z]);
    const pos = hit
      ? new THREE.Vector3(head[0] + (hit.point[0] - head[0]) * Math.max(0.15, hit.t - 0.03),
                          head[1] + (hit.point[1] - head[1]) * Math.max(0.15, hit.t - 0.03),
                          head[2] + (hit.point[2] - head[2]) * Math.max(0.15, hit.t - 0.03))
      : desired;
    pos.y = Math.max(pos.y, world.groundHeightAt(pos.x, pos.z, pos.y + 1, 2) + 0.3);
    this.camPos.lerp(pos, Math.min(1, dt * 14));
    this.camera.position.copy(this.camPos);
    const look = new THREE.Vector3(head[0] + fwd.x * 8, head[1] + fwd.y * 8, head[2] + fwd.z * 8);
    this.camera.lookAt(look);
    this.camera.updateMatrixWorld();
    const cam = this.camera;
    const w = this.renderer.domElement.clientWidth || window.innerWidth;
    const h = this.renderer.domElement.clientHeight || window.innerHeight;
    return {
      camPos: [this.camPos.x, this.camPos.y, this.camPos.z],
      camForward: [fwd.x, fwd.y, fwd.z],
      widthPx: w, heightPx: h,
      project: (p) => {
        this._v.set(p[0], p[1], p[2]).project(cam);
        return { x: (this._v.x * 0.5 + 0.5) * w, y: (-this._v.y * 0.5 + 0.5) * h, behind: this._v.z > 1 };
      },
    };
  }

  render() { this.renderer.render(this.scene, this.camera); }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
