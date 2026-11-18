/**
 * プレイヤー機体（コアラ頭の重装甲メカ）の手続き的モデル。
 * ローカル座標: 足元原点、前方 −Z（rotation.y = yaw で sim の forwardFromYaw と一致）、右 +X、上 +Y。
 * 全高 ≈ 3.0 m、全幅 ≈ 1.6 m（PLAYER.halfExtents と整合）。
 */
import * as THREE from 'three';
import { DEFAULT_WEAPON, PLAYER } from '../params';
import type { LegsKind, Vec3, Weapon } from '../types';
import { disposeObject, glow, standard } from './materials';

export interface MechUpdate {
  /** 腕・武器の実際の射出方向（ワールド、単位） */
  aimDirection: Vec3;
  yaw: number;
  /** 歩行位相 [rad]（描画側で速度から積算） */
  walkPhase: number;
  /** 水平速度 [m/s] */
  speed: number;
  /** QB 噴射中 */
  boosting: boolean;
  /** 飛行推進中 */
  thrusting: boolean;
  grounded: boolean;
  /** 表示する武器（任意。既定は DEFAULT_WEAPON） */
  weapon?: Weapon;
  /** グライド中（任意。脚先を浮かせ後部ノズルを弱く発光） */
  gliding?: boolean;
  /** 生存（任意。false で大破姿勢） */
  alive?: boolean;
}

export interface MechModel {
  readonly root: THREE.Group;
  readonly legs: LegsKind;
  update(u: MechUpdate): void;
  /** 砲身先端のワールド座標 */
  getMuzzleWorldPosition(target: THREE.Vector3): THREE.Vector3;
  /** 砲身の向き（ワールド、単位） */
  getBarrelWorldDirection(target: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

/** 歩行アニメーションを開始する速度 [m/s]（視覚のみ） */
export const WALK_ANIM_MIN_SPEED = 0.5;
/** 右肩の関節位置（ローカル） */
const SHOULDER_R: Vec3 = [0.62, 2.15, 0];
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const SHOULDER_L: Vec3 = [-0.62, 2.15, 0];
/** 砲身先端の目標（ローカル）。x,y は PLAYER.muzzleOffset、z は前方（−Z） */
const MUZZLE_LOCAL: Vec3 = [PLAYER.muzzleOffset[0], PLAYER.muzzleOffset[1], -Math.abs(PLAYER.muzzleOffset[2])];
/** 腕（肩関節）のヨー可動域 [rad]。超過分は上半身のひねりで吸収し、砲身は常に aimDirection と一致させる */
const ARM_YAW_LIMIT = 1.1;
/** 腕の向きに上半身が追従する割合（可動域内） */
const UPPER_FOLLOW = 0.15;

const UP = new THREE.Vector3(0, 1, 0);

interface MechMaterials {
  armor: THREE.MeshStandardMaterial;
  armorDark: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  joint: THREE.MeshStandardMaterial;
  fur: THREE.MeshStandardMaterial;
  earInner: THREE.MeshStandardMaterial;
  nose: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
  gun: THREE.MeshStandardMaterial;
  nozzle: THREE.MeshStandardMaterial;
  flame: THREE.MeshBasicMaterial;
  flameCore: THREE.MeshBasicMaterial;
  beamEmitter: THREE.MeshStandardMaterial;
  missilePod: THREE.MeshStandardMaterial;
  visor: THREE.MeshStandardMaterial;
}

function makeMaterials(): MechMaterials {
  return {
    armor: standard(0x7e8b98, 0.45, 0.75),
    armorDark: standard(0x3b4249, 0.55, 0.7),
    accent: standard(0xd4661f, 0.5, 0.5),
    joint: standard(0x24272a, 0.4, 0.85),
    fur: standard(0x8d8d92, 0.95, 0.05),
    earInner: standard(0xd9bdb3, 0.9, 0.0),
    nose: standard(0x121212, 0.35, 0.2),
    eye: standard(0x0a0a0a, 0.2, 0.3, 0x202020, 0.5),
    gun: standard(0x2c3136, 0.45, 0.8),
    nozzle: standard(0x3a3f44, 0.4, 0.9, 0xff7a20, 0.2),
    flame: glow(0xff8a30, 0.85),
    flameCore: glow(0xfff0c0, 0.9),
    beamEmitter: standard(0x1a3a4a, 0.3, 0.6, 0x30d0ff, 1.5),
    missilePod: standard(0x4a4f3a, 0.6, 0.5),
    visor: standard(0x102030, 0.3, 0.6, 0x40c0ff, 0.6),
  };
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function sphere(r: number, mat: THREE.Material, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, seg = 20): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg - 4)), mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  return m;
}

