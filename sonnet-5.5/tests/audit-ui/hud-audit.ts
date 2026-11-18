/**
 * audit-ui 実ブラウザ監査 (2b/3): 戦闘中の HUD (実 DOM/SVG) を、実際のゲーム状態 (敵をロックし、撃ち、撃たれ、砲台を壊す) と突き合わせる。
 *  H1 ロックの進行 (未取得→取得中→完了) の各フレームで DOM の文言・進捗リング・マーカー位置が state と一致し、補正照準は完了後にだけ出る
 *  H2 補正解なし (×形 + 「補正解なし」の文字) とロックの維持
 *  H3 補正照準点が画面外になったときの端表示 (ロックは維持)
 *  H4 拒否・不足の通知 (未ロックのミサイル・EN不足・弾切れ) が文字/形で判別できる
 *  H5 射撃予告 (前方・背後) と被弾方向ウェッジ
 *  H6 制御砲台の破壊 → 0/6..6/6・隔壁の開放・最終ゲート・脱出マーカー
 *  H7 失敗 → 結果画面 → 再出撃/格納庫へ戻る の繰り返し (初期化・構成の保持・リスナー/更新ループの非重複) ※§9 との境界
 * 実行: npx tsx tests/audit-ui/hud-audit.ts [--only=H1,H2,H3,H4,H5,H6]   (1 セッションあたり数分かかる)
 */
import type { Browser } from 'playwright';
import { readHud } from './hudDom';
import type { HudDom } from './hudDom';
import { checks, f, images, launchBrowser, ok, rec, Sess, startServer, stopServer } from './lib';

const W = 1280;
const H = 720;
const START = { x: 12, y: 1.5, z: 14 };
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const want = (k: string): boolean => !only || only.has(k);

interface Proj {
  x: number;
  y: number;
  onScreen: boolean;
  depth: number;
}
interface PlaceOpts {
  id: string;
  dist: number;
  /** 視点を回す [rad] (敵は動かさない = 背後に置く) */
  yawAdd?: number;
  /** true: 敵の AI を戻す */
  ai?: boolean;
  /** カメラ右方向への初速 [m/s] */
  lateral?: number;
  /** カメラ前方への初速 [m/s] (負=近づく) */
  away?: number;
}

/** セッション + 実 DOM/状態を読むヘルパー */
class Rig {
  private constructor(readonly s: Sess) {}

  static async open(browser: Browser, fcs?: 'wide' | 'medium' | 'narrow'): Promise<Rig> {
    const s = await Sess.open(browser, { w: W, h: H, path: 'tests/audit-ui/harness.html' });
    if (fcs) await s.page.click(`.card[data-part="fcs:${fcs}"]`);
    await s.sortie();
    await s.app((app) => {
      for (const e of app.game.state.enemies) e.scripted = true; // 位置固定・射撃なし (必要な敵だけ戻す)
    });
    return new Rig(s);
  }

  /** プレイヤーを START に置き、カメラ正面 dist m に敵を置いて画面中央へ向ける */
  async place(o: PlaceOpts): Promise<void> {
    await this.s.appWith({ ...o, pos: START }, (app, a) => {
      const st = app.game.state;
      st.player.pos = { x: a.pos.x, y: a.pos.y, z: a.pos.z };
      st.player.vel = { x: 0, y: 0, z: 0 };
      st.player.yaw = Math.PI;
      st.player.pitch = 0;
      st.player.hp = 1000;
      st.player.en = st.stats.maxEn;
      st.damageIndicators.length = 0;
      st.enemyBullets.length = 0;
      app.game.look(0, 0);
      const e = st.enemies.find((x) => x.id === a.id)!;
      e.alive = true;
      e.hp = e.maxHp;
      e.scripted = !a.ai;
      e.alert = false;
      e.telegraph = 0;
      const c = st.camera;
      e.pos = { x: c.pos.x + c.forward.x * a.dist, y: 1.5 + (c.pos.y - 2.7), z: c.pos.z + c.forward.z * a.dist };
      for (let i = 0; i < 3; i++) {
        const cc = st.camera;
        const dx = e.pos.x - cc.pos.x;
        const dy = e.pos.y - cc.pos.y;
        const dz = e.pos.z - cc.pos.z;
        const len = Math.hypot(dx, dy, dz);
        st.player.yaw = Math.atan2(-dx, -dz);
        st.player.pitch = Math.asin(dy / len);
        app.game.look(0, 0);
      }
      const cc = st.camera;
      const hl = Math.hypot(cc.forward.x, cc.forward.z) || 1; // 遠ざかる向きはカメラ前方の水平成分 (床へ潜らない)
      e.vel = { x: cc.right.x * (a.lateral ?? 0) + (cc.forward.x / hl) * (a.away ?? 0), y: 0, z: cc.right.z * (a.lateral ?? 0) + (cc.forward.z / hl) * (a.away ?? 0) };
      if (a.yawAdd) {
        st.player.yaw += a.yawAdd;
        app.game.look(0, 0);
      }
    });
  }

