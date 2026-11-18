/**
 * 描画モジュール（Three.js オブジェクトグラフ）のヘッドレス試験。
 * WebGLRenderer を使わないため vitest の node 環境で動く。
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ENEMIES, PLAYER } from '../src/params';
import { directionFromYawPitch } from '../src/sim/vec';
import { EFFECT_CAPACITY, EffectsSystem, BEAM_SECONDS, EXPLOSION_MAX_RADIUS, EXPLOSION_SECONDS } from '../src/render/effects';
import { EnemySharedMaterials, TELEGRAPH_BLINK_PERIOD, createEnemyModel } from '../src/render/enemyModels';
import { MaterialLibrary } from '../src/render/materials';
import { createPlayerMech, type MechUpdate } from '../src/render/mech';
import { BARRIER_OPEN_SECONDS, DOOR_OPENING_OPACITY, LAMP_LIGHT_BUDGET, MAX_POINT_LIGHTS, StageMeshes } from '../src/render/stageMeshes';
import type { DecorDef, EnemyView, LightDef, ProjectileView, SimEvent, SolidDef, StageData, Vec3 } from '../src/types';
import { box, makeFlatStage } from './helpers/testStage';

/** 可視メッシュだけの境界（非表示の武器先端などは除く） */
function bounds(obj: THREE.Object3D): THREE.Box3 {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3();
  const tmp = new THREE.Box3();
  obj.traverse((o) => {
    if (!o.visible) return;
    let p: THREE.Object3D | null = o;
    while (p) {
      if (!p.visible) return;
      p = p.parent;
    }
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    tmp.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    b.union(tmp);
  });
  return b;
}

function countMeshes(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n++;
  });
  return n;
}

function baseUpdate(over: Partial<MechUpdate> = {}): MechUpdate {
  return {
    aimDirection: [0, 0, -1],
    yaw: 0,
    walkPhase: 0,
    speed: 0,
    boosting: false,
    thrusting: false,
    grounded: true,
    weapon: 'machinegun',
    gliding: false,
    alive: true,
    ...over,
  };
}

function legRotations(root: THREE.Object3D): number[] {
  const out: number[] = [];
  root.traverse((o) => {
    if ((o as THREE.Group).isGroup && o !== root) out.push(o.rotation.x, o.rotation.y, o.rotation.z);
  });
  return out;
}

function angleBetween(a: THREE.Vector3, b: Vec3): number {
  const bv = new THREE.Vector3(b[0], b[1], b[2]).normalize();
  return Math.acos(Math.max(-1, Math.min(1, a.dot(bv))));
}

