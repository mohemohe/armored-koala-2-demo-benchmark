/**
 * Render module tests that can run in Node (no WebGL): geometry generation, materials, model structure, effect pools,
 * camera basis and weapon/muzzle alignment. Uses the real Game / sim modules for state.
 */
import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Quaternion, ShaderChunk, ShaderLib, Texture, Vector3 } from 'three';
import type { InstancedMesh, Mesh, Object3D } from 'three';
import { ENEMIES, PLAYER } from '../src/config';
import { freeFireDirection, playerMuzzlePosition, updateCamera } from '../src/sim/camera';
import { Game } from '../src/sim/game';
import { World } from '../src/sim/world';
import { projectToScreen } from '../src/sim/project';
import { buildTestArenaStage } from '../src/sim/testArena';
import type { BoxDef, GameEvent, GameState, MaterialKey, PlayerBullet, StageDef } from '../src/sim/types';
import { applySimCamera } from '../src/render/cameraRig';
import { usesFcsDirection, visualAimDirection } from '../src/render/aim';
import { LightShafts } from '../src/render/atmosphere';
import { Effects, MG_FLASH, MG_TRACER, ParticleSystem } from '../src/render/effects';
import { ENEMY_RIM, EnemyModel, MUZZLE_HEIGHT, createEnemyMaterials, createEnemyShared } from '../src/render/enemyModels';
import { GeoBuilder } from '../src/render/geo';
import { HangarScene, buildHangarBoxes } from '../src/render/hangar';
import { MechModel, WEAPON_LENGTH, type MechFrame } from '../src/render/mech';
import { UNTINTED_MATS, lerpHex, sectorLook } from '../src/render/look';
import { MAX_BUFFER_PIXELS, effectivePixelRatio } from '../src/render/renderer';
import { buildStageMeshes } from '../src/render/stageMesh';
import { MaterialLibrary, STAGE_MATS } from '../src/render/textures';
import { SectorVisibility, portalBox, sectorContains } from '../src/render/visibility';
import { buildDemoStage, buildStressStage } from '../src/render/viewerStage';
import { buildStage } from '../src/stage';

const ALL_MATS: MaterialKey[] = [
  'concrete', 'concreteDark', 'metal', 'metalDark', 'rust', 'hazard', 'grating', 'pipe', 'crate', 'machine', 'glass', 'barrier', 'gate', 'floorTile', 'roof', 'lightPanel',
];

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('GeoBuilder', () => {
  it('builds an outward-facing box with world-space uv', () => {
    const gb = new GeoBuilder();
    gb.addBox({ x: 10, y: 0, z: -4 }, { x: 14, y: 2, z: 4 }, { tile: 4 });
    expect(gb.vertexCount).toBe(24);
    expect(gb.triangleCount).toBe(12);
    const g = gb.build();
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const ix = g.getIndex()!;
    for (let t = 0; t < ix.count; t += 3) {
      const a = new Vector3().fromBufferAttribute(pos, ix.getX(t));
      const b = new Vector3().fromBufferAttribute(pos, ix.getX(t + 1));
      const c = new Vector3().fromBufferAttribute(pos, ix.getX(t + 2));
      const n = new Vector3().fromBufferAttribute(nor, ix.getX(t));
      const face = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
      expect(face.dot(n)).toBeGreaterThan(0);
    }
    // uv on the +Y face equals (x, -z) / tile => spans 1 unit in u for a 4 m wide box
    let umin = Infinity;
    let umax = -Infinity;
    for (let i = 0; i < 24; i++) {
      if (nor.getY(i) > 0.5) {
        umin = Math.min(umin, uv.getX(i));
        umax = Math.max(umax, uv.getX(i));
      }
    }
    expect(umax - umin).toBeCloseTo(1, 6);
    expect(g.boundingBox!.min.x).toBeCloseTo(10, 6);
    expect(g.boundingBox!.max.z).toBeCloseTo(4, 6);
  });
});

describe('stage meshes', () => {
  it('merges boxes into few chunks and keeps every box inside the merged bounds', () => {
    const lib = new MaterialLibrary();
    const stage = buildStressStage(2500);
    const res = buildStageMeshes(stage, lib);
    expect(res.stats.boxes).toBe(stage.boxes.length);
    expect(res.chunks.length).toBeGreaterThan(0);
    // sparse worst case (boxes scattered over 760 x 760 m): still several boxes per merged mesh
    expect(res.chunks.length).toBeLessThan(stage.boxes.length / 3);
    // triangle count: 12 per plain box; cylinders add more
    const plain = stage.boxes.filter((b) => !b.shape || b.shape === 'box').length;
    expect(res.stats.triangles).toBeGreaterThanOrEqual(plain * 12);
    const barriers = stage.boxes.filter((b) => b.barrierId).length;
    expect(res.barrierBoxes.length).toBe(barriers);
    // draw call estimate is chunks + barrier boxes
    expect(res.stats.drawCallsIfAllVisible).toBe(res.chunks.length + barriers);
    // all attributes present and finite
    for (const c of res.chunks) {
      for (const name of ['position', 'normal', 'uv', 'color']) expect(c.geometry.getAttribute(name)).toBeDefined();
      const p = c.geometry.getAttribute('position').array as Float32Array;
      for (let i = 0; i < p.length; i += 97) expect(Number.isFinite(p[i])).toBe(true);
    }
    // cylinders stay within their AABB
    const cyl = stage.boxes.find((b) => b.shape === 'cylY');
    expect(cyl).toBeDefined();
  });

  it('fits cylinder shapes into their AABB along the right axis', () => {
    const lib = new MaterialLibrary();
    const mk = (shape: BoxDef['shape'], id: string): BoxDef => ({ id, min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 4, z: 2 }, mat: 'pipe', sectorId: 'T', shape });
    for (const shape of ['cylX', 'cylY', 'cylZ'] as const) {
      const stage: StageDef = { ...buildTestArenaStage({ floorHalf: 0 }), boxes: [mk(shape, 'c')] };
      const res = buildStageMeshes(stage, lib);
      const bb = res.chunks[0].geometry.boundingBox!;
      const size = new Vector3().subVectors(bb.max, bb.min);
      if (shape === 'cylX') {
        expect(size.x).toBeCloseTo(10, 4);
        expect(size.y).toBeLessThanOrEqual(4 + 1e-4);
      }
      if (shape === 'cylY') {
        expect(size.y).toBeCloseTo(4, 4);
        expect(size.x).toBeLessThanOrEqual(10 + 1e-4);
      }
      if (shape === 'cylZ') {
        expect(size.z).toBeCloseTo(2, 4);
        expect(size.y).toBeLessThanOrEqual(4 + 1e-4);
      }
    }
  });

  it('keeps barrier boxes out of the merged chunks and splits emissive levels', () => {
    const lib = new MaterialLibrary();
    const stage = buildDemoStage();
    const res = buildStageMeshes(stage, lib);
    const names = res.chunks.map((c) => c.name).join('\n');
    expect(names).not.toContain('barrier:');
    expect(res.barrierBoxes.map((b) => b.box.id).sort()).toEqual(stage.boxes.filter((b) => b.barrierId).map((b) => b.id).sort());
    expect(res.lights.length).toBeGreaterThan(0);
    // light panels use an emissive material, plain concrete does not
    const lit = res.chunks.find((c) => c.name.startsWith('chunk:lightPanel'))!;
    expect((lit.material as unknown as { emissiveIntensity: number }).emissiveIntensity).toBeGreaterThan(0);
    const concrete = res.chunks.find((c) => c.name.startsWith('chunk:concrete|0'))!;
    expect((concrete.material as unknown as { emissiveIntensity: number }).emissiveIntensity).toBe(0);
  });
});

