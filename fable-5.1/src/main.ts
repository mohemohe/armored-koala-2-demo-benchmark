/**
 * 起動処理: ゲーム、描画、HUD、格納庫、一時停止・結果画面、入力、ベンチAPIを結線する。
 */
import './ui/styles.css';
import { installBench } from './bench';
import { InputManager, requestPointerLock } from './input';
import { DEFAULT_LOADOUT, DEFAULT_SEED, ENEMIES, OBJECTIVE, PLAYER, SIM, WEAPONS, computeEffectiveStats } from './params';
import { GameRenderer } from './render/renderer';
import { Game } from './sim/game';
import { parseSeed } from './sim/rng';
import { dot, length, lengthXZ, sub } from './sim/vec';
import { STAGE_DATA } from './stage/stageData';
import type { FireDenialReason, HudView, Loadout, ScreenMarker, SimEvent, Vec3, Weapon } from './types';
import { GarageUI } from './ui/garage';
import { Hud, formatTurretId } from './ui/hud';
import { Overlays } from './ui/overlays';

const app = document.getElementById('app') as HTMLElement;
const viewRoot = document.getElementById('view') as HTMLElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

const seed = parseSeed(window.location.search, DEFAULT_SEED);
let loadout: Loadout = { ...DEFAULT_LOADOUT };

const game = new Game({
  stage: STAGE_DATA,
  loadout,
  seed,
  viewport: { width: app.clientWidth || window.innerWidth, height: app.clientHeight || window.innerHeight },
  buildNav: true,
});

const renderer = new GameRenderer(viewRoot);
renderer.setStage(STAGE_DATA);
renderer.setPlayerLoadout(loadout.legs);

const hud = new Hud(uiRoot);
const overlays = new Overlays(uiRoot, {
  onResume: () => void resumeFromPause(),
  onRetry: () => void launchRun(),
  onGarage: () => goToGarage(),
});
const garage = new GarageUI(uiRoot, {
  onLoadoutChange: (l) => {
    loadout = { ...l };
    game.setLoadout(loadout);
    renderer.setPlayerLoadout(loadout.legs);
  },
  onLaunch: () => void launchRun(),
});
garage.setLoadout(loadout);

const input = new InputManager(viewRoot);
input.attach();

installBench(() => game);

// ---------------------------------------------------------------------------
// HUD 補助状態（実時間ベースの表示用）
// ---------------------------------------------------------------------------
interface HitIndicator {
  angle: number;
  at: number;
}
let hitIndicators: HitIndicator[] = [];
let lastDenial: { weapon: Weapon; reason: FireDenialReason; at: number } | null = null;
let recentBarrier: { label: string; at: number } | null = null;
let pointerLockError: string | null = null;
let realNow = performance.now() / 1000;
/** 開発用フック使用時のみ true: フォーカス喪失・タブ非表示による自動一時停止を行わない（自動検証のため） */
let devNoAutoPause = false;

function resetHudState(): void {
  hitIndicators = [];
  lastDenial = null;
  recentBarrier = null;
}

// ---------------------------------------------------------------------------
// 状態遷移（ユーザー操作起点のポインターロック）
// ---------------------------------------------------------------------------
let transitioning = false;

async function launchRun(): Promise<void> {
  if (transitioning) return;
  if (game.state === 'playing' || game.state === 'paused') return;
  transitioning = true;
  const before = game.state;
  const res = await requestPointerLock(viewRoot);
  transitioning = false;
  if (game.state !== before) {
    // 待機中に状態が変わった（格納庫へ戻った等）: 取得したロックは解除して何もしない
    if (document.pointerLockElement === viewRoot) document.exitPointerLock();
    return;
  }
  if (!res.ok) {
    pointerLockError = res.message;
    if (game.state === 'garage') garage.setPointerLockError(res.message);
    else overlays.showResult(game.state === 'cleared' ? 'cleared' : 'failed', resultSummary(), res.message);
    return;
  }
  pointerLockError = null;
  garage.setPointerLockError(null);
  beginRun();
}

/** ポインターロック取得後の出撃処理（状態初期化と画面切り替え） */
function beginRun(): void {
  game.launch();
  resetHudState();
  renderer.resetRun();
  renderer.setGarageMode(false);
  for (const b of STAGE_DATA.barriers) renderer.setBarrierOpen(b.id, false);
  renderer.setGateOpen(false);
  garage.setVisible(false);
  overlays.hide();
  hud.setVisible(true);
  input.clear();
  input.setEnabled(true);
}

