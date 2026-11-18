/**
 * e2e 4 (一時停止) と 5 (失敗・結果画面・再出撃) と 9 の一部 (再出撃でのJSヒープ)。
 * 実ステージを本物のキー/マウスで歩き、警備ロボットの射線に入って HP 0 まで実際に到達させる。
 */
import type { Browser } from 'playwright';
import { formatTime } from '../../src/ui/hudLogic';
import { ROUTE_MAIN_POINTS } from '../../src/stage/routes';
import { PLAYER_START } from '../../src/stage/blueprint';
import type { Snapshot } from '../../src/sim/bench';
import { checkShape } from '../snapshotShape';
import { Sess, checks, dist3, f, jsonEq, near, ok, rec, standUntilEnd, state, walkPath } from './lib';

type E2EWin = { __e2e: { keys: { t: string; c: string; r: boolean }[]; events: string[]; rafCalls: number } };
const rafCalls = (s: Sess): Promise<number> => s.page.evaluate(() => (window as unknown as E2EWin).__e2e.rafCalls);

/** 2つのスナップショットの差分パス (再出撃で初期化されていない項目の検出) */
export function diffPaths(a: unknown, b: unknown, path = '$', out: string[] = []): string[] {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffPaths(a[i], b[i], `${path}[${i}]`, out);
  } else if (a !== null && typeof a === 'object' && b !== null) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    for (const k of new Set([...ka, ...kb])) diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
  } else if (a !== b) {
    out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  return out;
}

interface ResultInfo {
  visible: boolean;
  title: string;
  reason: string;
  rows: Record<string, string>;
  buttons: string[];
  hudHidden: boolean;
  lockEl: string | null;
}
async function resultInfo(s: Sess): Promise<ResultInfo> {
  return s.page.evaluate(() => {
    const o = document.querySelector('.screen-result') as HTMLElement | null;
    const rows: Record<string, string> = {};
    o?.querySelectorAll('.stat-k').forEach((k) => {
      rows[k.textContent ?? ''] = (k.nextElementSibling as HTMLElement | null)?.textContent ?? '';
    });
    return {
      visible: !!o && !o.hidden,
      title: o?.querySelector('.result-title')?.textContent ?? '',
      reason: o?.querySelector('.dialog-lead')?.textContent ?? '',
      rows,
      buttons: Array.from(o?.querySelectorAll('button') ?? []).map((b) => b.textContent ?? ''),
      hudHidden: (document.getElementById('hud') as HTMLElement).hidden === true,
      lockEl: document.pointerLockElement ? (document.pointerLockElement as HTMLElement).id : null,
    };
  });
}

/** 出撃位置から主経路を歩き、最初の被弾 (HP<980) まで進む。W は押したまま */
async function engage(s: Sess, maxSec = 40): Promise<Snapshot> {
  const r = await walkPath(s, ROUTE_MAIN_POINTS, { maxSec, dtMs: 100, until: (sn) => sn.player.hp < 980 });
  return r.snap;
}

/** 交戦して HP0 まで立ち止まる。失敗状態のスナップショットを返す (到達しなければ最後の状態) */
async function dieOnce(s: Sess): Promise<Snapshot> {
  let sn = await engage(s);
  if (sn.state !== 'playing') return sn;
  sn = await standUntilEnd(s, 150, 200);
  if (sn.state === 'playing') {
    // 立ち止まって撃たれなかった場合: さらに進んで敵の射線に入る (現在位置に最も近い経路点の次から)
    const p = sn.player.position;
    let nearIdx = 0;
    let best = Infinity;
    ROUTE_MAIN_POINTS.forEach((q, i) => {
      const d = Math.hypot(q.x - p[0], q.z - p[2]);
      if (d < best) {
        best = d;
        nearIdx = i;
      }
    });
    const r = await walkPath(s, ROUTE_MAIN_POINTS, { maxSec: 120, dtMs: 100, start: nearIdx + 1 });
    sn = r.snap;
    if (sn.state === 'playing') sn = await standUntilEnd(s, 150, 200);
  }
  return sn;
}

