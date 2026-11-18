/**
 * GameRenderer の統括試験。WebGLRenderer は node で生成できないため、three をモックして差し替える。
 * それ以外（Scene, Camera, Mesh, Group など）は実物を使う。
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CAMERA, PLAYER, SIM } from '../src/params';
import { SimCamera } from '../src/sim/camera';
import { directionFromYawPitch } from '../src/sim/vec';
import type { EnemyView, PlayerView, ProjectileView, SimEvent, StageData, Vec3 } from '../src/types';
import { box, makeFlatStage } from './helpers/testStage';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class StubWebGLRenderer {
    domElement = { style: {} as Record<string, string>, parentNode: null as unknown };
    shadowMap = { enabled: false };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    renders = 0;
    lastSize: [number, number] = [0, 0];
    setPixelRatio(): void {}
    setSize(w: number, h: number): void {
      this.lastSize = [w, h];
    }
    render(): void {
      this.renders++;
    }
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: StubWebGLRenderer };
});

// モック後に読み込む
const { GameRenderer } = await import('../src/render/renderer');

function fakeContainer(): HTMLElement {
  const children: unknown[] = [];
  return {
    clientWidth: 1280,
    clientHeight: 720,
    appendChild(c: unknown) {
      children.push(c);
      (c as { parentNode: unknown }).parentNode = this;
      return c;
    },
    removeChild(c: unknown) {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
      return c;
    },
    get childCount() {
      return children.length;
    },
  } as unknown as HTMLElement;
}

function playerView(over: Partial<PlayerView> = {}): PlayerView {
  return {
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    yaw: 0,
    aimDirection: [0, 0, -1],
    muzzlePosition: [PLAYER.muzzleOffset[0], PLAYER.muzzleOffset[1], PLAYER.muzzleOffset[2]],
    legs: 'biped',
    weapon: 'machinegun',
    grounded: true,
    horizontalMode: 'walk',
    verticalMode: 'grounded',
    glideEnabled: false,
    boosting: false,
    thrusting: false,
    alive: true,
    ...over,
  };
}

function enemyViews(n: number): EnemyView[] {
  const out: EnemyView[] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 3 === 0 ? 'turret' : 'guard';
    out.push({
      id: 'e' + i,
      kind,
      position: [i * 5, 0, -30],
      yaw: 0,
      gunDirection: [0, 0, 1],
      alive: true,
      telegraphing: i % 2 === 0,
      alert: true,
      isGateControl: i === 0,
      hp: 100,
      maxHp: 100,
      center: [i * 5, 1.5, -30],
      radius: 1.5,
    });
  }
  return out;
}

function stage(): StageData {
  const data = makeFlatStage({
    extraSolids: [
      { box: box([-10, 0, -40], [10, 6, -38]), material: 'concrete' },
      { box: box([12, 0, -20], [14, 4, -10]), material: 'steel' },
    ],
  });
  data.barriers = [{ id: 'B1', box: box([10, 0, -1], [14, 6, 1]), controlTurretId: 'T1', fromSectorId: 'flat', toSectorId: 'flat' }];
  data.gate = { id: 'G', box: box([30, 0, -3], [31, 8, 3]) };
  data.lights = [{ position: [0, 6, -10], color: 0xffaa66, intensity: 1, distance: 30 }];
  data.decor = [{ kind: 'lamp', position: [3, 5, -5], material: 'lampRed' }];
  return data;
}

describe('renderer.ts: GameRenderer', () => {
  it('SimCamera の位置・姿勢・視野角・アスペクトを写す', () => {
    const container = fakeContainer();
    const r = new GameRenderer(container);
    expect((container as unknown as { childCount: number }).childCount).toBe(1);
    r.setStage(stage());
    const cam = new SimCamera();
    cam.setViewport(1280, 720);
    cam.position = [3, 4, 5];
    cam.yaw = 0.8;
    cam.pitch = -0.3;
    r.update({ dtReal: 1 / 60, camera: cam, player: playerView(), enemies: [], projectiles: [], events: [], time: 0 });
    expect(r.camera.position.toArray()).toEqual([3, 4, 5]);
    const wd = r.camera.getWorldDirection(new THREE.Vector3());
    const expected = directionFromYawPitch(cam.yaw, cam.pitch);
    expect(wd.x).toBeCloseTo(expected[0], 6);
    expect(wd.y).toBeCloseTo(expected[1], 6);
    expect(wd.z).toBeCloseTo(expected[2], 6);
    expect(r.camera.fov).toBe(CAMERA.fovYDeg);
    expect(r.camera.aspect).toBeCloseTo(1280 / 720, 9);
    // リサイズ
    r.resize(1920, 1080);
    expect(r.camera.aspect).toBeCloseTo(1920 / 1080, 9);
    expect((r.renderer as unknown as { lastSize: [number, number] }).lastSize).toEqual([1920, 1080]);
    cam.setViewport(1920, 1080);
    r.update({ dtReal: 1 / 60, camera: cam, player: playerView(), enemies: [], projectiles: [], events: [], time: 0 });
    expect(r.camera.aspect).toBeCloseTo(1920 / 1080, 9);
    expect((r.renderer as unknown as { renders: number }).renders).toBe(2);
    r.dispose();
    expect((container as unknown as { childCount: number }).childCount).toBe(0);
  });

  it('機体・敵・弾体・イベントを同期し、長時間・再出撃でもシーンのオブジェクト数が増えない', () => {
    const r = new GameRenderer(fakeContainer());
    const data = stage();
    r.setStage(data);
    const cam = new SimCamera();
    const enemies = enemyViews(45);
    const projectiles: ProjectileView[] = [];
    for (let i = 0; i < 20; i++) projectiles.push({ kind: i % 2 ? 'machinegun' : 'enemy', position: [i, 2, -i], direction: [0, 0, -1] });
    projectiles.push({ kind: 'missile', position: [0, 3, -5], direction: [0, 0, -1] });
    const events: SimEvent[] = [
      { type: 'mgFire', muzzle: [1, 2, 1], direction: [0, 0, -1] },
      { type: 'enemyDestroyed', enemyId: 'e1', kind: 'guard', position: [5, 0, -30] },
      { type: 'barrierOpened', barrierId: 'B1' },
      { type: 'landed', position: [0, 0, 0] },
    ];
    const frame = (t: number, ev: SimEvent[]) => {
      cam.follow([t, 0, -t], null);
      r.update({
        dtReal: 1 / 60,
        camera: cam,
        player: playerView({ position: [t, 0, -t], velocity: [0, 0, -6] }),
        enemies,
        projectiles,
        events: ev,
        time: t,
      });
    };
    for (let i = 0; i < 10; i++) frame(i / 60, events);
    expect(r.stats().enemies).toBe(45);
    const sceneCount = r.scene.children.length;
    const total = () => {
      let n = 0;
      r.scene.traverse(() => n++);
      return n;
    };
    const totalAfterWarmup = total();
    // 長時間（600 フレーム、毎フレームイベント）
    for (let i = 10; i < 610; i++) frame(i / 60, events);
    expect(r.scene.children.length).toBe(sceneCount);
    expect(total()).toBe(totalAfterWarmup);
    // 機体の位置は追従
    const mech = r.playerMech!;
    expect(mech.root.position.x).toBeCloseTo(609 / 60, 6);
    // 撃破された敵は残骸表示、再出撃（同じステージ・全員生存）で復元
    enemies[1].alive = false;
    frame(11, []);
    expect(total()).toBe(totalAfterWarmup);
    enemies[1].alive = true;
    r.setStage(data); // 同じデータなら作り直さない
    r.setBarrierOpen('B1', false);
    r.setGateOpen(false);
    frame(0, []);
    expect(total()).toBe(totalAfterWarmup);
    expect(r.stats().staticMeshes).toBeGreaterThan(0);
    expect(r.stats().pointLights).toBe(2);
    r.dispose();
  });

  it('格納庫モードでは機体を正面から映し、脚部切り替えでモデルが変わる', () => {
    const r = new GameRenderer(fakeContainer());
    r.setGarageMode(true);
    const cam = new SimCamera();
    cam.position = [100, 100, 100];
    r.update({ dtReal: 1 / 60, camera: cam, player: playerView(), enemies: [], projectiles: [], events: [], time: 0 });
    // カメラは機体の前方（−Z 側）にあり、機体を見る
    expect(r.camera.position.z).toBeLessThan(-3);
    expect(Math.abs(r.camera.position.x)).toBeLessThan(0.01);
    const wd = r.camera.getWorldDirection(new THREE.Vector3());
    expect(wd.z).toBeGreaterThan(0.8);
    expect(r.playerMech!.root.position.length()).toBeLessThan(1e-6);
    // 顔（鼻）の位置がカメラから見えるか: 機体前面がカメラ側
    const yawA = r.playerMech!.root.rotation.y;
    r.update({ dtReal: 0.5, camera: cam, player: playerView(), enemies: [], projectiles: [], events: [], time: 0.5 });
    expect(r.playerMech!.root.rotation.y).not.toBe(yawA);
    expect(Math.abs(r.playerMech!.root.rotation.y)).toBeLessThan(1.0);
    // 脚部切り替え
    expect(r.playerMech!.legs).toBe('biped');
    r.setPlayerLoadout('quadruped');
    expect(r.playerMech!.legs).toBe('quadruped');
    r.setPlayerLoadout('quadruped');
    const same = r.playerMech;
    r.setPlayerLoadout('quadruped');
    expect(r.playerMech).toBe(same);
    // プレイへ戻ると SimCamera に従う
    r.setGarageMode(false);
    cam.position = [1, 2, 3];
    cam.yaw = 0;
    cam.pitch = 0;
    r.update({ dtReal: 1 / 60, camera: cam, player: playerView({ legs: 'biped' }), enemies: [], projectiles: [], events: [], time: 1 });
    expect(r.camera.position.toArray()).toEqual([1, 2, 3]);
    expect(r.playerMech!.legs).toBe('biped');
    const pos: Vec3 = [1, 2, 3];
    expect(pos).toEqual(r.camera.position.toArray());
    r.dispose();
  });
});

describe('renderer.ts: レビュー指摘の回帰', () => {
  it('sim 時刻が進まないフレーム（一時停止）では効果・隔壁アニメ・ミサイルの煙が進まない', () => {
    const r = new GameRenderer(fakeContainer());
    r.setStage(stage());
    const cam = new SimCamera();
    const missile: ProjectileView[] = [{ kind: 'missile', position: [0, 3, -5], direction: [0, 0, -1] }];
    const frame = (t: number, ev: SimEvent[] = []) =>
      r.update({ dtReal: 1 / 60, camera: cam, player: playerView(), enemies: [], projectiles: missile, events: ev, time: t });
    frame(1.0);
    // main.ts は barrierOpened イベントで setBarrierOpen を呼び、同じフレームの events を描画へ渡す
    r.setBarrierOpen('B1', true);
    frame(1.0 + 1 / 60, [{ type: 'barrierOpened', barrierId: 'B1' }]);
    const door = r.scene.getObjectByName('barrier:B1') as THREE.Mesh;
    expect(door.position.y).toBeLessThan(3); // 1 フレーム分沈んでいる（閉鎖時の中心 y=3）
    const yAfterOpen = door.position.y;
    const particlesAfterOpen = r.stats().effects.particles;
    expect(particlesAfterOpen).toBeGreaterThan(0);
    // 一時停止: 実時間は流れるが sim 時刻は同じ
    for (let i = 0; i < 120; i++) frame(1.0 + 1 / 60);
    expect(door.position.y).toBe(yAfterOpen);
    expect(door.visible).toBe(true);
    expect(r.stats().effects.particles).toBe(particlesAfterOpen);
    // 再開: sim 時刻が進めば扉は沈み切り、火花は消える
    for (let i = 2; i < 200; i++) frame(1.0 + i / 60);
    expect(door.visible).toBe(false);
    expect(door.position.y).toBeLessThan(yAfterOpen - 1);
    r.dispose();
  });

  it('dtReal は SIM.maxFrameSeconds まで受け付ける（0.1 秒で切り詰めない）', () => {
    const cam = new SimCamera();
    const spin = (dts: number[]): number => {
      const r = new GameRenderer(fakeContainer());
      r.setGarageMode(true);
      for (const dt of dts) r.update({ dtReal: dt, camera: cam, player: playerView(), enemies: [], projectiles: [], events: [], time: 0 });
      const yaw = r.playerMech!.root.rotation.y;
      r.dispose();
      return yaw;
    };
    expect(SIM.maxFrameSeconds).toBeGreaterThan(0.1);
    // 0.2 秒 1 回 = 0.1 秒 2 回（0.1 で切り詰めていれば一致しない）
    expect(spin([0.2])).toBeCloseTo(spin([0.1, 0.1]), 9);
    // 上限を超える分は切り詰める
    expect(spin([SIM.maxFrameSeconds + 0.3])).toBeCloseTo(spin([SIM.maxFrameSeconds]), 9);
    expect(spin([0.2])).not.toBeCloseTo(spin([0.1]), 3);
  });

  it('歩行姿勢は位置の実移動から決まる（壁に押し付けて velocity>0 でも位置が動かなければ歩かない）', () => {
    const r = new GameRenderer(fakeContainer());
    r.setStage(stage());
    const cam = new SimCamera();
    const hips = (): THREE.Object3D[] => {
      const out: THREE.Object3D[] = [];
      r.playerMech!.root.traverse((o) => {
        if ((o as THREE.Group).isGroup && Math.abs(o.position.y - 1.32) < 1e-6) out.push(o);
      });
      return out;
    };
    const frame = (t: number, pos: Vec3, vel: Vec3) =>
      r.update({ dtReal: 1 / 60, camera: cam, player: playerView({ position: pos, velocity: vel }), enemies: [], projectiles: [], events: [], time: t });
    // 壁に阻まれて位置が変わらない（velocity は 6 m/s のまま）
    for (let i = 0; i < 20; i++) frame(i / 60, [0, 0, 0], [0, 0, -6]);
    expect(hips().length).toBe(2);
    for (const h of hips()) expect(Math.abs(h.rotation.x)).toBeLessThan(1e-9);
    // 実際に 6 m/s で進む（velocity の申告は 0 でも脚が動く）
    let moved = false;
    for (let i = 20; i < 40; i++) {
      frame(i / 60, [0, 0, -(i - 20) * 0.1], [0, 0, 0]);
      if (hips().some((h) => Math.abs(h.rotation.x) > 0.05)) moved = true;
    }
    expect(moved).toBe(true);
    r.dispose();
  });
});