async function resumeFromPause(): Promise<void> {
  if (transitioning) return;
  if (game.state !== 'paused') return;
  transitioning = true;
  const res = await requestPointerLock(viewRoot);
  transitioning = false;
  if (game.state !== 'paused') {
    if (document.pointerLockElement === viewRoot) document.exitPointerLock();
    return;
  }
  if (!res.ok) {
    pointerLockError = res.message;
    overlays.showPause(res.message);
    return;
  }
  pointerLockError = null;
  game.resume();
  overlays.hide();
  input.clear();
  input.setEnabled(true);
}

function pauseGame(): void {
  if (game.state !== 'playing') return;
  game.pause();
  input.setEnabled(false);
  if (document.pointerLockElement === viewRoot) document.exitPointerLock();
  overlays.showPause(pointerLockError);
}

function goToGarage(): void {
  if (transitioning) return;
  if (document.pointerLockElement === viewRoot) document.exitPointerLock();
  input.setEnabled(false);
  game.returnToGarage();
  resetHudState();
  overlays.hide();
  hud.setVisible(false);
  renderer.setGarageMode(true);
  for (const b of STAGE_DATA.barriers) renderer.setBarrierOpen(b.id, false);
  renderer.setGateOpen(false);
  garage.setLoadout(loadout);
  garage.setVisible(true);
}

function resultSummary() {
  return {
    elapsedSeconds: game.time,
    controlsDestroyed: game.controlsDestroyed,
    enemiesDestroyed: OBJECTIVE.totalEnemies - game.aliveEnemyCount(),
    failReason: game.failReason,
  };
}

function onRunEnded(): void {
  input.setEnabled(false);
  if (document.pointerLockElement === viewRoot) document.exitPointerLock();
  overlays.showResult(game.state === 'cleared' ? 'cleared' : 'failed', resultSummary(), null);
}

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== viewRoot && game.state === 'playing') pauseGame();
});
document.addEventListener('pointerlockerror', () => {
  if (game.state === 'playing') pauseGame();
});
window.addEventListener('blur', () => {
  if (!devNoAutoPause) pauseGame();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !devNoAutoPause) pauseGame();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && game.state === 'playing') pauseGame();
});

// ---------------------------------------------------------------------------
// リサイズ
// ---------------------------------------------------------------------------
function applyResize(): void {
  const w = Math.max(1, app.clientWidth);
  const h = Math.max(1, app.clientHeight);
  game.setViewport(w, h);
  renderer.resize(w, h);
}
window.addEventListener('resize', applyResize);
applyResize();

// ---------------------------------------------------------------------------
// HUD ビュー生成
// ---------------------------------------------------------------------------
function marker(p: Vec3): ScreenMarker {
  const cam = game.camera;
  const sp = cam.project(p);
  const w = cam.viewportWidth;
  const h = cam.viewportHeight;
  const x = sp.x;
  const y = sp.y;
  const onScreen = sp.inFront && x >= 0 && x <= w && y >= 0 && y <= h;
  let angle: number;
  if (sp.inFront) {
    angle = Math.atan2(y - h / 2, x - w / 2);
  } else {
    // 背後の点: カメラ空間の右・上成分から端の方向を決める（真後ろなら下端）
    const d = sub(p, cam.position);
    const xc = dot(d, cam.right());
    const yc = dot(d, cam.up());
    angle = Math.hypot(xc, yc) < 1e-6 ? Math.PI / 2 : Math.atan2(-yc, xc);
  }
  return { x, y, onScreen, angle };
}

function screenAngleFromWorldDir(dir: Vec3): number {
  const cam = game.camera;
  const x = dot(dir, cam.right());
  const z = dot(dir, cam.horizontalForward());
  return Math.atan2(x, z);
}

function handleEvents(events: SimEvent[]): void {
  for (const ev of events) {
    switch (ev.type) {
      case 'playerHit': {
        const toShooter: Vec3 = [-ev.fromDirection[0], -ev.fromDirection[1], -ev.fromDirection[2]];
        hitIndicators.push({ angle: screenAngleFromWorldDir(toShooter), at: realNow });
        if (hitIndicators.length > 12) hitIndicators.splice(0, hitIndicators.length - 12);
        break;
      }
      case 'fireDenied':
        lastDenial = { weapon: ev.weapon, reason: ev.reason, at: realNow };
        break;
      case 'barrierOpened': {
        const b = STAGE_DATA.barriers.find((x) => x.id === ev.barrierId);
        recentBarrier = { label: b?.label ?? ev.barrierId, at: realNow };
        renderer.setBarrierOpen(ev.barrierId, true);
        break;
      }
      case 'gateOpened':
        renderer.setGateOpen(true);
        recentBarrier = { label: STAGE_DATA.gate.label ?? '最終搬出ゲート', at: realNow };
        break;
      case 'cleared':
      case 'failed':
        onRunEnded();
        break;
      default:
        break;
    }
  }
}

