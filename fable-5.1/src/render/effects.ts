/**
 * 視覚効果: MG 曳光、ビーム軌跡、ミサイル弾体＋噴射＋煙、命中火花、被弾、撃破爆発、QB 噴射、着地の砂塵、隔壁開放灯。
 * 全てプール（InstancedMesh または固定数の Mesh）で、上限を超えない。寿命付きで確実に消える。
 * 乱数は視覚専用（Math.random）で、ゲーム進行の Rng とは分離。
 */
import * as THREE from 'three';
import type { ProjectileView, SimEvent, Vec3 } from '../types';
import { glow, standard } from './materials';

/** ビーム軌跡の表示時間 [s] */
export const BEAM_SECONDS = 0.12;
/** 爆発の寿命 [s] */
export const EXPLOSION_SECONDS = 0.8;
/** 爆発の発光球の半径 [m]（size=1、寿命の始まりと終わり） */
export const EXPLOSION_MIN_RADIUS = 0.6;
export const EXPLOSION_MAX_RADIUS = 2.4;
/** 各プールの上限 */
export const EFFECT_CAPACITY = {
  mgTracers: 96,
  enemyTracers: 512,
  missiles: 24,
  sparks: 600,
  debris: 160,
  puffs: 320,
  beams: 8,
  explosions: 8,
  flashes: 24,
  barrierLights: 6,
} as const;

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const tmpPos = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
const tmpColor = new THREE.Color();
const IDENTITY_QUAT = new THREE.Quaternion();

const rnd = (): number => Math.random();
const rndRange = (a: number, b: number): number => a + (b - a) * Math.random();

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  gravity: number;
  r: number;
  g: number;
  b: number;
  /** 寿命に応じた拡大率 */
  grow: number;
  drag: number;
}

/** InstancedMesh ベースの粒子プール */
class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  readonly particles: Particle[] = [];
  private readonly capacity: number;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, private readonly fade: boolean) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, tmpColor.setRGB(1, 1, 1));
  }

  spawn(p: Particle): void {
    if (this.particles.length >= this.capacity) this.particles.shift();
    this.particles.push(p);
  }

  get count(): number {
    return this.particles.length;
  }

  update(dt: number): void {
    const list = this.particles;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= p.gravity * dt;
      const drag = Math.max(0, 1 - p.drag * dt);
      p.vx *= drag;
      p.vy *= drag;
      p.vz *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      list[w++] = p;
    }
    list.length = w;
    const mesh = this.mesh;
    for (let i = 0; i < w; i++) {
      const p = list[i];
      const t = 1 - p.life / p.maxLife;
      const s = p.size * (1 + p.grow * t);
      tmpPos.set(p.x, p.y, p.z);
      tmpScale.set(s, s, s);
      tmpMat.compose(tmpPos, IDENTITY_QUAT, tmpScale);
      mesh.setMatrixAt(i, tmpMat);
      const k = this.fade ? 1 - t : 1;
      mesh.setColorAt(i, tmpColor.setRGB(p.r * k, p.g * k, p.b * k));
    }
    mesh.count = w;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    this.particles.length = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
    this.mesh.removeFromParent();
  }
}

/** 寿命付きの単体メッシュプール（ビーム・爆発・閃光） */
interface TimedMesh {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

class TimedPool {
  readonly items: TimedMesh[] = [];
  private free: THREE.Mesh[] = [];

  constructor(
    readonly parent: THREE.Object3D,
    private readonly capacity: number,
    factory: () => THREE.Mesh,
    private readonly animate: (m: THREE.Mesh, t: number) => void,
    /** メッシュごとにマテリアルを所有している（dispose で破棄） */
    private readonly ownsMaterials = false,
  ) {
    for (let i = 0; i < capacity; i++) {
      const m = factory();
      m.visible = false;
      parent.add(m);
      this.free.push(m);
    }
  }

  acquire(life: number): THREE.Mesh | null {
    let m = this.free.pop();
    if (!m) {
      // 最も古いものを再利用
      const oldest = this.items.shift();
      if (!oldest) return null;
      m = oldest.mesh;
    }
    m.visible = true;
    this.items.push({ mesh: m, life, maxLife: life });
    return m;
  }