/** 軸 axis に沿ったシリンダー */
function cylinder(rTop: number, rBot: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, axis: 'x' | 'y' | 'z' = 'y', seg = 14): THREE.Mesh {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  return m;
}

/** 2 点間を結ぶシリンダー（関節間の部材） */
function segment(a: Vec3, b: Vec3, r: number, mat: THREE.Material, seg = 12): THREE.Mesh {
  const va = new THREE.Vector3(a[0], a[1], a[2]);
  const vb = new THREE.Vector3(b[0], b[1], b[2]);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  const m = new THREE.Mesh(g, mat);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  if (len > 1e-6) m.quaternion.setFromUnitVectors(UP, dir.multiplyScalar(1 / len));
  return m;
}

/** 推進器のノズルと炎 */
interface Thruster {
  nozzle: THREE.Mesh;
  flame: THREE.Mesh;
  core: THREE.Mesh;
  baseScale: number;
}

function makeThruster(mats: MechMaterials, x: number, y: number, z: number, radius: number, parent: THREE.Object3D): Thruster {
  const nozzle = cylinder(radius, radius * 0.8, radius * 2.2, mats.nozzle, x, y, z, 'z');
  parent.add(nozzle);
  const ring = cylinder(radius * 1.15, radius * 1.15, radius * 0.3, mats.armorDark, x, y, z + radius * 1.0, 'z');
  parent.add(ring);
  // 炎は +Z（後方）へ伸びる円錐。ConeGeometry の先端(+Y)を +Z へ向ける
  const flameGeom = new THREE.ConeGeometry(radius * 0.95, 1, 12, 1, true);
  flameGeom.rotateX(Math.PI / 2);
  flameGeom.translate(0, 0, 0.5);
  const flame = new THREE.Mesh(flameGeom, mats.flame);
  flame.position.set(x, y, z + radius * 1.1);
  flame.visible = false;
  parent.add(flame);
  const coreGeom = new THREE.ConeGeometry(radius * 0.5, 1, 10, 1, true);
  coreGeom.rotateX(Math.PI / 2);
  coreGeom.translate(0, 0, 0.5);
  const core = new THREE.Mesh(coreGeom, mats.flameCore);
  core.position.copy(flame.position);
  core.visible = false;
  parent.add(core);
  return { nozzle, flame, core, baseScale: radius * 4 };
}

function setThruster(t: Thruster, strength: number, jitter: number): void {
  const on = strength > 0.01;
  t.flame.visible = on;
  t.core.visible = on;
  if (on) {
    const len = t.baseScale * strength * (0.85 + jitter * 0.3);
    t.flame.scale.set(1, 1, len);
    t.core.scale.set(0.9, 0.9, len * 0.6);
  }
}

