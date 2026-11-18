/**
 * Hangar scene: maintenance bay with a turntable. The real mech model is shown (biped / quadruped switch), starting
 * with the head seen from the front, then a slow automatic turntable. Legs play a walk-in-place preview.
 */
import {
  AmbientLight,
  Color,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  Scene,
  SpotLight,
  Texture,
} from 'three';
import { PLAYER } from '../config';
import type { BoxDef, Loadout, StageDef } from '../sim/types';
import { forwardFromYaw, rightFromYaw } from '../sim/math';
import { MechModel } from './mech';
import { buildStageMeshes } from './stageMesh';
import { MaterialLibrary } from './textures';

const PLATFORM_TOP = 0.35;

/** hangar architecture as ordinary BoxDefs (reuses the stage mesh merger) */
export function buildHangarBoxes(): BoxDef[] {
  const boxes: BoxDef[] = [];
  let n = 0;
  const add = (min: [number, number, number], max: [number, number, number], mat: BoxDef['mat'], extra: Partial<BoxDef> = {}): void => {
    boxes.push({ id: `h${n++}`, min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] }, mat, sectorId: 'H', ...extra });
  };
  // floor + turntable
  add([-34, -2, -30], [34, 0, 24], 'floorTile');
  add([-4.6, 0, -4.6], [4.6, 0.12, 4.6], 'hazard', { shape: 'cylY' });
  add([-3.9, 0.12, -3.9], [3.9, PLATFORM_TOP, 3.9], 'metalDark', { shape: 'cylY' });
  add([-3.2, PLATFORM_TOP, -3.2], [3.2, PLATFORM_TOP + 0.02, 3.2], 'metalDark', { shape: 'cylY' });
  // floor guide lines
  add([-0.25, 0, -30], [0.25, 0.02, -4.7], 'hazard');
  add([-0.25, 0, 4.7], [0.25, 0.02, 24], 'hazard');
  add([-30, 0, -0.25], [-4.7, 0.02, 0.25], 'hazard');
  add([4.7, 0, -0.25], [30, 0.02, 0.25], 'hazard');
  // back wall with big door
  add([-34, 0, -32], [34, 20, -30], 'metal');
  add([-9, 0, -30], [9, 13, -29.5], 'gate');
  add([-9.6, 0, -30], [-9, 13.4, -29.3], 'hazard');
  add([9, 0, -30], [9.6, 13.4, -29.3], 'hazard');
  add([-9.6, 13, -30], [9.6, 13.6, -29.3], 'hazard');
  for (let i = -3; i <= 3; i++) add([i * 9 - 0.3, 0, -29.9], [i * 9 + 0.3, 20, -29.5], 'metalDark');
  // side walls
  add([-34, 0, -32], [-32, 20, 24], 'concrete');
  add([32, 0, -32], [34, 20, 24], 'concrete');
  add([-32, 0, -30], [-31.5, 12, 22], 'metal');
  add([31.5, 0, -30], [32, 12, 22], 'metal');
  // ceiling + trusses + light bars
  add([-34, 20, -32], [34, 22, 24], 'roof');
  for (let z = -24; z <= 16; z += 8) {
    add([-32, 18.4, z - 0.4], [32, 19.4, z + 0.4], 'metalDark');
    add([-6, 17.9, z - 0.6], [6, 18.4, z + 0.6], 'lightPanel', { emissive: 1 });
  }
  for (let x = -24; x <= 24; x += 12) add([x - 0.3, 14, -32], [x + 0.3, 20, 24], 'metalDark');
  // pipes along the walls
  add([-31.5, 6.5, -30], [-30.5, 7.5, 22], 'pipe', { shape: 'cylZ' });
  add([-31.5, 9, -30], [-30.7, 9.8, 22], 'pipe', { shape: 'cylZ' });
  add([30.5, 8, -30], [31.5, 9, 22], 'pipe', { shape: 'cylZ' });
  add([-33, 11.5, -31.5], [33, 12.5, -30.5], 'pipe', { shape: 'cylX' });
  // machines, crates and light towers around the edges
  add([-28, 0, -26], [-22, 5, -20], 'machine');
  add([-28, 5, -25], [-24, 6.4, -21], 'machine');
  add([22, 0, -26], [28, 6, -19], 'machine');
  add([-30, 0, -8], [-25, 3, -2], 'crate');
  add([-30, 3, -7], [-26, 5.5, -3], 'crate');
  add([25, 0, -10], [30, 3, -4], 'crate');
  add([26, 0, 6], [30, 2.6, 12], 'crate');
  for (const x of [-16, 16]) {
    add([x - 0.5, 0, -22.5], [x + 0.5, 9, -21.5], 'metalDark');
    add([x - 1.4, 8.6, -23], [x + 1.4, 9.4, -21], 'lightPanel', { emissive: 1 });
  }
  // gantry (maintenance arm frame) behind the turntable
  add([-8, 0, -14], [-7, 12, -13], 'metalDark');
  add([7, 0, -14], [8, 12, -13], 'metalDark');
  add([-8, 11.2, -14], [8, 12, -13], 'metalDark');
  add([-8, 4, -13.6], [-7, 4.6, -12.4], 'hazard');
  add([7, 4, -13.6], [8, 4.6, -12.4], 'hazard');
  add([-2.2, 8.5, -13.6], [2.2, 11.2, -13], 'machine');
  return boxes;
}

