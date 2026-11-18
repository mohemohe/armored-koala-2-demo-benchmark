/**
 * シミュレーション側の TPS カメラ。
 * 描画側（Three.js PerspectiveCamera）はこの位置・姿勢・視野角を毎フレーム写す。
 * FCS の投影判定（ロック円内か）はこのクラスの project() を使用する。
 */
import { CAMERA, PLAYER } from '../params';
import type { CollisionWorld, Vec3 } from '../types';
import { add, addScaled, clamp, cross, directionFromYawPitch, dot, forwardFromYaw, normalize, rightFromYaw, sub } from './vec';

export interface ScreenPoint {
  /** CSS px（左上原点） */
  x: number;
  y: number;
  /** カメラ前方の深度 [m]（>0 で前方） */
  depth: number;
  /** カメラ前方（near より前）にあるか */
  inFront: boolean;
}

export class SimCamera {
  position: Vec3 = [0, 0, 0];
  /** ヨー [rad]。0 で前方 -Z。マウス右移動で減少（右旋回） */
  yaw = 0;
  /** ピッチ [rad]。正で上向き */
  pitch = 0;
  fovYDeg: number = CAMERA.fovYDeg;
  viewportWidth = 1280;
  viewportHeight = 720;
  near: number = CAMERA.near;

  get aspect(): number {
    return this.viewportWidth / Math.max(1, this.viewportHeight);
  }

  setViewport(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
  }

  /** マウス移動を適用 */
  applyLook(deltaX: number, deltaY: number): void {
    this.yaw -= deltaX * CAMERA.sensitivity;
    this.pitch = clamp(this.pitch - deltaY * CAMERA.sensitivity, CAMERA.minPitch, CAMERA.maxPitch);
    // yaw を [-π, π] に正規化
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** 視線方向（単位） */
  forward(): Vec3 {
    return directionFromYawPitch(this.yaw, this.pitch);
  }

  /** 水平前方（単位） */
  horizontalForward(): Vec3 {
    return forwardFromYaw(this.yaw);
  }

  /** 右方向（単位、水平） */
  right(): Vec3 {
    return rightFromYaw(this.yaw);
  }

  /** 上方向（単位） */
  up(): Vec3 {
    return normalize(cross(this.right(), this.forward()));
  }

  /** 指定のワールド点を向くように yaw/pitch を設定（試験・格納庫で使用） */
  lookAt(target: Vec3): void {
    const d = normalize(sub(target, this.position));
    this.yaw = Math.atan2(-d[0], -d[2]);
    this.pitch = clamp(Math.atan2(d[1], Math.hypot(d[0], d[2])), CAMERA.minPitch, CAMERA.maxPitch);
  }

  /**
   * プレイヤー足元位置から TPS カメラ位置を更新する。
   * 注視点から後方・上・右肩へオフセットし、ステージ遮蔽物があれば手前へ引き寄せる。
   */
  follow(playerFeetPos: Vec3, world: CollisionWorld | null): void {
    const pivot = add(playerFeetPos, PLAYER.cameraPivotOffset);
    const fwd = this.forward();
    const right = this.right();
    const desired = addScaled(addScaled(addScaled(pivot, fwd, -CAMERA.distance), right, CAMERA.shoulder), [0, 1, 0], CAMERA.height);
    if (!world) {
      this.position = desired;
      return;
    }
    const dir = sub(desired, pivot);
    const dist = Math.hypot(dir[0], dir[1], dir[2]);
    if (dist < 1e-6) {
      this.position = desired;
      return;
    }
    const unit: Vec3 = [dir[0] / dist, dir[1] / dist, dir[2] / dist];
    // 半径 collisionMargin の球を注視点から掃引し、壁面から常に余裕を保つ（ニアクリップのめり込み防止）
    const hit = world.sweepSphere(pivot, desired, CAMERA.collisionMargin);
    if (hit) {
      const t = Math.max(0.2, hit.t * dist);
      this.position = addScaled(pivot, unit, Math.min(t, dist));
    } else {
      this.position = desired;
    }
  }

  /** ワールド点を CSS px に投影する */
  project(p: Vec3): ScreenPoint {
    const d = sub(p, this.position);
    const f = this.forward();
    const r = this.right();
    const u = this.up();
    const zc = dot(d, f);
    const xc = dot(d, r);
    const yc = dot(d, u);
    const tanHalf = Math.tan((this.fovYDeg * Math.PI) / 360);
    const inFront = zc > this.near;
    const zSafe = inFront ? zc : Math.max(1e-6, Math.abs(zc));
    const ndcX = xc / zSafe / (tanHalf * this.aspect);
    const ndcY = yc / zSafe / tanHalf;
    return {
      x: ((ndcX + 1) / 2) * this.viewportWidth,
      y: ((1 - ndcY) / 2) * this.viewportHeight,
      depth: zc,
      inFront,
    };
  }

  /** 画面中心からの CSS px 距離 */
  distanceFromCenter(sp: ScreenPoint): number {
    return Math.hypot(sp.x - this.viewportWidth / 2, sp.y - this.viewportHeight / 2);
  }
}