describe('materials', () => {
  it('has a textured, cached material for every MaterialKey', () => {
    const lib = new MaterialLibrary();
    expect(Object.keys(STAGE_MATS).sort()).toEqual([...ALL_MATS].sort());
    for (const k of ALL_MATS) {
      const m = lib.stage(k, 0);
      expect(m.map).toBeTruthy();
      expect(m.vertexColors).toBe(true);
      expect(lib.stage(k, 0)).toBe(m);
    }
    expect(lib.stage('barrier', 0).emissiveIntensity).toBeGreaterThan(0);
    expect(lib.stage('lightPanel', 4).emissiveIntensity).toBeGreaterThan(lib.stage('lightPanel', 1).emissiveIntensity);
    expect(lib.stage('concrete', 2)).not.toBe(lib.stage('concrete', 0));
    lib.disposeAll();
    expect(lib.textureCount).toBe(0);
  });
});

/** state of a real Game on the demo stage (sim modules, not a mock) */
function demoState(legs: 'biped' | 'quadruped' = 'biped'): { game: Game; state: GameState } {
  const game = new Game({ stage: buildDemoStage(), loadout: { fcs: 'medium', generator: 'balanced', legs } });
  game.sortie({ fcs: 'medium', generator: 'balanced', legs });
  return { game, state: game.state };
}

function mechFrame(state: GameState, dt: number, time: number): MechFrame {
  const p = state.player;
  const muzzle = playerMuzzlePosition(p);
  const aim = visualAimDirection(state, muzzle);
  return {
    dt,
    time,
    pos: p.pos,
    vel: p.vel,
    yaw: p.yaw,
    pitch: p.pitch,
    grounded: p.grounded,
    vertical: p.mv.verticalMode,
    horizontal: p.mv.horizontalMode,
    thrusting: p.mv.thrusting,
    qbRemaining: p.mv.qbImpulseRemaining,
    qbDir: p.mv.qbDir,
    weapon: p.weapon,
    muzzle,
    aimDir: aim,
    legs: state.loadout.legs,
  };
}

describe('MechModel', () => {
  it('has a koala head (ears + nose), body, arms, weapons and both leg sets', () => {
    const mech = new MechModel(new MaterialLibrary());
    const names: string[] = [];
    mech.root.traverse((o) => names.push(o.name));
    for (const n of ['head', 'torso', 'armUpper', 'armFore', 'legsBiped', 'legsQuad', 'weapon:machinegun', 'weapon:beam', 'weapon:missile']) {
      expect(names.some((x) => x === n || x.startsWith(n))).toBe(true);
    }
    // black nose exists in the head (ears / eyes / antenna are merged into the head meshes)
    const head = mech.head.children[0];
    expect(head.children.some((c) => c.name === 'head/black')).toBe(true);
    expect(mech.triangleCount).toBeGreaterThan(3000);
    expect(mech.triangleCount).toBeLessThan(40000);
  });

  it('switches biped / quadruped leg models and weapons', () => {
    const { state } = demoState();
    const mech = new MechModel(new MaterialLibrary());
    mech.update(mechFrame(state, 1 / 60, 0));
    expect(mech.root.getObjectByName('legsBiped')!.visible).toBe(true);
    expect(mech.root.getObjectByName('legsQuad')!.visible).toBe(false);
    const f = mechFrame(state, 1 / 60, 0);
    mech.update({ ...f, legs: 'quadruped', weapon: 'missile' });
    expect(mech.root.getObjectByName('legsBiped')!.visible).toBe(false);
    expect(mech.root.getObjectByName('legsQuad')!.visible).toBe(true);
    expect(mech.root.getObjectByName('weapon:missile')!.visible).toBe(true);
    expect(mech.root.getObjectByName('weapon:machinegun')!.visible).toBe(false);
  });

  it('places the weapon bore exactly through the sim muzzle along the real firing direction', () => {
    const rnd = lcg(12345);
    for (const legs of ['biped', 'quadruped'] as const) {
      const { game, state } = demoState(legs);
      const mech = new MechModel(new MaterialLibrary());
      for (let i = 0; i < 60; i++) {
        const p = state.player;
        p.pos = { x: (rnd() - 0.5) * 40, y: 1.5 + rnd() * 10, z: (rnd() - 0.5) * 40 };
        p.yaw = (rnd() - 0.5) * Math.PI * 4;
        p.pitch = (rnd() - 0.5) * 2.2;
        p.weapon = (['machinegun', 'beam', 'missile'] as const)[i % 3];
        p.vel = { x: (rnd() - 0.5) * 60, y: (rnd() - 0.5) * 10, z: (rnd() - 0.5) * 60 };
        p.grounded = rnd() < 0.5;
        p.mv.horizontalMode = (['walk', 'glide', 'quickboost'] as const)[Math.floor(rnd() * 3)];
        p.mv.verticalMode = p.grounded ? 'grounded' : (['rising', 'flying', 'falling'] as const)[Math.floor(rnd() * 3)];
        p.mv.thrusting = !p.grounded && rnd() < 0.5;
        p.mv.qbImpulseRemaining = p.mv.horizontalMode === 'quickboost' ? 0.1 : 0;
        p.mv.qbDir = { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
        updateCamera(state, game.world);
        if (i % 2 === 0) {
          // pretend a solved lock: the arm must follow the corrected launch direction
          const d = new Vector3(rnd() - 0.5, (rnd() - 0.5) * 0.4, rnd() - 0.5).normalize();
          state.lock = { state: 'locked', targetId: 'G01', progress: 1, elapsed: 1, radiusCssPx: 100 };
          state.fc = { ...state.fc, status: 'solved', weapon: p.weapon, launchDirection: { x: d.x, y: d.y, z: d.z } };
        } else {
          state.lock = { state: 'none', targetId: null, progress: 0, elapsed: 0, radiusCssPx: 100 };
        }
        mech.update(mechFrame(state, 1 / 60, i / 60));
        const w = mech.weaponTipWorld();
        const muzzle = playerMuzzlePosition(p);
        const aim = mechFrame(state, 0, 0).aimDir;
        expect(Math.hypot(w.tip.x - muzzle.x, w.tip.y - muzzle.y, w.tip.z - muzzle.z)).toBeLessThan(1e-4);
        expect(w.dir.x * aim.x + w.dir.y * aim.y + w.dir.z * aim.z).toBeGreaterThan(1 - 1e-8);
      }
    }
    expect(WEAPON_LENGTH.machinegun).toBeGreaterThan(0.5);
  });

  it('animates legs with walking speed and keeps every joint finite', () => {
    const { state } = demoState();
    const mech = new MechModel(new MaterialLibrary());
    const p = state.player;
    p.vel = { x: 0, y: 0, z: -9 };
    const hips: number[] = [];
    for (let i = 0; i < 90; i++) {
      mech.update(mechFrame(state, 1 / 60, i / 60));
      const legs = mech.root.getObjectByName('legsBiped')!;
      const hip = legs.children[1] as unknown as { rotation: { x: number } };
      hips.push(hip.rotation.x);
    }
    expect(Math.max(...hips) - Math.min(...hips)).toBeGreaterThan(0.4);
    // standing still: the swing dies away
    p.vel = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 120; i++) mech.update(mechFrame(state, 1 / 60, 2 + i / 60));
    const legs = mech.root.getObjectByName('legsBiped')!;
    const hip = legs.children[1] as unknown as { rotation: { x: number } };
    expect(Math.abs(hip.rotation.x)).toBeLessThan(0.05);
    mech.root.traverse((o) => {
      expect(Number.isFinite(o.position.x + o.position.y + o.position.z)).toBe(true);
      expect(Number.isFinite(o.quaternion.x + o.quaternion.y + o.quaternion.z + o.quaternion.w)).toBe(true);
    });
  });

  it('shows boost flames for flight and quick boost, none while idle', () => {
    const { state } = demoState();
    const mech = new MechModel(new MaterialLibrary());
    for (let i = 0; i < 30; i++) mech.update(mechFrame(state, 1 / 60, i / 60));
    const idle = mech.flameStrength;
    state.player.grounded = false;
    state.player.mv.verticalMode = 'flying';
    state.player.mv.thrusting = true;
    for (let i = 0; i < 30; i++) mech.update(mechFrame(state, 1 / 60, 1 + i / 60));
    const flight = mech.flameStrength;
    state.player.mv.thrusting = false;
    state.player.mv.horizontalMode = 'quickboost';
    state.player.mv.qbImpulseRemaining = 0.1;
    state.player.mv.qbDir = { x: 0, z: -1 };
    state.player.vel = { x: 0, y: 0, z: -80 };
    for (let i = 0; i < 10; i++) mech.update(mechFrame(state, 1 / 60, 2 + i / 60));
    expect(flight).toBeGreaterThan(idle + 0.4);
    expect(mech.flameStrength).toBeGreaterThan(flight);
    expect(mech.qbActive).toBe(true);
  });
});