/** 装甲板・胸部・肩・背部推進器を持つ胴体（上半身グループに追加） */
function buildTorso(mats: MechMaterials, upper: THREE.Group): Thruster[] {
  // 骨盤・腹部
  upper.add(box(0.8, 0.3, 0.55, mats.armorDark, 0, 1.45, 0));
  upper.add(cylinder(0.22, 0.22, 0.3, mats.joint, 0, 1.7, 0));
  upper.add(box(0.5, 0.2, 0.4, mats.armor, 0, 1.72, 0));
  // 胸部
  upper.add(box(1.05, 0.58, 0.7, mats.armor, 0, 2.06, 0));
  // 胸部装甲板（前面、左右に角度付き）
  const plateL = box(0.44, 0.42, 0.12, mats.armor, -0.27, 2.08, -0.38);
  plateL.rotation.y = -0.28;
  const plateR = box(0.44, 0.42, 0.12, mats.armor, 0.27, 2.08, -0.38);
  plateR.rotation.y = 0.28;
  upper.add(plateL, plateR);
  upper.add(box(0.12, 0.5, 0.08, mats.accent, 0, 2.06, -0.42));
  // 中央のセンサー
  upper.add(box(0.3, 0.1, 0.06, mats.visor, 0, 2.3, -0.38));
  // 肩装甲（パウルドロン）
  for (const s of [-1, 1]) {
    upper.add(box(0.38, 0.3, 0.56, mats.armor, s * 0.62, 2.3, 0));
    upper.add(box(0.36, 0.08, 0.5, mats.accent, s * 0.63, 2.47, 0));
    upper.add(box(0.1, 0.22, 0.4, mats.armorDark, s * 0.81, 2.22, 0));
  }
  // 首関節
  upper.add(cylinder(0.2, 0.24, 0.16, mats.joint, 0, 2.4, 0));
  // 背部バックパック
  upper.add(box(0.9, 0.7, 0.34, mats.armorDark, 0, 1.98, 0.5));
  upper.add(box(0.5, 0.5, 0.12, mats.accent, 0, 1.98, 0.7));
  // 主推進器 2 基（後方 +Z）
  const thrusters: Thruster[] = [];
  thrusters.push(makeThruster(mats, -0.3, 1.9, 0.72, 0.13, upper));
  thrusters.push(makeThruster(mats, 0.3, 1.9, 0.72, 0.13, upper));
  return thrusters;
}

/** コアラ頭部（首の上、正面 −Z） */
function buildHead(mats: MechMaterials, upper: THREE.Group): THREE.Group {
  const head = new THREE.Group();
  head.position.set(0, 2.68, 0);
  // 頭（やや横広の球）
  head.add(sphere(0.34, mats.fur, 0, 0, 0, 1.05, 1.0, 0.98, 24));
  // 大きな丸い耳（扁平な球）と内側の明るいパッド
  for (const s of [-1, 1]) {
    head.add(sphere(0.21, mats.fur, s * 0.39, 0.15, 0.02, 1.0, 1.0, 0.5, 18));
    head.add(sphere(0.135, mats.earInner, s * 0.385, 0.15, -0.075, 1.0, 1.0, 0.4, 16));
  }
  // 黒い楕円の鼻（前面に大きく）
  head.add(sphere(0.125, mats.nose, 0, -0.06, -0.31, 0.9, 1.2, 0.75, 18));
  // 目
  for (const s of [-1, 1]) {
    head.add(sphere(0.05, mats.eye, s * 0.14, 0.07, -0.29, 1, 1, 0.8, 12));
    head.add(sphere(0.015, mats.earInner, s * 0.155, 0.085, -0.335, 1, 1, 1, 8));
  }
  // 口元・顎の装甲
  const jaw = box(0.34, 0.09, 0.2, mats.armorDark, 0, -0.24, -0.2);
  jaw.rotation.x = 0.2;
  head.add(jaw);
  head.add(box(0.14, 0.02, 0.04, mats.nose, 0, -0.17, -0.31));
  // 頭頂の小型装甲（センサー）
  head.add(box(0.2, 0.05, 0.16, mats.armor, 0, 0.32, -0.02));
  upper.add(head);
  return head;
}

interface ArmParts {
  aim: THREE.Group;
  tips: Record<Weapon, THREE.Object3D>;
  muzzle: THREE.Object3D;
  /** 上腕（肩に固定。毎フレーム肘へ向けて伸縮） */
  upperArm: THREE.Group;
  /** 肘の位置（照準グループ内） */
  elbowMarker: THREE.Object3D;
  /** 照準グループ内の腕本体（肩原点座標系） */
  armBody: THREE.Group;
}