  get active(): number {
    return this.items.length;
  }

  update(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      it.life -= dt;
      if (it.life <= 0) {
        it.mesh.visible = false;
        this.free.push(it.mesh);
        continue;
      }
      this.animate(it.mesh, 1 - it.life / it.maxLife);
      this.items[w++] = it;
    }
    this.items.length = w;
  }

  clear(): void {
    for (const it of this.items) {
      it.mesh.visible = false;
      this.free.push(it.mesh);
    }
    this.items.length = 0;
  }

  dispose(): void {
    const all = [...this.free, ...this.items.map((i) => i.mesh)];
    for (const m of all) {
      m.geometry.dispose();
      if (this.ownsMaterials) (m.material as THREE.Material).dispose();
      m.removeFromParent();
    }
    this.free = [];
    this.items.length = 0;
    void this.capacity;
  }
}

/** ミサイル弾体（コーン＋胴体＋噴射炎）: 索引ごとにプールから割り当て */
class MissilePool {
  readonly group = new THREE.Group();
  private readonly bodies: THREE.Group[] = [];
  private readonly flames: THREE.Mesh[] = [];
  private readonly bodyMat = standard(0xb8b0a0, 0.5, 0.6);
  private readonly finMat = standard(0x802020, 0.6, 0.4);
  private readonly flameMat = glow(0xffa040, 0.9);
  private readonly bodyGeom: THREE.BufferGeometry;
  private readonly noseGeom: THREE.BufferGeometry;
  private readonly finGeom: THREE.BufferGeometry;
  private readonly flameGeom: THREE.BufferGeometry;

  constructor(private readonly capacity: number) {
    // 進行方向は +Z（quaternion で direction へ向ける）
    this.bodyGeom = new THREE.CylinderGeometry(0.12, 0.12, 0.7, 10);
    this.bodyGeom.rotateX(Math.PI / 2);
    this.noseGeom = new THREE.ConeGeometry(0.12, 0.3, 10);
    this.noseGeom.rotateX(Math.PI / 2);
    this.noseGeom.translate(0, 0, 0.5);
    this.finGeom = new THREE.BoxGeometry(0.4, 0.02, 0.2);
    this.finGeom.translate(0, 0, -0.25);
    this.flameGeom = new THREE.ConeGeometry(0.1, 0.8, 8, 1, true);
    this.flameGeom.rotateX(-Math.PI / 2);
    this.flameGeom.translate(0, 0, -0.75);
  }

  private make(): THREE.Group {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(this.bodyGeom, this.bodyMat));
    g.add(new THREE.Mesh(this.noseGeom, this.finMat));
    const fin1 = new THREE.Mesh(this.finGeom, this.finMat);
    const fin2 = new THREE.Mesh(this.finGeom, this.finMat);
    fin2.rotation.z = Math.PI / 2;
    g.add(fin1, fin2);
    const flame = new THREE.Mesh(this.flameGeom, this.flameMat);
    g.add(flame);
    this.flames.push(flame);
    this.group.add(g);
    this.bodies.push(g);
    return g;
  }

  get poolSize(): number {
    return this.bodies.length;
  }

  sync(missiles: ProjectileView[]): void {
    const n = Math.min(missiles.length, this.capacity);
    while (this.bodies.length < n) this.make();
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      if (i >= n) {
        body.visible = false;
        continue;
      }
      const m = missiles[i];
      body.visible = true;
      body.position.set(m.position[0], m.position[1], m.position[2]);
      tmpDir.set(m.direction[0], m.direction[1], m.direction[2]);
      if (tmpDir.lengthSq() > 1e-8) body.quaternion.setFromUnitVectors(Z_AXIS, tmpDir.normalize());
      const f = this.flames[i];
      const sc = 0.8 + rnd() * 0.5;
      f.scale.set(sc, sc, sc);
    }
  }

  clear(): void {
    for (const b of this.bodies) b.visible = false;
  }

  dispose(): void {
    this.bodyGeom.dispose();
    this.noseGeom.dispose();
    this.finGeom.dispose();
    this.flameGeom.dispose();
    this.bodyMat.dispose();
    this.finMat.dispose();
    this.flameMat.dispose();
    this.group.removeFromParent();
  }
}