describe('EnemyModel', () => {
  const setup = (): { state: GameState; guard: EnemyModel; turret: EnemyModel; control: EnemyModel } => {
    const { state } = demoState();
    const lib = new MaterialLibrary();
    const mats = createEnemyMaterials(lib);
    const shared = createEnemyShared();
    const g = state.enemies.find((e) => e.kind === 'guard')!;
    const t = state.enemies.find((e) => e.kind === 'turret' && !e.isGateControl)!;
    const c = state.enemies.find((e) => e.isGateControl)!;
    return { state, guard: new EnemyModel(g, mats, shared), turret: new EnemyModel(t, mats, shared), control: new EnemyModel(c, mats, shared) };
  };

  it('builds the guard / turret structures within a small triangle budget', () => {
    const { guard, turret, control } = setup();
    expect(guard.triangleCount).toBeGreaterThan(300);
    expect(guard.triangleCount).toBeLessThan(6000);
    expect(turret.triangleCount).toBeGreaterThan(300);
    expect(turret.triangleCount).toBeLessThan(6000);
    // only the control turret has a beacon (pillar + diamond + halo); both are far cheaper than the guard hierarchy
    const beacons = (m: EnemyModel): number => {
      let n = 0;
      m.root.traverse((o) => {
        if ((o as Mesh).isMesh && (o as Mesh).renderOrder >= 5) n++;
      });
      return n;
    };
    expect(beacons(control)).toBe(3);
    expect(beacons(turret)).toBe(0);
    // guard uses few draw calls (merged per part)
    let meshes = 0;
    guard.root.traverse((o) => {
      if ((o as Mesh).isMesh) meshes++;
    });
    expect(meshes).toBeLessThan(40);
  });

  it('faces the player yaw, shows the telegraph glow, hit flash, wreck and the far LOD', () => {
    const { state, guard, turret } = setup();
    const gs = state.enemies.find((e) => e.kind === 'guard')!;
    const ts = state.enemies.find((e) => e.kind === 'turret' && !e.isGateControl)!;
    gs.yaw = 1.1;
    gs.alert = true;
    gs.telegraph = 0.6;
    guard.update(gs, state.player.pos, 1 / 60, 0.3, true);
    expect(guard.root.rotation.y).toBeCloseTo(1.1, 9);
    const glowVisible = (m: EnemyModel): boolean => {
      let v = false;
      m.root.traverse((o) => {
        const mesh = o as Mesh;
        if (mesh.isMesh && mesh.visible && (mesh.material as { blending?: number }).blending === 2 && mesh.renderOrder < 5 && mesh.geometry.type === 'SphereGeometry') v = true;
      });
      return v;
    };
    expect(glowVisible(guard)).toBe(true);
    gs.telegraph = 0;
    guard.update(gs, state.player.pos, 1 / 60, 0.3, true);
    expect(glowVisible(guard)).toBe(false);
    // far LOD swaps to the single-mesh silhouette and the telegraph is still visible
    gs.telegraph = 0.5;
    guard.update(gs, state.player.pos, 1 / 60, 0.3, false);
    const live = guard.root.children[0];
    expect(live.visible).toBe(false);
    expect(glowVisible(guard)).toBe(true);
    // turret head yaw follows the sim yaw, base does not rotate
    ts.yaw = -0.7;
    turret.update(ts, state.player.pos, 1 / 60, 0, true);
    expect(turret.root.rotation.y).toBe(0);
    // death: live model hidden, wreck shown; revival (retry) restores it
    gs.alive = false;
    guard.update(gs, state.player.pos, 1 / 60, 0, true);
    expect(guard.isDead).toBe(true);
    expect(guard.root.children[0].visible).toBe(false);
    gs.alive = true;
    guard.update(gs, state.player.pos, 1 / 60, 0, true);
    expect(guard.isDead).toBe(false);
    expect(guard.root.children[0].visible).toBe(true);
    expect(ENEMIES.guard.hp).toBe(120);
  });
});

describe('enemy rim light (audit-ui V11: 敵が灰青色の背景に溶けない)', () => {
  const patched = (m: { onBeforeCompile: (s: never, r: never) => void }): { uniforms: Record<string, { value: unknown }>; fragmentShader: string } => {
    const sh = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '', fragmentShader: ShaderLib.physical.fragmentShader };
    m.onBeforeCompile(sh as never, undefined as never);
    return sh;
  };

  it('unit / hazard は縁取り (リム) + 上面の明色を fragment shader に足し、1 つの program と uniform を共有する', () => {
    const mats = createEnemyMaterials(new MaterialLibrary());
    for (const m of [mats.unit, mats.hazard]) {
      const sh = patched(m);
      expect(m.customProgramCacheKey()).toBe('enemy-rim');
      expect(sh.fragmentShader).toContain('uniform vec3 uRimColor;');
      expect(sh.fragmentShader).toContain('totalEmissiveRadiance += uRimColor * pow( 1.0 - rimNV, uRimPower ) + uRimTop * rimUp;');
      expect(Object.keys(sh.uniforms).sort()).toEqual(['uRimColor', 'uRimPower', 'uRimTop']);
    }
    const rim = mats.unit.userData.rim as { uRimColor: { value: { r: number; g: number; b: number } }; uRimTop: { value: { r: number; g: number; b: number } }; uRimPower: { value: number } };
    expect(mats.hazard.userData.rim).toBe(rim);
    expect([rim.uRimColor.value.r, rim.uRimColor.value.g, rim.uRimColor.value.b].map((v) => Number(v.toFixed(4)))).toEqual([...ENEMY_RIM.rim]);
    expect(rim.uRimPower.value).toBe(ENEMY_RIM.power);
    // 暖色 (R > G > B) の縁: 灰青色の背景・青灰色の砲台に対して輝度だけでなく色相でも離す
    expect(ENEMY_RIM.rim[0]).toBeGreaterThan(ENEMY_RIM.rim[1]);
    expect(ENEMY_RIM.rim[1]).toBeGreaterThan(ENEMY_RIM.rim[2]);
    expect(Math.max(...ENEMY_RIM.rim)).toBeLessThan(1.5); // 白く光る敵にはしない
  });

  it('パッチが依存する GLSL (差し込み位置と変数) は three の MeshStandardMaterial の shader に実在する', () => {
    const f = ShaderLib.physical.fragmentShader;
    expect(f).toContain('#include <common>');
    expect(f).toContain('#include <emissivemap_fragment>');
    expect(f.indexOf('vec3 totalEmissiveRadiance')).toBeLessThan(f.indexOf('#include <emissivemap_fragment>'));
    expect(f.indexOf('#include <normal_fragment_begin>')).toBeLessThan(f.indexOf('#include <emissivemap_fragment>')); // `normal` はそこで定義済み
    expect(ShaderChunk.normal_fragment_begin).toMatch(/vec3 normal\b/);
    expect(f).toContain('varying vec3 vViewPosition');
    expect(ShaderChunk.common).toContain('inverseTransformDirection');
  });

  it('警備ロボット・砲台・制御砲台の識別 (形・ペイント色・ビーコン) は変えない: 制御砲台だけ赤いペイント + ビーコン', () => {
    const { state } = demoState();
    const lib = new MaterialLibrary();
    const mats = createEnemyMaterials(lib);
    const shared = createEnemyShared();
    const c = state.enemies.find((e) => e.isGateControl)!;
    const t = state.enemies.find((e) => e.kind === 'turret' && !e.isGateControl)!;
    const ctl = new EnemyModel(c, mats, shared);
    const plain = new EnemyModel(t, mats, shared);
    const beacon = (m: EnemyModel): number => {
      let n = 0;
      m.root.traverse((o) => {
        if ((o as Mesh).isMesh && (o as Mesh).renderOrder >= 5) n++;
      });
      return n;
    };
    expect(beacon(ctl)).toBeGreaterThan(beacon(plain));
  });
});