  /** state のカメラで世界座標を投影 (HUD と別に書いた同じ式) */
  async project(p: { x: number; y: number; z: number }): Promise<Proj> {
    return this.s.appWith(p, (app, q) => {
      const c = app.game.state.camera;
      const rx = q.x - c.pos.x;
      const ry = q.y - c.pos.y;
      const rz = q.z - c.pos.z;
      const depth = rx * c.forward.x + ry * c.forward.y + rz * c.forward.z;
      const cr = rx * c.right.x + ry * c.right.y + rz * c.right.z;
      const cu = rx * c.up.x + ry * c.up.y + rz * c.up.z;
      const scale = c.viewportH / 2 / Math.tan((c.fovYDeg * Math.PI) / 360);
      const x = c.viewportW / 2 + (cr / depth) * scale;
      const y = c.viewportH / 2 - (cu / depth) * scale;
      return { x, y, onScreen: depth > 0 && x >= 0 && x <= c.viewportW && y >= 0 && y <= c.viewportH, depth };
    });
  }
  async enemyPos(id: string): Promise<{ x: number; y: number; z: number }> {
    return this.s.appWith(id, (app, i) => ({ ...app.game.state.enemies.find((x) => x.id === i)!.pos }));
  }
  hud(): Promise<HudDom> {
    return readHud(this.s.page);
  }
  async debug(id: string): Promise<string> {
    const sn = await this.s.snap();
    const e = sn.enemies.find((x) => x.id === id)!;
    const d = Math.hypot(e.position[0] - sn.player.position[0], e.position[1] - sn.player.position[1], e.position[2] - sn.player.position[2]);
    return `t=${f(sn.elapsedSeconds, 2)} lock=${sn.lock.state}/${sn.lock.targetId} fc=${sn.fireControl.status} enemy=${e.position.map((v) => f(v, 1)).join(',')} dist=${f(d, 1)} los=${e.hasLineOfSight} alive=${e.alive}`;
  }
}

const hudShown = (h: HudDom, kind: string): HudDom['markers'][number] | undefined => h.markers.find((m) => m.kind === kind);