/** 曳光: 索引ごとに InstancedMesh を再構築 */
class TracerPool {
  readonly mesh: THREE.InstancedMesh;
  constructor(length: number, thickness: number, color: number, private readonly capacity: number) {
    const g = new THREE.BoxGeometry(thickness, thickness, length);
    this.mesh = new THREE.InstancedMesh(g, glow(color, 0.95), capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  sync(list: ProjectileView[]): void {
    const n = Math.min(list.length, this.capacity);
    for (let i = 0; i < n; i++) {
      const p = list[i];
      tmpPos.set(p.position[0], p.position[1], p.position[2]);
      tmpDir.set(p.direction[0], p.direction[1], p.direction[2]);
      if (tmpDir.lengthSq() > 1e-8) tmpQuat.setFromUnitVectors(Z_AXIS, tmpDir.normalize());
      else tmpQuat.identity();
      tmpScale.set(1, 1, 1);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      this.mesh.setMatrixAt(i, tmpMat);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
    this.mesh.removeFromParent();
  }
}

export class EffectsSystem {
  readonly root = new THREE.Group();
  private readonly mgTracers: TracerPool;
  private readonly enemyTracers: TracerPool;
  private readonly missiles: MissilePool;
  private readonly sparks: ParticlePool;
  private readonly debris: ParticlePool;
  private readonly puffs: ParticlePool;
  private readonly beams: TimedPool;
  private readonly explosions: TimedPool;
  private readonly flashes: TimedPool;
  private readonly barrierLights: TimedPool;
  private smokeAccumulator = 0;
  private readonly beamMat = glow(0x60e0ff, 0.9);
  private readonly explosionMat = glow(0xff9030, 0.85);
  private readonly flashMat = glow(0xffe0a0, 0.9);
  private readonly barrierLightMat = glow(0xffb020, 0.9);

  constructor() {
    this.root.name = 'effects';
    this.mgTracers = new TracerPool(1.4, 0.07, 0xffe080, EFFECT_CAPACITY.mgTracers);
    this.enemyTracers = new TracerPool(1.2, 0.14, 0xff5030, EFFECT_CAPACITY.enemyTracers);
    this.root.add(this.mgTracers.mesh, this.enemyTracers.mesh);
    this.missiles = new MissilePool(EFFECT_CAPACITY.missiles);
    this.root.add(this.missiles.group);
    this.sparks = new ParticlePool(new THREE.BoxGeometry(0.07, 0.07, 0.07), glow(0xffffff, 1), EFFECT_CAPACITY.sparks, true);
    this.debris = new ParticlePool(new THREE.BoxGeometry(0.25, 0.2, 0.3), standard(0x3a3632, 0.9, 0.3), EFFECT_CAPACITY.debris, false);
    this.puffs = new ParticlePool(
      new THREE.SphereGeometry(0.35, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.35, depthWrite: false }),
      EFFECT_CAPACITY.puffs,
      true,
    );
    this.root.add(this.sparks.mesh, this.debris.mesh, this.puffs.mesh);

    // ビーム: 単位シリンダー（+Z 方向、長さ 1）を from→to へ拡大
    const beamGeom = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    beamGeom.rotateX(Math.PI / 2);
    beamGeom.translate(0, 0, 0.5);
    this.beams = new TimedPool(
      this.root,
      EFFECT_CAPACITY.beams,
      () => new THREE.Mesh(beamGeom, this.beamMat),
      (m, t) => {
        const r = 0.08 * (1 - t * 0.7);
        m.scale.set(r, r, m.scale.z);
      },
    );
    const explosionGeom = new THREE.SphereGeometry(1, 14, 10);
    // 爆発は個別にフェードさせるためマテリアルを複製（プール数固定なので増えない）
    this.explosions = new TimedPool(
      this.root,
      EFFECT_CAPACITY.explosions,
      () => new THREE.Mesh(explosionGeom, this.explosionMat.clone()),
      (m, t) => {
        const size = (m.userData.size as number) ?? 1;
        // 発光球は照準を妨げない大きさに留める（最大半径 EXPLOSION_MAX_RADIUS × size）。撃破の読みは破片・火花・煙が担う
        const s = (EXPLOSION_MIN_RADIUS + t * (EXPLOSION_MAX_RADIUS - EXPLOSION_MIN_RADIUS)) * size;
        m.scale.set(s, s * (0.8 + t * 0.3), s);
        (m.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t) * (1 - t);
        m.rotation.y += 0.02;
      },
      true,
    );
    const flashGeom = new THREE.SphereGeometry(1, 8, 6);
    this.flashes = new TimedPool(
      this.root,
      EFFECT_CAPACITY.flashes,
      () => new THREE.Mesh(flashGeom, this.flashMat),
      (m, t) => {
        const s = m.userData.size * (1 - t * 0.6);
        m.scale.set(s, s, s);
      },
    );
    const lightGeom = new THREE.SphereGeometry(0.35, 8, 6);
    this.barrierLights = new TimedPool(
      this.root,
      EFFECT_CAPACITY.barrierLights,
      () => new THREE.Mesh(lightGeom, this.barrierLightMat),
      (m, t) => {
        const on = Math.floor(t * 12) % 2 === 0;
        const s = on ? 1.4 : 0.6;
        m.scale.set(s, s, s);
      },
    );
  }

  // -------------------------------------------------------------------------
  // イベント
  // -------------------------------------------------------------------------

  handleEvent(e: SimEvent, barrierCenter?: (id: string) => Vec3 | null): void {
    switch (e.type) {
      case 'mgFire':
        this.flash(e.muzzle, 0.25, 0.05);
        break;
      case 'beamFire':
        this.beam(e.from, e.to);
        this.flash(e.to, 0.5, 0.1);
        this.sparkBurst(e.to, [0, 1, 0], 10, 0x80f0ff, 6);
        break;
      case 'missileFire':
        this.flash(e.muzzle, 0.4, 0.08);
        this.smokeBurst(e.muzzle, 8, 0.4);
        break;
      case 'enemyHit':
        this.sparkBurst(e.point, [0, 1, 0], e.weapon === 'missile' ? 40 : 14, e.weapon === 'beam' ? 0x80f0ff : 0xffd060, 8);
        this.flash(e.point, e.weapon === 'missile' ? 1.2 : 0.4, 0.08);
        break;
      case 'worldHit':
        this.sparkBurst(e.point, e.normal, e.source === 'missile' ? 40 : 8, e.source === 'enemy' ? 0xff8060 : 0xffd060, e.source === 'missile' ? 10 : 5);
        if (e.source === 'missile') {
          this.explosion(e.point, 0.7);
          this.smokeBurst(e.point, 10, 0.8);
        }
        break;
      case 'missileExpired':
        this.smokeBurst(e.point, 6, 0.5);
        this.flash(e.point, 0.5, 0.08);
        break;
      case 'playerHit':
        this.sparkBurst(e.point, [-e.fromDirection[0], -e.fromDirection[1], -e.fromDirection[2]], 10, 0xff6040, 5);
        this.flash(e.point, 0.35, 0.06);
        break;
      case 'enemyDestroyed':
        this.explosion([e.position[0], e.position[1] + (e.kind === 'turret' ? 1.8 : 1.4), e.position[2]], 1.0);
        this.debrisBurst([e.position[0], e.position[1] + 1.2, e.position[2]], e.kind === 'turret' ? 18 : 12);
        this.sparkBurst([e.position[0], e.position[1] + 1.2, e.position[2]], [0, 1, 0], 40, 0xffb040, 9);
        this.smokeBurst([e.position[0], e.position[1] + 1.5, e.position[2]], 16, 1.2);
        break;
      case 'enemyFire':
        this.flash(e.muzzle, 0.35, 0.06);
        break;
      case 'qbStart':
        this.qbBurst(e.position, e.direction);
        break;
      case 'jump':
        this.dust(e.position, 6);
        break;
      case 'landed':
        this.dust(e.position, 10);
        break;
      case 'barrierOpened': {
        const c = barrierCenter ? barrierCenter(e.barrierId) : null;
        if (c) this.barrierLightsAt(c);
        break;
      }
      default:
        break;
    }
  }

  private flash(p: Vec3, size: number, life: number): void {
    const m = this.flashes.acquire(life);
    if (!m) return;
    m.position.set(p[0], p[1], p[2]);
    m.userData.size = size;
    m.scale.set(size, size, size);
  }

  private beam(from: Vec3, to: Vec3): void {
    const m = this.beams.acquire(BEAM_SECONDS);
    if (!m) return;
    tmpDir.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const len = tmpDir.length();
    if (len < 1e-4) {
      m.visible = false;
      return;
    }
    m.position.set(from[0], from[1], from[2]);
    m.quaternion.setFromUnitVectors(Z_AXIS, tmpDir.multiplyScalar(1 / len));
    m.scale.set(0.08, 0.08, len);
  }

  private explosion(p: Vec3, size: number): void {
    const m = this.explosions.acquire(EXPLOSION_SECONDS);
    if (!m) return;
    m.position.set(p[0], p[1], p[2]);
    m.scale.setScalar(0.6 * size);
    m.userData.size = size;
  }

  private sparkBurst(p: Vec3, normal: Vec3, count: number, color: number, speed: number): void {
    tmpColor.setHex(color);
    for (let i = 0; i < count; i++) {
      const vx = normal[0] * speed * 0.6 + rndRange(-1, 1) * speed;
      const vy = normal[1] * speed * 0.6 + rndRange(-0.5, 1.2) * speed;
      const vz = normal[2] * speed * 0.6 + rndRange(-1, 1) * speed;
      this.sparks.spawn({
        x: p[0],
        y: p[1],
        z: p[2],
        vx,
        vy,
        vz,
        life: rndRange(0.15, 0.45),
        maxLife: 0.45,
        size: rndRange(0.6, 1.4),
        gravity: 12,
        r: tmpColor.r,
        g: tmpColor.g,
        b: tmpColor.b,
        grow: 0,
        drag: 1.5,
      });
    }
  }

  private debrisBurst(p: Vec3, count: number): void {
    for (let i = 0; i < count; i++) {
      this.debris.spawn({
        x: p[0] + rndRange(-0.5, 0.5),
        y: p[1] + rndRange(-0.3, 0.5),
        z: p[2] + rndRange(-0.5, 0.5),
        vx: rndRange(-7, 7),
        vy: rndRange(3, 11),
        vz: rndRange(-7, 7),
        life: EXPLOSION_SECONDS + rndRange(0, 0.4),
        maxLife: 1.2,
        size: rndRange(0.5, 1.6),
        gravity: 18,
        r: 1,
        g: 1,
        b: 1,
        grow: 0,
        drag: 0.3,
      });
    }
  }

  private smokeBurst(p: Vec3, count: number, size: number): void {
    for (let i = 0; i < count; i++) {
      this.puffs.spawn({
        x: p[0] + rndRange(-0.3, 0.3),
        y: p[1] + rndRange(-0.3, 0.3),
        z: p[2] + rndRange(-0.3, 0.3),
        vx: rndRange(-1.5, 1.5),
        vy: rndRange(0.5, 2.5),
        vz: rndRange(-1.5, 1.5),
        life: rndRange(0.5, 1.0),
        maxLife: 1.0,
        size: size * rndRange(0.6, 1.2),
        gravity: -1,
        r: 0.5,
        g: 0.5,
        b: 0.5,
        grow: 2.5,
        drag: 1.5,
      });
    }
  }

  private dust(p: Vec3, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const sp = rndRange(1.5, 4);
      this.puffs.spawn({
        x: p[0],
        y: p[1] + 0.1,
        z: p[2],
        vx: Math.cos(a) * sp,
        vy: rndRange(0.2, 1.0),
        vz: Math.sin(a) * sp,
        life: rndRange(0.3, 0.6),
        maxLife: 0.6,
        size: 0.8,
        gravity: 0,
        r: 0.55,
        g: 0.5,
        b: 0.45,
        grow: 2.0,
        drag: 3,
      });
    }
  }

  private qbBurst(p: Vec3, dir: Vec3): void {
    // 推進方向と逆へ噴射炎の閃光と粒子
    const back: Vec3 = [-dir[0], -dir[1], -dir[2]];
    const c: Vec3 = [p[0] + back[0] * 0.8, p[1] + 1.8, p[2] + back[2] * 0.8];
    this.flash(c, 1.1, 0.12);
    this.sparkBurst(c, back, 24, 0xffa040, 12);
    this.smokeBurst([p[0], p[1] + 0.3, p[2]], 6, 0.6);
  }

  private barrierLightsAt(c: Vec3): void {
    for (let i = 0; i < 3; i++) {
      const m = this.barrierLights.acquire(1.6);
      if (!m) return;
      m.position.set(c[0] + (i - 1) * 1.5, c[1], c[2]);
    }
    this.sparkBurst(c, [0, 1, 0], 20, 0xffc040, 4);
  }

  // -------------------------------------------------------------------------
  // 更新
  // -------------------------------------------------------------------------

  private readonly mgList: ProjectileView[] = [];
  private readonly enemyList: ProjectileView[] = [];
  private readonly missileList: ProjectileView[] = [];

  update(dt: number, projectiles: ProjectileView[]): void {
    this.mgList.length = 0;
    this.enemyList.length = 0;
    this.missileList.length = 0;
    for (const p of projectiles) {
      if (p.kind === 'machinegun') this.mgList.push(p);
      else if (p.kind === 'enemy') this.enemyList.push(p);
      else this.missileList.push(p);
    }
    this.mgTracers.sync(this.mgList);
    this.enemyTracers.sync(this.enemyList);
    this.missiles.sync(this.missileList);
    // ミサイルの煙
    if (this.missileList.length > 0) {
      this.smokeAccumulator += dt;
      const interval = 0.06;
      if (this.smokeAccumulator >= interval) {
        this.smokeAccumulator -= interval;
        for (const m of this.missileList) {
          this.puffs.spawn({
            x: m.position[0] - m.direction[0] * 0.6,
            y: m.position[1] - m.direction[1] * 0.6,
            z: m.position[2] - m.direction[2] * 0.6,
            vx: rndRange(-0.5, 0.5),
            vy: rndRange(0, 0.8),
            vz: rndRange(-0.5, 0.5),
            life: 0.7,
            maxLife: 0.7,
            size: 0.5,
            gravity: -0.5,
            r: 0.6,
            g: 0.6,
            b: 0.6,
            grow: 2.0,
            drag: 1,
          });
        }
      }
    } else {
      this.smokeAccumulator = 0;
    }
    this.sparks.update(dt);
    this.debris.update(dt);
    this.puffs.update(dt);
    this.beams.update(dt);
    this.explosions.update(dt);
    this.flashes.update(dt);
    this.barrierLights.update(dt);
  }

  /** 診断用: 生存中の効果数 */
  activeCounts(): { particles: number; timed: number; missiles: number } {
    return {
      particles: this.sparks.count + this.debris.count + this.puffs.count,
      timed: this.beams.active + this.explosions.active + this.flashes.active + this.barrierLights.active,
      missiles: this.missiles.poolSize,
    };
  }

  /** 再出撃時: 全効果を消す（プールは保持） */
  clear(): void {
    this.sparks.clear();
    this.debris.clear();
    this.puffs.clear();
    this.beams.clear();
    this.explosions.clear();
    this.flashes.clear();
    this.barrierLights.clear();
    this.missiles.clear();
    this.mgTracers.sync([]);
    this.enemyTracers.sync([]);
    this.smokeAccumulator = 0;
  }

  dispose(): void {
    this.mgTracers.dispose();
    this.enemyTracers.dispose();
    this.missiles.dispose();
    this.sparks.dispose();
    this.debris.dispose();
    this.puffs.dispose();
    this.beams.dispose();
    this.explosions.dispose();
    this.flashes.dispose();
    this.barrierLights.dispose();
    this.beamMat.dispose();
    this.explosionMat.dispose();
    this.flashMat.dispose();
    this.barrierLightMat.dispose();
    this.root.removeFromParent();
  }
}