/**
 * 右腕（照準グループ）: 原点を銃口（PLAYER.muzzleOffset）に置き、腕全体を銃口を中心に回転させる。
 * これにより砲身先端のワールド位置が照準方向に依存せず、シミュレーションの銃口位置（ヨーのみで決まる）と常に一致する。
 * 肩関節は胴体側に固定し、上腕は毎フレーム肩→肘を結ぶように向きと長さを更新する。
 */
function buildRightArm(mats: MechMaterials, root: THREE.Group, upper: THREE.Group): ArmParts {
  const aim = new THREE.Group();
  aim.position.set(MUZZLE_LOCAL[0], MUZZLE_LOCAL[1], MUZZLE_LOCAL[2]);
  root.add(aim);
  // 砲身軸（肩原点座標系での銃口との差）
  const gx = MUZZLE_LOCAL[0] - SHOULDER_R[0];
  const gy = MUZZLE_LOCAL[1] - SHOULDER_R[1];
  const tipZ = MUZZLE_LOCAL[2];
  // 内側グループ: 肩を原点とする従来の座標系（銃口が aim の原点に来るよう平行移動）
  const armBody = new THREE.Group();
  armBody.position.set(-gx, -gy, -tipZ);
  aim.add(armBody);
  // 肩関節（胴体に固定）
  upper.add(sphere(0.16, mats.joint, SHOULDER_R[0], SHOULDER_R[1], SHOULDER_R[2], 1, 1, 1, 14));
  const elbow: Vec3 = [gx * 0.6, gy - 0.12, 0.2];
  // 上腕: 肩（胴体固定）→ 肘（照準グループ内）。+Z 方向に長さ 1 の円柱を置き、update で lookAt と scale.z で結ぶ
  const upperArm = new THREE.Group();
  upperArm.position.set(SHOULDER_R[0], SHOULDER_R[1], SHOULDER_R[2]);
  upper.add(upperArm);
  upperArm.add(cylinder(0.11, 0.11, 1, mats.armor, 0, 0, 0.5, 'z'));
  const elbowMarker = new THREE.Object3D();
  elbowMarker.position.set(elbow[0], elbow[1], elbow[2]);
  armBody.add(elbowMarker);
  armBody.add(box(0.26, 0.3, 0.26, mats.armor, elbow[0], elbow[1] + 0.02, elbow[2] + 0.02));
  armBody.add(sphere(0.13, mats.joint, elbow[0], elbow[1], elbow[2], 1, 1, 1, 12));
  // 前腕: 肘から前方 −Z へ
  const forearm = box(0.24, 0.22, 0.75, mats.armorDark, gx * 0.7, gy - 0.2, elbow[2] - 0.45);
  armBody.add(forearm);
  armBody.add(box(0.3, 0.1, 0.5, mats.accent, gx * 0.7, gy - 0.07, elbow[2] - 0.5));
  // 武器保持部と機関部（砲身軸 x=gx, y=gy）
  armBody.add(box(0.26, 0.3, 0.9, mats.gun, gx, gy, 0.1));
  armBody.add(box(0.16, 0.12, 0.3, mats.gun, gx, gy + 0.2, 0.05));
  armBody.add(box(0.12, 0.2, 0.2, mats.armorDark, gx, gy - 0.24, 0.25));
  // 武器ごとの先端（砲身先端は z = tipZ）
  const tips: Record<Weapon, THREE.Object3D> = { machinegun: new THREE.Group(), beam: new THREE.Group(), missile: new THREE.Group() };
  // マシンガン: 長い砲身＋マズルブレーキ
  {
    const g = tips.machinegun;
    g.add(cylinder(0.06, 0.06, -tipZ - 0.35, mats.gun, gx, gy, (tipZ - 0.35) / 2, 'z'));
    g.add(cylinder(0.05, 0.05, 0.4, mats.gun, gx, gy + 0.11, tipZ + 0.65, 'z'));
    g.add(cylinder(0.09, 0.09, 0.22, mats.armorDark, gx, gy, tipZ + 0.11, 'z'));
    g.add(box(0.2, 0.2, 0.1, mats.armorDark, gx, gy, tipZ + 0.02));
  }
  // ビーム: 太い放射器＋発光リング
  {
    const g = tips.beam;
    g.add(cylinder(0.1, 0.13, -tipZ - 0.35, mats.gun, gx, gy, (tipZ - 0.35) / 2, 'z'));
    g.add(cylinder(0.16, 0.16, 0.12, mats.beamEmitter, gx, gy, tipZ + 0.35, 'z'));
    g.add(cylinder(0.14, 0.14, 0.12, mats.beamEmitter, gx, gy, tipZ + 0.1, 'z'));
    g.add(cylinder(0.05, 0.08, 0.16, mats.beamEmitter, gx, gy, tipZ + 0.02, 'z'));
  }
  // ミサイル: 4 連装ポッド
  {
    const g = tips.missile;
    g.add(box(0.36, 0.36, -tipZ - 0.3, mats.missilePod, gx, gy, (tipZ - 0.3) / 2));
    for (const ox of [-0.09, 0.09]) {
      for (const oy of [-0.09, 0.09]) {
        g.add(cylinder(0.07, 0.07, 0.1, mats.joint, gx + ox, gy + oy, tipZ + 0.03, 'z'));
        g.add(cylinder(0.05, 0.05, 0.04, mats.accent, gx + ox, gy + oy, tipZ + 0.01, 'z'));
      }
    }
  }
  for (const w of Object.keys(tips) as Weapon[]) {
    tips[w].name = 'tip:' + w;
    armBody.add(tips[w]);
  }
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, 0);
  aim.add(muzzle);
  return { aim, tips, muzzle, upperArm, elbowMarker, armBody };
}