// ---------------------------------------------------------------------------------------------------------------------
async function h1(browser: Browser): Promise<void> {
  const r = await Rig.open(browser);
  const s = r.s;
  await r.place({ id: 'G01', dist: 30 });
  await s.step(3, 16);
  const errs: string[] = [];
  let sawNone = 0;
  let sawAcq = 0;
  let sawLocked = 0;
  let firstLockedAt = -1;
  for (let i = 0; i < 70; i++) {
    await s.step(1, 16);
    const sn = await s.snap();
    const h = await r.hud();
    const t = sn.elapsedSeconds;
    const ph = sn.lock.state;
    if (ph === 'none') sawNone++;
    if (ph === 'acquiring') sawAcq++;
    if (ph === 'locked') {
      sawLocked++;
      if (firstLockedAt < 0) firstLockedAt = t;
    }
    if (h.fcs.phase !== ph) errs.push(`t=${f(t, 3)} DOM位相 ${h.fcs.phase} / state ${ph}`);
    const pct = Math.floor(sn.lock.progress * 100 + 1e-6);
    const wantLabel = ph === 'none' ? '' : ph === 'acquiring' ? `LOCKING ${pct}%` : 'LOCKED';
    if (h.reticle.label !== wantLabel) errs.push(`t=${f(t, 3)} 円ラベル "${h.reticle.label}" / 期待 "${wantLabel}"`);
    const m = /([\d.]+) ([\d.]+)/.exec(h.reticle.progDash);
    const ring = m ? Number(m[1]) / Number(m[2]) : NaN;
    const wantRing = ph === 'acquiring' ? sn.lock.progress : 0;
    if (!(Math.abs(ring - wantRing) < 0.01)) errs.push(`t=${f(t, 3)} 進捗リング ${f(ring, 3)} / progress ${f(wantRing, 3)}`);
    const tm = hudShown(h, 'target');
    if (ph === 'none') {
      if (tm) errs.push(`t=${f(t, 3)} 未取得なのに対象マーカーがある`);
    } else if (!tm) errs.push(`t=${f(t, 3)} ${ph}なのに対象マーカーが無い`);
    else {
      const ep = await r.project(await r.enemyPos('G01'));
      if (Math.hypot(tm.tx - ep.x, tm.ty - ep.y) > 1.2) errs.push(`t=${f(t, 3)} 対象マーカー (${f(tm.tx, 1)},${f(tm.ty, 1)}) / 投影 (${f(ep.x, 1)},${f(ep.y, 1)})`);
      if (!tm.shapeVisible) errs.push(`t=${f(t, 3)} 対象マーカーの形が非表示`);
    }
    const am = hudShown(h, 'aim');
    if (ph !== 'locked') {
      if (am) errs.push(`t=${f(t, 3)} ${ph}なのに補正照準マーカーがある`);
      if (/補正中|補正解なし/.test(h.fcs.aim) || /補正中|補正解なし/.test(h.reticle.aimLabel)) errs.push(`t=${f(t, 3)} ${ph}なのに補正有効/解なしの文字 "${h.fcs.aim}" "${h.reticle.aimLabel}"`);
    } else if (!am) errs.push(`t=${f(t, 3)} ロック完了なのに補正照準マーカーが無い`);
    else {
      if (!am.solvedVisible || am.noneVisible) errs.push(`t=${f(t, 3)} 補正解ありなのに形がひし形でない`);
      if (!/補正/.test(h.fcs.aim)) errs.push(`t=${f(t, 3)} FCS パネルの補正行 "${h.fcs.aim}"`);
      if (sn.fireControl.aimPoint) {
        const ap = await r.project({ x: sn.fireControl.aimPoint[0], y: sn.fireControl.aimPoint[1], z: sn.fireControl.aimPoint[2] });
        if (Math.hypot(am.tx - ap.x, am.ty - ap.y) > 1.2) errs.push(`t=${f(t, 3)} 補正マーカー (${f(am.tx, 1)},${f(am.ty, 1)}) / 補正点の投影 (${f(ap.x, 1)},${f(ap.y, 1)})`);
      }
      if (tm && Math.hypot(am.tx - tm.tx, am.ty - tm.ty) < 3) errs.push(`t=${f(t, 3)} 補正マーカーと対象マーカーが同じ位置`);
    }
    if (i === 30 && ph === 'acquiring') await s.shot('h1-acquiring', 'ロック取得中 (円の進捗リング・LOCKING n%・対象マーカー)');
    if (ph === 'locked' && sawLocked === 5) await s.shot('h1-locked', 'ロック完了 (LOCKED・対象マーカー=角括弧・補正マーカー=ひし形)');
  }
  ok('H1', `ロックの進行 (未取得 ${sawNone}f → 取得中 ${sawAcq}f → 完了 ${sawLocked}f): 各フレームで DOM の位相・円の文字・進捗リング・対象マーカー位置・補正マーカー (完了後のみ・位置=投影) が state と一致`, errs.length === 0 && sawAcq > 10 && sawLocked > 10, `完了時刻=${f(firstLockedAt, 3)}s 不一致 ${errs.length} 件: ${errs.slice(0, 4).join(' | ')}`);
  ok('H1b', 'ロック完了の時刻 = 中範囲FCS 0.8 秒 (±0.03 s)', Math.abs(firstLockedAt - 0.8) <= 0.03, `完了時刻=${f(firstLockedAt, 4)}s`);
  const full = await s.shot('h1-locked-full', 'ロック完了後の全画面');
  await s.page.screenshot({ path: full.replace('.png', '-crop.png'), clip: { x: 440, y: 190, width: 400, height: 340 }, timeout: 120000 });
  images.push({ path: full.replace('.png', '-crop.png'), note: 'ロック完了 円の周辺 (拡大用)' });

  const wantTxt = { Digit2: '現在位置', Digit3: '偏差', Digit1: '偏差+重力' } as const;
  let wsw = 0;
  for (const key of ['Digit2', 'Digit3', 'Digit1'] as const) {
    await s.page.keyboard.press(key);
    await s.step(2, 16);
    const sn = await s.snap();
    const h = await r.hud();
    if (sn.lock.state === 'locked' && sn.lock.targetId === 'G01' && h.fcs.aim.includes(wantTxt[key]) && h.reticle.aimLabel.includes(wantTxt[key]) && hudShown(h, 'aim')) wsw++;
    else rec('H1c-detail', `武器切替 ${key}`, 'info', `lock=${sn.lock.state} aim="${h.fcs.aim}" label="${h.reticle.aimLabel}"`);
  }
  ok('H1c', '武器切替 (実キー 2→3→1) でロックは維持され、補正表示の文言が 現在位置/偏差/偏差+重力 に追従する (DOM)', wsw === 3, `一致 ${wsw}/3`);
  ok('H1z', 'H1 セッション: 外部リクエスト無し・エラー無し', s.external.length === 0 && s.appProblems().length === 0, JSON.stringify(s.appProblems().slice(0, 2)));
  await s.close();
}

