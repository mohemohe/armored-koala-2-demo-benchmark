// 敵の描画（警備ロボット・固定砲台・制御砲台）。射撃予告は銃口の蓄光と明滅で示す。
import * as THREE from 'three';
import { GUARD_AI, TURRET } from '../config';
import type { Enemy } from '../sim/enemies';
import { textures } from './textures';

const shared = (() => {
  let v: ReturnType<typeof make> | null = null;
  function make() {
    const tx = textures();
    return {
      body: new THREE.MeshStandardMaterial({ color: 0x7d8690, map: tx.panel, roughness: 0.5, metalness: 0.45 }),
      bodyLight: new THREE.MeshStandardMaterial({ color: 0xb4bcc4, roughness: 0.5, metalness: 0.4 }),
      stripe: new THREE.MeshStandardMaterial({ color: 0xff6a18, roughness: 0.6, metalness: 0.2, emissive: 0x902800, emissiveIntensity: 0.7 }),
      joint: new THREE.MeshStandardMaterial({ color: 0x25292e, roughness: 0.4, metalness: 0.8 }),
      hazard: new THREE.MeshStandardMaterial({ map: tx.hazard, roughness: 0.6, metalness: 0.3 }),
      wreck: new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.95, metalness: 0.2 }),
      glow: tx.glow,
    };
  }
  return () => (v ??= make());
})();

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

export class EnemyView {
  root = new THREE.Group();
  private aim = new THREE.Group();
  private eyeMat: THREE.MeshBasicMaterial;
  private muzzleGlow: THREE.Sprite;
  private beacon: THREE.Sprite | null = null;
  private beaconMat: THREE.MeshBasicMaterial | null = null;
  private legs: THREE.Group[] = [];
  private flash = 0;
  private dead = false;
  private parts: THREE.Mesh[] = [];
  readonly enemy: Enemy;

