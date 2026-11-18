/**
 * audit-ui 実ブラウザ監査 (1/3): 格納庫 (SPEC §3 / §8 操作説明 / §1 リサイズ)。
 * 実行: npx tsx tests/audit-ui/garage-audit.ts   (127.0.0.1:5230 に build -> preview を立てて、終了時に止める)
 */
import { ImgAnalyzer } from './img';
import type { Rect } from './img';
import { checks, f, images, launchBrowser, ok, rec, Sess, startServer, stopServer } from './lib';

const SPEC_FCS = { wide: { r: 0.3, lock: 1.2, name: '広範囲' }, medium: { r: 0.2, lock: 0.8, name: '中範囲' }, narrow: { r: 0.1, lock: 0.4, name: '狭範囲' } } as const;
const SPEC_GEN = { capacity: { en: 180, regen: 10, name: '大容量' }, balanced: { en: 120, regen: 15, name: '均衡' }, recovery: { en: 90, regen: 20, name: '高回復' } } as const;
const SPEC_LEGS = { biped: { speed: 1.0, regen: 1.0, lockSpeed: 1.0, name: '2脚' }, quadruped: { speed: 0.8, regen: 0.75, lockSpeed: 1.5, name: '4脚' } } as const;

const num = (s: string): number => Number(/-?\d+(?:\.\d+)?/.exec(s)![0]);