async function h3(browser: Browser): Promise<void> {
  // 広範囲FCS: 標的を円内に保ち、横 90 m/s (40 m 先) -> MG の補正点は画面外 (Node 側の探索で確認済みの条件)
  const r = await Rig.open(browser, 'wide');
  const s = r.s;
  await r.place({ id: 'G01', dist: 40, lateral: 90 });
  let offOk = 0;
  const offBad: string[] = [];
  let shot = false;
  let lockedFrames = 0;
  let radiusDom = -1;
  let radiusBox = -1;
  for (let i = 0; i < 150; i++) {
    // 標的を円内へ戻し続ける (速度はそのまま)
    await s.appWith({}, (app) => {
      const st = app.game.state;
      const e = st.enemies.find((x) => x.id === 'G01')!;
      const c = st.camera;
      const j = Math.random() < 0.5 ? -0.5 : 0.5;
      e.pos = { x: c.pos.x + c.forward.x * 40 + c.right.x * j, y: c.pos.y + c.forward.y * 40, z: c.pos.z + c.forward.z * 40 + c.right.z * j };
    });
    await s.step(1, 16);
    const sn = await s.snap();
    if (sn.lock.state !== 'locked') continue;
    lockedFrames++;
    const h = await r.hud();
    radiusDom = h.reticle.r;
    radiusBox = h.reticle.bbox.w / 2;
    const am = hudShown(h, 'aim');
    if (am && am.off) {
      const inside = am.tx >= 0 && am.tx <= W && am.ty >= 0 && am.ty <= H;
      if (am.arrowVisible && !am.shapeVisible && inside && hudShown(h, 'target')) offOk++;
      else offBad.push(`t=${f(sn.elapsedSeconds, 2)} arrow=${am.arrowVisible} shape=${am.shapeVisible} pos=(${f(am.tx, 0)},${f(am.ty, 0)})`);
      if (!shot) {
        shot = true;
        await s.shot('h3-offscreen-aim', '補正照準点が画面外 (端の矢印表示・ロック維持・対象マーカーは画面内)');
      }
    }
  }
  const dbg = offOk === 0 ? await r.debug('G01') : '';
  ok('H3r', `広範囲FCS: 中央の判定円の半径 = 0.30 × min(幅,高さ) = ${0.3 * Math.min(W, H)} px (DOM の r 属性と実寸 ${f(radiusBox, 1)} px)`, Math.abs(radiusDom - 0.3 * Math.min(W, H)) < 1e-6 && Math.abs(radiusBox - radiusDom) < 2, `r=${radiusDom} 実寸半径=${radiusBox}`);
  ok('H3', `補正照準点が画面外のとき (ロック ${lockedFrames}f 中 ${offOk} フレーム観測): 端の矢印 (三角) で表示され画面内に収まり、ロックと対象マーカーは維持される (DOM)`, offOk >= 5 && offBad.length === 0, `観測=${offOk} 不正=${offBad.length} ${offBad.slice(0, 3).join(' | ')} ${dbg}`);
  await s.close();
}

async function h2(browser: Browser): Promise<void> {
  // 狭範囲FCS (0.4 秒で完了) + ミサイル (速度 45 m/s): 標的が横へ 60 m/s で動き続ける (円内に保つ) -> 偏差解なし = 補正解なし
  // (S01 は 56 m 先に遮蔽壁があり、遠ざかる標的では視線が切れるため、ミサイルの速度限界で解なしを作る)
  const r = await Rig.open(browser, 'narrow');
  const s = r.s;
  await r.place({ id: 'G01', dist: 30, lateral: 60 });
  await s.page.keyboard.press('Digit3');
  let nosol = 0;
  let lockedFrames = 0;
  const bad: string[] = [];
  let shot = false;
  let radiusDom = -1;
  let radiusBox = -1;
  for (let i = 0; i < 90; i++) {
    await s.appWith({}, (app) => {
      const st = app.game.state;
      const e = st.enemies.find((x) => x.id === 'G01')!;
      const c = st.camera;
      const j = Math.random() < 0.5 ? -0.3 : 0.3;
      e.pos = { x: c.pos.x + c.forward.x * 30 + c.right.x * j, y: c.pos.y + c.forward.y * 30, z: c.pos.z + c.forward.z * 30 + c.right.z * j };
    });
    await s.step(1, 16);
    const sn = await s.snap();
    if (sn.lock.state !== 'locked') continue;
    lockedFrames++;
    if (sn.fireControl.status !== 'no_solution') continue;
    const h = await r.hud();
    radiusDom = h.reticle.r;
    radiusBox = h.reticle.bbox.w / 2;
    const am = hudShown(h, 'aim');
    const tm = hudShown(h, 'target');
    const good = !!am && am.noneVisible === true && am.solvedVisible === false && /補正解なし/.test(am.text) && /補正解なし/.test(h.fcs.aim) && /補正解なし/.test(h.reticle.aimLabel) && h.fcs.aimNoSol && !!tm && h.fcs.phase === 'locked' && /LOCKED/.test(h.reticle.label);
    if (good) nosol++;
    else bad.push(`t=${f(sn.elapsedSeconds, 2)} aim=${JSON.stringify(am && { none: am.noneVisible, solved: am.solvedVisible, text: am.text })} fcs="${h.fcs.aim}" label="${h.reticle.aimLabel}" target=${!!tm}`);
    if (!shot) {
      shot = true;
      await s.shot('h2-nosolution', '補正解なし (×印と「補正解なし」の文字・ロックは維持)');
    }
  }
  const dbg = nosol === 0 ? await r.debug('G01') : '';
  ok('H2r', `狭範囲FCS: 中央の判定円の半径 = 0.10 × min(幅,高さ) = ${0.1 * Math.min(W, H)} px (DOM の r 属性と実寸 ${f(radiusBox, 1)} px)`, Math.abs(radiusDom - 0.1 * Math.min(W, H)) < 1e-6 && Math.abs(radiusBox - radiusDom) < 2, `r=${radiusDom} 実寸半径=${radiusBox}`);
  ok('H2', `補正解なし (ロック ${lockedFrames}f 中 ${nosol} フレーム観測): ×形の補正マーカー + 「補正解なし」の文字 (円の上・マーカー・FCS 行) が出て、ロック完了・対象マーカーは維持される (DOM)`, nosol >= 3 && bad.length === 0, `観測=${nosol} 不正=${bad.length} ${bad.slice(0, 2).join(' | ')} ${dbg}`);
  await s.close();
}