async function domCounts(s: Sess): Promise<Record<string, number>> {
  return s.page.evaluate(() => ({
    canvas: document.querySelectorAll('canvas').length,
    hudPanels: document.querySelectorAll('.hud-panel').length,
    overlays: document.querySelectorAll('.overlay').length,
    screensChildren: (document.getElementById('screens') as HTMLElement).children.length,
    hudSvg: document.querySelectorAll('.hud-svg').length,
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
export async function section45(browser: Browser, base: string): Promise<void> {
  state.section = 4;
  const S = await Sess.open(browser, base, 'combat');
  await S.step(2, 50);
  const first = await S.sortie();
  const initial = first; // 出撃直後 (t=0) の全状態: 再出撃後の比較基準 (視点 yaw は出撃位置の π と既知)
  const heap: { label: string; mb: number }[] = [{ label: '1回目の出撃 (t=0)', mb: await S.heapUsedMB() }];
  const listeners0 = await S.listenerCounts();
  const dom0 = await domCounts(S);
  ok('4.0', '実ステージで出撃: 敵45体・全員 alive・制御砲台0/6・隔壁なし', first.enemies.length === 45 && first.enemies.every((e) => e.alive) && first.objective.controlsDestroyed === 0 && first.objective.openBarrierIds.length === 0 && !first.objective.gateOpen, `敵=${first.enemies.length} alive=${first.enemies.filter((e) => e.alive).length} 位置=${first.player.position.map((x) => f(x, 1)).join(',')}`);

  // ---- 交戦開始 (最初の被弾) まで歩く
  const hit = await engage(S);
  ok('4.1', '実ステージを W + マウス視点で歩き、警備ロボットの攻撃を受ける (被弾方向・予告のHUDも確認)', hit.state === 'playing' && hit.player.hp < 980, `t=${f(hit.elapsedSeconds, 1)}s 位置=${hit.player.position.map((x) => f(x, 1)).join(',')} HP=${f(hit.player.hp, 0)} alert=${hit.enemies.filter((e) => e.alert).map((e) => e.id).join(',')}`);
  await S.shot('combat-first-hit', '交戦開始 (最初の被弾。ロック・補正マーカー・予告・被弾方向)');
  // 後退しながら QB を1回 (Q は押しっぱなし): 以降の一時停止試験で「Qを押したまま」を再現し、EN>=36 かつ待ち時間なしにする
  await S.up('KeyW');
  await S.down('KeyS');
  await S.down('KeyQ');
  await S.play(1.6, 50);
  const q0 = await S.snap();

  // ---- 一時停止の各トリガー
  interface Case {
    name: string;
    synthetic: boolean;
    fire: () => Promise<void>;
    after?: () => Promise<void>;
  }
  let extraPage: import('playwright').Page | null = null;
  const cases: Case[] = [
    { name: 'Esc キー (page.keyboard.press)', synthetic: false, fire: async () => void (await S.page.keyboard.press('Escape')) },
    { name: 'ポインターロック喪失 (document.exitPointerLock。keydown なし)', synthetic: false, fire: async () => void (await S.page.evaluate(() => document.exitPointerLock())) },
    {
      name: 'ウィンドウのフォーカス喪失 (別タブを前面化 -> ポインターロック喪失)',
      synthetic: false,
      fire: async () => {
        extraPage = await S.ctx.newPage();
        await extraPage.goto('about:blank');
        await extraPage.bringToFront();
      },
      after: async () => {
        await S.page.bringToFront();
        await extraPage?.close();
        extraPage = null;
      },
    },
    { name: 'window の blur イベント (合成)', synthetic: true, fire: async () => void (await S.page.evaluate(() => void window.dispatchEvent(new Event('blur')))) },
    {
      name: 'visibilitychange (document.hidden=true。合成)',
      synthetic: true,
      fire: async () => {
        await S.page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
      },
      after: async () => {
        await S.page.evaluate(() => {
          delete (document as unknown as { hidden?: boolean }).hidden;
        });
      },
    },
  ];

  let enemiesMoved = false;
  let caseNo = 0;
  for (const c of cases) {
    caseNo++;
    await S.down('KeyS'); // 押しっぱなし (repeat)
    await S.down('KeyQ');
    const pre0 = await S.snap();
    if (pre0.state !== 'playing') {
      rec(`4.${caseNo}`, `一時停止トリガー: ${c.name}`, 'unverified', `事前に state=${pre0.state} (失敗) になったため試験できず`);
      continue;
    }
    await S.play(0.5, 50);
    const A = await S.snap();
    const moved = A.enemies.some((e, i) => e.alive && dist3(e.position, pre0.enemies[i].position) > 0.3);
    enemiesMoved = enemiesMoved || moved;
    const dirBefore = A.player.movement.desiredHorizontalDirection;
    await c.fire();
    const P0 = await S.waitState('paused', 10000).catch(() => S.snap());
    await S.waitUntil(async () => S.page.evaluate(() => document.pointerLockElement === null), 5000, 'pointer lock released').catch(() => {});
    const ui = await S.page.evaluate(() => ({
      overlay: !(document.querySelector('.screen-pause') as HTMLElement).hidden,
      reason: document.querySelector('.screen-pause .dialog-lead')?.textContent ?? '',
      lock: document.pointerLockElement ? 'locked' : 'released',
      hudVisible: !(document.getElementById('hud') as HTMLElement).hidden,
    }));
    const rafB = await rafCalls(S);
    await S.step(30, 100); // 3秒分のフレーム (fake clock)。一時停止中は何も進まないはず
    const P1 = await S.snap();
    const rafA = await rafCalls(S);
    const frozen = jsonEq(P0, P1);
    ok(
      `4.${caseNo}a`,
      `一時停止 [${c.name}]${c.synthetic ? ' (合成イベント)' : ''}: state=paused、一時停止画面が出て、ロックが解除される`,
      P0.state === 'paused' && ui.overlay && ui.lock === 'released',
      `state=${P0.state} 画面=${ui.overlay} ロック=${ui.lock} 理由=「${ui.reason}」 HUD表示=${ui.hudVisible}`,
    );
    if (c.synthetic) checks_markSynthetic(`4.${caseNo}a`);
    ok(
      `4.${caseNo}b`,
      `一時停止中 (3秒分のフレームを実行) に 経過時間・HP・EN・ロック・QB待ち時間・敵の位置/HP/射撃数 が進まない (スナップショット全体が不変)`,
      frozen && rafA - rafB >= 30,
      `経過 ${f(P0.elapsedSeconds, 4)} -> ${f(P1.elapsedSeconds, 4)} / HP ${f(P0.player.hp, 1)} -> ${f(P1.player.hp, 1)} / EN ${f(P0.player.en, 2)} -> ${f(P1.player.en, 2)} / 敵 alive ${P0.enemies.filter((e) => e.alive).length} 全体一致=${frozen} / その間の rAF ${rafA - rafB}回 (ループは動作中) / 直前の1秒に動いていた敵=${moved}`,
    );
    if (c.after) await c.after();
    await S.click('.screen-pause .btn-primary'); // 再開 (実クリック)
    const R0 = await S.waitState('playing', 30000);
    const lockAfter = await S.page.evaluate(() => (document.pointerLockElement ? (document.pointerLockElement as HTMLElement).id : null));
    await S.step(1, 50);
    const R1 = await S.snap();
    const qCount = P0.player.movement.qbSuccessfulCount;
    ok(
      `4.${caseNo}c`,
      '再開ボタンの実クリックでロックを再取得して playing。停止中の時間はまとめて加算されず (再開時点で経過時間が同じ、1フレーム後も +0.05秒以内)、クリックが射撃にならない',
      lockAfter === 'game-canvas' && R0.elapsedSeconds === P0.elapsedSeconds && R1.elapsedSeconds - P0.elapsedSeconds <= 0.05 + 1e-9 && R1.player.ammo.machinegun === P0.player.ammo.machinegun && R1.recentPlayerShots.length === P0.recentPlayerShots.length,
      `ロック=${lockAfter} 経過 ${f(P0.elapsedSeconds, 4)} -> 再開直後 ${f(R0.elapsedSeconds, 4)} -> +1フレーム ${f(R1.elapsedSeconds, 4)} / MG ${P0.player.ammo.machinegun} -> ${R1.player.ammo.machinegun} / 射撃履歴 ${P0.recentPlayerShots.length} -> ${R1.recentPlayerShots.length}`,
    );
    // desiredHorizontalDirection は「水平移動が向かっている方向」 (src/sim/player.ts headingDirection): キーが無くても、QB 後の自動グライド/グライド中は
    // 保持したグライド方向を返す。この試験は Q を押してから止めるので、再開後にグライドが続いていれば同じ向きのまま (= 入力の有無とは区別できない)。
    // 入力が解除されていれば [0,0] (歩行) か、グライド保持の同じ方向のどちらか。解除されずに S が効き続ける場合は歩行に戻らない/向きが変わる
    const dirAfter = R1.player.movement.desiredHorizontalDirection;
    const dirZero = dirAfter[0] === 0 && dirAfter[1] === 0;
    const glideHeld = R1.player.movement.glideEnabled && Math.hypot(dirAfter[0] - dirBefore[0], dirAfter[1] - dirBefore[1]) < 1e-6;
    ok(
      `4.${caseNo}d`,
      '一時停止で入力状態が解除される: 再開後、新しいキー操作が来るまで移動入力は無効 (S を押したままでも desiredDirection=[0,0]。グライド中は保持したグライド方向のまま)',
      Math.abs(dirBefore[0]) + Math.abs(dirBefore[1]) > 0.5 && (dirZero || glideHeld),
      `停止前 desiredDir=${dirBefore.map((x) => f(x, 2)).join(',')} -> 再開後(キー操作なし) ${dirAfter.map((x) => f(x, 4)).join(',')} (${dirZero ? '入力なし・歩行 = [0,0]' : glideHeld ? `グライド保持 (glideEnabled=${R1.player.movement.glideEnabled} mode=${R1.player.movement.horizontalMode})` : '入力が残っている疑い'})`,
    );
    // Q と S を押したまま (OS のキーリピート = repeat=true) 復帰: Q は新しい押下として扱われない。S は level 入力なので復帰する
    const enOk = R1.player.en >= 36 && R1.player.movement.qbCooldownRemainingSeconds === 0;
    await S.down('KeyQ');
    await S.down('KeyS');
    await S.play(1.0, 50);
    const R2 = await S.snap();
    ok(
      `4.${caseNo}e`,
      '復帰時に Q を押しっぱなし (keydown repeat) にしていても新しい押下として扱われず QB が発動しない (EN>=36・待ち時間0で再発動可能な状態)',
      R2.player.movement.qbSuccessfulCount === qCount && enOk,
      `qbCount ${qCount} -> ${R2.player.movement.qbSuccessfulCount} / 復帰時 EN=${f(R1.player.en, 1)} cd=${f(R1.player.movement.qbCooldownRemainingSeconds, 2)} / 移動入力は復帰 desiredDir=${R2.player.movement.desiredHorizontalDirection.map((x) => f(x, 2)).join(',')}`,
    );
    if (R2.state !== 'playing') break;
  }
  ok('4.6', '一時停止の試験中、交戦中の敵が実際に動いていた (敵位置の不変が自明でないことの確認)', enemiesMoved, `動いた敵あり=${enemiesMoved}`);

  // ---- 一時停止画面から操作説明
  await S.up('KeyS');
  await S.up('KeyQ');
  const preHelp = await S.snap();
  if (preHelp.state === 'playing') {
    await S.page.keyboard.press('Escape');
    await S.waitState('paused', 10000);
    await S.click('.screen-pause button:has-text("操作方法")');
    const help = await S.page.evaluate(() => {
      const o = document.querySelector('.help-overlay') as HTMLElement | null;
      return { visible: !!o && !o.hidden, text: o?.textContent ?? '' };
    });
    await S.shot('pause-help', '一時停止画面から開いた操作説明');
    ok('4.7', '一時停止画面の「操作方法」から操作説明が見られる (Q単発36EN・自動グライド等を含む)', help.visible && help.text.includes('36 EN') && help.text.includes('自動でグライド'), `visible=${help.visible}`);
    await S.page.keyboard.press('Escape'); // 操作説明を閉じる (再開・ロックにはならない)
    const stillPaused = await S.snap();
    ok('4.8', 'その操作説明を Esc で閉じても一時停止のまま (勝手に再開しない)', stillPaused.state === 'paused', `state=${stillPaused.state}`);
    await S.shot('pause', '一時停止画面');
    await S.click('.screen-pause .btn-primary');
    await S.waitState('playing', 30000);
  }

  // ---- 失敗まで
  state.section = 5;
  const preFail = await S.snap();
  ok('4.9', '一時停止の全試験後も、ここまで警備ロボットの攻撃で HP が減っている (実際の被弾)', preFail.player.hp < 1000, `HP=${f(preFail.player.hp, 0)}`);
  const failed1 = await standUntilEnd(S, 200, 200);
  const res1 = await resultInfo(S);
  await S.step(20, 100);
  const failed1b = await S.snap();
  const kills1 = failed1.enemies.filter((e) => !e.alive).length;
  ok('5.1', '敵の射線に入って HP 0 まで実際に到達し、state=failed になる (hp<=0)', failed1.state === 'failed' && failed1.player.hp <= 0, `state=${failed1.state} HP=${f(failed1.player.hp, 2)} 経過=${f(failed1.elapsedSeconds, 2)}s 位置=${failed1.player.position.map((x) => f(x, 1)).join(',')}`);
  ok(
    '5.2',
    '結果画面: MISSION FAILED・理由 (HP 0)・経過時間・撃破数・制御砲台数と、「同じ構成で再出撃」「格納庫へ戻る」が出る。HP0後、戦闘の更新は停止し、ロックも解除される',
    res1.visible && res1.title === 'MISSION FAILED' && res1.reason.includes('HP') && res1.rows['経過時間'] === formatTime(failed1.elapsedSeconds) && res1.rows['撃破数'] === `${kills1} / 45` && res1.rows['制御砲台'] === `${failed1.objective.controlsDestroyed} / 6` && res1.buttons.some((b) => b.includes('同じ構成で再出撃')) && res1.buttons.some((b) => b.includes('格納庫へ')) && failed1b.elapsedSeconds === failed1.elapsedSeconds && res1.hudHidden && res1.lockEl === null,
    `title=${res1.title} 理由=「${res1.reason}」 行=${JSON.stringify(res1.rows)} ボタン=${res1.buttons.join(' / ')} 経過(stateのformatTime)=${formatTime(failed1.elapsedSeconds)} 失敗後20フレームの経過 ${f(failed1.elapsedSeconds, 4)} -> ${f(failed1b.elapsedSeconds, 4)} HUD非表示=${res1.hudHidden} ロック=${res1.lockEl}`,
  );
  await S.shot('result-failed', '失敗の結果画面');
  const errFailed = checkShape(failed1);
  ok('5.3', 'failed 状態のスナップショットが SPEC §10 の構造と一致 (NaN/Infinity なし)', errFailed.length === 0, errFailed.length ? errFailed.slice(0, 4).join(' ; ') : 'キー・型・列挙値が一致');
  rec('5.4', 'クリア (cleared) の結果画面・再出撃', 'unverified', '実ステージのクリア (6体の制御砲台の破壊 + 15区画・1500m の踏破) には本ツールの歩行ドライバーでは到達できなかったため実機では未確認。結果画面の表示モデルは tests/hud.test.ts の「6体全て破壊 → 最終ゲート開放 → 脱出可能表示 → 脱出領域でクリア (結果画面の値も state 由来)」で実際の Game を使って検証済み (DOM 表示は failed と同じコード経路)');

  // ---- 再出撃 x3 (毎回: 初期化・重複ループ/リスナーなし)
  const cycles: string[] = [];
  let lastFailed = failed1;
  for (let k = 1; k <= 3; k++) {
    await S.click('.screen-result .btn-primary'); // 同じ構成で再出撃 (実クリック)
    const r0 = await S.waitState('playing', 30000);
    const lockEl = await S.page.evaluate(() => (document.pointerLockElement ? (document.pointerLockElement as HTMLElement).id : null));
    const diffs = diffPaths(initial, r0);
    ok(
      `5.${4 + k}a`,
      `再出撃 ${k}回目: 位置・速度・HP・EN・弾数・全45体・隔壁・ゲート・目標・ロック・QB・経過時間が出撃直後と完全に同じ (スナップショット全体の差分0)、ロック再取得、結果画面が消える`,
      diffs.length === 0 && lockEl === 'game-canvas' && r0.elapsedSeconds === 0 && r0.enemies.every((e) => e.alive && e.hp > 0 && !e.alert && e.shotsFired === 0) && r0.player.hp === 1000 && r0.player.en === r0.effectiveStats.maxEn,
      `差分 ${diffs.length}件${diffs.length ? ': ' + diffs.slice(0, 5).join(' ; ') : ''} / 位置=${r0.player.position.join(',')} (出撃位置=${PLAYER_START.pos.x},${PLAYER_START.pos.y},${PLAYER_START.pos.z}) HP=${r0.player.hp} EN=${r0.player.en} 弾=${r0.player.ammo.machinegun}/${r0.player.ammo.missile} 敵alive=${r0.enemies.filter((e) => e.alive).length} 隔壁=[${r0.objective.openBarrierIds}] ゲート=${r0.objective.gateOpen} 経過=${r0.elapsedSeconds} qb=${r0.player.movement.qbSuccessfulCount} glide=${r0.player.movement.glideEnabled} ロック=${lockEl}`,
    );
    // 重複ループの検出: 1フレーム(rAF 1回)=1回だけ advance する (経過時間が2倍速で進まない)
    const rB = await rafCalls(S);
    for (let i = 0; i < 5; i++) await S.step(1, 100);
    const rA = await rafCalls(S);
    const t5 = await S.snap();
    ok(
      `5.${4 + k}b`,
      `再出撃 ${k}回目: 更新ループが重複していない — 5フレーム(各dt=100ms)で elapsedSeconds が0.5秒だけ進み (2倍速でない)、rAF は1フレームにつき1回`,
      near(t5.elapsedSeconds - r0.elapsedSeconds, 0.5, 0.01) && rA - rB === 5,
      `Δelapsed=${f(t5.elapsedSeconds - r0.elapsedSeconds, 4)} (期待0.5000) / rAF ${rA - rB}回 (期待5)`,
    );
    // リスナー: Q 1回押下 = QB 成功1回、マウス 100px = yaw 0.22rad (二重登録なら 2倍)
    await S.calibrateYaw();
    const yawB = S.yaw;
    await S.look(100, 0);
    const yawExpect = S.yaw;
    const yawMeasured = await S.calibrateYaw();
    const en0 = (await S.snap()).player.en;
    await S.down('KeyQ');
    await S.step(1, 16);
    await S.up('KeyQ');
    await S.step(1, 16);
    const q1 = await S.snap();
    const lc = await S.listenerCounts();
    const lcDiff = Object.keys({ ...listeners0, ...lc }).filter((key) => (listeners0[key] ?? 0) !== (lc[key] ?? 0));
    const domK = await domCounts(S);
    const domDiff = Object.keys(dom0).filter((key) => dom0[key] !== domK[key]);
    ok(
      `5.${4 + k}c`,
      `再出撃 ${k}回目: イベントリスナーが重複していない — Q 1回押下で QB 成功1回 (EN-36)、マウス100pxで yaw 0.22rad、window/document のリスナー数と DOM の主要ノード数が1回目の出撃時と同じ`,
      q1.player.movement.qbSuccessfulCount === 1 && near(en0 - q1.player.en, 36, 1e-6) && near(yawB - yawMeasured, 0.22, 0.004) && near(yawMeasured, yawExpect, 0.004) && lcDiff.length === 0 && domDiff.length === 0,
      `qbCount=${q1.player.movement.qbSuccessfulCount} EN低下=${f(en0 - q1.player.en, 4)} / yaw差=${f(yawB - yawMeasured, 4)}rad (期待0.2200) / リスナー差分=${lcDiff.length ? lcDiff.map((d) => `${d}:${listeners0[d] ?? 0}->${lc[d] ?? 0}`).join(',') : 'なし'} (window/document 合計 ${Object.values(lc).reduce((a, b) => a + b, 0)}件) / DOM差分=${domDiff.length ? domDiff.join(',') : 'なし'}`,
    );
    heap.push({ label: `再出撃${k}回目 (t≈1s)`, mb: await S.heapUsedMB() });
    cycles.push(`#${k} ok`);
    if (k === 1) {
      await S.shot('retry-start', '再出撃直後 (初期化された状態のHUD)');
    }
    lastFailed = await dieOnce(S);
    const rr = await resultInfo(S);
    ok(`5.${4 + k}d`, `再出撃 ${k}回目の後も、再び HP 0 まで実際に到達して失敗の結果画面が出る`, lastFailed.state === 'failed' && rr.visible && rr.title === 'MISSION FAILED', `state=${lastFailed.state} 経過=${f(lastFailed.elapsedSeconds, 1)}s 画面=${rr.visible} ${rr.title}`);
    if (lastFailed.state !== 'failed') break;
  }

  // ---- 格納庫へ戻る -> 再出撃
  if (lastFailed.state === 'failed') {
    await S.click('.screen-result .dialog-buttons .btn:not(.btn-primary)'); // 格納庫へ戻る
    const g = await S.waitState('garage', 15000);
    const gui = await S.page.evaluate(() => ({ garage: !(document.getElementById('garage') as HTMLElement).hidden, result: !(document.querySelector('.screen-result') as HTMLElement).hidden, hud: !(document.getElementById('hud') as HTMLElement).hidden }));
    ok('5.8', '「格納庫へ戻る」で格納庫 (state=garage、経過0、敵45体alive) に戻り、結果画面・HUDが消える', g.state === 'garage' && g.elapsedSeconds === 0 && g.enemies.every((e) => e.alive) && gui.garage && !gui.result && !gui.hud, `state=${g.state} 経過=${g.elapsedSeconds} 格納庫=${gui.garage} 結果画面=${gui.result} HUD=${gui.hud}`);
    await S.step(3, 50);
    await S.click('.gar-buttons .btn-primary');
    const again = await S.waitState('playing', 30000);
    const dd = diffPaths(initial, again);
    ok('5.9', '格納庫からの再出撃でも出撃直後の状態と完全に同じ (差分0)', dd.length === 0, `差分 ${dd.length}件${dd.length ? ': ' + dd.slice(0, 5).join(' ; ') : ''}`);
    await S.step(5, 100);
    heap.push({ label: '格納庫経由の出撃 (t≈0.5s)', mb: await S.heapUsedMB() });
  }
  const h = heap.map((x) => x.mb);
  const growth = h.length >= 4 ? h[3] - h[1] : NaN;
  ok(
    '5.10',
    '再出撃を繰り返しても JS ヒープ (GC後) が増え続けない (3回目が1回目の再出撃時と比べ +8MB 以内、かつ +30% 以内)',
    h.length >= 4 && growth < 8 && h[3] <= h[1] * 1.3,
    heap.map((x) => `${x.label}: ${f(x.mb, 1)}MB`).join(' / '),
    { heap },
  );
  const pr = S.appProblems();
  ok('5.11', '戦闘・一時停止・失敗・再出撃の全体を通して、コンソールのエラー/警告が出ない', pr.length === 0, pr.length ? pr.slice(0, 4).map((p) => `${p.type}: ${p.text}`).join(' | ') : 'エラー0 / 警告0');
  await S.close();
}

/** 直近に記録したチェックの status を synthetic に変える (合成イベントでの確認を区別する) */
function checks_markSynthetic(id: string): void {
  const c = checks.find((x) => x.id === id);
  if (c && c.status === 'pass') c.status = 'synthetic';
}