function nextObjectivePosition(): { position: Vec3; label: string } | null {
  for (const b of STAGE_DATA.barriers) {
    const t = game.targetInfo(b.controlTurretId);
    const e = game.enemies.byId(b.controlTurretId);
    if (e && e.alive && t) return { position: t.center, label: `制御砲台 ${formatTurretId(b.controlTurretId)}` };
  }
  if (game.stage.gateOpen) {
    const z = STAGE_DATA.exitZone;
    return { position: [(z.min[0] + z.max[0]) / 2, (z.min[1] + z.max[1]) / 2, (z.min[2] + z.max[2]) / 2], label: '脱出領域' };
  }
  const g = STAGE_DATA.gate.box;
  return { position: [(g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2, (g.min[2] + g.max[2]) / 2], label: '最終ゲート' };
}

/**
 * 次の目標の説明文。区画の説明（objectiveHints）を基に、その区画の制御砲台が既に破壊されていれば
 * 破壊後の進路（説明文の「。」以降）だけを示し、ゲート開放後は脱出を指示する。
 */
function nextObjectiveText(sectorId: string | null, hints: Record<string, string>): string {
  if (game.stage.gateOpen) return '最終搬出ゲート開放 — 脱出領域へ進め';
  const generic = `制御砲台を破壊して隔壁を開け（${game.controlsDestroyed}/${OBJECTIVE.controlsRequired}）`;
  const hint = sectorId ? hints[sectorId] : undefined;
  if (!hint) return generic;
  // この区画から開く隔壁（制御砲台が同じ区画にあるもの）
  const barrier = STAGE_DATA.barriers.find((b) => {
    const e = game.enemies.byId(b.controlTurretId);
    return e ? e.def.sectorId === sectorId : false;
  });
  if (barrier && game.stage.isBarrierOpen(barrier.id)) {
    const after = hint.split('。').slice(1).join('。').trim();
    const next = nextObjectivePosition();
    return `隔壁 ${barrier.label ?? barrier.id} 開放${after ? ' — ' + after : ''}${next ? `（次: ${next.label}）` : ''}`;
  }
  return hint;
}

function buildHudView(): HudView {
  const p = game.player;
  const stats = computeEffectiveStats(game.loadout);
  const fs = game.fireSolution;
  const cam = game.camera;
  let targetMarker: ScreenMarker | null = null;
  if (game.fcs.targetId) {
    const t = game.targetInfo(game.fcs.targetId);
    if (t && t.alive) targetMarker = marker(t.center);
  }
  let aimMarker: HudView['aimMarker'] = null;
  if (game.fcs.state === 'locked' && fs.status !== 'inactive' && fs.aimPoint) {
    aimMarker = { ...marker(fs.aimPoint), status: fs.status };
  }
  const telegraphMarkers: ScreenMarker[] = [];
  const controlTurretMarkers: HudView['controlTurretMarkers'] = [];
  for (const e of game.enemyViews()) {
    if (e.alive && e.telegraphing) telegraphMarkers.push(marker(e.center));
    if (e.isGateControl) controlTurretMarkers.push({ ...marker(e.center), id: e.id, alive: e.alive });
  }
  const objectivePos = nextObjectivePosition();
  const objectiveMarker = objectivePos ? { ...marker(objectivePos.position), label: objectivePos.label } : null;
  const denial = lastDenial && realNow - lastDenial.at < 1.5 ? { weapon: lastDenial.weapon, reason: lastDenial.reason, ageSeconds: realNow - lastDenial.at } : null;
  hitIndicators = hitIndicators.filter((h) => realNow - h.at < 1.0);
  const sectorId = game.currentSectorId;
  const hints = STAGE_DATA.objectiveHints;
  const qbCooldown = p.qbCooldownRemaining(game.time);
  return {
    state: game.state,
    viewportWidth: cam.viewportWidth,
    viewportHeight: cam.viewportHeight,
    elapsedSeconds: game.time,
    hp: p.hp,
    maxHp: PLAYER.maxHp,
    en: p.en,
    maxEn: stats.maxEn,
    regenPerSecond: stats.regenPerSecond,
    weapon: p.weapon,
    ammo: { machinegun: p.ammo.machinegun, missile: p.ammo.missile },
    beamEnCost: WEAPONS.beam.enCost,
    lock: {
      state: game.fcs.state,
      targetId: game.fcs.targetId,
      progress: game.fcs.progress,
      radiusCssPx: game.fcs.radiusCssPx(cam),
      lockSeconds: stats.lockSeconds,
    },
    targetMarker,
    aimMarker,
    fireControl: fs,
    fireDenied: denial,
    movement: {
      horizontalMode: p.horizontalMode,
      verticalMode: p.verticalMode,
      glideEnabled: p.glideEnabled,
      qbReady: p.canQuickBoost(game.time, input.isHeld('ControlLeft')),
      qbCooldownRemainingSeconds: qbCooldown,
      qbImpulseRemainingSeconds: p.qbImpulseRemaining,
      qbCost: PLAYER.qb.cost,
      speed: lengthXZ(p.vel),
      horizontalSpeedMultiplier: stats.horizontalSpeedMultiplier,
    },
    objective: {
      currentSectorId: sectorId,
      currentSectorName: game.stage.sectorName(sectorId),
      nextObjective: nextObjectiveText(sectorId, hints),
      controlsDestroyed: game.controlsDestroyed,
      controlsRequired: OBJECTIVE.controlsRequired,
      openBarrierIds: [...game.stage.openBarrierIds],
      recentBarrierLabel: recentBarrier && realNow - recentBarrier.at < 4 ? recentBarrier.label : null,
      gateOpen: game.stage.gateOpen,
      enemiesAlive: game.aliveEnemyCount(),
      enemiesTotal: OBJECTIVE.totalEnemies,
    },
    hitIndicators: hitIndicators.map((h) => ({ angle: h.angle, ageSeconds: realNow - h.at })),
    telegraphMarkers,
    controlTurretMarkers,
    objectiveMarker,
    pointerLockError,
  };
}

// ---------------------------------------------------------------------------
// メインループ（描画頻度に依存しない固定刻みシミュレーション）
// ---------------------------------------------------------------------------
let lastFrame = performance.now();
function frame(now: number): void {
  const dtReal = Math.min(SIM.maxFrameSeconds, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  realNow = now / 1000;

  if (game.state === 'playing') {
    game.setInput(input.poll());
    game.advance(dtReal);
  }
  const events = game.drainEvents();
  handleEvents(events);

  renderer.update({
    dtReal,
    camera: game.camera,
    player: game.playerView(),
    enemies: game.enemyViews(),
    projectiles: game.projectileViews(),
    events,
    time: game.time,
  });
  if (game.state !== 'garage') hud.update(buildHudView());
  requestAnimationFrame(frame);
}

// 初期状態: 格納庫
renderer.setGarageMode(true);
hud.setVisible(false);
garage.setVisible(true);
overlays.hide();
requestAnimationFrame(frame);

// 参考情報（状態変更 API は公開しない）
(window as unknown as { __ak2Info?: unknown }).__ak2Info = Object.freeze({ seed, stage: STAGE_DATA.id, guardHp: ENEMIES.guard.hp, turretHp: ENEMIES.turret.hp, remaining: () => length(sub(game.player.pos, STAGE_DATA.start.position)) });

// 開発サーバー限定の検証フック（本番ビルドには含まれない）。`?devhook` 付きで開いたときだけ、
// ポインターロックなしで出撃・再開し、キーボード・マウス入力をそのまま受け付ける。
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('devhook')) {
  (window as unknown as { __AK2_DEV?: unknown }).__AK2_DEV = {
    game,
    input,
    renderer,
    launchNoLock(): void {
      if (game.state === 'playing' || game.state === 'paused') return;
      input.requireLock = false;
      devNoAutoPause = true;
      beginRun();
    },
    resumeNoLock(): void {
      if (game.state !== 'paused') return;
      input.requireLock = false;
      game.resume();
      overlays.hide();
      input.clear();
      input.setEnabled(true);
    },
    pause(): void {
      pauseGame();
    },
    /** 3D ビューを 1 回描画して JPEG data URL を返す（自動検証用。HUD は含まない） */
    capture(quality = 0.85): string {
      renderer.update({ dtReal: 0, camera: game.camera, player: game.playerView(), enemies: game.enemyViews(), projectiles: game.projectileViews(), events: [], time: game.time });
      return renderer.renderer.domElement.toDataURL('image/jpeg', quality);
    },
    /** 入力フレームを直接注入して n フレーム進める（自動検証用） */
    step(frames: number, partial: Partial<import('./types').InputFrame>, dt = 1 / 60): void {
      for (let i = 0; i < frames; i++) {
        if (game.state !== 'playing') break;
        game.setInput({ ...input.poll(), ...partial });
        game.advance(dt);
        // イベントは通常の描画ループが drainEvents() で処理する（ここで消費しない）
      }
    },
  };
}
