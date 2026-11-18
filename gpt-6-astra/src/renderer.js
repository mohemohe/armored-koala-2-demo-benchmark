import * as THREE from 'three';
import { createKoalaMech, animateMech, createEnemyModel } from './models.js';

const UP = new THREE.Vector3(0, 1, 0);
export class GameRenderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#151e1b');
    this.scene.fog = new THREE.FogExp2('#263530', 0.005);
    this.scene.add(new THREE.HemisphereLight('#d9e4d5', '#39423b', 2.5));
    this.scene.add(new THREE.AmbientLight('#819788', 0.7));
    this.sun = new THREE.DirectionalLight('#ffdfae', 3.4);
    this.sun.position.set(-45, 80, 15);
    this.scene.add(this.sun);
    this.rim = new THREE.DirectionalLight('#b3dbe1', 1.2);
    this.rim.position.set(30, 30, -45);
    this.scene.add(this.rim);
    this.camera = new THREE.PerspectiveCamera(64, 1, 0.1, 360);
    this.enemyModels = new Map();
    this.projectileModels = new Map();
    this.effectModels = new Map();
    this.bulletGeometry = new THREE.SphereGeometry(0.13, 6, 4);
    this.missileGeometry = new THREE.ConeGeometry(0.24, 1.05, 6);
    this.particleGeometry = new THREE.IcosahedronGeometry(1, 0);
    this.ringGeometry = new THREE.TorusGeometry(1, 0.045, 4, 32);
    this.materials = {
      machinegun: new THREE.MeshBasicMaterial({ color: '#ffe8a8' }),
      missile: new THREE.MeshBasicMaterial({ color: '#ff9e37' }),
      enemy: new THREE.MeshBasicMaterial({ color: '#ff503e' }),
      beam: new THREE.LineBasicMaterial({ color: '#baffce', transparent: true, opacity: 0.95 }),
      tracer: new THREE.LineBasicMaterial({ color: '#ffcf72' }),
    };
  }
  setWorld(world, combat, loadout) {
    this.clearTransient();
    if (this.world) this.scene.remove(this.world.meshes);
    if (this.playerModel) { this.scene.remove(this.playerModel); disposeObject(this.playerModel); }
    for (const model of this.enemyModels.values()) { this.scene.remove(model); disposeObject(model); }
    this.enemyModels.clear();
    this.world = world;
    this.scene.add(world.meshes);
    this.playerModel = createKoalaMech(loadout.legs);
    this.scene.add(this.playerModel);
    for (const enemy of combat.enemies) {
      const model = createEnemyModel(enemy.kind, enemy.isGateControl);
      const signal = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 6), new THREE.MeshBasicMaterial({ color: '#ff6e45', transparent: true, opacity: 0.9 }));
      signal.position.set(0, 0.45, enemy.kind === 'guard' ? 1.83 : 2.13);
      signal.visible = false; model.add(signal); model.userData.attackSignal = signal;
      this.enemyModels.set(enemy.id, model);
      this.scene.add(model);
    }
  }
  resize(width, height) {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
  updateCamera(player, yaw, pitch) {
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    const pivot = player.position.clone().add(new THREE.Vector3(0, 3.5, 0));
    const direction = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const desired = pivot.clone().addScaledVector(direction, -11).addScaledVector(right, 2.4).addScaledVector(UP, 2);
    const collision = this.world?.raycast(pivot, desired, 0.35);
    this.camera.position.copy(collision ? pivot.clone().lerp(desired, Math.max(0, collision.t - 0.025)) : desired);
    this.camera.lookAt(this.camera.position.clone().addScaledVector(direction, 70));
    this.camera.updateMatrixWorld(true);
    this.forward = forward;
  }
  sync(player, combat, time, yaw, pitch) {
    this.updateCamera(player, yaw, pitch);
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    this.playerModel.position.copy(player.position);
    this.playerModel.rotation.y = yaw;
    let aimDirection = combat.fireControl.launchDirection;
    if (Array.isArray(aimDirection)) aimDirection = new THREE.Vector3(...aimDirection);
    if (!aimDirection) aimDirection = this.camera.getWorldDirection(new THREE.Vector3());
    animateMech(this.playerModel, { time, speed, glide: player.movement.glideEnabled,
      flying: player.movement.verticalMode === 'flying', quickboost: player.movement.horizontalMode === 'quickboost', yaw, aimDirection, weapon: player.weapon });
    for (const enemy of combat.enemies) {
      const model = this.enemyModels.get(enemy.id);
      if (!model) continue;
      model.visible = enemy.alive;
      if (!enemy.alive) continue;
      // Enemy model origin is its collider center; feet are local y=-2.
      model.position.copy(enemy.position);
      model.rotation.y = enemy.yaw || 0;
      const signal = model.userData.attackSignal;
      signal.visible = !!enemy.telegraph;
      signal.scale.setScalar(0.8 + 0.35 * Math.sin(time * 45));
      model.traverse(child => {
        if (child.userData.telegraph && child.material) {
          child.material.emissiveIntensity = enemy.telegraph ? 3.5 + Math.sin(time * 40) * 2 : 0.4;
        }
      });
      if (enemy.kind === 'guard' && model.userData.legs) {
        model.userData.legs.forEach((leg, i) => { leg.rotation.x = Math.sin(time * 9 + i * Math.PI) * Math.min(enemy.velocity.length() / 15, 0.5); });
      }
    }
    this.syncProjectiles(combat.projectiles);
    this.syncEffects(combat.effects);
  }
  syncProjectiles(projectiles) {
    const alive = new Set();
    for (const bullet of projectiles) {
      alive.add(bullet.id);
      let group = this.projectileModels.get(bullet.id);
      if (!group) {
        group = new THREE.Group();
        const missile = bullet.kind === 'missile' || bullet.weapon === 'missile';
        const enemy = bullet.owner !== 'player';
        const mesh = new THREE.Mesh(missile ? this.missileGeometry : this.bulletGeometry, this.materials[enemy ? 'enemy' : missile ? 'missile' : 'machinegun']);
        group.add(mesh);
        const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        const tracer = new THREE.Line(geometry, this.materials.tracer);
        group.add(tracer);
        this.projectileModels.set(bullet.id, group);
        this.scene.add(group);
      }
      group.position.copy(bullet.position);
      const velocity = bullet.velocity || new THREE.Vector3(0, 0, 1);
      if (velocity.lengthSq() > 0) group.children[0].quaternion.setFromUnitVectors(UP, velocity.clone().normalize());
      const tail = velocity.clone().normalize().multiplyScalar(-2.2);
      const vertices = group.children[1].geometry.attributes.position;
      vertices.setXYZ(1, tail.x, tail.y, tail.z);
      vertices.needsUpdate = true;
    }
    for (const [id, model] of this.projectileModels) if (!alive.has(id)) {
      this.scene.remove(model); model.children[1].geometry.dispose(); this.projectileModels.delete(id);
    }
  }
  syncEffects(effects) {
    const alive = new Set();
    for (const effect of effects) {
      alive.add(effect.id);
      let model = this.effectModels.get(effect.id);
      if (!model) {
        if (effect.end) {
          model = new THREE.Line(new THREE.BufferGeometry().setFromPoints([effect.position, effect.end]), this.materials.beam.clone());
        } else {
          const destroyed = effect.type === 'explosion' || effect.type === 'destroy';
          model = new THREE.Mesh(destroyed ? this.ringGeometry : this.particleGeometry,
            new THREE.MeshBasicMaterial({ color: destroyed ? '#ffad56' : '#fff2b9', transparent: true, opacity: 1, depthWrite: false }));
          model.position.copy(effect.position);
          model.userData.destroyed = destroyed;
        }
        this.scene.add(model); this.effectModels.set(effect.id, model);
      }
      const life = Math.max(0, 1 - (effect.age || 0) / (effect.lifetime || 0.3));
      model.material.opacity = life;
      if (!effect.end) {
        const scale = model.userData.destroyed ? 1 + (1 - life) * 5 : life * 0.8;
        model.scale.setScalar(scale);
        if (model.userData.destroyed) model.lookAt(this.camera.position);
      }
    }
    for (const [id, model] of this.effectModels) if (!alive.has(id)) {
      this.scene.remove(model); model.material.dispose(); if (model.isLine) model.geometry.dispose(); this.effectModels.delete(id);
    }
  }
  clearTransient() {
    for (const model of this.projectileModels.values()) { this.scene.remove(model); model.children[1].geometry.dispose(); }
    for (const model of this.effectModels.values()) { this.scene.remove(model); model.material.dispose(); if (model.isLine) model.geometry.dispose(); }
    this.projectileModels.clear(); this.effectModels.clear();
  }
  project(position, width, height) {
    const p = Array.isArray(position) ? new THREE.Vector3(...position) : position.clone();
    p.project(this.camera);
    return { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2, visible: p.z > -1 && p.z < 1, onScreen: Math.abs(p.x) < 1 && Math.abs(p.y) < 1 };
  }
  render() { this.renderer.render(this.scene, this.camera); }
}

function disposeObject(object) {
  const geometries = new Set(), materials = new Set();
  object.traverse(child => { if (child.geometry) geometries.add(child.geometry); if (child.material) (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => materials.add(m)); });
  geometries.forEach(g => { if (!g.userData?.shared) g.dispose(); });
  materials.forEach(m => { if (!m.userData?.shared) m.dispose(); });
}