async function h4(browser: Browser): Promise<void> {
  const r = await Rig.open(browser);
  const s = r.s;
  await s.page.keyboard.press('Digit3'); // ミサイル
  await s.appWith({}, (app) => {
    app.game.input.fire = true;
  });
  await s.step(4, 20);
  let h = await r.hud();
  const noLock = h.notices.find((n) => /NO LOCK|未ロック/.test(n.text));
  await s.appWith({}, (app) => {
    app.game.input.fire = false;
  });
  await s.page.keyboard.press('Digit2'); // ビーム
  await s.step(2, 20);
  await s.appWith({}, (app) => {
    app.game.input.fire = true;
  });
  for (let i = 0; i < 3; i++) {
    await s.appWith({}, (app) => {
      app.game.state.player.en = 7.9;
    });
    await s.step(1, 20);
  }
  h = await r.hud();
  const noEn = h.notices.find((n) => /EN不足/.test(n.text));
  const enLow = h.en.low;
  await s.shot('h4-en-shortage', 'ビーム EN 不足 (通知「EN不足」・ENバー low・QB 表示)');
  await s.appWith({}, (app) => {
    app.game.input.fire = false;
  });
  await s.page.keyboard.press('Digit1');
  await s.step(2, 20);
  await s.appWith({}, (app) => {
    app.game.state.player.ammo.machinegun = 0;
    app.game.input.fire = true;
  });
  await s.step(4, 20);
  h = await r.hud();
  const noAmmo = h.notices.find((n) => /弾切れ/.test(n.text));
  const mgRow = h.weapons[0];
  await s.shot('h4-ammo-empty', 'マシンガン弾切れ (通知「弾切れ」・武器行の「弾切れ」表示)');
  await s.appWith({}, (app) => {
    app.game.input.fire = false;
  });
  ok('H4a', '未ロックでミサイル: 文字「NO LOCK 未ロック…」の通知が DOM に出る', !!noLock, JSON.stringify(noLock));
  ok('H4b', 'ビーム EN 不足: 文字「EN不足」の通知が出る (色だけでない)', !!noEn, `${JSON.stringify(noEn)} enBar.low=${enLow}`);
  ok('H4c', 'マシンガン弾切れ: 文字「弾切れ」の通知と、武器行に「弾切れ」と empty 表示', !!noAmmo && mgRow.empty && /弾切れ/.test(mgRow.sub), `notice=${JSON.stringify(noAmmo)} row=${JSON.stringify(mgRow)}`);
  const nn = new Set([noLock?.text, noEn?.text, noAmmo?.text]);
  ok('H4d', '3 種の拒否通知は互いに文言が異なる (状態を文字で判別できる)', nn.size === 3, JSON.stringify([...nn]));
  await s.close();
}

async function h5(browser: Browser): Promise<void> {
  const r = await Rig.open(browser);
  const s = r.s;
  for (const [name, yawAdd, wantWedgeDeg] of [['前方', 0, 0], ['背後', Math.PI, 180]] as const) {
    // 固定砲台 T01 (実 AI) をカメラ正面 45 m に置く。背後ケースは、その後に視点だけを 180° 回す
    await r.place({ id: 'T01', dist: 45, ai: true, yawAdd });
    await s.step(3, 16);
    let sawTele = false;
    let teleOk = false;
    let teleInfo = '';
    let wedgeOk = false;
    let wedgeInfo = '';
    let wedgeShot = false;
    for (let i = 0; i < 500 && !wedgeOk; i++) {
      await s.step(1, 16);
      const sn = await s.snap();
      const hh = await r.hud();
      const tm = hudShown(hh, 'telegraph');
      if (tm && !sawTele) {
        sawTele = true;
        const pr = await r.project(await r.enemyPos('T01'));
        if (yawAdd === 0) teleOk = !tm.off && Math.hypot(tm.tx - pr.x, tm.ty - pr.y) < 1.5 && tm.shapeVisible && /射撃予告/.test(tm.text) && /T01/.test(tm.text);
        else teleOk = tm.off && tm.arrowVisible && !tm.shapeVisible && /射撃予告/.test(tm.text) && tm.tx >= 0 && tm.tx <= W && tm.ty >= 0 && tm.ty <= H;
        teleInfo = `${name}: 予告マーカー off=${tm.off} pos=(${f(tm.tx, 0)},${f(tm.ty, 0)}) text="${tm.text}" 投影=(${f(pr.x, 0)},${f(pr.y, 0)})`;
        await s.shot(`h5-telegraph-${yawAdd === 0 ? 'front' : 'back'}`, `固定砲台の射撃予告 (${name})`);
      }
      if (sn.player.hp < 1000 && hh.wedges > 0) {
        const ang = await s.page.evaluate(() => {
          const tips = Array.from(document.querySelectorAll('.hud-wedge'))
            .filter((w) => (w as SVGElement).style.display !== 'none')
            .map((w) => (w.querySelector('.hud-wedge-tip') as SVGElement).getAttribute('transform') ?? '');
          return tips.map((t) => Number(/rotate\(([-\d.]+)\)/.exec(t)?.[1] ?? NaN));
        });
        const dAng = ((((ang[0] - wantWedgeDeg) % 360) + 540) % 360) - 180;
        wedgeOk = Math.abs(dAng) < 6;
        wedgeInfo = `${name}: ウェッジ角 ${ang.map((a) => f(a, 1)).join(',')}° (期待 ${wantWedgeDeg}°) hp=${sn.player.hp} フラッシュ不透明度=${f(hh.flashOpacity, 3)}`;
        if (!wedgeShot) {
          wedgeShot = true;
          await s.shot(`h5-wedge-${yawAdd === 0 ? 'front' : 'back'}`, `被弾方向のウェッジ (${name}の砲台からの被弾)`);
        }
      }
    }
    const dbg = !sawTele || !wedgeOk ? await r.debug('T01') : '';
    ok(`H5-tele-${name}`, `射撃予告 (${name}の固定砲台): 予告マーカー (△と「!」+「射撃予告 T01」の文字) が${yawAdd === 0 ? '敵の投影位置に' : '画面端の矢印として'}出る (DOM)`, sawTele && teleOk, teleInfo || `予告が出なかった ${dbg}`);
    ok(`H5-wedge-${name}`, `被弾方向 (${name}の砲台の実弾が命中): ウェッジの向き = 射手の方位 ±6°`, wedgeOk, wedgeInfo || `被弾しなかった ${dbg}`);
    await s.appWith({}, (app) => {
      const e = app.game.state.enemies.find((x) => x.id === 'T01')!;
      e.scripted = true;
    });
  }
  await s.close();
}

