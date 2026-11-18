/**
 * 敵モデル: 警備ロボット（2 脚・銃）、固定砲台（台座＋回転砲塔）、制御砲台の標識、試験用標的。
 * 予告中は砲口を明滅、撃破後は焼けた残骸へ切り替える（生存モデルのまま放置しない）。
 * ローカル座標: 足元原点、前方 −Z。
 */
import * as THREE from 'three';
import { ENEMIES } from '../params';
import type { EnemyKind, EnemyView, Vec3 } from '../types';
import { disposeObject, glow, makeLabelTexture, standard } from './materials';

/** 予告の明滅周期 [s]（視覚のみ） */
export const TELEGRAPH_BLINK_PERIOD = 0.1;
/** 制御砲台の識別色 */
export const CONTROL_COLOR = 0x20e0ff;

export interface EnemyModel {
  readonly root: THREE.Group;
  readonly id: string;
  readonly kind: EnemyKind;
  /** 撃破表示中か */
  readonly wrecked: boolean;
  update(view: EnemyView, time: number, dt: number): void;
  dispose(): void;
}

/** 全敵で共有するマテリアル（数を抑える） */
export class EnemySharedMaterials {
  readonly hull = standard(0x5c646c, 0.55, 0.7);
  readonly hullDark = standard(0x353a40, 0.6, 0.7);
  readonly accent = standard(0xc85a20, 0.55, 0.5);
  readonly joint = standard(0x1c1f22, 0.4, 0.85);
  readonly visor = standard(0x402000, 0.3, 0.4, 0xff8a10, 0.8);
  readonly turretBase = standard(0x646a72, 0.7, 0.6);
  readonly turretHead = standard(0x7a6650, 0.6, 0.6);
  readonly burnt = standard(0x161412, 1.0, 0.2);
  readonly control = standard(0x104050, 0.3, 0.5, CONTROL_COLOR, 2.0);
  readonly controlGlow = glow(CONTROL_COLOR, 0.35);
  readonly flash = glow(0xffd070, 0.9);
  readonly target = standard(0x9040c0, 0.5, 0.3, 0x401060, 0.6);
  private labelTexture: THREE.CanvasTexture | null | undefined;

  /** 制御砲台の標識テクスチャ（ブラウザーのみ） */
  getControlLabelTexture(): THREE.CanvasTexture | null {
    if (this.labelTexture === undefined) this.labelTexture = makeLabelTexture('CONTROL', '#40f0ff', 'rgba(0,30,40,0.85)');
    return this.labelTexture;
  }

  all(): THREE.Material[] {
    return [this.hull, this.hullDark, this.accent, this.joint, this.visor, this.turretBase, this.turretHead, this.burnt, this.control, this.controlGlow, this.flash, this.target];
  }

  dispose(): void {
    for (const m of this.all()) m.dispose();
    if (this.labelTexture) this.labelTexture.dispose();
    this.labelTexture = undefined;
  }
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function cylinder(rTop: number, rBot: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, axis: 'x' | 'y' | 'z' = 'y', seg = 14): THREE.Mesh {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  return m;
}

function sphere(r: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 14): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(6, seg - 4)), mat);
  m.position.set(x, y, z);
  return m;
}