export function hangarStageDef(): StageDef {
  const boxes = buildHangarBoxes();
  return {
    name: 'hangar',
    boxes,
    sectors: [],
    portals: [],
    barriers: [],
    enemies: [],
    playerStart: { pos: { x: 0, y: 0, z: 0 }, yaw: 0 },
    escapeZone: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    mainRoute: { id: 'h', kind: 'main', note: '', points: [], sectorIds: [] },
    branches: [],
    loops: [],
    climbs: [],
    killY: -100,
  };
}

const DWELL = 3.8; // seconds facing the camera (head check) before turning
const TURN = 15; // seconds for a full turn
const ease = (t: number): number => t * t * (3 - 2 * t);

export class HangarScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(36, 16 / 9, 0.1, 400);
  readonly mech: MechModel;
  readonly turntableRing = new Group();
  private loadout: Loadout;
  private t = 0;
  private stageGroup: Group;
  triangles = 0;

  constructor(lib: MaterialLibrary, env: Texture | null, loadout: Loadout) {
    this.loadout = { ...loadout };
    this.scene.background = new Color(0x0d1117);
    this.scene.fog = new Fog(0x0d1117, 30, 90);
    if (env) {
      this.scene.environment = env;
      this.scene.environmentIntensity = 0.3;
    }
    const built = buildStageMeshes(hangarStageDef(), lib);
    this.stageGroup = built.group;
    this.triangles = built.stats.triangles;
    for (const c of built.chunks) c.receiveShadow = true;
    this.scene.add(this.stageGroup);

    this.mech = new MechModel(lib);
    this.mech.root.position.set(0, PLATFORM_TOP + PLAYER.HALF.y, 0);
    this.mech.root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = false;
      }
    });
    this.scene.add(this.mech.root);

    const hemi = new HemisphereLight(0xa8b8d0, 0x2a2622, 0.3);
    this.scene.add(hemi, new AmbientLight(0x202830, 0.25));
    const key = new SpotLight(0xfff0dc, 520, 60, 0.42, 0.55, 2);
    key.position.set(5, 14, 9);
    key.target.position.set(0, 1.8, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.camera.near = 4;
    key.shadow.camera.far = 40;
    this.scene.add(key, key.target);
    const fill = new SpotLight(0x9cc0ff, 200, 60, 0.6, 0.8, 2);
    fill.position.set(-10, 8, 8);
    fill.target.position.set(0, 2, 0);
    this.scene.add(fill, fill.target);
    const rim = new SpotLight(0x58c8ff, 500, 60, 0.5, 0.8, 2);
    rim.position.set(-3, 9, -9);
    rim.target.position.set(0, 2.4, 0);
    this.scene.add(rim, rim.target);
    const rim2 = new SpotLight(0xffb070, 260, 60, 0.5, 0.8, 2);
    rim2.position.set(6, 6, -8);
    rim2.target.position.set(0, 2.4, 0);
    this.scene.add(rim2, rim2.target);

    this.camera.position.set(0, 3.2, 10.4);
    this.camera.lookAt(0, 2.35, 0);
    this.setLoadout(loadout);
    this.reset();
  }

  setLoadout(l: Loadout): void {
    this.loadout = { ...l };
    this.mech.setLegs(l.legs);
  }

  reset(): void {
    this.t = 0;
  }

  setAspect(a: number): void {
    this.camera.aspect = a;
    // keep the whole mech in frame on narrow windows
    this.camera.fov = a < 1.3 ? 36 * (1.3 / Math.max(a, 0.6)) ** 0.7 : 36;
    this.camera.updateProjectionMatrix();
  }

  /** current turntable yaw of the mech (rad). 0 => faces +Z (toward the camera) */
  yawAt(t: number): number {
    const cycle = DWELL + TURN;
    const u = t % cycle;
    let a = 0;
    if (u > DWELL) a = ease((u - DWELL) / TURN) * Math.PI * 2;
    return Math.PI + a;
  }

  update(dt: number): void {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.t += dt;
    const yaw = this.yawAt(this.t);
    const pos = this.mech.root.position;
    // display pose: gun slightly outward so the weapon is seen in profile from the front
    const f = forwardFromYaw(yaw);
    const r = rightFromYaw(yaw);
    const o = PLAYER.MUZZLE_OFFSET;
    const muzzle = { x: pos.x + r.x * o.right + f.x * o.forward, y: pos.y + o.up, z: pos.z + r.z * o.right + f.z * o.forward };
    const ax = 0.3;
    const aimDir = { x: f.x + r.x * ax, y: 0.06, z: f.z + r.z * ax };
    const l = Math.hypot(aimDir.x, aimDir.y, aimDir.z);
    aimDir.x /= l;
    aimDir.y /= l;
    aimDir.z /= l;
    this.mech.update({
      dt,
      time: this.t,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw,
      pitch: 0,
      grounded: true,
      vertical: 'grounded',
      horizontal: 'walk',
      thrusting: false,
      qbRemaining: 0,
      qbDir: { x: 0, z: 0 },
      weapon: 'machinegun',
      muzzle,
      aimDir,
      legs: this.loadout.legs,
      fixedYaw: yaw,
      walkSpeed: this.loadout.legs === 'quadruped' ? 3.6 : 4.4,
    });
  }

  dispose(): void {
    this.mech.dispose();
    this.stageGroup.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }
}