describe('mech.ts: コアラ頭の機体', () => {
  it('2脚モデルの寸法は全高≈3.0m・全幅≈1.6m', () => {
    const m = createPlayerMech('biped');
    m.update(baseUpdate());
    const b = bounds(m.root);
    const size = b.getSize(new THREE.Vector3());
    expect(size.y).toBeGreaterThan(2.8);
    expect(size.y).toBeLessThan(3.25);
    // 胴体＋肩 ≈ 1.6m、腕・銃を含めた可視全幅は 2.1m 未満
    expect(size.x).toBeGreaterThan(1.4);
    expect(size.x).toBeLessThan(2.1);
    expect(b.min.y).toBeGreaterThan(-0.05);
    expect(b.min.y).toBeLessThan(0.05);
    // 銃口 x（0.95）は右側の外縁付近
    expect(b.max.x).toBeGreaterThan(PLAYER.muzzleOffset[0]);
    m.dispose();
  });

  it('4脚モデルは脚のメッシュが増え、寸法は同程度', () => {
    const b2 = createPlayerMech('biped');
    const b4 = createPlayerMech('quadruped');
    b2.update(baseUpdate());
    b4.update(baseUpdate());
    expect(countMeshes(b4.root)).toBeGreaterThan(countMeshes(b2.root));
    const size = bounds(b4.root).getSize(new THREE.Vector3());
    expect(size.y).toBeGreaterThan(2.8);
    expect(size.y).toBeLessThan(3.25);
    expect(size.x).toBeLessThan(2.1);
    expect(b4.legs).toBe('quadruped');
    b2.dispose();
    b4.dispose();
  });

  it('砲身の向きが aimDirection と一致する（ヨー・ピッチ各種）', () => {
    const m = createPlayerMech('biped');
    const dir = new THREE.Vector3();
    const cases: { yaw: number; aim: Vec3 }[] = [];
    for (const yaw of [0, 0.7, -2.1, Math.PI]) {
      for (const dy of [-0.5, 0, 0.6]) {
        for (const dyaw of [-0.6, 0, 0.5]) {
          cases.push({ yaw, aim: directionFromYawPitch(yaw + dyaw, dy) });
        }
      }
    }
    for (const c of cases) {
      m.update(baseUpdate({ yaw: c.yaw, aimDirection: c.aim }));
      m.getBarrelWorldDirection(dir);
      expect(angleBetween(dir, c.aim)).toBeLessThan(1e-3);
    }
    m.dispose();
  });

  it('正面照準時の砲口は PLAYER.muzzleOffset の x,y 付近で機体前方にある', () => {
    const m = createPlayerMech('biped');
    m.update(baseUpdate());
    const p = m.getMuzzleWorldPosition(new THREE.Vector3());
    expect(Math.abs(p.x - PLAYER.muzzleOffset[0])).toBeLessThan(0.15);
    expect(Math.abs(p.y - PLAYER.muzzleOffset[1])).toBeLessThan(0.15);
    // 前方 −Z（機体の中心より前）
    expect(p.z).toBeLessThan(-0.5);
    // yaw を回すと銃口も回る
    m.update(baseUpdate({ yaw: Math.PI / 2, aimDirection: directionFromYawPitch(Math.PI / 2, 0) }));
    const q = m.getMuzzleWorldPosition(new THREE.Vector3());
    expect(q.x).toBeLessThan(-0.5);
    m.dispose();
  });

  it('武器切り替えで見える先端が入れ替わる', () => {
    const m = createPlayerMech('biped');
    const tip = (w: string) => m.root.getObjectByName('tip:' + w)!;
    m.update(baseUpdate({ weapon: 'machinegun' }));
    expect(tip('machinegun').visible).toBe(true);
    expect(tip('beam').visible).toBe(false);
    expect(tip('missile').visible).toBe(false);
    m.update(baseUpdate({ weapon: 'missile' }));
    expect(tip('machinegun').visible).toBe(false);
    expect(tip('missile').visible).toBe(true);
    m.update(baseUpdate({ weapon: 'beam' }));
    expect(tip('beam').visible).toBe(true);
    m.dispose();
  });

  it('歩行: 接地かつ速度>0.5 で脚が動き、静止・空中では歩行姿勢にならない', () => {
    for (const legs of ['biped', 'quadruped'] as const) {
      const m = createPlayerMech(legs);
      m.update(baseUpdate({ speed: 0, walkPhase: 1.0 }));
      const idle = legRotations(m.root);
      m.update(baseUpdate({ speed: 6, walkPhase: 1.0 }));
      const walkA = legRotations(m.root);
      m.update(baseUpdate({ speed: 6, walkPhase: 2.5 }));
      const walkB = legRotations(m.root);
      const diff = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
      expect(diff(idle, walkA)).toBeGreaterThan(0.2);
      expect(diff(walkA, walkB)).toBeGreaterThan(0.2);
      // 速度が閾値以下なら静止姿勢
      m.update(baseUpdate({ speed: 0.3, walkPhase: 2.5 }));
      expect(diff(idle, legRotations(m.root))).toBeLessThan(1e-6);
      m.dispose();
    }
  });

  it('推進器の炎は QB/飛行で表示され、接地静止時は非表示', () => {
    const m = createPlayerMech('biped');
    const flames = (): THREE.Mesh[] => {
      const out: THREE.Mesh[] = [];
      m.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry instanceof THREE.ConeGeometry) out.push(mesh);
      });
      return out;
    };
    m.update(baseUpdate());
    expect(flames().every((f) => !f.visible)).toBe(true);
    m.update(baseUpdate({ boosting: true }));
    const boostScale = flames().filter((f) => f.visible).map((f) => f.scale.z);
    expect(boostScale.length).toBeGreaterThan(0);
    m.update(baseUpdate({ thrusting: true, grounded: false }));
    const thrustScale = flames().filter((f) => f.visible).map((f) => f.scale.z);
    expect(thrustScale.length).toBeGreaterThan(0);
    // QB は飛行より強い炎
    expect(Math.max(...boostScale)).toBeGreaterThan(Math.max(...thrustScale));
    m.dispose();
  });

  it('dispose 後にジオメトリが破棄され、root は親から外れる', () => {
    const scene = new THREE.Scene();
    const m = createPlayerMech('quadruped');
    scene.add(m.root);
    m.dispose();
    expect(m.root.parent).toBeNull();
    expect(scene.children.length).toBe(0);
  });
});

function enemyView(over: Partial<EnemyView> & { id: string; kind: EnemyView['kind'] }): EnemyView {
  const def = over.kind === 'turret' ? ENEMIES.turret : over.kind === 'guard' ? ENEMIES.guard : ENEMIES.target;
  const pos: Vec3 = over.position ?? [0, 0, 0];
  return {
    position: pos,
    yaw: 0,
    gunDirection: [0, 0, -1],
    alive: true,
    telegraphing: false,
    alert: false,
    isGateControl: false,
    hp: 100,
    maxHp: 100,
    center: [pos[0] + def.centerOffset[0], pos[1] + def.centerOffset[1], pos[2] + def.centerOffset[2]],
    radius: def.radius,
    ...over,
  };
}

