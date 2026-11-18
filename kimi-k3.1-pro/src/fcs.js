import * as THREE from 'three';
import { FCS } from './config.js';
import { hasLineOfSight } from './collision.js';

const _projected = new THREE.Vector3();
const _cameraForward = new THREE.Vector3();
const _toTarget = new THREE.Vector3();

export class FlightControlSystem {
  constructor(camera, canvas, colliders) {
    this.camera = camera;
    this.canvas = canvas;
    this.colliders = colliders;
    this.targetId = null;
    this.progress = 0;
    this.state = 'none';
    this.lockSeconds = 0.8;
    this.radiusFactor = 0.2;
    this.lastCandidate = null;
  }

  configure(loadout, effectiveStats) {
    this.radiusFactor = FCS[loadout.fcs].radius;
    this.lockSeconds = effectiveStats.lockSeconds;
    this.reset();
  }

  reset() { this.targetId = null; this.progress = 0; this.state = 'none'; this.lastCandidate = null; }
  get radiusCssPx() { return Math.min(this.canvas.clientWidth, this.canvas.clientHeight) * this.radiusFactor; }

  clear() { this.targetId = null; this.progress = 0; this.state = 'none'; }

  validate(enemy, muzzle, cameraPosition = this.camera.position) {
    if (!enemy || !enemy.alive) return null;
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (!width || !height) return null;
    const center = enemy.position;
    if (muzzle.distanceTo(center) > 120) return null;
    this.camera.getWorldDirection(_cameraForward);
    _toTarget.subVectors(center, cameraPosition);
    if (_toTarget.dot(_cameraForward) <= 0) return null;
    _projected.copy(center).project(this.camera);
    if (_projected.z < -1 || _projected.z > 1) return null;
    const px = (_projected.x * 0.5 + 0.5) * width;
    const py = (-_projected.y * 0.5 + 0.5) * height;
    const dx = px - width / 2, dy = py - height / 2;
    const distanceCss = Math.hypot(dx, dy);
    if (distanceCss > this.radiusCssPx) return null;
    if (!hasLineOfSight(cameraPosition, center, this.colliders)) return null;
    if (!hasLineOfSight(muzzle, center, this.colliders)) return null;
    return { enemy, distanceCss };
  }

  update(dt, enemies, muzzle) {
    this.camera.updateMatrixWorld(true);
    let current = this.targetId ? this.validate(enemies.find(e => e.id === this.targetId), muzzle) : null;
    if (this.targetId && !current) this.clear();
    if (!this.targetId) {
      const candidates = [];
      for (const enemy of enemies) {
        const valid = this.validate(enemy, muzzle);
        if (valid) candidates.push(valid);
      }
      candidates.sort((a, b) => a.distanceCss - b.distanceCss || a.enemy.id.localeCompare(b.enemy.id));
      if (candidates.length) {
        this.targetId = candidates[0].enemy.id;
        this.progress = 0;
        this.state = 'acquiring';
        current = candidates[0];
      }
    }
    this.lastCandidate = current?.enemy || null;
    if (this.targetId && current) {
      this.progress = Math.min(1, this.progress + dt / this.lockSeconds);
      this.state = this.progress >= 1 - 1e-9 ? 'locked' : 'acquiring';
      if (this.state === 'locked') this.progress = 1;
    } else {
      this.progress = 0; this.state = 'none';
    }
  }

  target(enemies) { return this.targetId ? enemies.find(e => e.id === this.targetId) || null : null; }

  snapshot() {
    return { state: this.state, targetId: this.targetId, progress: this.progress, radiusCssPx: this.radiusCssPx };
  }
}