async function main(): Promise<void> {
  await startServer();
  const browser = await launchBrowser();
  const img = new ImgAnalyzer(browser);
  try {
    // ------------------------------------------------------------------------------------------------ 1280x720 @2x
    const s = await Sess.open(browser, { w: 1280, h: 720, dpr: 2 });
    const page = s.page;

    // ---- 初期状態
    const sn0 = await s.snap();
    ok('G01', '起動直後は格納庫 (state=garage)', sn0.state === 'garage', `state=${sn0.state}`);
    ok('G02', '初期選択 = 中範囲FCS/均衡/2脚 (スナップショット)', sn0.loadout.fcs === 'medium' && sn0.loadout.generator === 'balanced' && sn0.loadout.legs === 'biped', JSON.stringify(sn0.loadout));
    const dom0 = await page.evaluate(() => {
      const sel = Array.from(document.querySelectorAll('.gar-sec .card.selected')).map((e) => (e as HTMLElement).dataset.part);
      const cards = Array.from(document.querySelectorAll('.gar-sec .card')).map((e) => ({
        part: (e as HTMLElement).dataset.part,
        name: e.querySelector('.card-name')?.textContent,
        pro: e.querySelector('.tag.pro')?.parentElement?.textContent,
        con: e.querySelector('.tag.con')?.parentElement?.textContent,
        checked: e.getAttribute('aria-checked'),
      }));
      return { sel, cards, selected: document.querySelector('.gar-selected')?.textContent, weapon: document.body.innerText.includes('マシンガン') };
    });
    ok('G03', '初期の選択中カード = fcs:medium / generator:balanced / legs:biped (DOM)', JSON.stringify(dom0.sel.sort()) === JSON.stringify(['fcs:medium', 'generator:balanced', 'legs:biped']), JSON.stringify(dom0.sel));
    ok('G04', '部品カード 8 枚すべてに「長所」「短所」の文がある (DOM)', dom0.cards.length === 8 && dom0.cards.every((c) => (c.pro ?? '').length > 5 && (c.con ?? '').length > 5), `cards=${dom0.cards.length}`);
    ok('G05', '「選択中: ...」の表示が選択と一致 (DOM)', /中範囲FCS.*均衡ジェネレーター.*2脚/.test(dom0.selected ?? ''), dom0.selected ?? '');

    // ---- 初期画面 (頭部を正面から)
    await s.step(2, 16);
    const p0 = await s.shot('g01-garage-default-2x', '格納庫 初期表示 (1280x720, dpr2)');
    const headRect: Rect = { x: 2 * 500, y: 2 * 170, w: 2 * 280, h: 2 * 200 };
    await page.screenshot({ path: p0.replace('.png', '-head.png'), clip: { x: 500, y: 170, width: 280, height: 200 }, timeout: 120000 });
    images.push({ path: p0.replace('.png', '-head.png'), note: '格納庫 頭部クローズアップ (正面)' });
    const l0 = await img.luma(p0.replace('.png', '-head.png'));
    rec('G06', '頭部クローズアップの輝度 (見えていること)', l0.mean > 0.12 && l0.p95 > 0.5 ? 'pass' : 'fail', `mean=${f(l0.mean)} p5=${f(l0.p5)} p95=${f(l0.p95)} (画像を目視で確認: ${p0.replace('.png', '-head.png')})`);
    void headRect;

    // ---- 18構成: 実クリックで全構成を選び、表示 (DOM) と snapshot を SPEC の式と突き合わせる
    let bad = 0;
    let n = 0;
    const details: string[] = [];
    for (const fcs of ['wide', 'medium', 'narrow'] as const) {
      for (const gen of ['capacity', 'balanced', 'recovery'] as const) {
        for (const legs of ['biped', 'quadruped'] as const) {
          for (const [k, id] of [['fcs', fcs], ['generator', gen], ['legs', legs]] as const) {
            const sel = await page.evaluate((part) => (document.querySelector(`.card[data-part="${part}"]`) as HTMLElement).classList.contains('selected'), `${k}:${id}`);
            if (!sel) await s.click(`.card[data-part="${k}:${id}"]`);
          }
          n++;
          const st = await page.evaluate(() => {
            const dl = document.querySelector('.stat-grid')!;
            const kk = Array.from(dl.querySelectorAll('dt')).map((e) => e.textContent ?? '');
            const vv = Array.from(dl.querySelectorAll('dd')).map((e) => e.textContent ?? '');
            const m: Record<string, string> = {};
            kk.forEach((k, i) => (m[k] = vv[i]));
            const sel = Array.from(document.querySelectorAll('.card.selected')).map((e) => (e as HTMLElement).dataset.part);
            return { m, sel, txt: document.querySelector('.gar-selected')?.textContent ?? '' };
          });
          const want = {
            maxEn: SPEC_GEN[gen].en,
            regen: SPEC_GEN[gen].regen * SPEC_LEGS[legs].regen,
            lock: SPEC_FCS[fcs].lock / SPEC_LEGS[legs].lockSpeed,
            walk: 10 * SPEC_LEGS[legs].speed,
            glide: 22 * SPEC_LEGS[legs].speed,
            air: 16 * SPEC_LEGS[legs].speed,
            qb: 80 * SPEC_LEGS[legs].speed,
            r: SPEC_FCS[fcs].r,
          };
          const got = {
            maxEn: num(st.m['最大EN']),
            regen: num(st.m['EN回復率']),
            lock: num(st.m['ロック所要時間']),
            walk: num(st.m['歩行速度']),
            glide: num(st.m['グライド速度(地上)']),
            air: num(st.m['空中水平速度']),
            qb: num(st.m['QB速度']),
            r: num(st.m['ロック領域']),
          };
          const tol = { maxEn: 0, regen: 0.006, lock: 0.006, walk: 0.006, glide: 0.006, air: 0.006, qb: 0.006, r: 0.0051 };
          const errs: string[] = [];
          for (const key of Object.keys(want) as (keyof typeof want)[]) if (Math.abs(want[key] - got[key]) > tol[key]) errs.push(`${key}: 表示 ${got[key]} / 期待 ${want[key]}`);
          const selOk = JSON.stringify(st.sel.sort()) === JSON.stringify([`fcs:${fcs}`, `generator:${gen}`, `legs:${legs}`].sort());
          const nameOk = st.txt.includes(SPEC_FCS[fcs].name) && st.txt.includes(SPEC_GEN[gen].name) && st.txt.includes(SPEC_LEGS[legs].name);
          const sn = await s.snap();
          const snOk =
            sn.loadout.fcs === fcs &&
            sn.loadout.generator === gen &&
            sn.loadout.legs === legs &&
            sn.effectiveStats.maxEn === want.maxEn &&
            Math.abs(sn.effectiveStats.regenPerSecond - want.regen) < 1e-9 &&
            Math.abs(sn.effectiveStats.lockSeconds - want.lock) < 1e-9 &&
            Math.abs(sn.effectiveStats.horizontalSpeedMultiplier - SPEC_LEGS[legs].speed) < 1e-9;
          if (errs.length || !selOk || !nameOk || !snOk) {
            bad++;
            details.push(`${fcs}/${gen}/${legs}: ${errs.join('; ')} sel=${selOk} name=${nameOk} snap=${snOk}`);
          }
        }
      }
    }
    ok('G07', '18構成すべて (実クリック) で 選択表示・最大EN・EN回復率・ロック所要時間・ロック領域・各速度の表示が SPEC の式と一致、snapshot の実効値も一致', n === 18 && bad === 0, `構成数=${n} 不一致=${bad} ${details.slice(0, 3).join(' | ')}`);

    // ---- 2脚 / 4脚の実モデル
    for (const [k, id] of [['fcs', 'medium'], ['generator', 'balanced'], ['legs', 'biped']] as const) {
      const sel = await page.evaluate((part) => (document.querySelector(`.card[data-part="${part}"]`) as HTMLElement).classList.contains('selected'), `${k}:${id}`);
      if (!sel) await s.click(`.card[data-part="${k}:${id}"]`);
    }
    await s.step(2, 16);
    const bipA = await s.shot('g02-hangar-biped-a', '格納庫 2脚 (フレームA)');
    await s.step(6, 100);
    const bipB = await s.shot('g03-hangar-biped-b', '格納庫 2脚 (0.6秒後 フレームB)');
    await s.click('.card[data-part="legs:quadruped"]');
    await s.step(2, 16);
    const quadA = await s.shot('g04-hangar-quad-a', '格納庫 4脚 (フレームA)');
    await s.step(6, 100);
    const quadB = await s.shot('g05-hangar-quad-b', '格納庫 4脚 (0.6秒後 フレームB)');
    // 脚の領域 (機体中央の下半分): x 520..760, y 400..600 (CSS px) -> dpr2
    const legRect: Rect = { x: 2 * 520, y: 2 * 400, w: 2 * 240, h: 2 * 200 };
    const bodyRect: Rect = { x: 2 * 520, y: 2 * 170, w: 2 * 240, h: 2 * 230 };
    const dModel = await img.diff(bipA, quadA, legRect);
    const dBiWalk = await img.diff(bipA, bipB, legRect, 20);
    const dQuWalk = await img.diff(quadA, quadB, legRect, 20);
    const dBodyModel = await img.diff(bipA, quadA, bodyRect);
    ok('G08', '脚部を 2脚→4脚 に変えると格納庫の 3D モデルの脚の領域が実際に変わる (画素差)', dModel > 0.05, `脚領域の差分画素 ${f(dModel * 100, 1)}% (胴・頭領域は ${f(dBodyModel * 100, 1)}%)`);
    ok('G09', '格納庫の 2脚モデルが 0.6 秒で脚の領域が変化する = 歩行アニメーション (画素差)', dBiWalk > 0.01, `差分画素 ${f(dBiWalk * 100, 2)}% (${bipA} vs ${bipB})`);
    ok('G10', '格納庫の 4脚モデルが 0.6 秒で脚の領域が変化する = 歩行アニメーション (画素差)', dQuWalk > 0.01, `差分画素 ${f(dQuWalk * 100, 2)}% (${quadA} vs ${quadB})`);
    // 脚数を目視で数えるための拡大 (4脚)
    await page.screenshot({ path: quadA.replace('.png', '-legs.png'), clip: { x: 480, y: 380, width: 320, height: 230 }, timeout: 120000 });
    images.push({ path: quadA.replace('.png', '-legs.png'), note: '格納庫 4脚 脚部クローズアップ' });
    await page.screenshot({ path: bipA.replace('.png', '-legs.png'), clip: { x: 480, y: 380, width: 320, height: 230 }, timeout: 120000 });
    images.push({ path: bipA.replace('.png', '-legs.png'), note: '格納庫 2脚 脚部クローズアップ' });

    // ---- ターンテーブルが回る (側面/背面): 時間を進めて撮る
    await s.step(40, 100);
    await s.shot('g06-hangar-quad-turn1', '格納庫 4脚 回転中 (+4秒)');
    await s.step(40, 100);
    await s.shot('g07-hangar-quad-turn2', '格納庫 4脚 回転中 (+8秒)');
    // 2脚へ戻す
    await s.click('.card[data-part="legs:biped"]');
    await s.step(2, 16);

    // ---- レイアウト: パネルが画面内で、出撃ボタンが押せる (最上位の要素)
    const lay = await page.evaluate(() => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const rects = Array.from(document.querySelectorAll('.gar-sec, .gar-bottom, .gar-title')).map((e) => {
        const r = e.getBoundingClientRect();
        return { cls: e.className, l: r.left, t: r.top, r: r.right, b: r.bottom };
      });
      const btn = document.querySelector('.gar-buttons .btn-primary') as HTMLElement;
      const br = btn.getBoundingClientRect();
      const top = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
      const scrollers = Array.from(document.querySelectorAll('.gar-side')).map((e) => ({ sh: e.scrollHeight, ch: e.clientHeight }));
      return { W, H, rects, btnTop: top === btn, scrollers, docScroll: document.documentElement.scrollWidth > W || document.documentElement.scrollHeight > H };
    });
    const inside = lay.rects.every((r) => r.l >= -0.5 && r.t >= -0.5 && r.r <= lay.W + 0.5 && r.b <= lay.H + 0.5);
    ok('G11', '1280x720 の格納庫: 全パネルが画面内・ページスクロール無し・出撃ボタンが最前面', inside && lay.btnTop && !lay.docScroll, `inside=${inside} btnTop=${lay.btnTop} docScroll=${lay.docScroll} sidePanelOverflow=${JSON.stringify(lay.scrollers)}`);

    // ---- 操作説明 (出撃前)
    await s.click('.gar-buttons .btn:not(.btn-primary)');
    await s.step(1, 16);
    const help = await page.evaluate(() => {
      const ov = document.querySelector('.help-overlay') as HTMLElement | null;
      return { visible: !!ov && !ov.hidden, text: ov?.innerText ?? '' };
    });
    ok('G12', '出撃前 (格納庫) から「操作方法を確認」で操作説明が開く', help.visible, `visible=${help.visible} 文字数=${help.text.length}`);
    const T = help.text;
    ok('G13', '操作説明: 対象をFCS領域に保てば偏差と重力を自動補正 / 中央照準を補正マーカーへ手動で合わせる必要はない', /偏差と重力を自動補正/.test(T) && /手動で合わせる必要はない/.test(T), '');
    ok('G14', '操作説明: Qは単発・36 EN / QB後は自動グライド / グライドは0 EN / 停止は左CtrlまたはShiftでの解除', /単発[^\n]*36\s*EN/.test(T) && /自動でグライド/.test(T) && /グライドは0\s*EN/.test(T) && /左CtrlまたはShift/.test(T), '');
    await s.shot('g08-help-garage', '格納庫から開いた操作説明');
    await s.click('.help-overlay .btn');
    await s.step(1, 16);
    const closed = await page.evaluate(() => Boolean((document.querySelector('.help-overlay') as HTMLElement).hidden));
    ok('G15', '操作説明を閉じられる', closed, '');

    // ---- リサイズ (格納庫): 各サイズで全パネルが画面内・スクロール無し・出撃ボタンが最前面・canvas が追従・機体 (頭部) が画面内に描かれる
    const resizeBad: string[] = [];
    for (const [w, h] of [[1920, 1080], [1280, 1024], [2560, 1440], [2560, 1080], [3840, 2160], [1500, 720], [1280, 720]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await s.waitUntil(async () => (await page.evaluate(() => (document.querySelector('#game-canvas') as HTMLCanvasElement).getBoundingClientRect().width)) === w, 15000, `resize ${w}x${h}`);
      await s.step(3, 16);
      const r = await page.evaluate(() => {
        const W = window.innerWidth;
        const H = window.innerHeight;
        const rects = Array.from(document.querySelectorAll('.gar-sec, .gar-bottom, .gar-title')).map((e) => {
          const b = e.getBoundingClientRect();
          return { cls: e.className, l: b.left, t: b.top, r: b.right, b: b.bottom };
        });
        const btn = document.querySelector('.gar-buttons .btn-primary') as HTMLElement;
        const br = btn.getBoundingClientRect();
        const top = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
        const c = document.querySelector('#game-canvas') as HTMLCanvasElement;
        const cr = c.getBoundingClientRect();
        return { W, H, rects, btnTop: top === btn, cssW: cr.width, cssH: cr.height, bufW: c.width, bufH: c.height, docScroll: document.documentElement.scrollWidth > W || document.documentElement.scrollHeight > H };
      });
      const insideAll = r.rects.every((q) => q.l >= -0.5 && q.t >= -0.5 && q.r <= r.W + 0.5 && q.b <= r.H + 0.5);
      // 左右パネルの間の空き (参考値。頭部が実際にパネルに隠れるかは head-audit.ts が測る)
      const leftMax = Math.max(...r.rects.filter((q) => q.l < r.W / 2 && q.cls.includes('gar-sec')).map((q) => q.r));
      const rightMin = Math.min(...r.rects.filter((q) => q.l >= r.W / 2 && q.cls.includes('gar-sec')).map((q) => q.l));
      const gap = rightMin - leftMax;
      const good = insideAll && r.btnTop && !r.docScroll && Math.abs(r.cssW - w) < 1 && Math.abs(r.cssH - h) < 1 && r.bufW >= 0.75 * w; // 描画バッファは性能上限で CSS 幅の 0.75 倍以上 (4K で 3126x1758 に抑える)
      if (!good) resizeBad.push(`${w}x${h}: inside=${insideAll} btnTop=${r.btnTop} scroll=${r.docScroll} canvas=${r.cssW}x${r.cssH} buf=${r.bufW}x${r.bufH} 中央の空き=${f(gap, 0)}px`);
      if (w === 1920 || (w === 1280 && h === 1024)) await s.shot(`g09-garage-${w}x${h}`, `格納庫 ${w}x${h}`);
    }
    ok('G18', '格納庫のリサイズ (1920x1080 / 1280x1024 / 2560x1440 / 2560x1080 / 3840x2160 / 1500x720 / 1280x720): 全パネルが画面内・スクロール無し・出撃ボタンが最前面・canvas が追従', resizeBad.length === 0, resizeBad.join(' | '));
    await page.setViewportSize({ width: 1280, height: 720 });
    await s.step(2, 16);

    // ---- 外部通信
    ok('G16', '格納庫までの全リクエストが 127.0.0.1:5230 内 (外部へのリクエストなし・abort 0 件)', s.external.length === 0, `requests=${s.requests.length} external=${JSON.stringify(s.external)}`);
    const probs = s.appProblems();
    ok('G17', '格納庫でコンソールエラー/警告・ページエラー・失敗リクエスト無し', probs.length === 0, JSON.stringify(probs.slice(0, 5)));
    await s.close();
  } finally {
    await img.close();
    await browser.close();
    stopServer();
  }
  const fails = checks.filter((c) => c.status === 'fail');
  console.log(`\n== garage-audit: ${checks.length} checks, ${fails.length} fail ==`);
  for (const c of fails) console.log(`FAIL ${c.id} ${c.title} :: ${c.detail}`);
  console.log('images:\n' + images.map((i) => `  ${i.path}  ${i.note}`).join('\n'));
}

main().catch((e) => {
  console.error(e);
  stopServer();
  process.exit(1);
});