async function h6(browser: Browser): Promise<void> {
  const r = await Rig.open(browser);
  const s = r.s;
  await s.step(3, 16);
  const ctl = await s.appWith({}, (app) =>
    app.game.state.enemies
      .filter((e) => e.controlIndex !== null)
      .sort((a, b) => (a.controlIndex as number) - (b.controlIndex as number))
      .map((e) => ({ id: e.id, barrierId: e.barrierId as string, idx: e.controlIndex as number })),
  );
  const order = [3, 0, 5, 2, 1, 4];
  const destroyed = new Set<number>();
  const bad: string[] = [];
  for (const idx of order) {
    const c = ctl[idx];
    await s.appWith(c.id, (app, id) => {
      const st = app.game.state;
      const e = st.enemies.find((x) => x.id === id)!;
      (window as unknown as { __t: { damageEnemy: (s: unknown, e: unknown, n: number, w: string) => boolean } }).__t.damageEnemy(st, e, 99999, 'machinegun');
    });
    destroyed.add(idx);
    await s.step(3, 16);
    const hh = await r.hud();
    const world = await s.appWith(
      ctl.map((x) => x.barrierId),
      (app, ids) =>
        ids.map((id) => {
          const st = app.game.state;
          const b = st.stage.barriers.find((x) => x.id === id)!;
          return { id, open: b.boxIds.every((bid) => !st.world.isBoxEnabled(st.world.indexOfBox(bid))), closed: b.boxIds.every((bid) => st.world.isBoxEnabled(st.world.indexOfBox(bid))) };
        }),
    );
    const n = destroyed.size;
    if (hh.mission.ctl !== `${n}/6`) bad.push(`破壊 ${n}: 表示 ${hh.mission.ctl}`);
    if (hh.mission.pipsOn !== n) bad.push(`破壊 ${n}: pip ${hh.mission.pipsOn}`);
    for (const w of world) {
      const wantOpen = ctl.some((cc, i) => destroyed.has(i) && cc.barrierId === w.id);
      const chip = hh.mission.barriers.find((b) => b.text.startsWith(w.id + ' '));
      if (!chip || chip.open !== wantOpen || /開放/.test(chip.text) !== wantOpen) bad.push(`破壊 ${n}: 隔壁 ${w.id} 表示 ${chip?.text}/${chip?.open} 期待 open=${wantOpen}`);
      if (wantOpen ? !w.open : !w.closed) bad.push(`破壊 ${n}: 隔壁 ${w.id} の実衝突箱の状態が表示と食い違う`);
    }
    const last = n === 6;
    if (last !== hh.mission.gateOpen || last !== /脱出可能/.test(hh.mission.gate)) bad.push(`破壊 ${n}: ゲート表示 "${hh.mission.gate}" open=${hh.mission.gateOpen}`);
    if (!last && !/制御砲台/.test(hh.mission.next)) bad.push(`破壊 ${n}: 次の目標 "${hh.mission.next}"`);
    if (last && !(/脱出/.test(hh.mission.next) && hh.markers.some((m) => m.kind === 'escape'))) bad.push(`6/6: 次の目標 "${hh.mission.next}" 脱出マーカー=${hh.markers.some((m) => m.kind === 'escape')}`);
    if (n === 1) await s.shot('h6-first-control', '制御砲台 1/6 破壊 (対応する隔壁だけ「開放」)');
    if (last) await s.shot('h6-all-controls', '6/6 破壊 (最終ゲート開放・脱出可能表示)');
  }
  ok('H6', '制御砲台を任意順で 6 体破壊: n/6・pip・隔壁チップ (開放/閉)・実際の衝突箱・最終ゲート「脱出可能」・次の目標=脱出・脱出マーカー が毎回 state/world と一致 (DOM)', bad.length === 0, bad.slice(0, 4).join(' | '));
  ok('H6z', 'H6 セッション: 外部リクエスト無し・エラー無し', s.external.length === 0 && s.appProblems().length === 0, JSON.stringify(s.appProblems().slice(0, 2)));
  await s.close();
}

