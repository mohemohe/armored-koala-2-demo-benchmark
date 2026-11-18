/**
 * audit-ui 実ブラウザ監査 (2/3): 本番の index.html をそのまま使い、実キー・実マウス・実ポインターロックで
 * 出撃 -> HUD (DOM) と snapshot の突き合わせ -> 一時停止 -> 操作説明 -> 再開 -> リサイズ -> 外部通信、を確認する。
 * 実行: npx tsx tests/audit-ui/play-audit.ts
 */
import { readHud, overlaps } from './hudDom';
import type { HudDom } from './hudDom';
import { checks, f, images, launchBrowser, ok, rec, Sess, startServer, stopServer } from './lib';

const D = (w: number, h: number): number => Math.min(w, h);

async function main(): Promise<void> {
  await startServer();
  const browser = await launchBrowser();
  try {
    const s = await Sess.open(browser, { w: 1280, h: 720 });
    const page = s.page;

    // ---- 出撃 (実クリック -> ポインターロック)
    const before = await s.snap();
    ok('P01', '出撃前は state=garage・HUD 非表示', before.state === 'garage' && (await page.evaluate(() => Boolean((document.querySelector('#hud') as HTMLElement).hidden))), `state=${before.state}`);
    await s.click('.gar-buttons .btn-primary');
    const sn1 = await s.waitState('playing', 60000);
    const lockInfo = await page.evaluate(() => ({ locked: document.pointerLockElement?.id ?? null, events: (window as unknown as { __audit: { events: string[] } }).__audit.events.slice() }));
    ok('P02', '出撃ボタンの実クリックでポインターロックを取得して開始 (canvas がロック)', lockInfo.locked === 'game-canvas', `pointerLockElement=${lockInfo.locked} events=${lockInfo.events.join(',')} state=${sn1.state}`);
    await s.step(3, 50);
    let sn = await s.snap();
    ok('P03', '開始のクリックが射撃にならない (弾数300・射撃履歴なし)', sn.player.ammo.machinegun === 300 && sn.recentPlayerShots.length === 0, `ammo=${sn.player.ammo.machinegun} shots=${sn.recentPlayerShots.length}`);
    let h = await readHud(page);
    await s.shot('p01-play-start', '出撃直後のプレイ画面 (1280x720)');

    // ---- HUD レイアウト (左=武器, 右=EN, 下=HP, 中央=FCS円)
    const wp = h.panels.find((p) => p.name === 'weapons')!;
    const rp = h.panels.find((p) => p.name === 'right(EN/move)')!;
    const hp = h.panels.find((p) => p.name === 'hp')!;
    ok('P04', 'HUD 配置: 武器=左側 / EN=右側 / HP=下側 / FCS円=画面中央', (wp.l + wp.r) / 2 < h.viewport.w / 2 && (rp.l + rp.r) / 2 > h.viewport.w / 2 && (hp.t + hp.b) / 2 > h.viewport.h * 0.75 && Math.abs(h.reticle.cx - h.viewport.w / 2) < 1 && Math.abs(h.reticle.cy - h.viewport.h / 2) < 1, `weapons.cx=${f((wp.l + wp.r) / 2, 0)} en.cx=${f((rp.l + rp.r) / 2, 0)} hp.cy=${f((hp.t + hp.b) / 2, 0)} reticle=(${f(h.reticle.cx, 1)},${f(h.reticle.cy, 1)})`);
    ok('P05', 'FCS 円の表示半径 = snapshot.lock.radiusCssPx = 0.2 × min(幅,高さ) (DOM の実寸)', Math.abs(h.reticle.r - sn.lock.radiusCssPx) < 1e-6 && Math.abs(sn.lock.radiusCssPx - 0.2 * D(1280, 720)) < 1e-6 && Math.abs(h.reticle.bbox.w - 2 * h.reticle.r) < 4, `DOM r=${h.reticle.r} bboxW=${f(h.reticle.bbox.w, 1)} snapshot=${sn.lock.radiusCssPx}`);
    const ov: string[] = [];
    for (let i = 0; i < h.panels.length; i++) for (let j = i + 1; j < h.panels.length; j++) if (overlaps(h.panels[i], h.panels[j])) ov.push(`${h.panels[i].name}x${h.panels[j].name}`);
    const off = h.panels.filter((p) => p.l < -0.5 || p.t < -0.5 || p.r > h.viewport.w + 0.5 || p.b > h.viewport.h + 0.5).map((p) => p.name);
    ok('P06', '1280x720: HUD パネル同士が重ならず、すべて画面内', ov.length === 0 && off.length === 0, `overlaps=${JSON.stringify(ov)} outside=${JSON.stringify(off)}`);
    const reticleBox = { l: h.reticle.bbox.l, t: h.reticle.bbox.t, r: h.reticle.bbox.l + h.reticle.bbox.w, b: h.reticle.bbox.t + h.reticle.bbox.h };
    const cover = h.panels.filter((p) => overlaps(p, reticleBox)).map((p) => p.name);
    ok('P07', '1280x720 (中範囲FCS): HUD パネルが FCS 円の内側領域を覆わない', cover.length === 0, `円と交差するパネル=${JSON.stringify(cover)}`);

    // ---- HUD の値 = snapshot
    const cmpBasics = (name: string, hd: HudDom, snap: typeof sn): string[] => {
      const errs: string[] = [];
      const enFloor = Math.floor(snap.player.en + 1e-6);
      if (hd.en.text !== `${enFloor} / ${snap.effectiveStats.maxEn}`) errs.push(`EN 表示 "${hd.en.text}" / 期待 "${enFloor} / ${snap.effectiveStats.maxEn}" (en=${snap.player.en})`);
      if (hd.hp.text !== `${Math.ceil(snap.player.hp - 1e-9)} / 1000`) errs.push(`HP 表示 "${hd.hp.text}" / hp=${snap.player.hp}`);
      const sel = hd.weapons.find((w) => w.sel);
      if (!sel || sel.key !== ({ machinegun: '1', beam: '2', missile: '3' } as const)[snap.player.weapon]) errs.push(`選択武器 ${sel?.name} / snapshot ${snap.player.weapon}`);
      const mg = hd.weapons[0].ammo;
      if (mg !== `${snap.player.ammo.machinegun}/300`) errs.push(`MG 残弾 "${mg}" / ${snap.player.ammo.machinegun}`);
      if (hd.weapons[2].ammo !== `${snap.player.ammo.missile}/12`) errs.push(`ミサイル残弾 "${hd.weapons[2].ammo}" / ${snap.player.ammo.missile}`);
      const modeWant = ({ walk: 'WALK', glide: 'GLIDE', quickboost: 'QB' } as const)[snap.player.movement.horizontalMode];
      if (hd.move.mode !== modeWant) errs.push(`移動モード "${hd.move.mode}" / ${snap.player.movement.horizontalMode}`);
      const cd = Number(hd.move.cd.replace('s', ''));
      if (Math.abs(cd - snap.player.movement.qbCooldownRemainingSeconds) > 0.051) errs.push(`QB残り時間 "${hd.move.cd}" / ${snap.player.movement.qbCooldownRemainingSeconds}`);
      const sectorWant = snap.stage.currentSectorId;
      if (!hd.mission.sector.startsWith(sectorWant ?? '---')) errs.push(`区画 "${hd.mission.sector}" / ${sectorWant}`);
      if (hd.mission.ctl !== `${snap.objective.controlsDestroyed}/6`) errs.push(`制御砲台 "${hd.mission.ctl}" / ${snap.objective.controlsDestroyed}`);
      if (Math.abs(parseFloat(hd.en.fillPct) - (snap.player.en / snap.effectiveStats.maxEn) * 100) > 0.02) errs.push(`ENバー ${hd.en.fillPct} / ${(snap.player.en / snap.effectiveStats.maxEn) * 100}`);
      if (Math.abs(parseFloat(hd.hp.fillPct) - (snap.player.hp / 1000) * 100) > 0.02) errs.push(`HPバー ${hd.hp.fillPct} / ${(snap.player.hp / 1000) * 100}`);
      void name;
      return errs;
    };
    let errs = cmpBasics('start', h, sn);
    ok('P08', '出撃直後: HUD の EN/HP/武器/残弾/移動/QB/区画/制御砲台/バー = snapshot', errs.length === 0, `${errs.join(' | ')} :: ${JSON.stringify({ en: h.en.text, hp: h.hp.text, sector: h.mission.sector, ctl: h.mission.ctl })}`);
    ok('P09', '初期武器はマシンガン、残弾は 300/300、ビーム/ミサイル行の表示 (弾数無制限 / 1射 8 EN / 12/12)', h.weapons[0].sel && h.weapons[0].ammo === '300/300' && /無制限/.test(h.weapons[1].ammo) && /8\s*EN/.test(h.weapons[1].sub) && h.weapons[2].ammo === '12/12', JSON.stringify(h.weapons));
    ok('P10', '初期のHUD文言: 制御砲台 0/6・隔壁 6 つ閉・最終ゲート閉鎖中・次の目標=制御砲台・QB=READY・FCS=未取得', h.mission.ctl === '0/6' && h.mission.barriers.length === 6 && h.mission.barriers.every((b) => !b.open) && /閉鎖/.test(h.mission.gate) && /制御砲台/.test(h.mission.next) && h.move.qb === 'READY' && /未取得/.test(h.fcs.state), JSON.stringify({ m: h.mission, qb: h.move.qb, fcs: h.fcs.state }));

    // ---- 実キー入力: W / Q(5回のリピート) / 1-3 / 射撃
    await s.down('KeyW');
    await s.step(6, 50);
    sn = await s.snap();
    const sp0 = Math.hypot(sn.player.velocity[0], sn.player.velocity[2]);
    ok('P11', '実キー W で移動 (10 m/s 近辺)', sp0 > 8 && sp0 < 12, `水平速度 ${f(sp0)} m/s`);
    await s.down('KeyQ');
    await s.step(1, 40);
    sn = await s.snap();
    h = await readHud(page);
    errs = cmpBasics('qb', h, sn);
    ok('P12', 'QB 噴射中: HUD の移動モード=QB・QB=COOLDOWN・EN が 36 減った値 (snapshot と一致)', h.move.mode === 'QB' && h.move.qbData === 'COOLDOWN' && errs.length === 0 && sn.player.movement.horizontalMode === 'quickboost', `${errs.join(' | ')} mode=${h.move.mode} qb=${h.move.qb} en=${h.en.text} (snapshot en=${f(sn.player.en)})`);
    await s.shot('p02-play-qb', 'QB 噴射中 (HUD: QB / COOLDOWN)');
    for (let i = 0; i < 3; i++) await s.down('KeyQ'); // OS のキーリピート (repeat=true の keydown)
    await s.step(3, 50);
    sn = await s.snap();
    h = await readHud(page);
    ok('P13', 'Q 押しっぱなし (実キーリピート) でも QB 成功は 1 回・HUD は自動グライド (GLIDE)', sn.player.movement.qbSuccessfulCount === 1 && h.move.mode === 'GLIDE' && sn.player.movement.horizontalMode === 'glide', `count=${sn.player.movement.qbSuccessfulCount} mode=${h.move.mode}`);
    await s.up('KeyQ');
    await s.up('KeyW');
    await s.step(4, 100);
    sn = await s.snap();
    h = await readHud(page);
    errs = cmpBasics('glide', h, sn);
    ok('P14', 'QB 後 (全キー解放): グライド継続を HUD が GLIDE と表示し、値が snapshot と一致 (EN/クールダウン)', h.move.mode === 'GLIDE' && errs.length === 0 && Math.hypot(sn.player.velocity[0], sn.player.velocity[2]) > 15, `${errs.join(' | ')} mode=${h.move.mode} speed=${f(Math.hypot(sn.player.velocity[0], sn.player.velocity[2]))} cd=${h.move.cd}`);
    // クールダウンを過ぎるまで進める (1.0 秒)
    await s.play(1.2, 100);
    h = await readHud(page);
    sn = await s.snap();
    ok('P15', 'クールダウン後: QB 表示が READY に戻る (EN 十分)', h.move.qbData === 'READY' && sn.player.movement.qbCooldownRemainingSeconds === 0 && sn.player.en >= 36, `qb=${h.move.qb} cd=${sn.player.movement.qbCooldownRemainingSeconds} en=${f(sn.player.en)}`);

    await s.page.keyboard.press('Digit2');
    await s.step(2, 30);
    h = await readHud(page);
    sn = await s.snap();
    ok('P16', '実キー 2 でビーム選択: 武器欄が「ビーム」を選択表示し 弾数=「弾数無制限」・「1射 8 EN」を示す', sn.player.weapon === 'beam' && h.weapons[1].sel && /無制限/.test(h.weapons[1].ammo) && /8\s*EN/.test(h.weapons[1].sub), JSON.stringify(h.weapons[1]));
    await s.shot('p03-play-beam-selected', 'ビーム選択中の HUD');
    // ビーム射撃 (実マウスボタン)
    const enBeforeBeam = (await s.snap()).player.en;
    await page.mouse.down();
    await s.step(1, 20);
    await s.shot('p04-play-beam-fire', 'ビーム射撃直後 (射線の描画)');
    await page.mouse.up();
    await s.step(1, 20);
    sn = await s.snap();
    h = await readHud(page);
    ok('P17', 'ビーム射撃 (実クリック): EN が 8 消費され (回復分を除き)、HUD の EN 表示も一致', enBeforeBeam - sn.player.en >= 7.9 && enBeforeBeam - sn.player.en <= 8.5 && cmpBasics('beam', h, sn).length === 0 && sn.recentPlayerShots.some((x) => x.weapon === 'beam'), `EN ${f(enBeforeBeam)} -> ${f(sn.player.en)} shots=${sn.recentPlayerShots.length} hud=${h.en.text}`);

    // ミサイル未ロック
    await s.page.keyboard.press('Digit3');
    await s.step(1, 30);
    await page.mouse.down();
    await s.step(2, 30);
    h = await readHud(page);
    sn = await s.snap();
    ok('P18', '未ロックでミサイル発射 (実クリック): 弾数 12 のまま・HUD に文字で「NO LOCK/未ロック」通知', sn.player.ammo.missile === 12 && h.notices.some((n) => /NO LOCK|未ロック/.test(n.text)) && !sn.recentPlayerShots.some((x) => x.weapon === 'missile'), `ammo=${sn.player.ammo.missile} notices=${JSON.stringify(h.notices)}`);
    await s.shot('p05-play-missile-nolock', '未ロックでミサイル: 通知表示');
    await page.mouse.up();
    await s.page.keyboard.press('Digit1');
    await s.step(1, 30);

    // ---- 一時停止 (実 Esc)
    const tPause0 = (await s.snap()).elapsedSeconds;
    await s.page.keyboard.press('Escape');
    await s.step(2, 50);
    sn = await s.snap();
    const pauseUi = await page.evaluate(() => {
      const p = document.querySelector('.screen-pause') as HTMLElement;
      return { visible: !p.hidden, text: p.innerText, locked: document.pointerLockElement?.id ?? null, hudHidden: (document.querySelector('#hud') as HTMLElement).hidden, buttons: Array.from(p.querySelectorAll('button')).map((b) => b.textContent) };
    });
    ok('P19', 'Esc で一時停止: state=paused・ポインターロック解除・一時停止画面 (再開/操作方法/格納庫へ)', sn.state === 'paused' && pauseUi.visible && pauseUi.locked === null && ['再開', '操作方法', '格納庫へ'].every((b) => pauseUi.buttons.includes(b)), `state=${sn.state} lock=${pauseUi.locked} buttons=${JSON.stringify(pauseUi.buttons)}`);
    ok('P20', '一時停止中もゲーム内時間が進まない (5 フレーム)', true, '');
    checks.pop();
    const tPause1 = (await s.snap()).elapsedSeconds;
    await s.step(5, 100);
    const tPause2 = (await s.snap()).elapsedSeconds;
    ok('P20', '一時停止中: ゲーム内時間が進まない (5 フレーム × 100ms)', tPause2 === tPause1 && tPause1 >= tPause0, `t: ${tPause0} -> ${tPause1} -> ${tPause2}`);
    await s.shot('p06-pause', '一時停止画面');
    // 操作説明 (一時停止から)
    await s.click('.screen-pause .btn:nth-child(2)');
    await s.step(1, 30);
    const helpP = await page.evaluate(() => {
      const ov = document.querySelector('.help-overlay') as HTMLElement;
      const box = ov.querySelector('.dialog') as HTMLElement;
      const r = box.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + 60);
      const body = ov.querySelector('.help-body') as HTMLElement;
      return { visible: !ov.hidden, onTop: !!top && ov.contains(top), text: ov.innerText, bodyScrollable: body.scrollHeight > body.clientHeight + 1, sh: body.scrollHeight, ch: body.clientHeight };
    });
    ok('P21', '一時停止画面から「操作方法」で操作説明が開き、最前面に出る', helpP.visible && helpP.onTop, `visible=${helpP.visible} onTop=${helpP.onTop}`);
    ok('P22', '一時停止中の操作説明: FCS 自動補正 / 手動不要 / Q単発36EN / 自動グライド / グライド0EN / 左CtrlまたはShift', /偏差と重力を自動補正/.test(helpP.text) && /手動で合わせる必要はない/.test(helpP.text) && /単発[^\n]*36\s*EN/.test(helpP.text) && /自動でグライド/.test(helpP.text) && /グライドは0\s*EN/.test(helpP.text) && /左CtrlまたはShift/.test(helpP.text), '');
    rec('P23', '1280x720 の操作説明ダイアログは内部スクロールで全文を読める', helpP.bodyScrollable ? 'info' : 'pass', `help-body scrollHeight=${helpP.sh} clientHeight=${helpP.ch} (スクロール必要=${helpP.bodyScrollable}: 末尾の「目的」節は画面外)`);
    await s.shot('p07-pause-help', '一時停止から開いた操作説明');
    await s.page.keyboard.press('Escape');
    await s.step(1, 30);
    const helpClosed = await page.evaluate(() => Boolean((document.querySelector('.help-overlay') as HTMLElement).hidden) && !(document.querySelector('.screen-pause') as HTMLElement).hidden);
    ok('P24', '操作説明は Esc で閉じ、一時停止画面に戻る', helpClosed, '');

    // ---- 再開 (実クリック): 時間が跳ばない・クリックが射撃にならない
    const shotsBefore = (await s.snap()).recentPlayerShots.length;
    const tBeforeResume = (await s.snap()).elapsedSeconds;
    await s.click('.screen-pause .btn-primary');
    await s.waitState('playing', 60000);
    await s.step(2, 50);
    sn = await s.snap();
    ok('P25', '再開 (実クリック): 一時停止中の経過時間が加算されず、クリックが射撃にならない', sn.elapsedSeconds - tBeforeResume < 0.2 && sn.recentPlayerShots.length === shotsBefore, `t ${tBeforeResume} -> ${sn.elapsedSeconds} shots ${shotsBefore} -> ${sn.recentPlayerShots.length}`);

    // ---- リサイズ
    const sizes: [number, number][] = [[1600, 900], [1920, 1080], [1280, 1024], [1500, 720], [2560, 1440], [2560, 1080], [3840, 2160], [1280, 720]];
    for (const [w, hh] of sizes) {
      await page.setViewportSize({ width: w, height: hh });
      // 'resize' イベントは実描画フレームで遅れて届く (フェイククロック停止中は特に): App が受け取って FCS の円を作り直すまで待つ (実時間の sleep で決め打ちしない)
      await s.waitUntil(async () => Math.abs((await s.snap()).lock.radiusCssPx - 0.2 * D(w, hh)) < 1e-6, 15000, `resize ${w}x${hh} の反映`);
      await s.step(2, 30);
      sn = await s.snap();
      const hd = await readHud(page);
      const dom = await page.evaluate(() => {
        const c = document.querySelector('#game-canvas') as HTMLCanvasElement;
        const r = c.getBoundingClientRect();
        const svg = document.querySelector('.hud-svg') as SVGSVGElement;
        return { cssW: r.width, cssH: r.height, bufW: c.width, bufH: c.height, dpr: window.devicePixelRatio, vb: svg.getAttribute('viewBox'), sx: document.documentElement.scrollWidth, sy: document.documentElement.scrollHeight };
      });
      const want = 0.2 * D(w, hh);
      const ov2: string[] = [];
      for (let i = 0; i < hd.panels.length; i++) for (let j = i + 1; j < hd.panels.length; j++) if (overlaps(hd.panels[i], hd.panels[j])) ov2.push(`${hd.panels[i].name}x${hd.panels[j].name}`);
      const off2 = hd.panels.filter((p) => p.l < -0.5 || p.t < -0.5 || p.r > w + 0.5 || p.b > hh + 0.5).map((p) => p.name);
      const rb = { l: hd.reticle.bbox.l, t: hd.reticle.bbox.t, r: hd.reticle.bbox.l + hd.reticle.bbox.w, b: hd.reticle.bbox.t + hd.reticle.bbox.h };
      const cover2 = hd.panels.filter((p) => overlaps(p, rb)).map((p) => p.name);
      ok(
        `R-${w}x${hh}`,
        `リサイズ ${w}x${hh}: 判定円 r=0.2×D=${f(want, 1)} (snapshot・DOM 実寸が一致)・円は画面中央・canvas/バッファ/viewBox が追従・スクロールなし・HUD が画面内で重ならない`,
        Math.abs(sn.lock.radiusCssPx - want) < 1e-6 &&
          Math.abs(hd.reticle.r - want) < 1e-6 &&
          Math.abs(hd.reticle.bbox.w - 2 * want) < 4 &&
          Math.abs(hd.reticle.cx - w / 2) < 1 &&
          Math.abs(hd.reticle.cy - hh / 2) < 1 &&
          Math.abs(dom.cssW - w) < 1 &&
          Math.abs(dom.cssH - hh) < 1 &&
          dom.vb === `0 0 ${w} ${hh}` &&
          dom.bufW <= w * dom.dpr + 1 && dom.bufW >= 0.75 * w * dom.dpr - 1 && // 4K などではレンダラーが描画画素数を上限で抑える (性能のため): 0.75 倍以上を許容
          
          dom.sx <= w &&
          dom.sy <= hh &&
          ov2.length === 0 &&
          off2.length === 0 &&
          cover2.length === 0,
        `snapshot.r=${sn.lock.radiusCssPx} DOM r=${hd.reticle.r} bbox=${f(hd.reticle.bbox.w, 1)} center=(${f(hd.reticle.cx, 1)},${f(hd.reticle.cy, 1)}) canvas=${dom.cssW}x${dom.cssH} buffer=${dom.bufW}x${dom.bufH} viewBox=${dom.vb} scroll=${dom.sx}x${dom.sy} overlap=${JSON.stringify(ov2)} outside=${JSON.stringify(off2)} coversCircle=${JSON.stringify(cover2)}`,
      );
      if (w === 1920) await s.shot('p08-play-1920x1080', '1920x1080 のプレイ画面');
      if (w === 1500) await s.shot('p09-play-1500x720', '1500x720 (横長) のプレイ画面');
      if (w === 1280 && hh === 1024) await s.shot('p10-play-1280x1024', '1280x1024 (5:4) のプレイ画面');
    }

    // ---- 外部通信・エラー
    ok('P30', 'プレイ全体の全リクエストが 127.0.0.1:5230 内 (外部への通信 0 件)', s.external.length === 0, `requests=${s.requests.length} ${JSON.stringify(s.requests.map((u) => u.replace('http://127.0.0.1:5230', '')))} external=${JSON.stringify(s.external)}`);
    const probs = s.appProblems();
    ok('P31', 'プレイ全体でコンソールエラー/警告・ページエラー・失敗リクエスト無し', probs.length === 0, JSON.stringify(probs.slice(0, 6)));
    // 本番ページが window に公開するのは AK2_BENCH.getSnapshot だけ (ARCH §6: 他のメソッドを足さない)
    const exposed = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const bench = w.AK2_BENCH as Record<string, unknown> | undefined;
      const ours = Object.keys(w).filter((k) => /^(AK2|__app$|__t$|game$|app$|state$|renderer$)/i.test(k));
      return { ours, benchKeys: bench ? Object.keys(bench) : null, frozen: bench ? Object.isFrozen(bench) : null, hasApp: '__app' in w, hasT: '__t' in w };
    });
    ok('P32', '本番ページの window 公開は AK2_BENCH { getSnapshot } (凍結) のみで、__app 等の内部オブジェクトを公開していない', exposed.benchKeys?.length === 1 && exposed.benchKeys[0] === 'getSnapshot' && exposed.frozen === true && !exposed.hasApp && !exposed.hasT && exposed.ours.length === 1, JSON.stringify(exposed));
    await s.close();
  } finally {
    await browser.close();
    stopServer();
  }
  const fails = checks.filter((c) => c.status === 'fail');
  console.log(`\n== play-audit: ${checks.length} checks, ${fails.length} fail ==`);
  for (const c of fails) console.log(`FAIL ${c.id} ${c.title} :: ${c.detail}`);
  console.log('images:\n' + images.map((i) => `  ${i.path}  ${i.note}`).join('\n'));
}

main().catch((e) => {
  console.error(e);
  stopServer();
  process.exit(1);
});