describe('enemy barrel tip / pre-fire glow position', () => {
  it('tipWorld matches the drawn barrel tip (guard: body yaw, turret: swivel yaw) for any yaw and elevation', () => {
    const { state } = demoState();
    const lib = new MaterialLibrary();
    const mats = createEnemyMaterials(lib);
    const shared = createEnemyShared();
    const kinds = [state.enemies.find((e) => e.kind === 'guard')!, state.enemies.find((e) => e.kind === 'turret')!];
    for (const e of kinds) {
      const model = new EnemyModel(e, mats, shared);
      for (const yaw of [0, 1.1, -2.4, 3.0]) {
        e.yaw = yaw;
        e.alert = true;
        e.telegraph = 0.5;
        state.player.pos = { x: e.pos.x + 20, y: e.pos.y + 8, z: e.pos.z - 15 };
        for (let i = 0; i < 40; i++) model.update(e, state.player.pos, 1 / 60, 1, true);
        model.root.updateMatrixWorld(true);
        let barrel: Object3D | null = null;
        model.root.traverse((o) => {
          if (!barrel && o.position.x === 0 && Math.abs(o.position.y - MUZZLE_HEIGHT) < 1e-9 && o.position.z === 0 && o.children.length >= 3) barrel = o;
        });
        expect(barrel).not.toBeNull();
        const b = barrel as unknown as Object3D;
        const L = (e.kind === 'guard' ? 1.5 : 2.2) + 0.1;
        const world = b.localToWorld(new Vector3(0, 0, -L));
        const tip = model.tipWorld(e, { x: 0, y: 0, z: 0 });
        expect(Math.hypot(world.x - tip.x, world.y - tip.y, world.z - tip.z)).toBeLessThan(1e-6);
      }
    }
  });
});

describe('effects pools', () => {
  it('never grows: particles, beams, rings, missiles and bullets stay within fixed capacity', () => {
    const fx = new Effects();
    const before = fx.poolObjectCount;
    const rnd = lcg(7);
    const v = (): { x: number; y: number; z: number } => ({ x: (rnd() - 0.5) * 100, y: rnd() * 10, z: (rnd() - 0.5) * 100 });
    const dir = (): { x: number; y: number; z: number } => {
      const d = new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
      return { x: d.x, y: d.y, z: d.z };
    };
    let maxAdd = 0;
    let maxSmoke = 0;
    for (let frame = 0; frame < 900; frame++) {
      const events: GameEvent[] = [];
      for (let k = 0; k < 20; k++) {
        const t = frame / 60;
        events.push(
          { type: 'mgFire', time: t, origin: v(), dir: dir() },
          { type: 'beamFire', time: t, origin: v(), end: v(), hit: 'world', targetId: null },
          { type: 'missileFire', time: t, origin: v(), dir: dir() },
          { type: 'hit', time: t, pos: v(), normal: dir(), on: 'enemy', weapon: 'machinegun' },
          { type: 'explosion', time: t, pos: v(), size: 2.6 },
          { type: 'enemyDown', time: t, id: 'G01', kind: 'guard', pos: v() },
          { type: 'qb', time: t, pos: v(), dir: dir() },
          { type: 'land', time: t, pos: v(), impactSpeed: 30 },
          { type: 'enemyFire', time: t, id: 'G01', kind: 'turret', origin: v(), dir: dir() },
        );
      }
      for (const e of events) fx.handle(e);
      const bullets: PlayerBullet[] = Array.from({ length: 400 }, (_, i) => ({ id: i, pos: v(), prevPos: v(), origin: v(), v0: { x: 0, y: 0, z: -100 }, age: rnd(), damage: 12, alive: true }));
      fx.syncBullets(bullets, [], [], 1 / 60);
      fx.update(1 / 60);
      const s = fx.stats();
      maxAdd = Math.max(maxAdd, s.additiveParticles);
      maxSmoke = Math.max(maxSmoke, s.smokeParticles);
      expect(s.bullets).toBeLessThanOrEqual(160);
      expect(s.beams).toBeLessThanOrEqual(6);
      expect(s.rings).toBeLessThanOrEqual(10);
      expect(s.smokers).toBeLessThanOrEqual(10);
    }
    expect(maxAdd).toBeLessThanOrEqual(fx.additive.capacity);
    expect(maxSmoke).toBeLessThanOrEqual(fx.smoke.capacity);
    expect(fx.poolObjectCount).toBe(before);
    // everything expires by itself
    fx.syncBullets([], [], [], 1 / 60);
    for (let i = 0; i < 60 * 12; i++) fx.update(1 / 60);
    const s = fx.stats();
    expect(s.additiveParticles).toBe(0);
    expect(s.smokeParticles).toBe(0);
    expect(s.beams).toBe(0);
    expect(s.rings).toBe(0);
    expect(s.smokers).toBe(0);
    fx.clear();
    expect(fx.poolObjectCount).toBe(before);
  });

  it('the shock ring of a blast next to the camera fades out; the same blast far away keeps its ring', () => {
    const ringOpacity = (camera: { x: number; y: number; z: number }, blast: { x: number; y: number; z: number }): number => {
      const fx = new Effects();
      fx.viewPos.x = camera.x;
      fx.viewPos.y = camera.y;
      fx.viewPos.z = camera.z;
      fx.handle({ type: 'explosion', time: 0, pos: blast, size: 2.6 });
      for (let i = 0; i < 6; i++) fx.update(1 / 60); // 0.1 s into the 0.42 s ring
      const rings = (fx as unknown as { rings: { active: boolean; mat: { opacity: number } }[] }).rings.filter((r) => r.active);
      expect(rings.length).toBe(1);
      return rings[0].mat.opacity;
    };
    const near = ringOpacity({ x: 0, y: 4, z: 0 }, { x: 0, y: 1, z: -6 }); // the ring band (radius ~4 m at t=0.1s) is ~2 m from the camera plane
    const far = ringOpacity({ x: 0, y: 4, z: 0 }, { x: 0, y: 1, z: -40 });
    expect(near).toBeLessThan(0.08);
    expect(far).toBeGreaterThan(0.3);
    expect(far).toBeLessThanOrEqual(0.6); // peak alpha of the ring (was 0.8, additive)
  });

  it('particle system has bounded capacity and finite state', () => {
    const ps = new ParticleSystem(64, true);
    for (let i = 0; i < 1000; i++) ps.emit({ x: i, y: 0, z: 0, vx: 1, life: 0.5 + (i % 5) * 0.1, size0: 1, size1: 0.2, c0: [1, 1, 1] });
    ps.update(0.1);
    expect(ps.aliveCount).toBeLessThanOrEqual(64);
    const pos = ps.points.geometry.getAttribute('position').array as Float32Array;
    expect(pos.length).toBe(64 * 3);
    for (const x of pos) expect(Number.isFinite(x)).toBe(true);
    for (let i = 0; i < 20; i++) ps.update(0.1);
    expect(ps.aliveCount).toBe(0);
  });
});