describe('enemyModels.ts: 敵モデル', () => {
  it('警備ロボットは約 2.8m、砲台は台座＋砲塔、制御砲台はリング標識を持つ', () => {
    const shared = new EnemySharedMaterials();
    const guard = createEnemyModel(enemyView({ id: 'g1', kind: 'guard' }), shared);
    guard.update(enemyView({ id: 'g1', kind: 'guard' }), 0, 1 / 60);
    const gs = bounds(guard.root).getSize(new THREE.Vector3());
    expect(gs.y).toBeGreaterThan(2.5);
    expect(gs.y).toBeLessThan(3.3);
    const turret = createEnemyModel(enemyView({ id: 't1', kind: 'turret' }), shared);
    const control = createEnemyModel(enemyView({ id: 't2', kind: 'turret', isGateControl: true }), shared);
    const hasTorus = (o: THREE.Object3D) => {
      let found = false;
      o.traverse((c) => {
        if ((c as THREE.Mesh).isMesh && (c as THREE.Mesh).geometry instanceof THREE.TorusGeometry) found = true;
      });
      return found;
    };
    expect(hasTorus(turret.root)).toBe(false);
    expect(hasTorus(control.root)).toBe(true);
    expect(countMeshes(control.root)).toBeGreaterThan(countMeshes(turret.root));
    guard.dispose();
    turret.dispose();
    control.dispose();
    shared.dispose();
  });

  it('砲塔は gunDirection の向きへ回転する', () => {
    const shared = new EnemySharedMaterials();
    const dir = directionFromYawPitch(1.2, 0.3);
    const v = enemyView({ id: 't1', kind: 'turret', gunDirection: dir });
    const turret = createEnemyModel(v, shared);
    turret.update(v, 0.5, 1 / 60);
    // 砲身は head の −Z。head を探す: gunPivotOffset の高さにある Group
    let head: THREE.Object3D | null = null;
    turret.root.traverse((o) => {
      if ((o as THREE.Group).isGroup && o !== turret.root && Math.abs(o.position.y - ENEMIES.turret.gunPivotOffset[1]) < 1e-6) head = o;
    });
    expect(head).not.toBeNull();
    turret.root.updateMatrixWorld(true);
    const wd = new THREE.Vector3();
    (head as unknown as THREE.Object3D).getWorldDirection(wd);
    wd.multiplyScalar(-1);
    expect(angleBetween(wd, dir)).toBeLessThan(1e-3);
    turret.dispose();
    shared.dispose();
  });

  it('予告中は砲口が明滅し、撃破で残骸へ切り替わり、再出撃で復元される', () => {
    const shared = new EnemySharedMaterials();
    const v = enemyView({ id: 'g1', kind: 'guard', telegraphing: true });
    const guard = createEnemyModel(v, shared);
    const flashes = (): THREE.Mesh[] => {
      const out: THREE.Mesh[] = [];
      guard.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material === shared.flash) out.push(o as THREE.Mesh);
      });
      return out;
    };
    guard.update(v, 0.0, 1 / 60);
    const a = flashes()[0].visible;
    guard.update(v, TELEGRAPH_BLINK_PERIOD / 2 + 1e-4, 1 / 60);
    const b = flashes()[0].visible;
    expect(a).not.toBe(b);
    // 非予告時は消灯
    guard.update({ ...v, telegraphing: false }, 1.0, 1 / 60);
    expect(flashes()[0].visible).toBe(false);
    // 撃破
    const burntBefore = countMaterial(guard.root, shared.burnt);
    expect(burntBefore).toBe(0);
    guard.update({ ...v, alive: false }, 1.1, 1 / 60);
    expect(guard.wrecked).toBe(true);
    expect(countMaterial(guard.root, shared.burnt)).toBeGreaterThan(5);
    expect(countMaterial(guard.root, shared.visor)).toBe(0); // バイザーは非表示/差し替え
    // 復元
    guard.update({ ...v, alive: true, telegraphing: false }, 1.2, 1 / 60);
    expect(guard.wrecked).toBe(false);
    expect(countMaterial(guard.root, shared.burnt)).toBe(0);
    guard.dispose();
    shared.dispose();
  });

  it('警備ロボットは移動すると脚が動く', () => {
    const shared = new EnemySharedMaterials();
    const v0 = enemyView({ id: 'g1', kind: 'guard', position: [0, 0, 0] });
    const guard = createEnemyModel(v0, shared);
    guard.update(v0, 0, 1 / 60);
    guard.update(enemyView({ id: 'g1', kind: 'guard', position: [0, 0, -0.1] }), 1 / 60, 1 / 60);
    guard.update(enemyView({ id: 'g1', kind: 'guard', position: [0, 0, -0.2] }), 2 / 60, 1 / 60);
    const rot = legRotations(guard.root);
    expect(rot.some((r) => Math.abs(r) > 0.01)).toBe(true);
    guard.dispose();
    shared.dispose();
  });
});

function countMaterial(root: THREE.Object3D, mat: THREE.Material): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.material === mat && o.visible) n++;
  });
  return n;
}

function makeStage(opts: { solids?: SolidDef[]; decor?: DecorDef[]; lights?: LightDef[] } = {}): StageData {
  const data = makeFlatStage({ extraSolids: opts.solids });
  data.decor = opts.decor ?? [];
  data.lights = opts.lights ?? [];
  data.barriers = [
    { id: 'B1', box: box([10, 0, -1], [14, 6, 1]), controlTurretId: 'T1', fromSectorId: 'flat', toSectorId: 'flat' },
    { id: 'B2', box: box([20, 0, -1], [24, 6, 1]), controlTurretId: 'T2', fromSectorId: 'flat', toSectorId: 'flat' },
  ];
  data.gate = { id: 'G', box: box([30, 0, -3], [31, 8, 3]) };
  return data;
}

