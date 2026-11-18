/**
 * e2e 1 (起動→格納庫) と 2 (出撃/ポインターロック)。
 */
import type { Browser } from 'playwright';
import { relative } from 'node:path';
import { DEFAULT_LOADOUT, DEFAULT_SEED, FCS_PARTS, GENERATOR_PARTS, LEGS_PARTS, PLAYER } from '../../src/config';
import { checkShape } from '../snapshotShape';
import { ROOT, Sess, f, images, jsonEq, near, ok, rec, sleep, state } from './lib';

const HELP_PHRASES = [
  '対象をFCS円の中に保つだけで偏差と重力を自動補正する',
  '中央の照準を補正マーカーへ手動で合わせる必要はない',
  '単発',
  '36 EN',
  '自動でグライド',
  'グライドは0 EN',
  '左Ctrl',
  'Shift',
];

export async function section1(browser: Browser, base: string): Promise<void> {
  state.section = 1;

  // ---- 1a. 起動 (実時間の rAF)。スクリーンショットの前にコンソールを確認する (ReadPixels の GL ドライバー警告を混ぜないため)
  const b = await Sess.open(browser, base, 'boot', { stepped: false });
  await b.waitUntil(async () => (await b.page.evaluate(() => (window as unknown as { __e2e: { rafCalls: number } }).__e2e.rafCalls)) >= 3, 90000, '3 frames');
  await sleep(1500);
  const bootProblems = b.appProblems();
  ok('1.1', '起動〜格納庫表示でコンソールのエラー/警告が出ない (スクリーンショット前)', bootProblems.length === 0, bootProblems.length === 0 ? 'エラー0 / 警告0' : bootProblems.map((p) => `${p.type}: ${p.text}`).join(' | '));
  const net = b.logs.filter((l) => l.kind === 'http' || l.kind === 'requestfailed');
  const fav = await b.page.evaluate(() => {
    const l = document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null;
    return l ? l.href : null;
  });
  ok('1.2', 'favicon: インラインの data URI があり、404 / 通信失敗が出ない', net.length === 0 && !!fav && fav.startsWith('data:image/svg+xml'), `icon href=${fav ? fav.slice(0, 28) + '...' : 'なし'} / 失敗リクエスト ${net.length}件${net.length ? ': ' + net.map((n) => n.text).join(' | ') : ''}`);
  const s0 = await b.snap();
  ok('1.3', '起動後は格納庫 (state=garage)、既定のシード 20260908、既定の構成', s0.state === 'garage' && s0.seed === DEFAULT_SEED && jsonEq(s0.loadout, DEFAULT_LOADOUT), `state=${s0.state} seed=${s0.seed} loadout=${JSON.stringify(s0.loadout)}`);
  const sel0 = await b.page.evaluate(() => Array.from(document.querySelectorAll('.card[aria-checked="true"]')).map((e) => (e as HTMLElement).dataset.part));
  ok('1.4', '初期選択 = 中範囲FCS・均衡ジェネレーター・2脚 (格納庫UIの選択状態)', jsonEq(sel0.sort(), ['fcs:medium', 'generator:balanced', 'legs:biped']), sel0.join(', '));
  await b.shot('hangar-boot', '起動直後の格納庫 (実時間描画)');
  const noiseAfter = b.driverNoise();
  rec('1.5', 'スクリーンショット後に出る GL ドライバー警告 (SwiftShader の ReadPixels 警告。アプリのログではない)', 'info', `${noiseAfter}件`);
  await b.close();

  // ---- 1b. 18構成 (stepped)
  const g = await Sess.open(browser, base, 'garage');
  await g.step(3, 50);
  const bad: string[] = [];
  let combos = 0;
  const rows: Record<string, unknown>[] = [];
  const vmin = 720;
  for (const fcs of Object.keys(FCS_PARTS) as (keyof typeof FCS_PARTS)[]) {
    for (const gen of Object.keys(GENERATOR_PARTS) as (keyof typeof GENERATOR_PARTS)[]) {
      for (const legs of Object.keys(LEGS_PARTS) as (keyof typeof LEGS_PARTS)[]) {
        await g.click(`[data-part="fcs:${fcs}"]`);
        await g.click(`[data-part="generator:${gen}"]`);
        await g.click(`[data-part="legs:${legs}"]`);
        await g.step(1, 50);
        const dom = await g.page.evaluate(() => ({
          stats: Array.from(document.querySelectorAll('.gar-stats .stat-v')).map((e) => e.textContent ?? ''),
          checked: Array.from(document.querySelectorAll('.card[aria-checked="true"]')).map((e) => (e as HTMLElement).dataset.part ?? ''),
          selected: document.querySelector('.gar-selected')?.textContent ?? '',
        }));
        const sn = await g.snap();
        const F = FCS_PARTS[fcs];
        const G = GENERATOR_PARTS[gen];
        const L = LEGS_PARTS[legs];
        const exp = {
          maxEn: G.maxEn,
          regen: G.baseRegen * L.regenMult,
          lock: F.baseLockSeconds / L.lockSpeedMult,
          radius: F.radiusRatio,
          walk: PLAYER.WALK_SPEED * L.speedMult,
          glide: PLAYER.GLIDE_SPEED_GROUND * L.speedMult,
          air: PLAYER.AIR_SPEED * L.speedMult,
          qb: PLAYER.QB.SPEED * L.speedMult,
        };
        const shown = dom.stats.map((t) => parseFloat(t.replace(/[^0-9.\-]/g, '')));
        const keys = ['maxEn', 'regen', 'lock', 'radius', 'walk', 'glide', 'air', 'qb'] as const;
        const tag = `${fcs}/${gen}/${legs}`;
        keys.forEach((k, i) => {
          // 表示は小数2桁までに丸めている
          if (!near(shown[i], exp[k], 0.0051)) bad.push(`${tag}: ${k} 表示=${dom.stats[i]} 期待=${exp[k]}`);
        });
        const e = sn.effectiveStats;
        if (!(near(e.maxEn, exp.maxEn, 1e-9) && near(e.regenPerSecond, exp.regen, 1e-9) && near(e.lockSeconds, exp.lock, 1e-9) && near(e.horizontalSpeedMultiplier, L.speedMult, 1e-9))) {
          bad.push(`${tag}: snapshot.effectiveStats=${JSON.stringify(e)}`);
        }
        if (!jsonEq(sn.loadout, { fcs, generator: gen, legs })) bad.push(`${tag}: snapshot.loadout=${JSON.stringify(sn.loadout)}`);
        if (!jsonEq([...dom.checked].sort(), [`fcs:${fcs}`, `generator:${gen}`, `legs:${legs}`])) bad.push(`${tag}: 選択状態=${dom.checked.join(',')}`);
        if (!near(sn.lock.radiusCssPx, F.radiusRatio * vmin, 1e-9)) bad.push(`${tag}: lock.radiusCssPx=${sn.lock.radiusCssPx}`);
        if (!dom.selected.includes(F.name) || !dom.selected.includes(G.name) || !dom.selected.includes(L.name)) bad.push(`${tag}: 選択中表示=${dom.selected}`);
        rows.push({ tag, shown: dom.stats, exp });
        combos++;
      }
    }
  }
  ok('1.6', `18構成 (FCS3×ジェネレーター3×脚部2) を全て実クリックで選択でき、表示される実効値 (最大EN・EN回復率・ロック所要時間・ロック領域・歩行/グライド/空中/QB速度) が config・snapshot と一致`, combos === 18 && bad.length === 0, `${combos}構成を確認${bad.length ? ' / 不一致: ' + bad.slice(0, 6).join(' ; ') : ' / 不一致0'}`, { rows: rows.slice(0, 3) });

  // ---- 1c. 脚部でモデルが変わる (見た目はスクリーンショットを目視で確認する)
  await g.click('[data-part="fcs:medium"]');
  await g.click('[data-part="generator:balanced"]');
  await g.click('[data-part="legs:biped"]');
  await g.step(6, 50);
  const shotBiped = await g.shot('hangar-biped', '格納庫: 2脚 (中範囲FCS・均衡・2脚)');
  await g.click('[data-part="legs:quadruped"]');
  await g.step(6, 50);
  const shotQuad = await g.shot('hangar-quad', '格納庫: 4脚 (中範囲FCS・均衡・4脚)');
  await g.step(45, 100); // ゆっくり回転する: 斜め/側面から脚の本数を確認する
  const shotQuad2 = await g.shot('hangar-quad-turn1', '格納庫: 4脚 (回転後 4.5秒)');
  await g.step(40, 100);
  const shotQuad3 = await g.shot('hangar-quad-turn2', '格納庫: 4脚 (回転後 8.5秒)');
  rec('1.7', '脚部を変えると3Dモデルが変わる (2脚 / 4脚。4脚は脚が4本) — スクリーンショットの目視で確認', 'info', [shotBiped, shotQuad, shotQuad2, shotQuad3].map((p) => relative(ROOT, p)).join(' / '));

  // ---- 1d. 操作説明パネル
  await g.click('[data-part="legs:biped"]');
  await g.click('.gar-buttons .btn:not(.btn-primary)');
  const help = await g.page.evaluate(() => {
    const o = document.querySelector('.help-overlay') as HTMLElement | null;
    return { visible: !!o && !o.hidden, text: o?.textContent ?? '' };
  });
  const miss = HELP_PHRASES.filter((p) => !help.text.includes(p));
  ok('1.8', '格納庫の「操作方法を確認」で操作説明が開き、SPEC §8 の必須記述 (自動補正・手動で合わせない・Qは単発36EN・自動グライド・グライドは0EN・左Ctrl/Shift) を含む', help.visible && miss.length === 0, `visible=${help.visible} 欠落=${miss.length ? miss.join(' / ') : 'なし'}`);
  await g.shot('help', '格納庫から開いた操作説明');
  await g.page.keyboard.press('Escape');
  const closed = await g.page.evaluate(() => (document.querySelector('.help-overlay') as HTMLElement).hidden === true);
  const st = (await g.snap()).state;
  ok('1.9', '操作説明は Esc で閉じられ、格納庫のまま (state=garage)', closed && st === 'garage', `closed=${closed} state=${st}`);
  await g.click('.gar-buttons .btn:not(.btn-primary)');
  await g.click('.help-overlay .dialog-head .btn');
  const closed2 = await g.page.evaluate(() => (document.querySelector('.help-overlay') as HTMLElement).hidden === true);
  ok('1.10', '操作説明は「閉じる」ボタンでも閉じられる', closed2, `closed=${closed2}`);
  const gp = g.appProblems();
  ok('1.11', '格納庫の操作 (構成選択 18通り・操作説明) 中にコンソールのエラー/警告が出ない', gp.length === 0, gp.length ? gp.map((p) => p.text).join(' | ') : 'エラー0 / 警告0');
  await g.close();
  void images;
}