/** 左腕: シールド＋マニピュレーター（固定姿勢、わずかに揺れる） */
function buildLeftArm(mats: MechMaterials, upper: THREE.Group): THREE.Group {
  const arm = new THREE.Group();
  arm.position.set(SHOULDER_L[0], SHOULDER_L[1], SHOULDER_L[2]);
  upper.add(arm);
  arm.add(sphere(0.16, mats.joint, 0, 0, 0, 1, 1, 1, 14));
  const elbow: Vec3 = [-0.14, -0.42, 0.08];
  arm.add(segment([0, 0, 0], elbow, 0.11, mats.armor));
  arm.add(box(0.26, 0.28, 0.26, mats.armor, elbow[0] * 0.5, elbow[1] * 0.5, elbow[2] * 0.5));
  arm.add(sphere(0.13, mats.joint, elbow[0], elbow[1], elbow[2], 1, 1, 1, 12));
  const hand: Vec3 = [-0.2, -0.55, -0.45];
  arm.add(segment(elbow, hand, 0.1, mats.armorDark));
  arm.add(box(0.22, 0.2, 0.55, mats.armorDark, -0.18, -0.5, -0.22));
  // マニピュレーター（爪）
  arm.add(box(0.05, 0.14, 0.18, mats.joint, hand[0] - 0.07, hand[1], hand[2] - 0.1));
  arm.add(box(0.05, 0.14, 0.18, mats.joint, hand[0] + 0.07, hand[1], hand[2] - 0.1));
  // シールド板（腕の外側）
  const shield = box(0.08, 0.8, 0.62, mats.armor, -0.27, -0.42, -0.15);
  shield.rotation.y = 0.12;
  arm.add(shield);
  arm.add(box(0.03, 0.6, 0.12, mats.accent, -0.315, -0.42, -0.15));
  return arm;
}

interface BipedLeg {
  hip: THREE.Group;
  knee: THREE.Group;
  foot: THREE.Mesh;
}

