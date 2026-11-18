/**
 * e2e 6: リサイズ (1280x720, 1600x900, 1920x1080, 2560x1440, 1024x768)。
 * FCS円の画面上の半径 = ratio x min(w,h)、canvas と HUD が追従、HUD が画面外へはみ出さない。
 */
import type { Browser } from 'playwright';
import { FCS_PARTS } from '../../src/config';
import { Sess, f, near, ok, rec, sleep, state } from './lib';

const SIZES: [number, number][] = [
  [1280, 720],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
  [1024, 768],
];

interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

async function measureHud(s: Sess): Promise<{
  canvas: { w: number; h: number; pw: number; ph: number };
  svgViewBox: string | null;
  ret: { r: number | null; rect: Rect | null; cls: string | null };
  panels: { name: string; rect: Rect }[];
  markers: { cls: string; rect: Rect }[];
  scroll: { sw: number; sh: number; cw: number; ch: number };
  dpr: number;
}> {
  return s.page.evaluate(() => {
    const R = (e: Element): { l: number; t: number; r: number; b: number } => {
      const b = e.getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom };
    };
    const c = document.getElementById('game-canvas') as HTMLCanvasElement;
    const cb = c.getBoundingClientRect();
    const base = document.querySelector('.ret-base');
    const panels: { name: string; rect: { l: number; t: number; r: number; b: number } }[] = [];
    for (const sel of ['.hud-mission', '.hud-next', '.hud-fcs', '.hud-weapons', '.hud-right', '.hud-hp', '.hud-notices']) {
      const e = document.querySelector(sel);
      if (e && (e as HTMLElement).offsetParent !== null) panels.push({ name: sel.replace('.hud-', ''), rect: R(e) });
    }
    const markers: { cls: string; rect: { l: number; t: number; r: number; b: number } }[] = [];
    document.querySelectorAll('.hud-mk').forEach((m) => {
      if ((m as SVGElement).style.display !== 'none') markers.push({ cls: m.getAttribute('class') ?? '', rect: R(m) });
    });
    return {
      canvas: { w: cb.width, h: cb.height, pw: c.width, ph: c.height },
      svgViewBox: document.querySelector('.hud-svg')?.getAttribute('viewBox') ?? null,
      ret: { r: base ? Number(base.getAttribute('r')) : null, rect: base ? R(base) : null, cls: document.querySelector('.hud-reticle')?.getAttribute('class') ?? null },
      panels,
      markers,
      scroll: { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight },
      dpr: window.devicePixelRatio,
    };
  });
}

const inside = (r: Rect, w: number, h: number, tol = 1): boolean => r.l >= -tol && r.t >= -tol && r.r <= w + tol && r.b <= h + tol;
const overlap = (a: Rect, b: Rect): number => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));

/**
 * ビューポートを変えて、ページの resize イベント (レンダリング機会に届く) がアプリに反映されるまで待つ。
 * 高負荷で headless の描画が遅れると、固定フレーム数だけ待つ方式ではイベント到着前に測ってしまう (前回の 6.p1600x900 の不合格の原因)。
 * 反映されない場合は待ち切って測定し、そのまま不合格として記録される (待つだけで合格にはならない)。
 */
async function resizeTo(S: Sess, w: number, h: number, ratio: number): Promise<void> {
  await S.page.setViewportSize({ width: w, height: h });
  const want = ratio * Math.min(w, h);
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    // フレームは進めない (プレイ中にゲーム時間が進んで被弾しないように)。resize イベントはブラウザのレンダリング機会で届く (rAF とは別)
    const inner = await S.page.evaluate(() => [window.innerWidth, window.innerHeight]);
    const sn = await S.snap();
    if (inner[0] === w && inner[1] === h && near(sn.lock.radiusCssPx, want, 1e-6)) break;
    if (Date.now() - t0 > 30000) break;
    await sleep(50);
  }
  await S.step(3, 50);
}

