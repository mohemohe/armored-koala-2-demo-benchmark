/**
 * audit-ui 実ブラウザ監査 (4/4): HUD/FCS の投影と、実際に描画された 3D 画像の位置合わせ (SPEC §5 / §8 「表示円と実際の判定円は一致し、リサイズ後も一致」)。
 * 敵を画面の複数の位置に置き、「敵あり」「敵なし」の 2 枚の差分から敵の描画位置 (画素の重心・外接矩形) を取り出し、
 * シミュレーションのカメラで投影した位置 (= HUD のマーカー位置・FCS の判定点) と比べる。
 * 画面サイズ・縦横比・devicePixelRatio を変えても、描画された敵の位置が投影位置の上にあることを確かめる。
 * 実行: npx tsx tests/audit-ui/align-audit.ts
 */
import { ImgAnalyzer } from './img';
import { checks, f, launchBrowser, ok, rec, Sess, startServer, stopServer } from './lib';

const CONFIGS: { w: number; h: number; dpr: number }[] = [
  { w: 1280, h: 720, dpr: 1 },
  { w: 1600, h: 900, dpr: 1 },
  { w: 1280, h: 1024, dpr: 1 },
  { w: 1500, h: 720, dpr: 1 },
  { w: 1280, h: 720, dpr: 2 },
];
// カメラ基準の敵の位置 [右 m, 上 m, 前 m]
const PLACES: [number, number, number][] = [
  [0, 0, 30],
  [5, 2, 30],
  [-6, -1, 24],
  [8, 3, 45],
  [-9, 1, 18],
];

const offsets = new Map<string, { dx: number; dy: number }[]>(); // 配置 -> 各構成での (描画の重心 - 投影点) [CSS px]