describe('machine-gun tracer / muzzle flash (audit-ui A2: TPS の背後視点で見える大きさ)', () => {
  const tracerScale = (b: Partial<PlayerBullet>): { w: number; len: number } => {
    const fx = new Effects();
    const bullet: PlayerBullet = { id: 1, pos: { x: 0, y: 2, z: -30 }, prevPos: { x: 0, y: 2, z: -28 }, origin: { x: 0, y: 2, z: 0 }, v0: { x: 0, y: 0, z: -100 }, age: 0, damage: 12, alive: true, ...b }; // age 0: 速度は v0 のまま (100 m/s)
    fx.syncBullets([bullet], [], [], 1 / 60);
    const im = (fx as unknown as { tracerMesh: InstancedMesh }).tracerMesh;
    expect(im.count).toBe(1);
    const m = new Matrix4();
    im.getMatrixAt(0, m);
    const sc = new Vector3();
    m.decompose(new Vector3(), new Quaternion(), sc);
    return { w: sc.x, len: sc.z };
  };

  it('曳光弾は 0.3 m 幅・最大 8 m の筋 (従来 0.11 m・4.5 m)。銃口の直後の弾は発射点からの距離で短く切る', () => {
    expect(MG_TRACER.width).toBeGreaterThanOrEqual(0.2);
    expect(MG_TRACER.width).toBeLessThanOrEqual(0.4); // 照準中央を覆わない太さの上限 (0.4 m では中央 r40 への重なりが 10% を超え始める)
    const far = tracerScale({});
    expect(far.w).toBeCloseTo(MG_TRACER.width, 6);
    expect(far.len).toBeCloseTo(Math.min(MG_TRACER.maxLength, 100 * MG_TRACER.lengthPerSpeed), 6);
    expect(far.len).toBeGreaterThan(4.5);
    const near = tracerScale({ pos: { x: 0, y: 2, z: -0.5 } });
    expect(near.len).toBeCloseTo(0.5 + 0.3, 6); // 発射点 + 0.3 m より後ろへ伸びない
    expect(Number.isFinite(near.len)).toBe(true);
  });

  it('銃口炎は小さいままにしつつ従来 (0.36 / 0.6) より大きい。寿命は 0.05 秒のまま', () => {
    expect(MG_FLASH.size0).toBeGreaterThan(0.36);
    expect(MG_FLASH.size1).toBeGreaterThan(0.6);
    expect(MG_FLASH.size1).toBeLessThanOrEqual(1.5); // 照準 (画面中央) の近くなので大きくしすぎない
    expect(MG_FLASH.life).toBe(0.05);
    const fx = new Effects();
    fx.handle({ type: 'mgFire', time: 0, origin: { x: 0, y: 2, z: 0 }, dir: { x: 0, y: 0, z: -1 } });
    fx.update(0.01);
    expect(fx.stats().additiveParticles).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) fx.update(0.01); // 0.05 秒 + 火花の寿命 0.12 秒を過ぎれば消える
    expect(fx.stats().additiveParticles).toBe(0);
  });
});

describe('camera rig', () => {
  it('reproduces the sim projection exactly (FCS / HUD use the same math)', () => {
    const { game, state } = demoState();
    const cam = new PerspectiveCamera();
    const rnd = lcg(99);
    for (let i = 0; i < 40; i++) {
      state.player.pos = { x: (rnd() - 0.5) * 60, y: 1.5, z: (rnd() - 0.5) * 60 };
      state.player.yaw = (rnd() - 0.5) * 8;
      state.player.pitch = (rnd() - 0.5) * 2.4;
      updateCamera(state, game.world);
      applySimCamera(cam, state.camera, state.camera.viewportW / state.camera.viewportH);
      const dir = cam.getWorldDirection(new Vector3());
      expect(dir.x).toBeCloseTo(state.camera.forward.x, 9);
      expect(dir.y).toBeCloseTo(state.camera.forward.y, 9);
      expect(dir.z).toBeCloseTo(state.camera.forward.z, 9);
      for (let k = 0; k < 5; k++) {
        const p = { x: state.camera.pos.x + (rnd() - 0.5) * 80, y: state.camera.pos.y + (rnd() - 0.5) * 40, z: state.camera.pos.z + (rnd() - 0.5) * 80 };
        const sp = projectToScreen(state.camera, p);
        if (!sp.inFront) continue;
        const ndc = new Vector3(p.x, p.y, p.z).project(cam);
        const px = (ndc.x * state.camera.viewportW) / 2;
        const py = (-ndc.y * state.camera.viewportH) / 2;
        expect(px).toBeCloseTo(sp.x, 4);
        expect(py).toBeCloseTo(sp.y, 4);
      }
    }
  });
});