describe('stageMeshes.ts: ステージメッシュ', () => {
  it('約1500個の直方体をマテリアルごとに結合し、メッシュ数がマテリアル数に収まる', () => {
    const mats: SolidDef['material'][] = ['concrete', 'steel', 'rust', 'machine', 'catwalk', 'hazard'];
    const solids: SolidDef[] = [];
    for (let i = 0; i < 1500; i++) {
      const x = (i % 50) * 3;
      const z = Math.floor(i / 50) * 3;
      solids.push({ box: box([x, 0, z], [x + 2, 1 + (i % 4), z + 2]), material: mats[i % mats.length] });
    }
    const lib = new MaterialLibrary();
    const data = makeStage({ solids });
    const t0 = performance.now();
    const sm = new StageMeshes(data, lib);
    const buildMs = performance.now() - t0;
    // floorPlate（床）＋ 6 種 = 7 メッシュ
    expect(sm.staticMeshCount).toBe(7);
    let meshes = 0;
    let verts = 0;
    sm.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        meshes++;
        verts += m.geometry.getAttribute('position').count;
      }
    });
    // 静的 7 + 隔壁 2 + ゲート 1
    expect(meshes).toBe(10);
    expect(verts).toBeGreaterThanOrEqual(1501 * 24);
    expect(buildMs).toBeLessThan(5000);
    sm.dispose();
    lib.dispose();
    expect(sm.root.children.length).toBe(0);
  });

  it('隔壁は開放で BARRIER_OPEN_SECONDS かけて床へ沈み、閉鎖で即座に戻る', () => {
    const lib = new MaterialLibrary();
    const sm = new StageMeshes(makeStage(), lib);
    const mesh = sm.root.getObjectByName('barrier:B1') as THREE.Mesh;
    expect(mesh).toBeDefined();
    const closedY = mesh.position.y;
    expect(closedY).toBeCloseTo(3, 6);
    sm.update(1);
    expect(mesh.position.y).toBeCloseTo(closedY, 6);
    sm.setBarrierOpen('B1', true);
    sm.update(BARRIER_OPEN_SECONDS / 2);
    expect(mesh.position.y).toBeLessThan(closedY - 1);
    expect(mesh.position.y).toBeGreaterThan(closedY - 6);
    expect(mesh.visible).toBe(true);
    sm.update(BARRIER_OPEN_SECONDS / 2 + 0.01);
    expect(mesh.position.y).toBeLessThan(closedY - 6);
    expect(mesh.visible).toBe(false);
    // 他の隔壁は動かない
    const b2 = sm.root.getObjectByName('barrier:B2') as THREE.Mesh;
    expect(b2.position.y).toBeCloseTo(3, 6);
    // 再出撃: 閉鎖は即時
    sm.setBarrierOpen('B1', false);
    expect(mesh.position.y).toBeCloseTo(closedY, 6);
    expect(mesh.visible).toBe(true);
    // ゲート
    const gate = sm.root.getObjectByName('gate:G') as THREE.Mesh;
    sm.setGateOpen(true);
    sm.update(BARRIER_OPEN_SECONDS * 2);
    expect(gate.visible).toBe(false);
    sm.setGateOpen(false);
    expect(gate.visible).toBe(true);
    expect(sm.barrierBox('B1')).not.toBeNull();
    expect(sm.barrierBox('nope')).toBeNull();
    sm.dispose();
    lib.dispose();
  });

  it('PointLight の総数は上限で打ち切られ、ランプは予算内でのみ光源を持つ', () => {
    const lib = new MaterialLibrary();
    const lights: LightDef[] = [];
    for (let i = 0; i < 25; i++) lights.push({ position: [i * 5, 4, 0], color: 0xffffff, intensity: 1, distance: 20 });
    const decor: DecorDef[] = [];
    for (let i = 0; i < 20; i++) decor.push({ kind: 'lamp', position: [i * 3, 5, 5], material: 'lampRed' });
    const a = new StageMeshes(makeStage({ lights, decor }), lib);
    expect(a.pointLightCount).toBe(MAX_POINT_LIGHTS);
    const countLights = (root: THREE.Object3D) => {
      let n = 0;
      root.traverse((o) => {
        if ((o as THREE.PointLight).isPointLight) n++;
      });
      return n;
    };
    expect(countLights(a.root)).toBe(MAX_POINT_LIGHTS);
    a.dispose();
    const b = new StageMeshes(makeStage({ decor }), lib);
    expect(b.pointLightCount).toBe(LAMP_LIGHT_BUDGET);
    expect(countLights(b.root)).toBe(LAMP_LIGHT_BUDGET);
    b.dispose();
    lib.dispose();
  });

  it('装飾（円柱・矢印・ラベル・発光ボックス）を生成する', () => {
    const lib = new MaterialLibrary();
    const decor: DecorDef[] = [
      { kind: 'cylinder', position: [0, 3, 0], radius: 0.4, height: 6, axis: 'z', material: 'pipe' },
      { kind: 'arrow', position: [2, 0.1, 2], yaw: 1.0 },
      { kind: 'label', position: [0, 4, 0], text: 'EXIT' },
      { kind: 'box', box: box([5, 0, 5], [6, 1, 6]), emissive: 0x20e0ff },
    ];
    const sm = new StageMeshes(makeStage({ decor }), lib);
    expect(sm.labelCount).toBe(1);
    expect(sm.root.getObjectByName('label:EXIT')).toBeDefined();
    // 床 + pipe + lampAmber(矢印) + custom emissive = 4 静的メッシュ
    expect(sm.staticMeshCount).toBe(4);
    sm.dispose();
    lib.dispose();
  });
});