/** 方向ベクトルから yaw/pitch（sim の規約: yaw=0 で −Z、pitch>0 で上） */
function yawPitchOf(d: Vec3): { yaw: number; pitch: number } {
  const h = Math.hypot(d[0], d[2]);
  return { yaw: h > 1e-6 ? Math.atan2(-d[0], -d[2]) : 0, pitch: Math.atan2(d[1], h) };
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** 生存/撃破でマテリアルを切り替えるための記録 */
interface MaterialSwap {
  mesh: THREE.Mesh;
  original: THREE.Material;
}

abstract class BaseEnemyModel implements EnemyModel {
  readonly root = new THREE.Group();
  readonly id: string;
  readonly kind: EnemyKind;
  wrecked = false;
  protected readonly swaps: MaterialSwap[] = [];
  /** 撃破時に非表示にするもの（発光部・標識） */
  protected readonly hideOnWreck: THREE.Object3D[] = [];
  protected readonly ownMaterials: THREE.Material[] = [];
  protected lastPos: Vec3 | null = null;

  constructor(view: EnemyView, protected readonly shared: EnemySharedMaterials) {
    this.id = view.id;
    this.kind = view.kind;
    this.root.name = 'enemy:' + view.id;
  }

  protected registerForWreck(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.Material;
      if (mat === this.shared.flash || mat === this.shared.controlGlow) return;
      this.swaps.push({ mesh, original: mat });
    });
  }

  protected setWrecked(on: boolean): void {
    if (on === this.wrecked) return;
    this.wrecked = on;
    for (const s of this.swaps) s.mesh.material = on ? this.shared.burnt : s.original;
    for (const o of this.hideOnWreck) o.visible = !on;
    this.applyWreckPose(on);
  }

  protected abstract applyWreckPose(on: boolean): void;

  abstract update(view: EnemyView, time: number, dt: number): void;

  protected updateBase(view: EnemyView): void {
    this.root.position.set(view.position[0], view.position[1], view.position[2]);
    this.setWrecked(!view.alive);
  }

  dispose(): void {
    // 共有マテリアルは保持。自前マテリアルも disposeObject には渡さない（Sprite の map は共有の標識テクスチャで、
    // disposeObject が map まで破棄してしまうため）。自前のものは下で material.dispose() だけ行う
    const keep = new Set<THREE.Material>(this.shared.all());
    for (const m of this.ownMaterials) keep.add(m);
    disposeObject(this.root, keep);
    for (const m of this.ownMaterials) m.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }
}

/** 警備ロボット: 箱型の 2 脚機、暗い外装、橙のバイザー、右腕に銃 */
class GuardModel extends BaseEnemyModel {
  private readonly body = new THREE.Group();
  private readonly gunPivot = new THREE.Group();
  private readonly muzzleMat: THREE.MeshStandardMaterial;
  private readonly flash: THREE.Mesh;
  private readonly hips: THREE.Group[] = [];
  private readonly knees: THREE.Group[] = [];
  private readonly visor: THREE.Mesh;
  /** バイザーは個体ごとに警戒状態で明るさが変わるため、共有せず複製を持つ */
  private readonly visorMat: THREE.MeshStandardMaterial;
  private walkPhase = 0;