export async function section6(browser: Browser, base: string): Promise<void> {
  state.section = 6;
  const S = await Sess.open(browser, base, 'resize', { w: 1280, h: 720 });
  await S.step(2, 50);
  const ratio = FCS_PARTS.medium.radiusRatio;

  // ---- 格納庫 (garage) で各サイズ
  for (const [w, h] of SIZES) {
    await resizeTo(S, w, h, ratio);
    const m = await S.page.evaluate(() => {
      const R = (e: Element | null): { l: number; t: number; r: number; b: number } | null => {
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { l: b.left, t: b.top, r: b.right, b: b.bottom };
      };
      const c = document.getElementById('game-canvas') as HTMLCanvasElement;
      const cb = c.getBoundingClientRect();
      return {
        canvas: { w: cb.width, h: cb.height, pw: c.width, ph: c.height },
        parts: ['.gar-title', '.gar-left', '.gar-right', '.gar-bottom', '.gar-buttons .btn-primary', '.gar-stats'].map((sel) => ({ sel, rect: R(document.querySelector(sel)) })),
        scroll: { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight },
        // 左右パネルの内部スクロール (内容が多くて画面に収まらないときは各パネルがスクロールできる)
        panelScroll: Array.from(document.querySelectorAll('.gar-side')).map((e) => ({ sh: e.scrollHeight, ch: e.clientHeight })),
      };
    });
    const snap = await S.snap();
    const outside = m.parts.filter((p) => p.rect && !inside(p.rect, w, h)).map((p) => p.sel);
    const canvasOk = near(m.canvas.w, w, 0.5) && near(m.canvas.h, h, 0.5) && near(m.canvas.pw, w * 1, 1) && near(m.canvas.ph, h * 1, 1);
    const radiusOk = near(snap.lock.radiusCssPx, ratio * Math.min(w, h), 1e-6);
    ok(
      `6.g${w}x${h}`,
      `格納庫 ${w}x${h}: canvas が全面に追従、パネルと出撃ボタンが画面内、ページのスクロールなし、lock.radiusCssPx = 0.20 x min(w,h)`,
      canvasOk && outside.length === 0 && m.scroll.sw <= w && m.scroll.sh <= h && radiusOk,
      `canvas 表示 ${f(m.canvas.w, 0)}x${f(m.canvas.h, 0)} 描画 ${m.canvas.pw}x${m.canvas.ph} / 画面外のパネル=${outside.join(',') || 'なし'} / scroll ${m.scroll.sw}x${m.scroll.sh} / radius ${f(snap.lock.radiusCssPx, 3)} (期待 ${f(ratio * Math.min(w, h), 3)}) / パネル内部スクロール ${m.panelScroll.map((x) => `${x.sh}/${x.ch}`).join(' ')}`,
    );
    if (w === 1024) await S.shot('garage-1024x768', '格納庫 1024x768 (下限未満)');
    if (w === 1920) await S.shot('garage-1920x1080', '格納庫 1920x1080');
  }

  // ---- 出撃してプレイ中に各サイズ
  await resizeTo(S, 1280, 720, ratio);
  await S.sortie();
  await S.step(6, 50);
  const sizesResult: string[] = [];
  const problems: string[] = [];
  for (const [w, h] of SIZES) {
    await resizeTo(S, w, h, ratio);
    const m = await measureHud(S);
    const snap = await S.snap();
    const R = ratio * Math.min(w, h);
    const domR = m.ret.rect ? (m.ret.rect.r - m.ret.rect.l) / 2 : NaN;
    const cx = m.ret.rect ? (m.ret.rect.l + m.ret.rect.r) / 2 : NaN;
    const cy = m.ret.rect ? (m.ret.rect.t + m.ret.rect.b) / 2 : NaN;
    const tag = `${w}x${h}`;
    const errs: string[] = [];
    if (!(near(snap.lock.radiusCssPx, R, 1e-6))) errs.push(`snapshot.lock.radiusCssPx=${snap.lock.radiusCssPx} 期待=${R}`);
    if (!(m.ret.r !== null && near(m.ret.r, snap.lock.radiusCssPx, 1e-6))) errs.push(`DOMの円 r=${m.ret.r} != snapshot ${snap.lock.radiusCssPx}`);
    if (!near(domR, R, 1.6)) errs.push(`DOMの円の画面上の半径=${f(domR, 2)} 期待=${f(R, 2)} (線幅込みの許容1.6px)`);
    if (!(near(cx, w / 2, 1.0) && near(cy, h / 2, 1.0))) errs.push(`円の中心=(${f(cx, 1)},${f(cy, 1)}) 期待=(${w / 2},${h / 2})`);
    if (m.svgViewBox !== `0 0 ${w} ${h}`) errs.push(`HUD svg viewBox=${m.svgViewBox}`);
    if (!(near(m.canvas.w, w, 0.5) && near(m.canvas.h, h, 0.5) && near(m.canvas.pw, w * m.dpr, 1) && near(m.canvas.ph, h * m.dpr, 1))) errs.push(`canvas ${m.canvas.w}x${m.canvas.h} 描画 ${m.canvas.pw}x${m.canvas.ph}`);
    const out = m.panels.filter((p) => !inside(p.rect, w, h));
    if (out.length) errs.push(`画面外のHUD: ${out.map((p) => p.name).join(',')}`);
    const outM = m.markers.filter((p) => !inside(p.rect, w + 40, h + 40, 0)); // マーカーは矢印が端に置かれる (余白付き)
    if (outM.length) errs.push(`画面外のマーカー ${outM.length}個`);
    if (m.scroll.sw > w || m.scroll.sh > h) errs.push(`ページがスクロールする ${m.scroll.sw}x${m.scroll.sh}`);
    // 主要パネル同士の重なり
    const ov: string[] = [];
    for (let i = 0; i < m.panels.length; i++) {
      for (let j = i + 1; j < m.panels.length; j++) {
        const a = overlap(m.panels[i].rect, m.panels[j].rect);
        if (a > 1) ov.push(`${m.panels[i].name}x${m.panels[j].name}(${Math.round(a)}px²)`);
      }
    }
    // 円がパネルに隠れない: 判定円 (中心±半径) がどの HUD パネルとも重ならない
    const circle: Rect = { l: cx - domR, t: cy - domR, r: cx + domR, b: cy + domR };
    const coverCircle = m.panels.filter((p) => overlap(p.rect, circle) > 1).map((p) => p.name);
    if (ov.length) errs.push(`パネルの重なり: ${ov.join(' ')}`);
    if (coverCircle.length) errs.push(`判定円と重なるパネル: ${coverCircle.join(',')}`);
    const panelArea = m.panels.reduce((a, p) => a + (p.rect.r - p.rect.l) * (p.rect.b - p.rect.t), 0);
    const share = (100 * panelArea) / (w * h);
    sizesResult.push(`${tag}: 円 r=${f(domR, 1)} (期待 ${f(R, 1)}) HUDパネルの面積率 ${f(share, 1)}%`);
    if (errs.length) problems.push(`${tag}: ${errs.join(' / ')}`);
    ok(
      `6.p${tag}`,
      `プレイ中 ${tag}: FCS円の画面上の半径 = 0.20 x min(w,h) (DOM の円 = snapshot.lock.radiusCssPx)・中心が画面中央、canvas と HUD が追従、HUD が画面外へはみ出さない・重ならない${w === 1024 ? ' (下限未満でも壊れない)' : ''}`,
      errs.length === 0,
      errs.length === 0 ? `円 r=${f(domR, 2)}px (期待 ${f(R, 2)}) 中心 (${f(cx, 1)},${f(cy, 1)}) / canvas ${f(m.canvas.w, 0)}x${f(m.canvas.h, 0)} 描画 ${m.canvas.pw}x${m.canvas.ph} / HUDパネル面積 ${f(share, 1)}% / 画面外0・重なり0` : errs.join(' / '),
    );
    if (w === 1920 || w === 1024 || w === 2560) await S.shot(`hud-${w}x${h}`, `プレイ中のHUD ${w}x${h}`);
  }

  // ---- 一時停止・結果ダイアログが下限サイズでも画面内に収まる
  await resizeTo(S, 1024, 768, ratio);
  await S.page.keyboard.press('Escape');
  await S.waitState('paused', 10000);
  await S.step(2, 50);
  const dlg = await S.page.evaluate(() => {
    const d = document.querySelector('.screen-pause .dialog') as HTMLElement;
    const b = d.getBoundingClientRect();
    return { l: b.left, t: b.top, r: b.right, b: b.bottom, scroll: d.scrollHeight > d.clientHeight };
  });
  ok('6.dlg', '一時停止ダイアログが 1024x768 でも画面内に収まる', inside(dlg, 1024, 768), `rect=${f(dlg.l, 0)},${f(dlg.t, 0)}-${f(dlg.r, 0)},${f(dlg.b, 0)} 内部スクロール=${dlg.scroll}`);
  await S.click('.screen-pause .btn-primary');
  await S.waitState('playing', 30000);
  await resizeTo(S, 1280, 720, ratio);
  const back = await measureHud(S);
  const snapBack = await S.snap();
  ok('6.back', '縮小・拡大を繰り返した後 1280x720 に戻すと円の半径も元 (144px) に戻る', near(snapBack.lock.radiusCssPx, 144, 1e-6) && !!back.ret.rect && near((back.ret.rect.r - back.ret.rect.l) / 2, 144, 1.6), `snapshot=${f(snapBack.lock.radiusCssPx, 3)} DOM=${back.ret.rect ? f((back.ret.rect.r - back.ret.rect.l) / 2, 2) : 'なし'}`);
  const pr = S.appProblems();
  ok('6.log', 'リサイズ中にコンソールのエラー/警告が出ない', pr.length === 0, pr.length ? pr.slice(0, 3).map((p) => p.text).join(' | ') : 'エラー0 / 警告0');
  rec('6.sum', '各サイズの判定円', 'info', sizesResult.join(' ; ') + (problems.length ? ' || 問題: ' + problems.join(' ; ') : ''));
  await S.close();
}