function proj(kind: ProjectileView['kind'], i: number): ProjectileView {
  return { kind, position: [i, 1, -i], direction: [0, 0, -1] };
}

describe('effects.ts: 効果は上限付きで寿命後に消える', () => {
  it('全イベント種別を処理でき、大量発生でも上限を超えず、時間経過で全て消える', () => {
    const fx = new EffectsSystem();
    const events: SimEvent[] = [
      { type: 'mgFire', muzzle: [0, 2, 0], direction: [0, 0, -1] },
      { type: 'beamFire', from: [0, 2, 0], to: [0, 2, -50], hitEnemyId: 'e1' },
      { type: 'missileFire', muzzle: [0, 2, 0], direction: [0, 0, -1] },
      { type: 'enemyHit', enemyId: 'e1', point: [0, 2, -50], weapon: 'machinegun' },
      { type: 'enemyHit', enemyId: 'e1', point: [0, 2, -50], weapon: 'missile' },
      { type: 'worldHit', point: [0, 0, -10], normal: [0, 1, 0], source: 'machinegun' },
      { type: 'worldHit', point: [0, 0, -10], normal: [0, 1, 0], source: 'missile' },
      { type: 'worldHit', point: [0, 0, -10], normal: [0, 1, 0], source: 'enemy' },
      { type: 'missileExpired', point: [0, 5, -100] },
      { type: 'playerHit', point: [0, 1.5, 0], fromDirection: [0, 0, -1], damage: 18 },
      { type: 'enemyDestroyed', enemyId: 'e1', kind: 'guard', position: [0, 0, -50] },
      { type: 'enemyDestroyed', enemyId: 't1', kind: 'turret', position: [0, 0, -50] },
      { type: 'enemyFire', enemyId: 'e2', muzzle: [5, 2, -20], direction: [0, 0, 1] },
      { type: 'enemyTelegraph', enemyId: 'e2' },
      { type: 'qbStart', position: [0, 0, 0], direction: [1, 0, 0] },
      { type: 'jump', position: [0, 0, 0] },
      { type: 'landed', position: [0, 0, 0] },
      { type: 'barrierOpened', barrierId: 'B1' },
      { type: 'gateOpened' },
      { type: 'fireDenied', weapon: 'missile', reason: 'noLock' },
      { type: 'cleared' },
      { type: 'failed', reason: 'hp' },
    ];
    const barrierCenter = (id: string): Vec3 | null => (id === 'B1' ? [12, 3, 0] : null);
    for (let round = 0; round < 60; round++) {
      for (const e of events) fx.handleEvent(e, barrierCenter);
      fx.update(1 / 60, []);
    }
    const counts = fx.activeCounts();
    expect(counts.particles).toBeLessThanOrEqual(EFFECT_CAPACITY.sparks + EFFECT_CAPACITY.debris + EFFECT_CAPACITY.puffs);
    expect(counts.particles).toBeGreaterThan(0);
    expect(counts.timed).toBeLessThanOrEqual(EFFECT_CAPACITY.beams + EFFECT_CAPACITY.explosions + EFFECT_CAPACITY.flashes + EFFECT_CAPACITY.barrierLights);
    const childrenAfterBurst = fx.root.children.length;
    // 3 秒後には全て消える
    for (let i = 0; i < 180; i++) fx.update(1 / 60, []);
    const after = fx.activeCounts();
    expect(after.particles).toBe(0);
    expect(after.timed).toBe(0);
    // シーンのオブジェクト数は増えない（プール）
    for (let round = 0; round < 20; round++) {
      for (const e of events) fx.handleEvent(e, barrierCenter);
      fx.update(1 / 60, []);
    }
    expect(fx.root.children.length).toBe(childrenAfterBurst);
    fx.dispose();
    expect(fx.root.children.length).toBe(0);
  });

  it('ビームは 0.12 秒、爆発は 0.8 秒で消える', () => {
    const fx = new EffectsSystem();
    fx.handleEvent({ type: 'beamFire', from: [0, 2, 0], to: [0, 2, -30], hitEnemyId: null });
    fx.update(BEAM_SECONDS * 0.5, []);
    expect(fx.activeCounts().timed).toBeGreaterThan(0);
    fx.update(BEAM_SECONDS * 0.6, []);
    expect(fx.activeCounts().timed).toBe(0);
    fx.handleEvent({ type: 'enemyDestroyed', enemyId: 'e', kind: 'guard', position: [0, 0, 0] });
    fx.update(EXPLOSION_SECONDS * 0.9, []);
    expect(fx.activeCounts().timed).toBeGreaterThan(0);
    fx.update(EXPLOSION_SECONDS * 0.2, []);
    expect(fx.activeCounts().timed).toBe(0);
    fx.dispose();
  });

  it('曳光・ミサイルは ProjectileView の索引で同期され、上限で打ち切られる', () => {
    const fx = new EffectsSystem();
    const list: ProjectileView[] = [];
    for (let i = 0; i < 50; i++) list.push(proj('machinegun', i));
    for (let i = 0; i < 600; i++) list.push(proj('enemy', i));
    for (let i = 0; i < 30; i++) list.push(proj('missile', i));
    fx.update(1 / 60, list);
    const instanced: THREE.InstancedMesh[] = [];
    fx.root.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) instanced.push(o as THREE.InstancedMesh);
    });
    const counts = instanced.map((m) => m.count).sort((a, b) => a - b);
    expect(counts).toContain(50);
    expect(counts).toContain(EFFECT_CAPACITY.enemyTracers);
    expect(fx.activeCounts().missiles).toBe(EFFECT_CAPACITY.missiles);
    // 弾がなくなれば曳光も消える
    fx.update(1 / 60, []);
    for (const m of instanced) expect(m.count).toBe(0);
    // ミサイルの煙は寿命付き
    fx.update(0.1, [proj('missile', 0)]);
    expect(fx.activeCounts().particles).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) fx.update(1 / 60, []);
    expect(fx.activeCounts().particles).toBe(0);
    fx.dispose();
  });
});