async function main(): Promise<void> {
  await startServer();
  const browser = await launchBrowser();
  const img = new ImgAnalyzer(browser);
  try {
    for (const cfg of CONFIGS) {
      const tag = `${cfg.w}x${cfg.h}@${cfg.dpr}x`;
      const s = await Sess.open(browser, { ...cfg, path: 'tests/audit-ui/harness.html' });
      await s.sortie();
      await s.page.addStyleTag({ content: '#hud, #screens { display: none !important; }' });
      await s.app((app) => {
        for (const e of app.game.state.enemies) e.scripted = true;
      });
      await s.appWith({}, (app) => {
        const st = app.game.state;
        st.player.pos = { x: 12, y: 1.5, z: 14 };
        st.player.yaw = Math.PI;
        st.player.pitch = 0;
        app.game.look(0, 0);
      });
      await s.step(4, 16);
      const rows: string[] = [];
      let worst = 0;
      let inside = 0;
      let n = 0;
      for (const [r, u, d] of PLACES) {
        const placed = await s.appWith({ r, u, d }, (app, a) => {
          const st = app.game.state;
          const c = st.camera;
          const e = st.enemies.find((x) => x.id === 'G01')!;
          e.alive = true;
          e.hp = e.maxHp;
          e.scripted = true;
          e.pos = { x: c.pos.x + c.forward.x * a.d + c.right.x * a.r + c.up.x * a.u, y: c.pos.y + c.forward.y * a.d + c.right.y * a.r + c.up.y * a.u, z: c.pos.z + c.forward.z * a.d + c.right.z * a.r + c.up.z * a.u };
          const blocked = app.game.world.segmentBlocked(c.pos, e.pos);
          const rx = e.pos.x - c.pos.x;
          const ry = e.pos.y - c.pos.y;
          const rz = e.pos.z - c.pos.z;
          const depth = rx * c.forward.x + ry * c.forward.y + rz * c.forward.z;
          const scale = c.viewportH / 2 / Math.tan((c.fovYDeg * Math.PI) / 360);
          return {
            blocked,
            x: c.viewportW / 2 + ((rx * c.right.x + ry * c.right.y + rz * c.right.z) / depth) * scale,
            y: c.viewportH / 2 - ((rx * c.up.x + ry * c.up.y + rz * c.up.z) / depth) * scale,
            vw: c.viewportW,
            vh: c.viewportH,
          };
        });
        if (placed.blocked) continue;
        await s.step(4, 16);
        const withE = await s.shot('al-with', `位置合わせ 敵あり ${tag}`);
        await s.appWith({}, (app) => {
          app.game.state.enemies.find((x) => x.id === 'G01')!.pos = { x: 5000, y: -500, z: 5000 };
        });
        await s.step(2, 16);
        const without = await s.shot('al-without', `位置合わせ 敵なし ${tag}`);
        // 投影点の周囲 ±110 CSS px だけを見る (塵・明滅など画面全体の小さな変化を除く)。差分のしきい値も少し高め
        const sx = (await img.diffInfo(without, withE, { thr: 255 })).width / placed.vw; // 画素 / CSS px (rect 無しの幅から換算)
        const half = 110 * sx;
        const rx0 = Math.max(0, Math.round(placed.x * sx - half));
        const ry0 = Math.max(0, Math.round(placed.y * sx - half));
        const rw = Math.min(Math.round(placed.vw * sx) - rx0, Math.round(2 * half));
        const rh = Math.min(Math.round(placed.vh * sx) - ry0, Math.round(2 * half));
        const info = await img.diffInfo(without, withE, { thr: 40, rect: { x: rx0, y: ry0, w: rw, h: rh } });
        if (!info.bbox || !info.centroid || info.count < 100) {
          rows.push(`[${r},${u},${d}] 敵の画素が少ない (${info.count})`);
          continue;
        }
        n++;
        const cx = (rx0 + info.centroid.x) / sx;
        const cy = (ry0 + info.centroid.y) / sx;
        const err = Math.hypot(cx - placed.x, cy - placed.y);
        const m = 3 * sx;
        const inBox = placed.x * sx >= rx0 + info.bbox.x0 - m && placed.x * sx <= rx0 + info.bbox.x1 + m && placed.y * sx >= ry0 + info.bbox.y0 - m && placed.y * sx <= ry0 + info.bbox.y1 + m;
        if (inBox) inside++;
        worst = Math.max(worst, err);
        const key = `${r},${u},${d}`;
        const list = offsets.get(key) ?? [];
        list.push({ dx: cx - placed.x, dy: cy - placed.y });
        offsets.set(key, list);
        rows.push(`[右${r} 上${u} 前${d}] 投影(${f(placed.x, 1)},${f(placed.y, 1)}) 描画の重心(${f(cx, 1)},${f(cy, 1)}) 誤差=${f(err, 1)}px bbox=${info.bbox.x1 - info.bbox.x0 + 1}x${info.bbox.y1 - info.bbox.y0 + 1}px 内=${inBox}`);
      }
      console.log(`${tag}\n  ${rows.join('\n  ')}`);
      ok(`AL-${tag}`, `${tag}: 描画された敵の位置が、シミュレーションのカメラでの投影位置 (HUD マーカー・FCS 判定点) の上にある (${n} 点、投影点が敵の外接矩形内 ${inside}/${n}。描画の重心と投影点の最大差 ${f(worst, 1)} CSS px は敵モデルの形による)`, n >= 4 && inside === n, rows.join(' | '));
      ok(`AL-${tag}-net`, `${tag}: 外部通信・エラー無し`, s.external.length === 0 && s.appProblems().length === 0, JSON.stringify(s.appProblems().slice(0, 2)));
      await s.close();
    }
    // 構成 (画面サイズ・縦横比・devicePixelRatio) を変えても、投影点に対する描画位置のずれ方は変わらない (敵モデルの形によるずれだけ)
    const spread: string[] = [];
    let worstSpread = 0;
    for (const [k, list] of offsets) {
      if (list.length < CONFIGS.length) continue;
      const sx = Math.max(...list.map((o) => o.dx)) - Math.min(...list.map((o) => o.dx));
      const sy = Math.max(...list.map((o) => o.dy)) - Math.min(...list.map((o) => o.dy));
      worstSpread = Math.max(worstSpread, sx, sy);
      spread.push(`[右,上,前=${k}] dx幅=${f(sx, 1)} dy幅=${f(sy, 1)}`);
    }
    // 参考値: 描画の重心は敵モデルの形と、差分マスクに混じる塵・光の粒に左右されるので、合否には使わない (合否は「投影点が敵の外接矩形内」)
    rec('AL-consistency', `5 構成で、投影点に対する描画の重心のずれ方の構成間の幅 (最大 ${f(worstSpread, 1)} CSS px。参考値)`, 'info', spread.join(' | '));
  } finally {
    await img.close();
    await browser.close();
    stopServer();
  }
  const fails = checks.filter((c) => c.status === 'fail');
  console.log(`\n== align-audit: ${checks.length} checks, ${fails.length} fail ==`);
  for (const c of fails) console.log(`FAIL ${c.id} ${c.title} :: ${c.detail}`);
}

main().catch((e) => {
  console.error(e);
  stopServer();
  process.exit(1);
});