// ---------------------------------------------------------------------------------------------------------------------
export async function section2(browser: Browser, base: string): Promise<void> {
  state.section = 2;
  const s = await Sess.open(browser, base, 'sortie');
  await s.step(2, 50);
  const g0 = await s.snap();
  const errs0 = checkShape(g0);
  ok('2.0', '出撃前 (garage) のスナップショットが SPEC §10 の構造と一致', errs0.length === 0, errs0.length ? errs0.slice(0, 4).join(' ; ') : 'キー・型・列挙値が一致');

  await s.click('.gar-buttons .btn-primary'); // 実クリック
  const p0 = await s.waitState('playing', 30000);
  const lock = await s.page.evaluate(() => document.pointerLockElement?.id ?? null);
  ok('2.1', '出撃ボタンの実クリックからポインターロックを取得し、state=playing になる', lock === 'game-canvas' && p0.state === 'playing', `pointerLockElement=${lock} state=${p0.state} 経過=${f(p0.elapsedSeconds)}s`);
  await s.step(40, 16);
  const p1 = await s.snap();
  ok(
    '2.2',
    '出撃ボタンのクリックが射撃にならない (残弾・EN・射撃履歴が変化しない)',
    p1.player.ammo.machinegun === 300 && p1.player.ammo.missile === 12 && p1.player.en === p0.player.en && p1.recentPlayerShots.length === 0,
    `40フレーム後 MG=${p1.player.ammo.machinegun} MS=${p1.player.ammo.missile} EN=${p1.player.en} shots=${p1.recentPlayerShots.length} 経過=${f(p1.elapsedSeconds)}s`,
  );
  const errs1 = checkShape(p1);
  ok('2.3', 'playing 中のスナップショットが SPEC §10 の構造と一致 (NaN/Infinity なし)', errs1.length === 0, errs1.length ? errs1.slice(0, 4).join(' ; ') : 'キー・型・列挙値が一致');

  // ---- 2b. 再開でロックが取れない場合 (ページ側で requestPointerLock を失敗させる)。一時停止のまま進まず、説明と再試行が出る
  await s.page.keyboard.press('Escape');
  const paused = await s.waitState('paused', 10000);
  await s.page.evaluate(() => {
    (HTMLCanvasElement.prototype as unknown as { requestPointerLock: () => void }).requestPointerLock = function () {
      queueMicrotask(() => document.dispatchEvent(new Event('pointerlockerror')));
    };
  });
  await s.click('.screen-pause .btn-primary');
  await s.waitUntil(async () => s.page.evaluate(() => !(document.querySelector('.screen-lockerr') as HTMLElement).hidden), 10000, 'lock error overlay');
  await s.step(20, 100);
  const pf = await s.snap();
  const lockTxt = await s.page.evaluate(() => (document.querySelector('.screen-lockerr') as HTMLElement).textContent ?? '');
  ok(
    '2.4',
    '再開でポインターロックが取れないとき、説明と再試行が出て paused のまま進まない (経過時間・EN・敵が不変)',
    pf.state === 'paused' && pf.elapsedSeconds === paused.elapsedSeconds && pf.player.en === paused.player.en && lockTxt.includes('再試行') && lockTxt.includes('一時停止のまま'),
    `state=${pf.state} 経過 ${f(paused.elapsedSeconds)}->${f(pf.elapsedSeconds)} 表示=${lockTxt.slice(0, 60).replace(/\s+/g, ' ')}...`,
  );
  await s.shot('lockerror-resume', 'ポインターロック取得失敗の表示 (再開時)');
  await s.page.evaluate(() => {
    delete (HTMLCanvasElement.prototype as unknown as { requestPointerLock?: () => void }).requestPointerLock;
  });
  await s.click('.screen-lockerr .btn-primary'); // 再試行
  const back = await s.waitState('playing', 20000);
  ok('2.5', '「再試行」で今度はロックを取得でき、再開して playing に戻る', back.state === 'playing', `state=${back.state}`);
  const ammoAfter = back.player.ammo.machinegun;
  await s.step(20, 16);
  const back2 = await s.snap();
  ok('2.6', '再開ボタンのクリックが射撃にならない (再開後も残弾・射撃履歴が変化しない)', back2.player.ammo.machinegun === ammoAfter && back2.recentPlayerShots.length === 0 && back2.player.en === back.player.en, `MG=${back2.player.ammo.machinegun} shots=${back2.recentPlayerShots.length}`);
  await s.close();

  // ---- 2c. ポインターロックが取れない状況。
  // (i) focus emulation を送らない context: この Chromium では page.click(出撃) の実クリックでページがフォーカスされ、ロックが取れてしまうことがある。何が起きたかを記録する
  const n0 = await Sess.open(browser, base, 'nofocus', { focus: false });
  await n0.step(2, 50);
  await n0.click('.gar-buttons .btn-primary');
  await sleep(1500);
  await n0.step(5, 50);
  const n0s = await n0.snap();
  const n0e = await n0.page.evaluate(() => (window as unknown as { __e2e: { events: string[] } }).__e2e.events);
  const n0o = await n0.page.evaluate(() => !(document.querySelector('.screen-lockerr') as HTMLElement).hidden);
  rec('2.7', 'focus emulation なしの context で出撃を実クリックしたときの挙動 (参考)', 'info', `state=${n0s.state} lockErrorOverlay=${n0o} events=${n0e.join(',') || 'なし'} (state=garage かつ overlay=true なら取得失敗、state=playing ならこの環境では取得できた)`);
  if (n0s.state === 'garage') {
    ok('2.7b', 'ロックが取れなかったとき、説明と再試行が出て garage のまま進まない', n0o && n0s.elapsedSeconds === 0, `state=${n0s.state} overlay=${n0o}`);
  }
  await n0.close();

  // (ii) ロックが取れない状況を requestPointerLock の差し替えで確実に作る (この Chromium はユーザー操作なしの JS click でもロックを許可してしまうため、
  //      「操作なしの要求」では再現できない: 前回の実行で 2.8/2.9 が「ロックが取れてしまった」ことで不合格になった原因)。実際のクリックで出撃を要求し、失敗の3経路を試す。
  const failModes: { key: string; label: string }[] = [
    { key: 'event', label: 'pointerlockerror イベント' },
    { key: 'reject', label: 'Promise の reject (NotAllowedError)' },
    { key: 'silent', label: '何も返らない (4秒のタイムアウト)' },
  ];
  let modeNo = 0;
  for (const fm of failModes) {
    modeNo++;
    const n = await Sess.open(browser, base, `nolock-${fm.key}`);
    await n.step(2, 50);
    await n.page.evaluate((mode: string) => {
      (HTMLCanvasElement.prototype as unknown as { requestPointerLock: () => unknown }).requestPointerLock = function (): unknown {
        if (mode === 'event') queueMicrotask(() => document.dispatchEvent(new Event('pointerlockerror')));
        if (mode === 'reject') return Promise.reject(new DOMException('blocked by test', 'NotAllowedError'));
        return undefined; // silent: 何も起きない
      };
    }, fm.key);
    await n.click('.gar-buttons .btn-primary'); // 実クリックで出撃を要求 -> ロックが取れない
    let shown = false;
    try {
      await n.waitUntil(async () => n.page.evaluate(() => !(document.querySelector('.screen-lockerr') as HTMLElement).hidden), fm.key === 'silent' ? 3000 : 10000, 'lock error overlay');
      shown = true;
    } catch {
      if (fm.key === 'silent') {
        await n.page.clock.fastForward(4500); // アプリの取得待ちタイムアウト (4秒) を fake clock で進める
        shown = await n.page.evaluate(() => !(document.querySelector('.screen-lockerr') as HTMLElement).hidden);
      }
    }
    await n.step(30, 100);
    const nf = await n.snap();
    const errTxt = await n.page.evaluate(() => (document.querySelector('.screen-lockerr') as HTMLElement).textContent ?? '');
    const hudHidden = await n.page.evaluate(() => (document.getElementById('hud') as HTMLElement).hidden);
    ok(
      `2.8${'abc'[modeNo - 1]}`,
      `ロックが取れない [${fm.label}] とき、説明と再試行ボタンが出て、state=garage のまま進まない (経過0・HUD非表示)`,
      shown && nf.state === 'garage' && nf.elapsedSeconds === 0 && hudHidden && errTxt.includes('再試行') && errTxt.includes('出撃はまだ開始していません'),
      `overlay=${shown} state=${nf.state} 経過=${f(nf.elapsedSeconds)}s HUD非表示=${hudHidden} 詳細=${errTxt.replace(/\s+/g, ' ').slice(-90)}`,
    );
    if (fm.key === 'event') await n.shot('lockerror-sortie', 'ポインターロック取得失敗の表示 (出撃時)');
    // 再試行を実クリックで繰り返しても、取れない間は進行しない
    await n.click('.screen-lockerr .btn-primary');
    if (fm.key === 'silent') await n.page.clock.fastForward(4500);
    await sleep(1000);
    await n.step(10, 100);
    const nf2 = await n.snap();
    const stillShown = await n.page.evaluate(() => !(document.querySelector('.screen-lockerr') as HTMLElement).hidden);
    ok(`2.9${'abc'[modeNo - 1]}`, `再試行 (実クリック) してもロックが取れない間 [${fm.label}] は garage のまま進行せず、失敗表示が出続ける`, nf2.state === 'garage' && nf2.elapsedSeconds === 0 && stillShown, `state=${nf2.state} 経過=${f(nf2.elapsedSeconds)}s overlay=${stillShown}`);
    if (fm.key !== 'event') {
      await n.close();
      continue;
    }
    await n.click('.screen-lockerr .dialog-buttons .btn:not(.btn-primary)'); // 戻る
    const dis = await n.page.evaluate(() => ({ err: !(document.querySelector('.screen-lockerr') as HTMLElement).hidden, disabled: (document.querySelector('.gar-buttons .btn-primary') as HTMLButtonElement).disabled }));
    ok('2.10', '「戻る」で失敗表示が閉じ、出撃ボタンが再び押せる', !dis.err && !dis.disabled, JSON.stringify(dis));
    // 差し替えを外す (= ロックが取れる状態に戻す) と、実クリックで出撃できる
    await n.page.evaluate(() => {
      delete (HTMLCanvasElement.prototype as unknown as { requestPointerLock?: () => void }).requestPointerLock;
    });
    await n.click('.gar-buttons .btn-primary');
    const okSortie = await n.waitState('playing', 30000);
    ok('2.11', '失敗後にロックが取れる状態へ戻して実クリックで出撃し直すと、ロックを取得でき playing になる', okSortie.state === 'playing', `state=${okSortie.state}`);
    await n.close();
  }
}