function buildBipedLeg(mats: MechMaterials, parent: THREE.Object3D, side: number): BipedLeg {
  const hip = new THREE.Group();
  hip.position.set(side * 0.3, 1.32, 0);
  parent.add(hip);
  hip.add(sphere(0.15, mats.joint, 0, 0, 0, 1, 1, 1, 12));
  hip.add(box(0.3, 0.6, 0.36, mats.armor, 0, -0.3, 0));
  hip.add(box(0.2, 0.42, 0.1, mats.accent, 0, -0.28, -0.2));
  const knee = new THREE.Group();
  knee.position.set(0, -0.6, 0);
  hip.add(knee);
  knee.add(sphere(0.14, mats.joint, 0, 0, 0, 1, 1, 1, 12));
  knee.add(box(0.26, 0.2, 0.14, mats.armor, 0, -0.02, -0.16));
  knee.add(box(0.24, 0.6, 0.28, mats.armorDark, 0, -0.3, 0.02));
  const foot = box(0.32, 0.12, 0.56, mats.armorDark, 0, -0.66, -0.08);
  knee.add(foot);
  knee.add(box(0.28, 0.08, 0.2, mats.armor, 0, -0.56, -0.2));
  return { hip, knee, foot };
}

interface QuadLeg {
  hip: THREE.Group;
  lift: THREE.Group;
  sx: number;
  sz: number;
  /** 脚の面（ローカル +X）を外向き対角へ向ける基準ヨー [rad]。歩行の振りはこれに加算する */
  baseYaw: number;
}

function buildQuadLeg(mats: MechMaterials, parent: THREE.Object3D, sx: number, sz: number): QuadLeg {
  const hip = new THREE.Group();
  hip.position.set(sx * 0.35, 1.2, sz * 0.35);
  // 脚の面（ローカル +X）を外向き対角へ
  const dx = sx * Math.SQRT1_2;
  const dz = sz * Math.SQRT1_2;
  const baseYaw = Math.atan2(-dz, dx);
  hip.rotation.y = baseYaw;
  parent.add(hip);
  const lift = new THREE.Group();
  hip.add(lift);
  lift.add(sphere(0.14, mats.joint, 0, 0, 0, 1, 1, 1, 12));
  const kneePos: Vec3 = [0.45, 0.45, 0];
  const footPos: Vec3 = [0.6, -1.2, 0];
  lift.add(segment([0, 0, 0], kneePos, 0.1, mats.armor));
  const thighArmor = box(0.5, 0.2, 0.26, mats.armor, kneePos[0] * 0.5, kneePos[1] * 0.5 + 0.06, 0);
  thighArmor.rotation.z = Math.atan2(kneePos[1], kneePos[0]);
  lift.add(thighArmor);
  lift.add(sphere(0.13, mats.joint, kneePos[0], kneePos[1], kneePos[2], 1, 1, 1, 12));
  lift.add(segment(kneePos, footPos, 0.075, mats.armorDark));
  const shinArmor = box(0.14, 1.2, 0.2, mats.accent, (kneePos[0] + footPos[0]) * 0.5 - 0.06, (kneePos[1] + footPos[1]) * 0.5, 0);
  shinArmor.rotation.z = Math.atan2(footPos[1] - kneePos[1], footPos[0] - kneePos[0]) + Math.PI / 2;
  lift.add(shinArmor);
  // 足先
  lift.add(cylinder(0.05, 0.16, 0.16, mats.joint, footPos[0], footPos[1] + 0.08, footPos[2]));
  return { hip, lift, sx, sz, baseYaw };
}