  constructor(e: Enemy) {
    this.enemy = e;
    const s = shared();
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0xff3a1a, toneMapped: false });
    this.muzzleGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: s.glow, color: 0xff5020, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }),
    );
    if (e.kind === 'guard') this.buildGuard();
    else this.buildTurret(e.def.isGateControl);
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) this.parts.push(o);
    });
  }

  private buildGuard() {
    const s = shared();
    const r = this.root;
    // 脚
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.45, 1.05, 0);
      leg.add(box(0.28, 0.6, 0.34, s.joint, 0, -0.3, 0));
      leg.add(box(0.24, 0.5, 0.3, s.body, 0, -0.75, 0.05));
      leg.add(box(0.4, 0.14, 0.62, s.bodyLight, 0, -1.0, -0.08));
      r.add(leg);
      this.legs.push(leg);
    }
    // 胴体
    const bodyG = new THREE.Group();
    bodyG.position.y = 1.55;
    const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 0.35, 6, 14), s.body);
    hull.rotation.z = Math.PI / 2;
    hull.scale.set(1, 1, 0.95);
    bodyG.add(hull);
    bodyG.add(box(1.5, 0.14, 0.9, s.stripe, 0, -0.25, 0));
    bodyG.add(box(0.9, 0.22, 0.2, s.joint, 0, 0.18, -0.55)); // バイザー
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), this.eyeMat);
    eye.position.set(0, 0.18, -0.62);
    bodyG.add(eye);
    bodyG.add(box(0.1, 0.5, 0.1, s.joint, 0.4, 0.75, 0.2)); // アンテナ
    r.add(bodyG);
    // 銃腕（照準で上下）
    this.aim.position.set(0.72, 1.95, 0);
    const gun = box(0.26, 0.26, 1.1, s.joint, 0, 0, -0.45);
    this.aim.add(gun);
    this.aim.add(box(0.32, 0.36, 0.5, s.bodyLight, 0, 0, 0));
    this.muzzleGlow.position.set(0, 0, -1.1);
    this.aim.add(this.muzzleGlow);
    r.add(this.aim);
  }

  private buildTurret(control: boolean) {
    const s = shared();
    const r = this.root;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.2, 0.6, 18), control ? s.hazard : s.body);
    base.position.y = 0.3;
    r.add(base);
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.6, 12), s.joint);
    pedestal.position.y = 0.85;
    r.add(pedestal);
    // 旋回する砲塔
    this.aim.position.y = TURRET.hitCenterOffset;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.95, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), control ? s.bodyLight : s.body);
    dome.position.y = -0.15;
    this.aim.add(dome);
    this.aim.add(box(1.5, 0.18, 1.2, s.stripe, 0, -0.2, 0));
    for (const x of [-0.28, 0.28]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 1.5, 10), s.joint);
      b.rotation.x = Math.PI / 2;
      b.position.set(x, 0.05, -1.05);
      this.aim.add(b);
    }
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), this.eyeMat);
    eye.position.set(0, 0.35, -0.78);
    this.aim.add(eye);
    this.muzzleGlow.position.set(0, 0.05, -1.85);
    this.aim.add(this.muzzleGlow);
    r.add(this.aim);
    if (control) {
      // 制御砲台：アンテナと識別ビーコン（シアン）
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.6, 8), s.joint);
      mast.position.set(0, 2.9, 0.6);
      r.add(mast);
      this.beaconMat = new THREE.MeshBasicMaterial({ color: 0x30e0ff, toneMapped: false });
      const bulb = new THREE.Mesh(new THREE.OctahedronGeometry(0.35), this.beaconMat);
      bulb.position.set(0, 4.35, 0.6);
      r.add(bulb);
      this.beacon = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: s.glow, color: 0x30e0ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      );
      this.beacon.scale.setScalar(4);
      this.beacon.position.copy(bulb.position);
      r.add(this.beacon);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.08, 8, 28), this.beaconMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.62;
      r.add(ring);
    }
  }

  hit() {
    this.flash = 0.12;
  }

  update(time: number, dt: number) {
    const e = this.enemy;
    this.root.position.set(e.pos[0], e.pos[1], e.pos[2]);
    if (!e.alive) {
      if (!this.dead) {
        this.dead = true;
        const s = shared();
        for (const p of this.parts) p.material = s.wreck;
        this.eyeMat.color.setHex(0x111111);
        this.muzzleGlow.visible = false;
        if (this.beacon) this.beacon.visible = false;
        if (this.beaconMat) this.beaconMat.color.setHex(0x222222);
        this.root.rotation.z = e.kind === 'guard' ? 0.5 : 0.15;
        this.root.rotation.x = e.kind === 'guard' ? 0.3 : 0;
        this.aim.rotation.x = 0.5;
      }
      if (e.kind === 'guard') this.root.position.y = e.pos[1] - 0.6;
      return;
    }
    this.root.rotation.y = e.yaw;
    // 砲身の上下
    const ad = e.aimDir;
    const pitch = Math.asin(Math.max(-1, Math.min(1, ad[1])));
    this.aim.rotation.x = pitch;
    if (e.kind === 'guard') {
      const ph = e.walkPhase * 3;
      this.legs[0].rotation.x = Math.sin(ph) * 0.5;
      this.legs[1].rotation.x = -Math.sin(ph) * 0.5;
      void GUARD_AI;
    }
    // 射撃予告（明滅＋蓄光）と警戒色
    const spec = e.spec;
    let glow = 0;
    if (e.telegraphStart !== null) {
      const p = Math.min(1, (time - e.telegraphStart) / spec.telegraph);
      glow = 0.4 + 0.6 * p;
      const blink = Math.sin(time * 60) > 0 ? 1 : 0.55;
      glow *= blink;
    } else if (e.burstLeft > 0) glow = 0.9;
    const mg = this.muzzleGlow.material as THREE.SpriteMaterial;
    mg.opacity = glow;
    this.muzzleGlow.scale.setScalar(0.6 + glow * (e.kind === 'turret' ? 3.2 : 2.4));
    const eyeCol = e.alert ? (glow > 0 ? 0xffe060 : 0xff3a1a) : 0x40a0ff;
    this.eyeMat.color.setHex(this.flash > 0 ? 0xffffff : eyeCol);
    if (this.flash > 0) this.flash -= dt;
    if (this.beacon) {
      (this.beacon.material as THREE.SpriteMaterial).opacity = 0.55 + 0.45 * Math.sin(time * 4);
    }
  }
}