  constructor(view: EnemyView, shared: EnemySharedMaterials) {
    super(view, shared);
    const m = shared;
    const root = this.root;
    root.add(this.body);
    const b = this.body;
    // 脚（股関節 y=1.2、太腿 0.55、脛 0.55、足 0.1）
    for (const s of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(s * 0.32, 1.2, 0);
      b.add(hip);
      hip.add(sphere(0.13, m.joint));
      hip.add(box(0.28, 0.55, 0.32, m.hull, 0, -0.28, 0));
      const knee = new THREE.Group();
      knee.position.set(0, -0.55, 0);
      hip.add(knee);
      knee.add(sphere(0.12, m.joint));
      knee.add(box(0.24, 0.55, 0.26, m.hullDark, 0, -0.28, 0.02));
      knee.add(box(0.3, 0.1, 0.5, m.hullDark, 0, -0.6, -0.08));
      this.hips.push(hip);
      this.knees.push(knee);
    }
    // 胴体（箱型）
    b.add(box(0.7, 0.24, 0.5, m.hullDark, 0, 1.3, 0));
    b.add(box(1.0, 0.85, 0.7, m.hull, 0, 1.85, 0));
    b.add(box(0.7, 0.4, 0.1, m.accent, 0, 1.85, -0.38));
    b.add(box(1.1, 0.12, 0.6, m.hullDark, 0, 2.32, 0));
    // 肩ブロック
    for (const s of [-1, 1]) b.add(box(0.34, 0.34, 0.5, m.hullDark, s * 0.66, 2.15, 0));
    // 頭部＋バイザー
    b.add(box(0.6, 0.45, 0.55, m.hull, 0, 2.6, 0));
    this.visorMat = m.visor.clone();
    this.ownMaterials.push(this.visorMat);
    this.visor = box(0.5, 0.12, 0.06, this.visorMat, 0, 2.62, -0.29);
    b.add(this.visor);
    b.add(cylinder(0.02, 0.02, 0.4, m.joint, 0.2, 2.95, 0.1));
    // 左腕（固定）
    b.add(box(0.2, 0.6, 0.24, m.hull, -0.72, 1.7, 0));
    b.add(box(0.18, 0.2, 0.5, m.hullDark, -0.74, 1.4, -0.1));
    // 右腕＋銃（gunPivot は肩、−Z が銃口方向）
    this.gunPivot.position.set(ENEMIES.guard.muzzleOffset[0], ENEMIES.guard.muzzleOffset[1] + 0.25, 0);
    b.add(this.gunPivot);
    this.gunPivot.add(sphere(0.14, m.joint));
    this.gunPivot.add(box(0.22, 0.5, 0.26, m.hull, 0, -0.28, -0.1));
    this.gunPivot.add(box(0.24, 0.26, 1.0, m.hullDark, 0, -0.25, -0.5));
    this.gunPivot.add(cylinder(0.06, 0.06, 0.6, m.joint, 0, -0.22, -1.2, 'z'));
    this.muzzleMat = standard(0x402010, 0.4, 0.6, 0xff6010, 0.3);
    this.ownMaterials.push(this.muzzleMat);
    const muzzleRing = cylinder(0.09, 0.09, 0.14, this.muzzleMat, 0, -0.22, -1.5, 'z');
    this.gunPivot.add(muzzleRing);
    this.hideOnWreck.push(muzzleRing);
    this.flash = sphere(0.22, m.flash, 0, -0.22, -1.62, 10);
    this.flash.visible = false;
    this.gunPivot.add(this.flash);
    this.registerForWreck(this.body);
    this.hideOnWreck.push(this.visor);
    this.updateBase(view);
  }

  protected applyWreckPose(on: boolean): void {
    this.root.rotation.set(on ? 0.2 : 0, this.root.rotation.y, on ? 0.4 : 0);
    this.root.scale.set(1, on ? 0.8 : 1, 1);
    if (on) {
      this.gunPivot.rotation.set(0.6, 0, 0, 'YXZ');
      for (const h of this.hips) h.rotation.x = 0;
      for (const k of this.knees) k.rotation.x = 0;
      // 予告中に撃破されても閃光・砲口の蓄光を残骸に残さない（偽の予告になる）
      this.flash.visible = false;
      this.muzzleMat.emissiveIntensity = 0.3;
    }
  }

  update(view: EnemyView, time: number, dt: number): void {
    // 移動量から歩行位相を積算（描画側のみ）
    if (this.lastPos && dt > 0) {
      const dx = view.position[0] - this.lastPos[0];
      const dz = view.position[2] - this.lastPos[2];
      const speed = Math.hypot(dx, dz) / dt;
      if (speed > 0.5) this.walkPhase += speed * dt * 2.6;
      this.updateLegs(speed > 0.5 && view.alive);
    }
    this.lastPos = [view.position[0], view.position[1], view.position[2]];
    this.updateBase(view);
    this.root.rotation.y = view.yaw;
    if (!view.alive) return;
    // 銃の向き: gunDirection を機体ローカルへ
    const yp = yawPitchOf(view.gunDirection);
    const relYaw = wrapAngle(yp.yaw - view.yaw);
    const clampedYaw = Math.max(-1.0, Math.min(1.0, relYaw));
    this.gunPivot.rotation.set(yp.pitch, clampedYaw, 0, 'YXZ');
    // 上体は残りのヨーで追従
    this.body.rotation.y = relYaw - clampedYaw;
    this.visorMat.emissiveIntensity = view.alert ? 2.0 : 0.8;
    // 予告: 砲口の明滅と小さな閃光
    if (view.telegraphing) {
      const on = Math.floor(time / (TELEGRAPH_BLINK_PERIOD / 2)) % 2 === 0;
      this.muzzleMat.emissiveIntensity = on ? 4.0 : 0.6;
      this.flash.visible = on;
      const sc = 0.7 + Math.random() * 0.5;
      this.flash.scale.set(sc, sc, sc);
    } else {
      this.muzzleMat.emissiveIntensity = 0.3;
      this.flash.visible = false;
    }
  }