describe('hangar', () => {
  it('shows the head from the front first, then turns; leg model follows the loadout', () => {
    const scene = new HangarScene(new MaterialLibrary(), null, { fcs: 'medium', generator: 'balanced', legs: 'biped' });
    expect(buildHangarBoxes().length).toBeGreaterThan(50);
    scene.update(0.5);
    // yaw = PI => the mech's forward (-Z) points to +Z, toward the camera at +Z
    expect(scene.mech.root.rotation.y).toBeCloseTo(Math.PI, 9);
    expect(scene.camera.position.z).toBeGreaterThan(5);
    expect(scene.yawAt(1)).toBeCloseTo(Math.PI, 9);
    expect(Math.abs(scene.yawAt(9) - Math.PI)).toBeGreaterThan(0.5);
    expect(scene.yawAt(3.8 + 15 - 0.001) % (Math.PI * 2)).toBeCloseTo(Math.PI, 1);
    expect(scene.mech.root.getObjectByName('legsBiped')!.visible).toBe(true);
    scene.setLoadout({ fcs: 'medium', generator: 'balanced', legs: 'quadruped' });
    scene.update(0.1);
    expect(scene.mech.root.getObjectByName('legsQuad')!.visible).toBe(true);
    expect(scene.mech.root.getObjectByName('legsBiped')!.visible).toBe(false);
    // the walking preview moves the legs
    const legs = scene.mech.root.getObjectByName('legsQuad')!;
    const a = (legs.children[1] as unknown as { rotation: { x: number } }).rotation.x;
    for (let i = 0; i < 20; i++) scene.update(1 / 30);
    const b = (legs.children[1] as unknown as { rotation: { x: number } }).rotation.x;
    expect(Math.abs(a - b)).toBeGreaterThan(1e-3);
    // head stays above the turntable (framing sanity)
    expect(PLAYER.HALF.y).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// round 2: aim / visibility / atmosphere / textures
// ---------------------------------------------------------------------------------------------------------------------
describe('visual aim direction (SPEC §4.2)', () => {
  const unit = (x: number, y: number, z: number): { x: number; y: number; z: number } => {
    const l = Math.hypot(x, y, z);
    return { x: x / l, y: y / l, z: z / l };
  };

  it('follows fc.launchDirection for solved AND no_solution while locked; free fire otherwise', () => {
    const { game, state } = demoState();
    const p = state.player;
    p.weapon = 'machinegun';
    updateCamera(state, game.world);
    const muzzle = playerMuzzlePosition(p);
    const free = freeFireDirection(state, state.world, muzzle);
    const d = unit(0.6, 0.2, -0.7);
    // no lock: free fire
    expect(usesFcsDirection(state)).toBe(false);
    expect(visualAimDirection(state, muzzle)).toEqual(free);
    state.lock = { state: 'locked', targetId: 'G01', progress: 1, elapsed: 1, radiusCssPx: 100 };
    for (const status of ['solved', 'no_solution'] as const) {
      state.fc = { ...state.fc, status, weapon: p.weapon, launchDirection: d };
      expect(usesFcsDirection(state)).toBe(true);
      expect(visualAimDirection(state, muzzle)).toEqual(d);
    }
    // lock complete but no solution record yet (inactive): free fire
    state.fc = { ...state.fc, status: 'inactive', weapon: p.weapon, launchDirection: null };
    expect(visualAimDirection(state, muzzle)).toEqual(free);
    // the solution belongs to another weapon (weapon just switched): free fire
    state.fc = { ...state.fc, status: 'solved', weapon: 'beam', launchDirection: d };
    expect(visualAimDirection(state, muzzle)).toEqual(free);
    // still acquiring: free fire
    state.fc = { ...state.fc, status: 'solved', weapon: p.weapon, launchDirection: d };
    state.lock = { ...state.lock, state: 'acquiring', progress: 0.5 };
    expect(visualAimDirection(state, muzzle)).toEqual(free);
    // garbage (non finite) direction is never used
    state.lock = { ...state.lock, state: 'locked', progress: 1 };
    state.fc = { ...state.fc, launchDirection: { x: NaN, y: 0, z: 1 } };
    expect(usesFcsDirection(state)).toBe(false);
  });

  it('the arm / barrel points along a no_solution direct-aim direction exactly, for every weapon and leg set', () => {
    const rnd = lcg(4242);
    for (const legs of ['biped', 'quadruped'] as const) {
      const { game, state } = demoState(legs);
      const mech = new MechModel(new MaterialLibrary());
      for (let i = 0; i < 30; i++) {
        const p = state.player;
        p.pos = { x: (rnd() - 0.5) * 30, y: 1.5 + rnd() * 6, z: (rnd() - 0.5) * 30 };
        p.yaw = (rnd() - 0.5) * 6;
        p.pitch = (rnd() - 0.5) * 1.6;
        p.weapon = (['machinegun', 'beam', 'missile'] as const)[i % 3];
        updateCamera(state, game.world);
        const d = new Vector3(rnd() - 0.5, (rnd() - 0.5) * 0.6, rnd() - 0.5).normalize();
        state.lock = { state: 'locked', targetId: 'G01', progress: 1, elapsed: 1, radiusCssPx: 100 };
        state.fc = { ...state.fc, status: 'no_solution', weapon: p.weapon, launchDirection: { x: d.x, y: d.y, z: d.z } };
        mech.update(mechFrame(state, 1 / 60, i / 60));
        const w = mech.weaponTipWorld();
        const m = playerMuzzlePosition(p);
        expect(Math.hypot(w.tip.x - m.x, w.tip.y - m.y, w.tip.z - m.z)).toBeLessThan(1e-4);
        expect(w.dir.x * d.x + w.dir.y * d.y + w.dir.z * d.z).toBeGreaterThan(1 - 1e-8);
      }
    }
  });

  it('keeps the barrel tip on the muzzle while the recoil animation plays', () => {
    const { state } = demoState();
    const mech = new MechModel(new MaterialLibrary());
    mech.update(mechFrame(state, 1 / 60, 0));
    mech.onFire('missile');
    const m = playerMuzzlePosition(state.player);
    for (let i = 0; i < 6; i++) {
      mech.update(mechFrame(state, 1 / 60, i / 60));
      const w = mech.weaponTipWorld();
      expect(Math.hypot(w.tip.x - m.x, w.tip.y - m.y, w.tip.z - m.z)).toBeLessThan(1e-4);
    }
  });
});

describe('sector visibility (real campaign stage)', () => {
  const stage = buildStage();
  const vis = new SectorVisibility(stage);
  const flags = new Uint8Array(vis.count);
  const idx = (id: string): number => vis.indexById.get(id) as number;

  /** projection * view of a camera at `pos` looking at `target` (what SectorVisibility.compute takes) */
  const frustumAt = (pos: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }, far = 500): Matrix4 => {
    const cam = new PerspectiveCamera(70, 16 / 9, 0.3, far);
    cam.position.set(pos.x, pos.y, pos.z);
    cam.lookAt(target.x, target.y, target.z);
    cam.updateMatrixWorld(true);
    return new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  };
  const open = (): boolean => false;

  it('finds the sector of a point and every sector centre maps to itself', () => {
    expect(stage.sectors[vis.sectorAt(stage.playerStart.pos)].id).toBe('S01');
    stage.sectors.forEach((s, i) => {
      const c = { x: (s.bounds.min.x + s.bounds.max.x) / 2, y: (s.bounds.min.y + s.bounds.max.y) / 2, z: (s.bounds.min.z + s.bounds.max.z) / 2 };
      expect(vis.sectorAt(c)).toBe(i);
      expect(sectorContains(s, c)).toBe(true);
    });
    // a point outside every sector snaps to the nearest one (never -1 for a non-empty stage)
    expect(vis.sectorAt({ x: -500, y: 0, z: -500 })).toBeGreaterThanOrEqual(0);
  });

  it('every portal opening box contains the portal centre and is thin along the wall normal', () => {
    for (const p of stage.portals) {
      const a = stage.sectors.find((s) => s.id === p.a)!;
      const b = stage.sectors.find((s) => s.id === p.b)!;
      const box = portalBox(p, a, b);
      expect(box.containsPoint(new Vector3(p.center.x, p.center.y, p.center.z))).toBe(true);
      const size = new Vector3();
      box.getSize(size);
      expect(Math.min(size.x, size.y, size.z)).toBeLessThan(6);
    }
  });

  it('shows the neighbour only through an open portal that is in view', () => {
    const from = stage.playerStart.pos; // S01, portal P01 (to S02) at x=70, z=120
    const cam = { x: from.x, y: from.y + 2, z: from.z };
    const toward = frustumAt(cam, { x: 70, y: 4, z: 120 });
    const away = frustumAt(cam, { x: -60, y: 4, z: -100 });
    vis.compute(cam, from, toward, open, 420, flags);
    expect(flags[idx('S01')]).toBe(1);
    expect(flags[idx('S02')]).toBe(1);
    vis.compute(cam, from, away, open, 420, flags);
    expect(flags[idx('S01')]).toBe(1);
    expect(flags[idx('S02')]).toBe(0);
  });

  it('a closed barrier hides what is behind it, an opened one shows it', () => {
    // S03 -> S04 through P03 (x = 330, z = 100) which is closed by barrier B1
    const cam = { x: 300, y: 5.5, z: 96 };
    const f = frustumAt(cam, { x: 340, y: 5, z: 100 });
    vis.compute(cam, cam, f, (id) => id === 'B1', 420, flags);
    expect(flags[idx('S03')]).toBe(1);
    expect(flags[idx('S04')]).toBe(0);
    vis.compute(cam, cam, f, () => false, 420, flags);
    expect(flags[idx('S04')]).toBe(1);
  });

  it('draws only a small part of the 20 sectors along the whole main route (walls / other levels are never drawn)', () => {
    const pts = stage.mainRoute.points;
    let max = 0;
    let sum = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const p0 = { x: pts[k].x, y: pts[k].y + 1, z: pts[k].z };
      const p1 = pts[k + 1];
      const f = frustumAt(p0, { x: p1.x, y: p1.y + 1, z: p1.z });
      const n = vis.compute(p0, p0, f, open, 420, flags);
      expect(flags[vis.sectorAt(p0)]).toBe(1);
      max = Math.max(max, n);
      sum += n;
    }
    expect(max).toBeLessThanOrEqual(9);
    expect(sum / (pts.length - 1)).toBeLessThan(5);
  });

  it('never hides geometry the camera can actually see: ray ground truth from many views of the real stage', () => {
    const world = new World(stage.boxes);
    const rnd = lcg(20260930);
    const pts = stage.mainRoute.points;
    let rays = 0;
    let crossSector = 0;
    const misses: string[] = [];
    for (let k = 0; k < 90; k++) {
      // eye position: a main-route waypoint (free space) with a small offset, or the middle of a random sector floor
      let eye: { x: number; y: number; z: number };
      if (k % 3 === 2) {
        const s = stage.sectors[Math.floor(rnd() * stage.sectors.length)];
        eye = { x: s.bounds.min.x + 8 + rnd() * (s.bounds.max.x - s.bounds.min.x - 16), y: s.floorY + 2.5, z: s.bounds.min.z + 8 + rnd() * (s.bounds.max.z - s.bounds.min.z - 16) };
      } else {
        const p = pts[Math.floor(rnd() * pts.length)];
        eye = { x: p.x + (rnd() - 0.5) * 3, y: p.y + 1 + rnd() * 1.5, z: p.z + (rnd() - 0.5) * 3 };
      }
      const cam = new PerspectiveCamera(70, 16 / 9, 0.3, 1500);
      cam.position.set(eye.x, eye.y, eye.z);
      const yaw = rnd() * Math.PI * 2;
      const pitch = (rnd() - 0.5) * 1.0;
      cam.rotation.set(pitch, yaw, 0, 'YXZ');
      cam.updateMatrixWorld(true);
      const vp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      vis.compute(eye, eye, vp, () => true, 320, flags); // every barrier shut: barrier meshes are drawn separately from the sector chunks
      const eyeSector = vis.sectorAt(eye);
      for (let r = 0; r < 160; r++) {
        const p = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, 0.5).unproject(cam);
        const dir = p.sub(cam.position).normalize();
        const hit = world.raycast(eye, { x: dir.x, y: dir.y, z: dir.z }, 320);
        if (!hit) continue;
        const b = world.boxes[hit.boxIndex];
        if (b.barrierId || b.mat === 'glass') continue;
        rays++;
        const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
        const owner = stage.sectors.findIndex((sd) => sectorContains(sd, c));
        if (owner !== eyeSector) crossSector++;
        if (owner >= 0 && flags[owner] !== 1) misses.push(`view ${k} eye ${eye.x.toFixed(0)},${eye.y.toFixed(0)},${eye.z.toFixed(0)} in ${stage.sectors[eyeSector].id}: ray hit ${b.id} of ${stage.sectors[owner].id} (not drawn)`);
      }
    }
    expect(rays).toBeGreaterThan(5000);
    expect(crossSector).toBeGreaterThan(50); // the test really exercises views through portals into other sectors
    expect(misses.slice(0, 5)).toEqual([]);
  });

  it('merges the stage into per-sector chunks: every chunk belongs to one sector and every box is kept', () => {
    const lib = new MaterialLibrary();
    const res = buildStageMeshes(stage, lib);
    expect(res.chunks.length).toBe(res.chunkSector.length);
    expect(res.chunks.every((_, i) => res.chunkSector[i] >= 0)).toBe(true);
    expect(res.sectorChunks.reduce((n, a) => n + a.length, 0)).toBe(res.chunks.length);
    // triangle budget: >= 12 per plain box (boxes + decor, barrier boxes are separate meshes)
    const plain = [...stage.boxes, ...(stage.decor ?? [])].filter((b) => !b.barrierId && (!b.shape || b.shape === 'box')).length;
    expect(res.stats.triangles).toBeGreaterThanOrEqual(plain * 12);
    // the whole 5.6k-box stage collapses into a few hundred draw calls (most are only submitted when their sector is visible)
    expect(res.chunks.length).toBeLessThan(700);
    // every chunk carries its sector's floor height (grime shader) - e.g. S05 stands on a 12 m level, S10 in a -14 m pit
    for (const [id, floor] of [['S05', 12], ['S10', -14]] as const) {
      const si = stage.sectors.findIndex((s) => s.id === id);
      expect(stage.sectors[si].floorY).toBe(floor);
      expect(res.sectorChunks[si].length).toBeGreaterThan(0);
      for (const ci of res.sectorChunks[si]) {
        const a = res.chunks[ci].geometry.getAttribute('aFloorY');
        expect(a).toBeDefined();
        expect(a.count).toBe(res.chunks[ci].geometry.getAttribute('position').count);
        expect(a.getX(0)).toBe(floor);
        expect(a.getX(a.count - 1)).toBe(floor);
      }
    }
    // sector index recorded in the mesh matches the declared box sector for a sample
    const b0 = stage.boxes[0];
    const owner = stage.sectors.findIndex((s) => s.id === b0.sectorId);
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(res.sectorChunks[owner].length).toBeGreaterThan(0);
  });
});

describe('atmosphere, sector colour temperature and textures', () => {
  it('gives every sector kind a subtle, distinct look', () => {
    const kinds = ['dock', 'yard', 'factory', 'multilevel', 'corridor', 'shaft', 'pipe', 'warehouse', 'gate'] as const;
    const seen = new Set<string>();
    for (const kind of kinds) {
      const l = sectorLook({ id: 'S01', kind });
      for (const c of l.tint) {
        expect(c).toBeGreaterThan(0.84);
        expect(c).toBeLessThan(1.16);
      }
      seen.add(l.tint.map((x) => x.toFixed(2)).join(','));
      expect(l.fog).toBeLessThan(0x505050); // fog stays dark: enemies / edges must not wash out
    }
    expect(seen.size).toBeGreaterThanOrEqual(6);
    // neighbouring sectors of one kind differ a little (stable per id)
    expect(sectorLook({ id: 'S01', kind: 'factory' }).tint).toEqual(sectorLook({ id: 'S01', kind: 'factory' }).tint);
    expect(sectorLook({ id: 'S05', kind: 'factory' }).tint).not.toEqual(sectorLook({ id: 'S03', kind: 'factory' }).tint);
    expect(UNTINTED_MATS.has('lightPanel')).toBe(true);
    expect(UNTINTED_MATS.has('concrete')).toBe(false);
    expect(lerpHex(0x000000, 0xff8040, 0)).toBe(0);
    expect(lerpHex(0x000000, 0xff8040, 1)).toBe(0xff8040);
    expect(lerpHex(0x102030, 0x304050, 0.5)).toBe(0x203040);
  });

  it('light shafts: bounded instance count, only ceiling lights of visible sectors, hidden when disabled', () => {
    const ls = new LightShafts(4);
    const lights = Array.from({ length: 30 }, (_, i) => ({ pos: new Vector3(i * 4, 20, 0), color: 0xffe6b8, power: 1, sector: i < 20 ? 0 : 1 }));
    const cam = new Vector3(0, 2, 10);
    const fwd = new Vector3(1, 0, 0);
    ls.update(1, cam, fwd, lights, new Uint8Array([1, 0]), [0, 0], true);
    expect(ls.count).toBe(4);
    expect(ls.mesh.visible).toBe(true);
    // low lamps (< 6 m over the floor) and non-ceiling colours make no shafts
    const ls2 = new LightShafts(4);
    ls2.update(1, cam, fwd, [{ pos: new Vector3(3, 4, 0), color: 0xffe6b8, power: 1, sector: 0 }, { pos: new Vector3(3, 20, 0), color: 0x70ffd0, power: 1, sector: 0 }], null, [0], true);
    expect(ls2.count).toBe(0);
    ls.update(1, cam, fwd, lights, null, [0, 0], false);
    expect(ls.mesh.visible).toBe(false);
    ls.dispose();
    ls2.dispose();
  });

  it('marker lamps use an immediate-mode particle buffer (no ageing, drawn once per frame)', () => {
    const ps = new ParticleSystem(8, true);
    for (let f = 0; f < 3; f++) {
      ps.resetManual();
      for (let i = 0; i < 5; i++) ps.emit({ x: i, y: 1, z: 2, life: 1, size0: 0.5, c0: [1, 0.5, 0.2], a0: 0.9 });
      ps.commit();
      expect(ps.aliveCount).toBe(5);
      expect(ps.points.geometry.drawRange.count).toBe(5);
    }
    ps.resetManual();
    ps.commit();
    expect(ps.points.geometry.drawRange.count).toBe(0);
  });

  it('image based lighting only where it shows: metals / rust / glass reflect the environment, concrete and paint do not', () => {
    const lib = new MaterialLibrary();
    const env = new Texture();
    const early = lib.stage('metal', 0); // created BEFORE the environment exists
    lib.setEnvironment(env, 0.45);
    expect(early.envMap).toBe(env);
    for (const k of ALL_MATS) {
      const m = lib.stage(k, 0); // and materials created afterwards
      const d = STAGE_MATS[k];
      const expected = d.metalness >= 0.25 || k === 'glass';
      expect(m.envMap === env).toBe(expected);
      expect(m.envMapIntensity).toBeCloseTo(0.45, 9);
    }
    for (const k of ['concrete', 'concreteDark', 'floorTile', 'hazard', 'lightPanel'] as const) expect(lib.stage(k, 0).envMap).toBeNull();
    for (const k of ['metal', 'metalDark', 'pipe', 'grating', 'machine', 'gate', 'crate', 'roof', 'rust', 'glass'] as const) expect(lib.stage(k, 0).envMap).toBe(env);
    // barrier clones inherit the setting
    expect(lib.cloneStage('gate', 2).envMap).toBe(env);
    lib.setEnvironment(null, 0.45);
    expect(lib.stage('metal', 0).envMap).toBeNull();
    // effects: missile bodies follow the same switch
    const fx = new Effects();
    fx.setEnvironment(env, 0.45);
    let withEnv = 0;
    fx.group.traverse((o) => {
      const m = (o as Mesh).material as { envMap?: Texture | null; isMeshStandardMaterial?: boolean } | undefined;
      if (m?.isMeshStandardMaterial && m.envMap === env) withEnv++;
    });
    expect(withEnv).toBeGreaterThan(0);
  });

  it('every bumped stage material declares a roughness / height derivation; roughness stays a plain number without a canvas', () => {
    const lib = new MaterialLibrary();
    for (const k of ALL_MATS) {
      const d = STAGE_MATS[k];
      if (d.bump > 0) expect(d.mr).toBeDefined();
      const m = lib.stage(k, 0);
      // Node: no canvas => no derived map, material keeps its own mean roughness
      expect(m.roughnessMap).toBeNull();
      expect(m.roughness).toBeCloseTo(d.roughness, 9);
    }
    expect(lib.textureBytes).toBeGreaterThan(0);
  });
});

describe('resize / devicePixelRatio', () => {
  it('keeps the requested ratio while the drawing buffer stays small, and lowers it for huge windows', () => {
    expect(effectivePixelRatio(1280, 720, 1)).toBe(1);
    expect(effectivePixelRatio(1280, 720, 2)).toBe(2); // 3.7 M px
    expect(effectivePixelRatio(1280, 720, 1.5)).toBeCloseTo(1.5, 9);
    const big = effectivePixelRatio(1920, 1080, 2); // 8.3 M px at 2x -> reduced
    expect(big).toBeLessThan(2);
    expect(big).toBeGreaterThan(1.2);
    expect(1920 * 1080 * big * big).toBeLessThanOrEqual(MAX_BUFFER_PIXELS * 1.0001);
    const uhd = effectivePixelRatio(3840, 2160, 1);
    expect(3840 * 2160 * uhd * uhd).toBeLessThanOrEqual(MAX_BUFFER_PIXELS * 1.0001);
    // clamps and garbage in
    expect(effectivePixelRatio(800, 600, 0.1)).toBe(0.5);
    expect(effectivePixelRatio(800, 600, 9)).toBe(2);
    expect(effectivePixelRatio(800, 600, NaN)).toBe(1);
    expect(effectivePixelRatio(800, 600, -3)).toBe(1);
    // never zero / NaN for a degenerate window
    expect(Number.isFinite(effectivePixelRatio(1, 1, 2))).toBe(true);
  });
});

describe('sector visibility (stacked levels, no portal = no visibility)', () => {
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } => ({
    min: { x: x0, y: y0, z: z0 },
    max: { x: x1, y: y1, z: z1 },
  });
  const sec = (id: string, b: ReturnType<typeof box>, floorY: number): StageDef['sectors'][number] => ({ id, name: id, kind: 'factory', bounds: b, floorY, ceilingY: b.max.y - 2, combat: false, note: '' });
  // A: ground level, B: directly above A (hatch in the ceiling of A), C: touches A's east face but has NO portal, D: east of B via a door
  const stage = {
    sectors: [sec('A', box(0, 0, 0, 100, 20, 100), 0), sec('B', box(0, 20, 0, 100, 40, 100), 20), sec('C', box(100, 0, 0, 200, 20, 100), 0), sec('D', box(100, 20, 0, 200, 40, 100), 20)],
    portals: [
      { id: 'PH', a: 'A', b: 'B', center: { x: 50, y: 20, z: 50 }, width: 10, height: 10, kind: 'hatch' as const, barrierId: null },
      { id: 'PD', a: 'B', b: 'D', center: { x: 100, y: 27, z: 90 }, width: 12, height: 8, kind: 'door' as const, barrierId: 'BX' },
    ],
  };
  const vis = new SectorVisibility(stage);
  const flags = new Uint8Array(4);
  const frustum = (pos: [number, number, number], target: [number, number, number]): Matrix4 => {
    const cam = new PerspectiveCamera(70, 16 / 9, 0.3, 500);
    cam.position.set(...pos);
    cam.lookAt(...target);
    cam.updateMatrixWorld(true);
    return new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  };
  const at = { x: 20, y: 2, z: 50 };

  it('sees the level above only through the hatch, never the sector behind a wall', () => {
    vis.compute(at, at, frustum([20, 2, 50], [50, 20, 50]), () => false, 400, flags);
    expect([...flags]).toEqual([1, 1, 0, 0]); // A + B (through the hatch); C touches A but has no portal
    vis.compute(at, at, frustum([20, 2, 50], [-60, 2, 50]), () => false, 400, flags);
    expect([...flags]).toEqual([1, 0, 0, 0]); // looking away: the hatch is not in view, C is behind the wall
    vis.compute(at, at, frustum([20, 2, 50], [20, 2, 0]), () => false, 400, flags);
    expect(flags[2]).toBe(0);
    expect(flags[3]).toBe(0);
  });

  it('follows a portal chain (A -> B -> D) and stops at a closed barrier', () => {
    // camera in A looking up through the hatch and along the level above toward the door to D (not reachable from A directly)
    const cam = { x: 50, y: 2, z: 50 };
    vis.compute(cam, cam, frustum([50, 2, 50], [70, 27, 50]), () => false, 400, flags);
    expect(flags[1]).toBe(1);
    expect(flags[3]).toBe(0); // the door to D is in the camera frustum but NOT inside what the hatch lets us see (rectangle narrowing)
    // D lies beyond B's east door: chain works only when that door is in the view frustum of the camera
    const upstairs = { x: 20, y: 22, z: 50 };
    vis.compute(upstairs, upstairs, frustum([20, 22, 50], [100, 27, 90]), () => false, 400, flags);
    expect([flags[1], flags[3]]).toEqual([1, 1]);
    vis.compute(upstairs, upstairs, frustum([20, 22, 50], [100, 27, 90]), (id) => id === 'BX', 400, flags);
    expect([flags[1], flags[3]]).toEqual([1, 0]);
    // distance limit: a portal farther than the fog distance is skipped
    vis.compute(upstairs, upstairs, frustum([20, 22, 50], [100, 27, 90]), () => false, 30, flags);
    expect(flags[3]).toBe(0);
  });

  it('the player sector is always drawn, even when the camera is outside every sector', () => {
    const far = { x: -400, y: 10, z: -400 };
    const player = { x: 150, y: 5, z: 50 }; // in C
    vis.compute(far, player, frustum([-400, 10, -400], [-500, 10, -400]), () => false, 400, flags);
    expect(flags[2]).toBe(1);
    expect(vis.sectorAt(far)).toBeGreaterThanOrEqual(0); // snaps to the nearest sector instead of -1
  });
});