export function createPlayerMech(legs: LegsKind): MechModel {
  const mats = makeMaterials();
  const root = new THREE.Group();
  root.name = 'playerMech';
  const upper = new THREE.Group();
  root.add(upper);

  const thrusters = buildTorso(mats, upper);
  const head = buildHead(mats, upper);
  const rightArm = buildRightArm(mats, root, upper);
  const leftArm = buildLeftArm(mats, upper);
  // 腰部の補助ノズル（グライド用）
  const glideNozzles: Thruster[] = [makeThruster(mats, -0.42, 1.45, 0.3, 0.08, upper), makeThruster(mats, 0.42, 1.45, 0.3, 0.08, upper)];

  const bipedLegs: BipedLeg[] = [];
  const quadLegs: QuadLeg[] = [];
  const legRoot = new THREE.Group();
  root.add(legRoot);
  if (legs === 'biped') {
    bipedLegs.push(buildBipedLeg(mats, legRoot, -1), buildBipedLeg(mats, legRoot, 1));
  } else {
    // 4 脚: 腰部を低い台座に
    legRoot.add(cylinder(0.55, 0.62, 0.3, mats.armorDark, 0, 1.2, 0, 'y', 16));
    legRoot.add(box(0.9, 0.16, 0.9, mats.armor, 0, 1.38, 0));
    quadLegs.push(buildQuadLeg(mats, legRoot, -1, -1), buildQuadLeg(mats, legRoot, 1, -1), buildQuadLeg(mats, legRoot, -1, 1), buildQuadLeg(mats, legRoot, 1, 1));
  }

  const tmpDir = new THREE.Vector3();
  const tmpElbow = new THREE.Vector3();
  const tmpShoulder = new THREE.Vector3();
  const tmpInv = new THREE.Matrix4();

  const model: MechModel = {
    root,
    legs,
    update(u: MechUpdate): void {
      const alive = u.alive ?? true;
      root.rotation.y = u.yaw;
      // 大破姿勢
      root.rotation.z = alive ? 0 : 0.35;
      root.rotation.x = alive ? 0 : 0.15;
      // 腕: ワールド照準方向 → 機体ローカル（yaw の逆回転）
      const c = Math.cos(-u.yaw);
      const s = Math.sin(-u.yaw);
      const ax = u.aimDirection[0];
      const ay = u.aimDirection[1];
      const az = u.aimDirection[2];
      const lx = ax * c + az * s;
      const lz = -ax * s + az * c;
      const horiz = Math.hypot(lx, lz);
      const rawYaw = horiz > 1e-6 ? Math.atan2(-lx, -lz) : 0;
      // ピッチは制限しない（真上・真下の照準でも砲身が実際の射出方向と一致する）
      const armPitch = Math.atan2(ay, horiz);
      // 肩関節のヨーは可動域内。上半身は可動域内では少し追従し、可動域を超えた分は全て上半身のひねりで吸収する
      const armYaw = Math.max(-ARM_YAW_LIMIT, Math.min(ARM_YAW_LIMIT, rawYaw));
      const upperYaw = armYaw * UPPER_FOLLOW + (rawYaw - armYaw);
      upper.rotation.y = upperYaw;
      // 腕（照準グループ）は機体ルート直下で銃口を中心に回転する: 砲身の向き = aimDirection、銃口位置は不変
      rightArm.aim.rotation.set(armPitch, rawYaw, 0, 'YXZ');
      // 武器の先端
      const weapon = u.weapon ?? DEFAULT_WEAPON;
      for (const w of Object.keys(rightArm.tips) as Weapon[]) rightArm.tips[w].visible = w === weapon;

      // 歩行
      const walking = u.grounded && !u.gliding && u.speed > WALK_ANIM_MIN_SPEED;
      const blend = walking ? Math.min(1, (u.speed - WALK_ANIM_MIN_SPEED) / 1.5) : 0;
      const p = u.walkPhase;
      const airborne = !u.grounded;
      const glideLift = u.gliding && u.grounded ? 0.12 : 0;
      if (legs === 'biped') {
        for (let i = 0; i < bipedLegs.length; i++) {
          const leg = bipedLegs[i];
          const ph = p + (i === 0 ? 0 : Math.PI);
          const thigh = 0.6 * Math.sin(ph) * blend;
          const kneeBend = -0.9 * Math.max(0, Math.sin(ph - 0.9)) * blend;
          if (airborne) {
            // 空中: 脚をやや後ろへ流し、膝を曲げる
            leg.hip.rotation.x = -0.25;
            leg.knee.rotation.x = -0.55;
          } else {
            leg.hip.rotation.x = thigh + glideLift;
            leg.knee.rotation.x = kneeBend - glideLift * 0.5;
          }
          leg.foot.rotation.x = airborne ? 0.3 : 0;
        }
        upper.position.y = walking ? 0.03 * Math.abs(Math.sin(p)) : 0;
      } else {
        for (const leg of quadLegs) {
          // 対角ペア（前左+後右 / 前右+後左）が交互に動く
          const pair = leg.sx * leg.sz > 0 ? 0 : Math.PI;
          const ph = p + pair;
          const swing = 0.35 * Math.cos(ph) * blend;
          const lift = 0.35 * Math.max(0, Math.sin(ph)) * blend;
          // 脚の面は常に外向き対角（baseYaw）を基準にし、歩行の振りだけを加算する
          if (airborne) {
            leg.hip.rotation.y = leg.baseYaw;
            leg.lift.rotation.z = 0.35;
          } else {
            leg.hip.rotation.y = leg.baseYaw + leg.sx * swing;
            leg.lift.rotation.z = lift + glideLift;
          }
        }
        upper.position.y = walking ? 0.02 * Math.abs(Math.sin(p * 2)) : 0;
      }
      head.rotation.y = armYaw * 0.35;
      // Three の Rx は正で −Z 面が上を向く → 上を狙うと頭も上を向く
      head.rotation.x = armPitch * 0.2;
      leftArm.rotation.x = walking ? 0.15 * Math.sin(p) : airborne ? -0.3 : 0;

      // 推進器（炎の揺らぎは視覚専用の乱数）
      const jitter = Math.random();
      let strength = 0;
      if (!alive) strength = 0;
      else if (u.boosting) strength = 1.8;
      else if (u.thrusting) strength = 1.0;
      else if (airborne) strength = 0.25;
      else if (u.gliding) strength = 0.2;
      for (const t of thrusters) setThruster(t, strength, jitter);
      mats.nozzle.emissiveIntensity = 0.2 + strength * 1.6;
      const glideStrength = alive && (u.gliding || u.boosting) ? (u.boosting ? 1.0 : 0.45) : 0;
      for (const t of glideNozzles) setThruster(t, glideStrength, jitter);

      // 上腕（最後に計算: 上半身の上下動などが確定した後の行列を使う）: 肩（胴体固定）から肘（照準グループ内）へ向けて伸縮。ローカル行列だけで求める（機体の傾きに依存しない）
      rightArm.aim.updateMatrix();
      rightArm.armBody.updateMatrix();
      upper.updateMatrix();
      tmpElbow.copy(rightArm.elbowMarker.position).applyMatrix4(rightArm.armBody.matrix).applyMatrix4(rightArm.aim.matrix); // 機体ルート座標
      tmpInv.copy(upper.matrix).invert();
      tmpElbow.applyMatrix4(tmpInv); // 上半身ローカル座標
      tmpShoulder.copy(tmpElbow).sub(rightArm.upperArm.position);
      const upperLen = tmpShoulder.length();
      if (upperLen > 1e-6) {
        rightArm.upperArm.quaternion.setFromUnitVectors(Z_AXIS, tmpShoulder.multiplyScalar(1 / upperLen));
        rightArm.upperArm.scale.z = upperLen;
      }
    },
    getMuzzleWorldPosition(target: THREE.Vector3): THREE.Vector3 {
      root.updateMatrixWorld(true);
      return rightArm.muzzle.getWorldPosition(target);
    },
    getBarrelWorldDirection(target: THREE.Vector3): THREE.Vector3 {
      root.updateMatrixWorld(true);
      // Group の getWorldDirection は +Z。砲身は −Z
      rightArm.aim.getWorldDirection(tmpDir);
      return target.copy(tmpDir).multiplyScalar(-1).normalize();
    },
    dispose(): void {
      disposeObject(root);
      for (const m of Object.values(mats)) m.dispose();
      root.removeFromParent();
      root.clear();
    },
  };
  return model;
}