// ---------------------------------------------------------------------------
// レビュー指摘の回帰試験
// ---------------------------------------------------------------------------

/** 4 脚の足先（先細りシリンダー: 上半径 0.05・下半径 0.16）のワールド座標 */
function quadFeetWorld(root: THREE.Object3D): THREE.Vector3[] {
  root.updateMatrixWorld(true);
  const out: THREE.Vector3[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry as THREE.CylinderGeometry;
    // ConeGeometry も CylinderGeometry を継承する（parameters に radiusTop が無い）ので型名で限定する
    if (g.type !== 'CylinderGeometry') return;
    if (Math.abs(g.parameters.radiusTop - 0.05) > 1e-9 || Math.abs(g.parameters.radiusBottom - 0.16) > 1e-9) return;
    out.push(mesh.getWorldPosition(new THREE.Vector3()));
  });
  return out;
}

function findGroupAtY(root: THREE.Object3D, y: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.Group).isGroup && o !== root && Math.abs(o.position.y - y) < 1e-6) out.push(o);
  });
  return out;
}

describe('mech.ts: レビュー指摘の回帰', () => {
  it('4脚の足先は update 後も 4 象限（±x, ±z）に分かれて配置される（静止・歩行・空中）', () => {
    const m = createPlayerMech('quadruped');
    const states: Partial<MechUpdate>[] = [
      {},
      { speed: 6, walkPhase: 1.1 },
      { speed: 6, walkPhase: 2.9 },
      { grounded: false },
      { gliding: true, speed: 20 },
    ];
    for (const st of states) {
      m.update(baseUpdate(st));
      const feet = quadFeetWorld(m.root);
      expect(feet.length).toBe(4);
      const quadrants = new Set(feet.map((f) => `${f.x > 0 ? '+' : '-'}${f.z > 0 ? '+' : '-'}`));
      expect(quadrants.size).toBe(4);
      for (const f of feet) {
        // 胴体の外側に広がっている
        expect(Math.abs(f.x)).toBeGreaterThan(0.6);
        expect(Math.abs(f.z)).toBeGreaterThan(0.5);
      }
    }
    // 歩行中は静止時の位置から足先が動く（各脚は自分の象限内で前後に振れる）
    m.update(baseUpdate());
    const idle = quadFeetWorld(m.root);
    m.update(baseUpdate({ speed: 6, walkPhase: 0.7 }));
    const walking = quadFeetWorld(m.root);
    let maxDz = 0;
    for (let i = 0; i < 4; i++) {
      expect(Math.sign(walking[i].x)).toBe(Math.sign(idle[i].x));
      expect(Math.sign(walking[i].z)).toBe(Math.sign(idle[i].z));
      maxDz = Math.max(maxDz, Math.abs(walking[i].z - idle[i].z));
    }
    expect(maxDz).toBeGreaterThan(0.05);
    m.dispose();
  });

  it('頭部は腕の照準ピッチと同じ向きへ傾く（上を狙えば顔も上を向く）', () => {
    const m = createPlayerMech('biped');
    const head = findGroupAtY(m.root, 2.68)[0];
    expect(head).toBeDefined();
    const face = (): THREE.Vector3 => {
      m.root.updateMatrixWorld(true);
      // Group の getWorldDirection は +Z。顔は −Z
      return head.getWorldDirection(new THREE.Vector3()).multiplyScalar(-1);
    };
    m.update(baseUpdate({ aimDirection: directionFromYawPitch(0, 0.8) }));
    expect(head.rotation.x).toBeGreaterThan(0.05);
    expect(face().y).toBeGreaterThan(0.05);
    m.update(baseUpdate({ aimDirection: directionFromYawPitch(0, -0.8) }));
    expect(face().y).toBeLessThan(-0.05);
    m.dispose();
  });

  it('砲身は照準が可動域外（±π のヨー差・急なピッチ）でも aimDirection と一致する', () => {
    const m = createPlayerMech('biped');
    const dir = new THREE.Vector3();
    for (const yaw of [0, 1.3, -2.6]) {
      for (const dyaw of [-Math.PI + 0.01, -3.0, -1.5, -1.2, 1.2, 1.5, 3.0, Math.PI - 0.01]) {
        for (const dy of [-1.4, -0.9, 0, 0.9, 1.4]) {
          const aim = directionFromYawPitch(yaw + dyaw, dy);
          m.update(baseUpdate({ yaw, aimDirection: aim }));
          m.getBarrelWorldDirection(dir);
          expect(angleBetween(dir, aim)).toBeLessThan(1e-3);
        }
      }
    }
    // 真後ろ（レビューの再現例）
    m.update(baseUpdate({ yaw: 0, aimDirection: [0, 0, 1] }));
    m.getBarrelWorldDirection(dir);
    expect(angleBetween(dir, [0, 0, 1])).toBeLessThan(1e-3);
    // 脚（root 直下の脚グループ）はひねられない: 上半身だけが回る
    m.dispose();
  });

  it('weapon を省略しても更新でき、既定の武器（マシンガン）の先端が見える', () => {
    const m = createPlayerMech('biped');
    const u = baseUpdate();
    delete (u as { weapon?: unknown }).weapon;
    m.update(u);
    const tipVisible = (name: string): boolean => (m.root.getObjectByName('tip:' + name) as THREE.Object3D).visible;
    expect(tipVisible('machinegun')).toBe(true);
    expect(tipVisible('beam')).toBe(false);
    expect(tipVisible('missile')).toBe(false);
    m.dispose();
  });
});

