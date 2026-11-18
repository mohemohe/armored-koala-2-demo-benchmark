// コアラ頭の戦闘ロボット（プリミティブから構築）。脚部は2脚/4脚を切り替え、歩行で脚が動く。
import * as THREE from 'three';
import type { LegsId, WeaponId } from '../config';
import { textures } from './textures';

export interface MechAnimState {
  /** 機体ローカルでの水平速度（x=右, z=前） */
  localVel: [number, number];
  speed: number;
  grounded: boolean;
  mode: 'walk' | 'glide' | 'quickboost';
  thrusting: boolean;
  weapon: WeaponId;
  aimPitch: number;
  dt: number;
  firing: boolean;
}

const M = () => {
  const tx = textures();
  return {
    armor: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, map: tx.panel, roughness: 0.45, metalness: 0.6 }),
    armorLight: new THREE.MeshStandardMaterial({ color: 0xc9cfd6, roughness: 0.4, metalness: 0.5 }),
    fur: new THREE.MeshStandardMaterial({ color: 0x8b939d, roughness: 0.55, metalness: 0.45 }),
    earInner: new THREE.MeshStandardMaterial({ color: 0xe6e2dc, roughness: 0.8, metalness: 0.1 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2b3036, roughness: 0.5, metalness: 0.7 }),
    joint: new THREE.MeshStandardMaterial({ color: 0x3d434b, roughness: 0.4, metalness: 0.8 }),
    nose: new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.15, metalness: 0.3 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xd9a21b, roughness: 0.5, metalness: 0.3 }),
    eye: new THREE.MeshBasicMaterial({ color: 0x7dffb0, toneMapped: false }),
    core: new THREE.MeshBasicMaterial({ color: 0x5cd6ff, toneMapped: false }),
    flame: new THREE.MeshBasicMaterial({
      color: 0x7fd8ff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
    beam: new THREE.MeshBasicMaterial({ color: 0x55e0ff, toneMapped: false }),
    missileTip: new THREE.MeshStandardMaterial({ color: 0xc03020, roughness: 0.5, metalness: 0.3 }),
  };
};

type Mats = ReturnType<typeof M>;

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function sph(r: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 16): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg * 0.75)), mat);
  m.position.set(x, y, z);
  return m;
}
function cyl(rt: number, rb: number, h: number, mat: THREE.Material, seg = 14): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
}

/** 武器モデル（前方 -Z） */
function weaponModel(id: WeaponId, m: Mats): THREE.Group {
  const g = new THREE.Group();
  if (id === 'machinegun') {
    g.add(box(0.22, 0.28, 0.9, m.dark, 0, 0, -0.2));
    const barrel = cyl(0.07, 0.07, 0.8, m.joint, 10);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.03, -0.95);
    g.add(barrel);
    const drum = cyl(0.2, 0.2, 0.16, m.accent, 16);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(0, -0.2, -0.1);
    g.add(drum);
  } else if (id === 'beam') {
    g.add(box(0.2, 0.26, 1.3, m.armorLight, 0, 0, -0.35));
    const coil = cyl(0.12, 0.12, 0.7, m.beam, 12);
    coil.rotation.x = Math.PI / 2;
    coil.position.set(0, 0.12, -0.45);
    g.add(coil);
    const tip = cyl(0.05, 0.09, 0.3, m.joint, 10);
    tip.rotation.x = Math.PI / 2;
    tip.position.set(0, 0, -1.15);
    g.add(tip);
  } else {
    g.add(box(0.46, 0.46, 0.8, m.dark, 0, 0.05, -0.15));
    for (const [x, y] of [
      [-0.11, 0.16],
      [0.11, 0.16],
      [-0.11, -0.06],
      [0.11, -0.06],
    ]) {
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.2, 10), m.missileTip);
      tip.rotation.x = -Math.PI / 2;
      tip.position.set(x, y, -0.62);
      g.add(tip);
    }
  }
  return g;
}

