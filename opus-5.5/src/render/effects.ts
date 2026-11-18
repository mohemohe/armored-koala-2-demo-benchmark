// 弾体・ビーム・ミサイル・火花・爆発・ブースト演出。全て寿命付きのプールで管理し増え続けない。
import * as THREE from 'three';
import type { EnemyBullet } from '../sim/enemies';
import type { MgBullet, Missile } from '../sim/weapons';
import { textures } from './textures';

const Z = new THREE.Vector3(0, 0, 1);
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();

class InstancedStreaks {
  mesh: THREE.InstancedMesh;
  constructor(max: number, color: number, radius: number, scene: THREE.Scene) {
    const geo = new THREE.CylinderGeometry(radius, radius * 0.6, 1, 6, 1);
    geo.rotateX(Math.PI / 2); // 軸を +Z に
    const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  set(items: { a: THREE.Vector3; b: THREE.Vector3; w: number }[]) {
    const n = Math.min(items.length, this.mesh.instanceMatrix.count);
    for (let i = 0; i < n; i++) {
      const { a, b, w } = items[i];
      tmpV.subVectors(b, a);
      const len = Math.max(0.05, tmpV.length());
      tmpV.normalize();
      tmpQ.setFromUnitVectors(Z, tmpV);
      tmpS.set(w, w, len);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      tmpM.compose(mid, tmpQ, tmpS);
      this.mesh.setMatrixAt(i, tmpM);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

interface Particle {
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  max: number;
  grow: number;
  baseScale: number;
  gravity: number;
  fade: boolean;
}

interface BeamFx {
  mesh: THREE.Mesh;
  life: number;
}

export class Effects {
  private scene: THREE.Scene;
  private enemyGuard: InstancedStreaks;
  private enemyTurret: InstancedStreaks;
  private mg: InstancedStreaks;
  private missiles: THREE.Group[] = [];
  private particles: Particle[] = [];
  private freeSprites: THREE.Sprite[] = [];
  private beams: BeamFx[] = [];
  private beamGeo: THREE.CylinderGeometry;
  private beamMat: THREE.MeshBasicMaterial;
  private missileGeo: THREE.BufferGeometry;
  private missileMat: THREE.MeshStandardMaterial;
  private glowTex: THREE.Texture;
  private ringTex: THREE.Texture;
  private enemyGlow: THREE.Sprite[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.enemyGuard = new InstancedStreaks(256, 0xff8a20, 0.16, scene);
    this.enemyTurret = new InstancedStreaks(128, 0xff2a90, 0.24, scene);
    this.mg = new InstancedStreaks(256, 0xffe070, 0.06, scene);
    this.beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    this.beamGeo.rotateX(Math.PI / 2);
    this.beamMat = new THREE.MeshBasicMaterial({ color: 0x70f0ff, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.missileGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.9, 8);
    this.missileGeo.rotateX(Math.PI / 2);
    this.missileMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.4, metalness: 0.5, emissive: 0x331100 });
    const tx = textures();
    this.glowTex = tx.glow;
    this.ringTex = tx.ring;
  }

  private sprite(color: number, tex: THREE.Texture = this.glowTex): THREE.Sprite {
    let s = this.freeSprites.pop();
    if (!s) {
      s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      this.scene.add(s);
    }
    const m = s.material as THREE.SpriteMaterial;
    m.map = tex;
    m.color.setHex(color);
    m.opacity = 1;
    m.blending = THREE.AdditiveBlending;
    s.visible = true;
    return s;
  }

  private emit(pos: THREE.Vector3, color: number, opts: { vel?: THREE.Vector3; life: number; scale: number; grow?: number; gravity?: number; tex?: THREE.Texture; normalBlend?: boolean }) {
    if (this.particles.length > 900) return;
    const s = this.sprite(color, opts.tex);
    if (opts.normalBlend) (s.material as THREE.SpriteMaterial).blending = THREE.NormalBlending;
    s.position.copy(pos);
    s.scale.setScalar(opts.scale);
    this.particles.push({
      sprite: s,
      vel: opts.vel ? opts.vel.clone() : new THREE.Vector3(),
      life: opts.life,
      max: opts.life,
      grow: opts.grow ?? 0,
      baseScale: opts.scale,
      gravity: opts.gravity ?? 0,
      fade: true,
    });
  }

  sparks(pos: THREE.Vector3, color: number, n: number, speed: number, scale = 0.35) {
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 - 0.1, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      this.emit(pos, color, { vel: v, life: 0.25 + Math.random() * 0.25, scale, gravity: 14 });
    }
  }

  impact(pos: THREE.Vector3, kind: 'enemyBullet' | 'mg' | 'beam' | 'missile') {
    if (kind === 'mg') {
      this.sparks(pos, 0xffd070, 4, 7, 0.25);
      this.emit(pos, 0xffc060, { life: 0.08, scale: 0.9 });
    } else if (kind === 'beam') {
      this.sparks(pos, 0x80f0ff, 7, 9, 0.3);
      this.emit(pos, 0x80f0ff, { life: 0.18, scale: 2.2, grow: 4 });
    } else if (kind === 'missile') {
      this.explosion(pos, 0.8);
    } else {
      this.sparks(pos, 0xff7030, 3, 5, 0.22);
    }
  }

  hitEnemy(pos: THREE.Vector3, big: boolean) {
    this.sparks(pos, 0xfff0a0, big ? 14 : 5, big ? 14 : 8, big ? 0.5 : 0.3);
    this.emit(pos, 0xffffff, { life: 0.09, scale: big ? 3.2 : 1.3 });
  }

  explosion(pos: THREE.Vector3, size: number) {
    this.emit(pos, 0xffffff, { life: 0.12, scale: 5 * size });
    this.emit(pos, 0xff9a30, { life: 0.5, scale: 3 * size, grow: 14 * size });
    this.emit(pos, 0xff4010, { life: 0.7, scale: 2 * size, grow: 9 * size });
    this.emit(pos, 0xffd080, { life: 0.25, scale: 1.5 * size, grow: 9 * size, tex: this.ringTex });
    this.sparks(pos, 0xffb040, Math.round(22 * size), 20 * size, 0.5 * size);
    for (let i = 0; i < 6 * size; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6 + 0.3, Math.random() - 0.5).multiplyScalar(4);
      this.emit(pos, 0x303030, { vel: v, life: 1.4, scale: 2.2 * size, grow: 3, normalBlend: true });
    }
  }

  muzzle(pos: THREE.Vector3, color: number, scale: number) {
    this.emit(pos, color, { life: 0.06, scale });
  }

  boostBurst(pos: THREE.Vector3, dir: THREE.Vector3) {
    // QB：噴射方向と逆へ衝撃リングと粒子
    this.emit(pos, 0x9fe8ff, { life: 0.2, scale: 1.2, grow: 7, tex: this.ringTex });
    for (let i = 0; i < 12; i++) {
      const v = dir.clone().multiplyScalar(-18 - Math.random() * 10).add(new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.3) * 4, (Math.random() - 0.5) * 6));
      this.emit(pos, 0x7fd8ff, { vel: v, life: 0.3, scale: 0.9, grow: 2 });
    }
  }

  trail(pos: THREE.Vector3, color: number, scale: number, life = 0.25) {
    this.emit(pos, color, { life, scale, grow: 1.5 });
  }

  beam(from: THREE.Vector3, to: THREE.Vector3) {
    const m = new THREE.Mesh(this.beamGeo, this.beamMat.clone());
    tmpV.subVectors(to, from);
    const len = Math.max(0.1, tmpV.length());
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(Z, tmpV.normalize());
    m.scale.set(0.22, 0.22, len);
    this.scene.add(m);
    this.beams.push({ mesh: m, life: 0.18 });
    this.emit(from, 0x80f0ff, { life: 0.1, scale: 1.8 });
  }

  update(dt: number, enemyBullets: EnemyBullet[], mg: MgBullet[], missiles: Missile[], paused: boolean) {
    // 弾体（シミュレーションの位置をそのまま描画。直前位置との線分で弾道を表示）
    const g: { a: THREE.Vector3; b: THREE.Vector3; w: number }[] = [];
    const t: { a: THREE.Vector3; b: THREE.Vector3; w: number }[] = [];
    for (const b of enemyBullets) {
      const a = new THREE.Vector3(b.pos[0], b.pos[1], b.pos[2]);
      const dir = new THREE.Vector3(b.vel[0], b.vel[1], b.vel[2]).normalize();
      const tail = a.clone().addScaledVector(dir, b.kind === 'turret' ? -3.2 : -2.6);
      (b.kind === 'turret' ? t : g).push({ a: tail, b: a, w: 1 });
    }
    this.enemyGuard.set(g);
    this.enemyTurret.set(t);
    // 敵弾の発光
    const needGlow = Math.min(enemyBullets.length, 128);
    while (this.enemyGlow.length < needGlow) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      this.scene.add(s);
      this.enemyGlow.push(s);
    }
    for (let i = 0; i < this.enemyGlow.length; i++) {
      const s = this.enemyGlow[i];
      if (i < needGlow) {
        const b = enemyBullets[i];
        s.visible = true;
        s.position.set(b.pos[0], b.pos[1], b.pos[2]);
        (s.material as THREE.SpriteMaterial).color.setHex(b.kind === 'turret' ? 0xff3aa0 : 0xff9a30);
        s.scale.setScalar(b.kind === 'turret' ? 1.6 : 1.2);
      } else s.visible = false;
    }
    const m: { a: THREE.Vector3; b: THREE.Vector3; w: number }[] = [];
    for (const b of mg) {
      const a = new THREE.Vector3(b.pos[0], b.pos[1], b.pos[2]);
      const dir = new THREE.Vector3(b.vel[0], b.vel[1], b.vel[2]).normalize();
      m.push({ a: a.clone().addScaledVector(dir, -3.5), b: a, w: 1 });
    }
    this.mg.set(m);
    // ミサイル本体と噴射
    while (this.missiles.length < missiles.length) {
      const grp = new THREE.Group();
      grp.add(new THREE.Mesh(this.missileGeo, this.missileMat));
      const fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffa040, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      fl.position.z = 0.7;
      fl.scale.setScalar(1.4);
      grp.add(fl);
      this.scene.add(grp);
      this.missiles.push(grp);
    }
    for (let i = 0; i < this.missiles.length; i++) {
      const grp = this.missiles[i];
      const ms = missiles[i];
      if (!ms) {
        grp.visible = false;
        continue;
      }
      grp.visible = true;
      grp.position.set(ms.pos[0], ms.pos[1], ms.pos[2]);
      tmpV.set(-ms.dir[0], -ms.dir[1], -ms.dir[2]);
      grp.quaternion.setFromUnitVectors(Z, tmpV);
      if (!paused) this.trail(new THREE.Vector3(ms.pos[0] - ms.dir[0] * 0.6, ms.pos[1] - ms.dir[1] * 0.6, ms.pos[2] - ms.dir[2] * 0.6), 0x888888, 0.6, 0.5);
    }
    if (paused) return;
    // ビームの残光
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= dt;
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, b.life / 0.18);
      b.mesh.scale.x = b.mesh.scale.y = 0.22 * Math.max(0.2, b.life / 0.18);
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        this.beams.splice(i, 1);
      }
    }
    // 粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        this.freeSprites.push(p.sprite);
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.sprite.position.addScaledVector(p.vel, dt);
      const k = p.life / p.max;
      p.sprite.scale.setScalar(p.baseScale + p.grow * (1 - k));
      (p.sprite.material as THREE.SpriteMaterial).opacity = k;
    }
  }

  clear() {
    for (const p of this.particles) {
      p.sprite.visible = false;
      this.freeSprites.push(p.sprite);
    }
    this.particles = [];
    for (const b of this.beams) {
      this.scene.remove(b.mesh);
      (b.mesh.material as THREE.Material).dispose();
    }
    this.beams = [];
    this.enemyGuard.set([]);
    this.enemyTurret.set([]);
    this.mg.set([]);
    for (const m of this.missiles) m.visible = false;
    for (const s of this.enemyGlow) s.visible = false;
  }

  get particleCount() {
    return this.particles.length;
  }
}