  private updateLegs(walking: boolean): void {
    for (let i = 0; i < this.hips.length; i++) {
      const ph = this.walkPhase + (i === 0 ? 0 : Math.PI);
      this.hips[i].rotation.x = walking ? 0.5 * Math.sin(ph) : 0;
      this.knees[i].rotation.x = walking ? -0.8 * Math.max(0, Math.sin(ph - 0.9)) : 0;
    }
  }
}

/** 固定砲台: 台座＋回転砲塔。制御砲台は発光リングと浮遊標識 */
class TurretModel extends BaseEnemyModel {
  private readonly head = new THREE.Group();
  private readonly muzzleMat: THREE.MeshStandardMaterial;
  private readonly flash: THREE.Mesh;
  private readonly beacon: THREE.Group | null = null;
  private readonly ring: THREE.Mesh | null = null;
  private readonly isControl: boolean;

  constructor(view: EnemyView, shared: EnemySharedMaterials) {
    super(view, shared);
    const m = shared;
    const root = this.root;
    const t = ENEMIES.turret;
    this.isControl = view.isGateControl;
    const bodyGroup = new THREE.Group();
    root.add(bodyGroup);
    // 台座
    bodyGroup.add(cylinder(1.6, 1.75, 0.55, m.turretBase, 0, 0.275, 0, 'y', 18));
    bodyGroup.add(cylinder(0.85, 1.05, 1.2, m.turretBase, 0, 1.15, 0, 'y', 14));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const leg = box(0.35, 0.35, 1.0, m.hullDark, Math.sin(a) * 1.3, 0.4, Math.cos(a) * 1.3);
      leg.rotation.y = a;
      bodyGroup.add(leg);
    }
    bodyGroup.add(cylinder(0.5, 0.5, 0.3, m.joint, 0, t.gunPivotOffset[1] - 0.25, 0, 'y', 16));
    // 砲塔（gunPivotOffset を中心に回転、−Z が砲身方向）
    this.head.position.set(t.gunPivotOffset[0], t.gunPivotOffset[1], t.gunPivotOffset[2]);
    root.add(this.head);
    this.head.add(box(1.7, 0.9, 1.6, m.turretHead, 0, 0.1, 0.1));
    this.head.add(box(0.7, 0.25, 1.2, m.accent, 0, 0.65, 0.1));
    this.head.add(box(1.8, 0.35, 0.5, m.hullDark, 0, 0.0, 0.6));
    // 前面のセンサー（発光）: 遠距離でも砲台を識別できるようにする
    this.head.add(box(0.5, 0.22, 0.12, m.visor, 0.55, 0.2, -0.82));
    this.head.add(box(0.5, 0.22, 0.12, m.visor, -0.55, 0.2, -0.82));
    this.head.add(cylinder(0.2, 0.24, t.gunLength, m.hullDark, 0, 0, -t.gunLength / 2, 'z'));
    this.head.add(cylinder(0.1, 0.1, t.gunLength * 0.4, m.joint, 0.3, -0.1, -t.gunLength * 0.3, 'z'));
    this.muzzleMat = standard(0x402010, 0.4, 0.6, 0xff6010, 0.3);
    this.ownMaterials.push(this.muzzleMat);
    const muzzleRing = cylinder(0.2, 0.18, 0.2, this.muzzleMat, 0, 0, -t.gunLength + 0.05, 'z');
    this.head.add(muzzleRing);
    this.hideOnWreck.push(muzzleRing);
    this.flash = sphere(0.3, m.flash, 0, 0, -t.gunLength - 0.15, 10);
    this.flash.visible = false;
    this.head.add(this.flash);
    this.registerForWreck(bodyGroup);
    this.registerForWreck(this.head);
    // 制御砲台の標識
    if (this.isControl) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.1, 0.1, 8, 40), m.control);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.12;
      root.add(ring);
      this.ring = ring;
      this.hideOnWreck.push(ring);
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 6, 10, 1, true), m.controlGlow);
      pillar.position.y = 3.5;
      root.add(pillar);
      this.hideOnWreck.push(pillar);
      const beacon = new THREE.Group();
      beacon.position.y = 5.2;
      const upCone = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.5, 4), m.control);
      upCone.position.y = 0.25;
      const downCone = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.5, 4), m.control);
      downCone.rotation.x = Math.PI;
      downCone.position.y = -0.25;
      beacon.add(upCone, downCone);
      const tex = shared.getControlLabelTexture();
      if (tex) {
        const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
        this.ownMaterials.push(spriteMat);
        const sprite = new THREE.Sprite(spriteMat);
        sprite.scale.set(3.2, 0.8, 1);
        sprite.position.y = 1.1;
        beacon.add(sprite);
      }
      root.add(beacon);
      this.beacon = beacon;
      this.hideOnWreck.push(beacon);
    }
    this.updateBase(view);
  }

  protected applyWreckPose(on: boolean): void {
    this.head.rotation.set(on ? -0.5 : 0, this.head.rotation.y, on ? 0.3 : 0, 'YXZ');
    this.root.scale.set(1, on ? 0.9 : 1, 1);
    if (on) {
      this.flash.visible = false;
      this.muzzleMat.emissiveIntensity = 0.3;
    }
  }

  update(view: EnemyView, time: number, _dt: number): void {
    this.updateBase(view);
    if (!view.alive) return;
    const yp = yawPitchOf(view.gunDirection);
    // ピッチは制限しない: 真上の対象（飛行中のプレイヤー）にも砲身が sim の gunDirection と一致する
    this.head.rotation.set(yp.pitch, yp.yaw, 0, 'YXZ');
    if (view.telegraphing) {
      const on = Math.floor(time / (TELEGRAPH_BLINK_PERIOD / 2)) % 2 === 0;
      this.muzzleMat.emissiveIntensity = on ? 4.0 : 0.6;
      this.flash.visible = on;
      const sc = 0.8 + Math.random() * 0.5;
      this.flash.scale.set(sc, sc, sc);
    } else {
      this.muzzleMat.emissiveIntensity = 0.3;
      this.flash.visible = false;
    }
    if (this.beacon) {
      this.beacon.rotation.y = time * 1.2;
      this.beacon.position.y = 5.2 + Math.sin(time * 2.0) * 0.25;
    }
    if (this.ring) this.ring.rotation.z = time * 0.5;
  }
}

/** 試験用標的（等速移動・非攻撃）: 球 */
class TargetModel extends BaseEnemyModel {
  constructor(view: EnemyView, shared: EnemySharedMaterials) {
    super(view, shared);
    const s = sphere(Math.max(0.2, view.radius), shared.target, 0, 0, 0, 16);
    this.root.add(s);
    this.registerForWreck(this.root);
    this.updateBase(view);
  }
  protected applyWreckPose(on: boolean): void {
    this.root.scale.setScalar(on ? 0.6 : 1);
  }
  update(view: EnemyView): void {
    this.updateBase(view);
    // 標的の中心は centerOffset 分ずらす（既定 0）
    const off = ENEMIES.target.centerOffset;
    this.root.position.set(view.position[0] + off[0], view.position[1] + off[1], view.position[2] + off[2]);
  }
}

export function createEnemyModel(view: EnemyView, shared: EnemySharedMaterials): EnemyModel {
  switch (view.kind) {
    case 'guard':
      return new GuardModel(view, shared);
    case 'turret':
      return new TurretModel(view, shared);
    default:
      return new TargetModel(view, shared);
  }
}