/** 砲口リング（emissive 0xff6010 の個体別マテリアル）の発光強度 */
function muzzleIntensities(root: THREE.Object3D): number[] {
  const out: number[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mat.isMeshStandardMaterial && mat.emissive.getHex() === 0xff6010) out.push(mat.emissiveIntensity);
  });
  return out;
}

function flashMeshes(root: THREE.Object3D, shared: EnemySharedMaterials): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material === shared.flash) out.push(o as THREE.Mesh);
  });
  return out;
}

describe('enemyModels.ts: レビュー指摘の回帰', () => {
  it('予告の点灯中に撃破されても、残骸に閃光と砲口の蓄光が残らない（警備ロボット・砲台）', () => {
    const shared = new EnemySharedMaterials();
    // time=0 は明滅の「点灯」半周期
    const onTime = 0;
    expect(Math.floor(onTime / (TELEGRAPH_BLINK_PERIOD / 2)) % 2).toBe(0);
    for (const kind of ['guard', 'turret'] as const) {
      const v = enemyView({ id: 'x-' + kind, kind, telegraphing: true });
      const model = createEnemyModel(v, shared);
      model.update(v, onTime, 1 / 60);
      const flash = flashMeshes(model.root, shared)[0];
      expect(flash.visible).toBe(true);
      expect(Math.max(...muzzleIntensities(model.root))).toBeGreaterThan(3);
      // 次のフレームで撃破（予告フラグは sim 側で残っていても構わない）
      model.update({ ...v, alive: false }, onTime + 1 / 60, 1 / 60);
      expect(model.wrecked).toBe(true);
      expect(flash.visible).toBe(false);
      for (const i of muzzleIntensities(model.root)) expect(i).toBeLessThanOrEqual(0.3);
      // 5 秒後も消えたまま
      model.update({ ...v, alive: false }, onTime + 5, 1 / 60);
      expect(flash.visible).toBe(false);
      // 復元後は予告で再び点灯できる
      model.update({ ...v, alive: true }, onTime + 6, 1 / 60);
      expect(flash.visible).toBe(true);
      model.dispose();
    }
    shared.dispose();
  });

  it('バイザーの明るさは個体ごと（共有マテリアルを書き換えない）', () => {
    const shared = new EnemySharedMaterials();
    const va = enemyView({ id: 'A', kind: 'guard', alert: true });
    const vb = enemyView({ id: 'B', kind: 'guard', alert: false });
    const a = createEnemyModel(va, shared);
    const b = createEnemyModel(vb, shared);
    const visorOf = (root: THREE.Object3D): THREE.MeshStandardMaterial => {
      let found: THREE.MeshStandardMaterial | null = null;
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && Math.abs(mesh.position.y - 2.62) < 1e-6 && Math.abs(mesh.position.z + 0.29) < 1e-6) found = mesh.material as THREE.MeshStandardMaterial;
      });
      expect(found).not.toBeNull();
      return found as unknown as THREE.MeshStandardMaterial;
    };
    a.update(va, 0, 1 / 60);
    b.update(vb, 0, 1 / 60);
    const ma = visorOf(a.root);
    const mb = visorOf(b.root);
    expect(ma).not.toBe(mb);
    expect(ma).not.toBe(shared.visor);
    expect(ma.emissiveIntensity).toBeCloseTo(2.0, 9);
    expect(mb.emissiveIntensity).toBeCloseTo(0.8, 9);
    // 共有マテリアルは変わらない
    expect(shared.visor.emissiveIntensity).toBeCloseTo(0.8, 9);
    a.dispose();
    b.dispose();
    shared.dispose();
  });

  it('砲塔の砲身は急なピッチ（真上付近）でも gunDirection と一致する', () => {
    const shared = new EnemySharedMaterials();
    for (const [yaw, pitch] of [
      [0.3, 1.25],
      [-2.0, 1.5],
      [1.0, -1.0],
      [0, 0],
    ]) {
      const dir = directionFromYawPitch(yaw, pitch);
      const v = enemyView({ id: 't', kind: 'turret', gunDirection: dir });
      const turret = createEnemyModel(v, shared);
      turret.update(v, 0.5, 1 / 60);
      const head = findGroupAtY(turret.root, ENEMIES.turret.gunPivotOffset[1])[0];
      turret.root.updateMatrixWorld(true);
      const wd = head.getWorldDirection(new THREE.Vector3()).multiplyScalar(-1);
      expect(angleBetween(wd, dir)).toBeLessThan(1e-3);
      turret.dispose();
    }
    shared.dispose();
  });

  it('制御砲台を dispose しても共有の標識テクスチャは破棄されない', () => {
    const shared = new EnemySharedMaterials();
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const disposeSpy = vi.spyOn(tex, 'dispose');
    shared.getControlLabelTexture = () => tex as unknown as THREE.CanvasTexture;
    const v = enemyView({ id: 'c1', kind: 'turret', isGateControl: true });
    const model = createEnemyModel(v, shared);
    let sprite: THREE.Sprite | null = null;
    model.root.traverse((o) => {
      if ((o as THREE.Sprite).isSprite) sprite = o as THREE.Sprite;
    });
    expect(sprite).not.toBeNull();
    expect(((sprite as unknown as THREE.Sprite).material as THREE.SpriteMaterial).map).toBe(tex);
    const other = createEnemyModel(enemyView({ id: 'c2', kind: 'turret', isGateControl: true }), shared);
    model.dispose();
    expect(disposeSpy).not.toHaveBeenCalled();
    other.dispose();
    expect(disposeSpy).not.toHaveBeenCalled();
    shared.dispose();
    tex.dispose();
  });
});