export class MechView {
  root = new THREE.Group();
  private m: Mats;
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private legsGroup = new THREE.Group();
  private armR = new THREE.Group();
  private armL = new THREE.Group();
  private forearmR = new THREE.Group();
  private forearmL = new THREE.Group();
  private handR = new THREE.Group();
  private stowed: Record<WeaponId, THREE.Group> = {} as Record<WeaponId, THREE.Group>;
  private inHand: Record<WeaponId, THREE.Group> = {} as Record<WeaponId, THREE.Group>;
  private flames: THREE.Mesh[] = [];
  private legFlames: THREE.Mesh[] = [];
  private legJoints: { hip: THREE.Group; knee: THREE.Group; phaseOffset: number; side: number; front: number; baseYaw: number }[] = [];
  legs: LegsId = 'biped';
  private phase = 0;
  private hipBase = 1.35;
  private recoil = 0;
  earL!: THREE.Group;
  earR!: THREE.Group;

  constructor(legs: LegsId) {
    this.m = M();
    this.buildTorso();
    this.root.add(this.torso);
    this.root.add(this.legsGroup);
    this.setLegs(legs);
  }

  private buildTorso() {
    const m = this.m;
    const t = this.torso;
    // 胴体
    t.add(box(1.5, 0.95, 1.0, m.armor, 0, 0.55, 0));
    t.add(box(1.25, 0.35, 0.9, m.dark, 0, 0.0, 0.02)); // 腰
    t.add(box(1.1, 0.5, 0.25, m.armorLight, 0, 0.62, -0.55)); // 胸部装甲
    t.add(box(0.2, 0.55, 0.12, m.accent, -0.45, 0.62, -0.64));
    t.add(box(0.2, 0.55, 0.12, m.accent, 0.45, 0.62, -0.64));
    const core = cyl(0.13, 0.13, 0.08, m.core, 16);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, 0.6, -0.69);
    t.add(core);
    // 背部推進器
    t.add(box(1.0, 0.8, 0.5, m.dark, 0, 0.6, 0.72));
    for (const x of [-0.32, 0.32]) {
      const n = cyl(0.2, 0.26, 0.5, m.joint, 14);
      n.rotation.x = Math.PI / 2;
      n.position.set(x, 0.45, 1.05);
      t.add(n);
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.2, 12, 1, true), m.flame);
      f.rotation.x = Math.PI / 2;
      f.position.set(x, 0.45, 1.85);
      t.add(f);
      this.flames.push(f);
    }
    // 首
    const neck = cyl(0.22, 0.28, 0.3, m.joint, 12);
    neck.position.set(0, 1.12, 0);
    t.add(neck);

    // ---- コアラの頭部 ----
    const h = this.head;
    h.position.set(0, 1.5, -0.02);
    const skull = sph(0.5, m.fur, 0, 0, 0, 24);
    skull.scale.set(1.12, 0.95, 1.0);
    h.add(skull);
    // 顔面装甲（前面）
    const face = sph(0.42, m.armorLight, 0, -0.06, -0.16, 20);
    face.scale.set(1.05, 0.85, 0.75);
    h.add(face);
    // 頭頂の装甲板と継ぎ目
    h.add(box(0.5, 0.08, 0.6, m.armor, 0, 0.45, 0.02));
    h.add(box(0.06, 0.12, 0.7, m.dark, 0, 0.44, 0.02));
    // 大きな丸い耳（左右）
    const mkEar = (side: number) => {
      const e = new THREE.Group();
      const disc = cyl(0.38, 0.38, 0.16, m.fur, 28);
      disc.rotation.x = Math.PI / 2;
      e.add(disc);
      const inner = cyl(0.26, 0.26, 0.05, m.earInner, 24);
      inner.rotation.x = Math.PI / 2;
      inner.position.z = -0.08;
      e.add(inner);
      // 耳の内側の房（機械的なフィン）
      for (let i = -2; i <= 2; i++) {
        const fin = box(0.035, 0.34 - Math.abs(i) * 0.06, 0.04, m.armorLight, i * 0.08, 0, -0.11);
        e.add(fin);
      }
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.05, 8, 32), m.dark);
      e.add(rim);
      e.position.set(side * 0.56, 0.32, 0.02);
      e.rotation.y = side * -0.25;
      e.rotation.z = side * -0.35;
      h.add(e);
      return e;
    };
    this.earL = mkEar(-1);
    this.earR = mkEar(1);
    // 黒い大きな鼻
    const nose = sph(0.19, m.nose, 0, -0.08, -0.5, 20);
    nose.scale.set(0.95, 1.2, 0.8);
    h.add(nose);
    h.add(box(0.1, 0.03, 0.02, m.dark, 0, -0.26, -0.52)); // 口の継ぎ目
    // 目（センサー）
    for (const x of [-0.2, 0.2]) {
      h.add(box(0.2, 0.08, 0.04, m.dark, x, 0.1, -0.47));
      h.add(sph(0.045, m.eye, x, 0.1, -0.49, 10));
    }
    // 顎の装甲とアンテナ
    h.add(box(0.46, 0.12, 0.3, m.armor, 0, -0.33, -0.28));
    const ant = cyl(0.02, 0.02, 0.5, m.joint, 6);
    ant.position.set(0.3, 0.6, 0.12);
    ant.rotation.z = -0.3;
    h.add(ant);
    h.add(sph(0.04, m.eye, 0.38, 0.84, 0.12, 8));
    t.add(h);

    // 腕
    const mkArm = (side: number, grp: THREE.Group, fore: THREE.Group) => {
      grp.position.set(side * 0.98, 0.82, 0);
      grp.add(sph(0.3, m.joint, 0, 0, 0, 14));
      grp.add(box(0.55, 0.28, 0.62, m.armor, side * 0.12, 0.22, 0)); // 肩装甲
      grp.add(box(0.5, 0.06, 0.64, m.accent, side * 0.12, 0.38, 0));
      grp.add(box(0.28, 0.6, 0.3, m.dark, 0, -0.4, 0)); // 上腕
      fore.position.set(0, -0.75, 0);
      fore.add(sph(0.17, m.joint, 0, 0, 0, 12));
      fore.add(box(0.32, 0.3, 0.7, m.armor, 0, -0.08, -0.28)); // 前腕（前へ）
      grp.add(fore);
      this.torso.add(grp);
    };
    mkArm(1, this.armR, this.forearmR);
    mkArm(-1, this.armL, this.forearmL);
    this.handR.position.set(0, -0.12, -0.72);
    this.forearmR.add(this.handR);
    this.handR.add(box(0.24, 0.24, 0.22, m.dark));
    this.forearmL.add(box(0.22, 0.22, 0.2, m.dark, 0, -0.1, -0.66));

    // 3武器：手持ち（使用中）と背部・腰の格納
    for (const w of ['machinegun', 'beam', 'missile'] as WeaponId[]) {
      const inHand = weaponModel(w, m);
      inHand.position.set(0, -0.05, -0.1);
      this.handR.add(inHand);
      this.inHand[w] = inHand;
      const st = weaponModel(w, m);
      st.scale.setScalar(0.8);
      this.stowed[w] = st;
      this.torso.add(st);
    }
  }

  setLegs(legs: LegsId) {
    this.legs = legs;
    this.legsGroup.clear();
    this.legJoints = [];
    this.legFlames = [];
    const m = this.m;
    if (legs === 'biped') {
      this.hipBase = 1.35;
      for (const side of [-1, 1]) {
        const hip = new THREE.Group();
        hip.position.set(side * 0.42, this.hipBase, 0);
        hip.add(sph(0.22, m.joint, 0, 0, 0, 12));
        hip.add(box(0.36, 0.72, 0.44, m.armor, 0, -0.38, 0)); // 大腿
        hip.add(box(0.38, 0.2, 0.1, m.accent, 0, -0.22, -0.24));
        const knee = new THREE.Group();
        knee.position.set(0, -0.75, 0);
        knee.add(sph(0.19, m.joint, 0, 0, 0, 12));
        knee.add(box(0.26, 0.2, 0.2, m.armorLight, 0, 0.02, -0.2)); // 膝装甲
        knee.add(box(0.32, 0.62, 0.38, m.dark, 0, -0.33, 0.04)); // 脛
        knee.add(box(0.46, 0.16, 0.74, m.armor, 0, -0.62, -0.08)); // 足
        const lf = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.7, 10, 1, true), m.flame);
        lf.position.set(0, -0.5, 0.35);
        lf.rotation.x = Math.PI * 0.62;
        knee.add(lf);
        this.legFlames.push(lf);
        hip.add(knee);
        this.legsGroup.add(hip);
        this.legJoints.push({ hip, knee, phaseOffset: side > 0 ? 0 : Math.PI, side, front: 0, baseYaw: 0 });
      }
      this.torso.position.y = 1.35;
    } else {
      this.hipBase = 1.15;
      // 4脚：胴体下の台座と四隅の脚
      const base = box(1.5, 0.35, 1.6, m.dark, 0, 1.15, 0);
      this.legsGroup.add(base);
      this.legsGroup.add(box(1.2, 0.1, 1.3, m.accent, 0, 1.36, 0));
      const corners: [number, number, number][] = [
        [-1, -1, 0],
        [1, -1, Math.PI],
        [-1, 1, Math.PI],
        [1, 1, 0],
      ];
      for (const [sx, sz, off] of corners) {
        const hip = new THREE.Group();
        hip.position.set(sx * 0.7, 1.15, sz * 0.72);
        hip.rotation.y = Math.atan2(sx, sz); // 外向き
        hip.add(sph(0.2, m.joint, 0, 0, 0, 12));
        const upper = box(0.26, 0.26, 0.95, m.armor, 0, 0.2, 0.42);
        upper.rotation.x = -0.45;
        hip.add(upper);
        const knee = new THREE.Group();
        knee.position.set(0, 0.42, 0.86);
        knee.add(sph(0.17, m.joint, 0, 0, 0, 12));
        knee.add(box(0.24, 1.45, 0.26, m.dark, 0, -0.72, 0.12));
        knee.add(box(0.4, 0.14, 0.46, m.armor, 0, -1.47, 0.14));
        knee.add(box(0.26, 0.3, 0.1, m.accent, 0, -0.2, 0.26));
        const lf = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.6, 10, 1, true), m.flame);
        lf.position.set(0, -1.2, 0.3);
        lf.rotation.x = Math.PI * 0.62;
        knee.add(lf);
        this.legFlames.push(lf);
        hip.add(knee);
        this.legsGroup.add(hip);
        this.legJoints.push({ hip, knee, phaseOffset: off, side: sx, front: sz, baseYaw: hip.rotation.y });
      }
      this.torso.position.y = 1.35;
    }
    // 格納武器の配置
    this.stowed.machinegun.position.set(-0.75, 0.2, 0.62);
    this.stowed.machinegun.rotation.set(0, 0, Math.PI / 2);
    this.stowed.beam.position.set(0.6, 0.75, 0.8);
    this.stowed.beam.rotation.set(-0.3, 0, 0);
    this.stowed.missile.position.set(-0.55, 1.05, 0.62);
    this.stowed.missile.rotation.set(-0.5, 0, 0);
  }

  /** 発射時の反動演出 */
  kick() {
    this.recoil = 1;
  }

  animate(s: MechAnimState) {
    const dt = s.dt;
    for (const w of ['machinegun', 'beam', 'missile'] as WeaponId[]) {
      this.inHand[w].visible = w === s.weapon;
      this.stowed[w].visible = w !== s.weapon;
    }
    // 腕：照準方向へ
    this.recoil = Math.max(0, this.recoil - dt * 10);
    const pitch = Math.max(-0.9, Math.min(0.9, s.aimPitch));
    // 上腕は前下方、前腕は照準方向（前腕の向き = 上腕角 + 前腕角 = pitch）
    this.armR.rotation.x = 0.55 + pitch * 0.5 - this.recoil * 0.1;
    this.forearmR.rotation.x = pitch - this.armR.rotation.x + this.recoil * 0.15;
    this.armL.rotation.x = 0.35 + (s.firing ? 0.25 : 0);
    this.forearmL.rotation.x = -0.9;
    this.head.rotation.x = -pitch * 0.4;

    const sp = s.speed;
    const walking = s.grounded && s.mode === 'walk' && sp > 0.4;
    if (walking) this.phase += dt * (3.2 + sp * 0.55);
    const amp = walking ? Math.min(1, sp / 8) : 0;
    const back = s.localVel[1] < -0.5 ? -1 : 1;
    if (this.legs === 'biped') {
      for (const j of this.legJoints) {
        const ph = this.phase * back + j.phaseOffset;
        if (walking) {
          j.hip.rotation.x = Math.sin(ph) * 0.65 * amp;
          j.knee.rotation.x = Math.max(0, -Math.cos(ph)) * 0.9 * amp;
          j.hip.rotation.z = 0;
        } else if (!s.grounded) {
          j.hip.rotation.x = 0.35 + j.side * 0.1;
          j.knee.rotation.x = 0.55;
          j.hip.rotation.z = j.side * 0.08;
        } else if (s.mode !== 'walk') {
          // グライド：低い姿勢で滑走
          j.hip.rotation.x = j.side > 0 ? 0.35 : -0.25;
          j.knee.rotation.x = j.side > 0 ? 0.6 : 0.25;
          j.hip.rotation.z = j.side * 0.12;
        } else {
          j.hip.rotation.x *= 0.8;
          j.knee.rotation.x *= 0.8;
          j.hip.rotation.z *= 0.8;
        }
      }
      const bob = walking ? Math.abs(Math.sin(this.phase)) * 0.06 * amp : 0;
      this.torso.position.y = 1.35 + bob - (s.grounded && s.mode !== 'walk' ? 0.15 : 0);
      this.legsGroup.position.y = s.grounded && s.mode !== 'walk' ? -0.15 : 0;
    } else {
      for (const j of this.legJoints) {
        const ph = this.phase + j.phaseOffset;
        if (walking) {
          // 対角の脚が交互に持ち上がるトロット歩行
          const lift = Math.max(0, Math.sin(ph));
          j.hip.rotation.x = -lift * 0.3 * amp;
          j.knee.rotation.x = lift * 0.25 * amp;
          j.hip.rotation.y = j.baseYaw + Math.cos(ph) * 0.3 * amp * j.side * j.front * back;
        } else if (!s.grounded) {
          j.knee.rotation.x = 0.25;
          j.hip.rotation.x = -0.15;
          j.hip.rotation.y = j.baseYaw;
        } else {
          j.knee.rotation.x *= 0.8;
          j.hip.rotation.x *= 0.8;
          j.hip.rotation.y = j.baseYaw + (j.hip.rotation.y - j.baseYaw) * 0.8;
        }
      }
      this.torso.position.y = 1.35 + (walking ? Math.abs(Math.sin(this.phase * 2)) * 0.03 : 0);
    }
    // 噴射炎
    const qb = s.mode === 'quickboost';
    const glide = s.mode === 'glide';
    const back0 = qb ? 2.2 : s.thrusting ? 1.3 : glide ? 0.8 : 0.0;
    for (const f of this.flames) {
      const flick = 0.85 + Math.random() * 0.3;
      f.visible = back0 > 0.01;
      f.scale.set(1 + (qb ? 0.5 : 0), back0 * flick, 1 + (qb ? 0.5 : 0));
      f.position.z = 1.3 + 0.55 * back0 * flick;
    }
    for (const f of this.legFlames) {
      const on = s.thrusting || (glide && s.grounded) || qb;
      f.visible = on;
      const sc = s.thrusting ? 1.4 : qb ? 1.2 : 0.8;
      f.scale.set(1, sc * (0.85 + Math.random() * 0.3), 1);
    }
  }

  dispose() {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}