/** window / document に登録されているイベントリスナーの種類別の数 (CDP DOMDebugger) */
async function listenerCounts(s: Sess): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const target of ['window', 'document']) {
    const { result } = await s.cdp.send('Runtime.evaluate', { expression: target });
    const { listeners } = await s.cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId as string });
    for (const l of listeners) out[`${target}:${l.type}`] = (out[`${target}:${l.type}`] ?? 0) + 1;
    await s.cdp.send('Runtime.releaseObject', { objectId: result.objectId as string });
  }
  return out;
}

async function h7(browser: Browser): Promise<void> {
  // 失敗 → 結果画面 (再出撃 / 格納庫へ戻る) → 再出撃の繰り返しで、初期化・構成の保持・イベントリスナーと rAF ループの非重複を実 DOM で確認
  const s = await Sess.open(browser, { w: W, h: H, path: 'tests/audit-ui/harness.html' });
  await s.page.click('.card[data-part="legs:quadruped"]');
  await s.page.click('.card[data-part="fcs:narrow"]');
  await s.page.click('.card[data-part="generator:recovery"]');
  await s.sortie();
  await s.page.evaluate(() => {
    const w = window as unknown as { __raf: number; requestAnimationFrame: (cb: FrameRequestCallback) => number };
    const orig = w.requestAnimationFrame.bind(window);
    w.__raf = 0;
    w.requestAnimationFrame = (cb) => {
      w.__raf++;
      return orig(cb);
    };
  });
  const rafPerFrame = async (): Promise<number> => {
    const a = (await s.page.evaluate('window.__raf')) as number;
    await s.step(1, 16);
    const b = (await s.page.evaluate('window.__raf')) as number;
    return b - a;
  };
  await s.step(10, 16);
  const base = await listenerCounts(s);
  const raf0 = await rafPerFrame();
  const bad: string[] = [];
  const fail = async (): Promise<void> => {
    await s.appWith({}, (app) => {
      app.game.state.player.hp = 0;
    });
    await s.step(3, 16);
  };
  const dirty = async (): Promise<void> => {
    // 出撃中に状態を汚しておく (消費・移動・撃破・QB・ロック) -> 再出撃で全て初期化されることを見る
    await s.appWith({}, (app) => {
      const st = app.game.state;
      st.player.ammo.machinegun = 17;
      st.player.ammo.missile = 2;
      st.player.en = 3;
      st.player.pos = { x: 300, y: 5.5, z: 60 };
      st.player.vel = { x: 30, y: 0, z: 0 };
      for (const e of st.enemies.slice(0, 5)) e.alive = false;
      st.objective.controlsDestroyed = 0;
    });
    await s.appWith({}, (app) => {
      app.game.input.forward = true;
      app.game.input.qb = true;
    });
    await s.step(6, 20);
    await s.appWith({}, (app) => {
      app.game.input.forward = false;
      app.game.input.qb = false;
    });
  };
  for (let round = 1; round <= 3; round++) {
    await dirty();
    await fail();
    const sn = await s.snap();
    const ui = await s.page.evaluate(() => {
      const r = document.querySelector('.screen-result') as HTMLElement;
      return {
        visible: !r.hidden,
        title: (r.querySelector('.result-title') as HTMLElement).textContent,
        rows: Array.from(r.querySelectorAll('.stat-k')).map((e) => `${e.textContent}=${(e.nextElementSibling as HTMLElement).textContent}`),
        buttons: Array.from(r.querySelectorAll('button')).map((b) => b.textContent),
        hudHidden: Boolean((document.querySelector('#hud') as HTMLElement).hidden),
        locked: document.pointerLockElement?.id ?? null,
        reason: (r.querySelector('.dialog-lead') as HTMLElement).textContent,
      };
    });
    if (round === 1) await s.shot('h7-result-failed', '失敗の結果画面 (理由・数値・再出撃 / 格納庫へ戻る)');
    if (!(sn.state === 'failed' && ui.visible && /FAILED/.test(ui.title ?? '') && ui.buttons.includes('同じ構成で再出撃') && ui.buttons.includes('格納庫へ戻る') && ui.hudHidden && ui.locked === null && /HP 0|大破/.test(ui.reason ?? ''))) bad.push(`失敗 ${round}: ${JSON.stringify({ state: sn.state, ...ui })}`);
    if (round === 1 && !ui.rows.some((r) => /制御砲台/.test(r)) ) bad.push(`結果の行 ${JSON.stringify(ui.rows)}`);
    // 失敗後は戦闘の更新を停止 (経過時間が進まない)
    const t0 = (await s.snap()).elapsedSeconds;
    await s.step(5, 50);
    if ((await s.snap()).elapsedSeconds !== t0) bad.push(`失敗 ${round}: 結果画面表示中に経過時間が進んだ`);
    await s.click('.screen-result .btn-primary'); // 実クリック -> ポインターロック -> 再出撃
    const re = await s.waitState('playing', 60000);
    await s.step(3, 20);
    const sn2 = await s.snap();
    const alive = sn2.enemies.filter((e) => e.alive).length;
    const fresh =
      sn2.player.hp === 1000 &&
      sn2.player.ammo.machinegun === 300 &&
      sn2.player.ammo.missile === 12 &&
      sn2.player.en > sn2.effectiveStats.maxEn - 1 &&
      sn2.elapsedSeconds < 0.3 &&
      alive === 45 &&
      sn2.objective.controlsDestroyed === 0 &&
      sn2.player.movement.qbSuccessfulCount === 0 &&
      sn2.recentPlayerShots.length === 0 &&
      Math.abs(sn2.player.position[0] - 12) < 0.5 &&
      Math.abs(sn2.player.position[2] - 14) < 0.5 &&
      sn2.loadout.legs === 'quadruped' &&
      sn2.loadout.fcs === 'narrow' &&
      sn2.loadout.generator === 'recovery' &&
      sn2.effectiveStats.maxEn === 90;
    if (!fresh || re.state !== 'playing') bad.push(`再出撃 ${round}: ${JSON.stringify({ hp: sn2.player.hp, ammo: sn2.player.ammo, en: sn2.player.en, t: sn2.elapsedSeconds, alive, ctl: sn2.objective.controlsDestroyed, pos: sn2.player.position, loadout: sn2.loadout, qb: sn2.player.movement.qbSuccessfulCount })}`);
    const lc = await listenerCounts(s);
    const diff = Object.keys({ ...base, ...lc }).filter((k) => (base[k] ?? 0) !== (lc[k] ?? 0));
    if (diff.length) bad.push(`再出撃 ${round}: イベントリスナー数が変化 ${diff.map((k) => `${k} ${base[k] ?? 0}→${lc[k] ?? 0}`).join(', ')}`);
    const rr = await rafPerFrame();
    if (rr !== raf0) bad.push(`再出撃 ${round}: 1 フレームあたりの rAF 予約数 ${raf0} → ${rr} (更新ループの重複)`);
  }
  // 格納庫へ戻る -> 構成が保持されている -> 再度出撃
  await fail();
  await s.click('.screen-result .btn:not(.btn-primary)');
  await s.step(3, 20);
  const g = await s.snap();
  const gui = await s.page.evaluate(() => ({ garageVisible: !(document.querySelector('#garage') as HTMLElement).hidden, resultHidden: (document.querySelector('.screen-result') as HTMLElement).hidden, sel: Array.from(document.querySelectorAll('.card.selected')).map((e) => (e as HTMLElement).dataset.part) }));
  if (!(g.state === 'garage' && gui.garageVisible && gui.resultHidden && JSON.stringify(gui.sel.sort()) === JSON.stringify(['fcs:narrow', 'generator:recovery', 'legs:quadruped']))) bad.push(`格納庫へ戻る: ${JSON.stringify({ state: g.state, ...gui })}`);
  await s.sortie();
  await s.step(5, 20);
  const lc2 = await listenerCounts(s);
  const diff2 = Object.keys({ ...base, ...lc2 }).filter((k) => (base[k] ?? 0) !== (lc2[k] ?? 0));
  if (diff2.length) bad.push(`格納庫経由の再出撃: イベントリスナー数が変化 ${diff2.map((k) => `${k} ${base[k] ?? 0}→${lc2[k] ?? 0}`).join(', ')}`);
  const rr2 = await rafPerFrame();
  if (rr2 !== raf0) bad.push(`格納庫経由の再出撃: rAF 予約数 ${raf0} → ${rr2}`);
  ok('H7', `失敗 → 結果画面 → 再出撃 ×3 → 格納庫へ戻る → 再出撃: 結果画面の内容・失敗後の停止・全項目の初期化・構成 (狭範囲/高回復/4脚) の保持・イベントリスナー (${Object.keys(base).length} 種類) と rAF ループが増えない (実クリック・実 DOM)`, bad.length === 0, `${bad.slice(0, 3).join(' | ')} (rAF/フレーム=${raf0})`);
  ok('H7z', 'H7 セッション: 外部リクエスト無し・エラー無し', s.external.length === 0 && s.appProblems().length === 0, JSON.stringify(s.appProblems().slice(0, 2)));
  await s.close();
}

async function main(): Promise<void> {
  await startServer();
  const browser = await launchBrowser();
  try {
    for (const [k, fn] of [['H1', h1], ['H2', h2], ['H3', h3], ['H4', h4], ['H5', h5], ['H6', h6], ['H7', h7]] as const) {
      if (!want(k)) continue;
      console.log(`--- ${k} ---`);
      await fn(browser);
    }
  } finally {
    await browser.close();
    stopServer();
  }
  const fails = checks.filter((c) => c.status === 'fail');
  console.log(`\n== hud-audit: ${checks.length} checks, ${fails.length} fail ==`);
  for (const c of fails) console.log(`FAIL ${c.id} ${c.title} :: ${c.detail}`);
  console.log('images:\n' + images.map((i) => `  ${i.path}  ${i.note}`).join('\n'));
}

main().catch((e) => {
  console.error(e);
  stopServer();
  process.exit(1);
});