describe('stageMeshes.ts: レビュー指摘の回帰', () => {
  it('隔壁は開放した瞬間から半透明になり、1 フレームで目に見えて沈み、閉鎖で不透明に戻る', () => {
    const lib = new MaterialLibrary();
    const sm = new StageMeshes(makeStage(), lib);
    const mesh = sm.root.getObjectByName('barrier:B1') as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const closedY = mesh.position.y;
    expect(mat).not.toBe(lib.get('barrier')); // 扉ごとの複製
    expect(mat.transparent).toBe(false);
    expect(mat.opacity).toBe(1);
    sm.setBarrierOpen('B1', true);
    // update 前でも既に「実体がない」見た目
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeCloseTo(DOOR_OPENING_OPACITY, 9);
    expect(mat.opacity).toBeLessThan(0.6);
    // 60fps の 1 フレームで 0.3 m 以上沈む
    sm.update(1 / 60);
    expect(mesh.position.y).toBeLessThan(closedY - 0.3);
    // 上限時間で完全に消える
    sm.update(BARRIER_OPEN_SECONDS);
    expect(mesh.visible).toBe(false);
    expect(BARRIER_OPEN_SECONDS).toBeLessThanOrEqual(0.4);
    // 閉鎖
    sm.setBarrierOpen('B1', false);
    expect(mesh.visible).toBe(true);
    expect(mesh.position.y).toBeCloseTo(closedY, 9);
    expect(mat.transparent).toBe(false);
    expect(mat.opacity).toBe(1);
    expect(mat.emissiveIntensity).toBeCloseTo(lib.get('barrier').emissiveIntensity, 9);
    sm.dispose();
    lib.dispose();
  });

  it('dispose はライブラリ共有テクスチャ（扉の複製マテリアルの map）を破棄しない', () => {
    const lib = new MaterialLibrary();
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const disposeSpy = vi.spyOn(tex, 'dispose');
    lib.get('barrier').map = tex;
    lib.get('gate').map = tex;
    const sm = new StageMeshes(makeStage(), lib);
    const door = sm.root.getObjectByName('barrier:B1') as THREE.Mesh;
    expect((door.material as THREE.MeshStandardMaterial).map).toBe(tex);
    sm.dispose();
    expect(disposeSpy).not.toHaveBeenCalled();
    lib.dispose();
    tex.dispose();
  });
});

describe('effects.ts: レビュー指摘の回帰', () => {
  it('撃破爆発の発光球は照準を妨げない大きさに留まる', () => {
    const fx = new EffectsSystem();
    fx.handleEvent({ type: 'enemyDestroyed', enemyId: 'e', kind: 'guard', position: [0, 0, 0] });
    const explosion = (): THREE.Mesh | null => {
      let found: THREE.Mesh | null = null;
      fx.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.visible && typeof m.userData.size === 'number' && m.geometry instanceof THREE.SphereGeometry) found = m;
      });
      return found;
    };
    let maxScale = 0;
    const steps = 40;
    for (let i = 0; i < steps; i++) {
      fx.update(EXPLOSION_SECONDS / steps, []);
      const m = explosion();
      if (!m) break;
      const s = Math.max(m.scale.x, m.scale.y, m.scale.z);
      maxScale = Math.max(maxScale, s);
      if (i === Math.round(steps * 0.3) - 1) expect(s).toBeLessThan(1.5);
    }
    expect(maxScale).toBeGreaterThan(0);
    expect(maxScale).toBeLessThanOrEqual(EXPLOSION_MAX_RADIUS * 1.1 + 1e-9);
    expect(EXPLOSION_MAX_RADIUS).toBeLessThanOrEqual(2.5);
    fx.dispose();
  });
});
