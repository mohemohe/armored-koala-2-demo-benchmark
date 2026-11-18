/**
 * audit-ui 実ブラウザ監査 (3/4): 画面表現 (SPEC §8 後半)。実プレイで通る経路 (stage.mainRoute) の各地点へ機体を移し、
 *  - 廃工場らしい造形 (画像を目視で確認するためのスクリーンショット)
 *  - 通路・足場の境界が識別できる明るさ (輝度の分布: 平均・黒つぶれ率・白飛び率)
 *  - 敵 (警備ロボット/固定砲台) が背景と識別できる (敵あり/なしの 2 枚の差分から敵の画素を取り出し、周囲との輝度差を測る)
 * を確認する。全ての隔壁を実際に開けた状態 (制御砲台 6 体を破壊) で経路上へ置く (閉じた隔壁の中へ置くと箱の内側を見て何も映らない)。
 * 実行: npx tsx tests/audit-ui/stage-audit.ts [--only=luma,enemy]   (127.0.0.1:5230 に build -> preview を立てて、終了時に止める)
 */
import { ImgAnalyzer } from './img';
import { checks, f, images, launchBrowser, ok, rec, Sess, startServer, stopServer } from './lib';

interface Pt {
  x: number;
  y: number;
  z: number;
}
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const want = (k: string): boolean => !only || only.has(k);

async function main(): Promise<void> {
  await startServer();
  const browser = await launchBrowser();
  const img = new ImgAnalyzer(browser);
  try {
    const s = await Sess.open(browser, { w: 1280, h: 720, path: 'tests/audit-ui/harness.html' });
    await s.sortie();
    // HUD を隠す (撮影は常に HUD なしで行う)
    await s.page.addStyleTag({ content: '#hud, #screens { display: none !important; }' });
    // 敵 AI は止める (scripted = 位置固定・射撃なし)。制御砲台を全て破壊して隔壁を開ける
    await s.app((app) => {
      const st = app.game.state;
      for (const e of st.enemies) e.scripted = true;
      const t = (window as unknown as { __t: { damageEnemy: (s: unknown, e: unknown, n: number, w: string) => boolean } }).__t;
      for (const e of st.enemies) if (e.controlIndex !== null) t.damageEnemy(st, e, 99999, 'machinegun');
      st.player.hp = 1000;
    });
    await s.step(120, 16); // シャッターの開放アニメーションを終える
    const gate = await s.snap();
    rec('V00', '準備: 制御砲台 6 体の破壊 → 全隔壁と最終ゲートが開いた状態', gate.objective.controlsDestroyed === 6 && gate.objective.gateOpen ? 'pass' : 'fail', `controls=${gate.objective.controlsDestroyed} openBarriers=${gate.objective.openBarrierIds.length} gate=${gate.objective.gateOpen}`);
    const route = await s.app((app) => app.game.state.stage.mainRoute.points.map((p) => ({ x: p.x, y: p.y, z: p.z })));
    const teleport = async (i: number, ground = false): Promise<void> => {
      const p: Pt = route[i];
      const q: Pt = route[Math.min(route.length - 1, i + 1)];
      const prev: Pt = route[Math.max(0, i - 1)];
      const dx = i < route.length - 1 ? q.x - p.x : p.x - prev.x;
      const dz = i < route.length - 1 ? q.z - p.z : p.z - prev.z;
      await s.appWith({ p, dx, dz, ground }, (app, a) => {
        const st = app.game.state;
        if (st.mode === 'paused') app.game.resume();
        let y = a.p.y;
        if (a.ground) {
          // 足元の床の上 (接地) に置く: 撮影中に落下してカメラが動かないように
          const hit = app.game.world.raycast({ x: a.p.x, y: a.p.y, z: a.p.z }, { x: 0, y: -1, z: 0 }, 60);
          if (hit) y = hit.point.y + 1.5;
        }
        st.player.pos = { x: a.p.x, y, z: a.p.z };
        st.player.vel = { x: 0, y: 0, z: 0 };
        st.player.yaw = Math.atan2(-a.dx, -a.dz);
        st.player.pitch = -0.08;
        st.player.hp = 1000;
        app.game.look(0, 0);
      });
    };

    // (敵の識別 → 輝度 の順。輝度の最後の地点でクリアになるため)
    // ---------------------------------------------------------------- 敵の識別
    if (want('enemy')) {
      const idx = [0, 3, 6, 8, 11, 13, 17, 20, 23, 26, 29, 31, 34, 38, 41, 43]; // 最終地点 (脱出領域) は入るとクリアで戦闘が止まるので、輝度の計測の最後にだけ使う
      const results: { i: number; sector: string; kind: string; dist: number; px: number; lIn: number; lRing: number; dL: number; dRgb: number; mean: [number, number, number] }[] = [];
      for (const i of idx) {
        for (const [id, dMax] of [['G01', 25], ['T01', 45]] as const) {
          await teleport(i, true);
          await s.step(2, 16);
          const placed = await s.appWith({ id, dMax }, (app, a) => {
            const st = app.game.state;
            const c = st.camera;
            // カメラの水平前方へ、視線が通る最大距離 - 3 m (最大 dMax)
            const hl = Math.hypot(c.forward.x, c.forward.z) || 1;
            const fx = c.forward.x / hl;
            const fz = c.forward.z / hl;
            const origin = { x: st.player.pos.x, y: st.player.pos.y, z: st.player.pos.z };
            const hit = app.game.world.raycast(origin, { x: fx, y: 0, z: fz }, 80);
            const free = hit ? hit.t : 80;
            const d = Math.min(a.dMax, free - 3);
            for (const e of st.enemies) {
              if (e.id !== a.id) continue;
              e.alive = true;
              e.hp = e.maxHp;
              e.scripted = true;
              e.pos = { x: origin.x + fx * Math.max(d, 0), y: origin.y, z: origin.z + fz * Math.max(d, 0) };
            }
            return { d, free };
          });
          if (placed.d < 8) continue; // 目の前に壁がある地点は対象外
          // 一時停止 (ゲーム状態を凍結し、機体・敵・カメラが動かない状態で 敵あり/敵なし を撮る。描画は続く)
          await s.appWith({}, (app) => app.game.pause());
          await s.step(4, 16);
          const withE = await s.shot('e-with', `敵 ${id} あり #${i}`);
          await s.appWith(id, (app, k) => {
            const e = app.game.state.enemies.find((x) => x.id === k)!;
            e.pos = { x: 5000, y: -500, z: 5000 };
          });
          await s.step(2, 16);
          const without = await s.shot('e-without', `敵 ${id} なし #${i}`);
          const info = await img.diffInfo(without, withE, { thr: 20, ring: 8 });
          const sn = await s.snap();
          const dRgb = Math.hypot(info.mean[0] - info.ringMean[0], info.mean[1] - info.ringMean[1], info.mean[2] - info.ringMean[2]) / 255;
          results.push({ i, sector: sn.stage.currentSectorId ?? '-', kind: id, dist: placed.d, px: info.count, lIn: info.lumaIn, lRing: info.lumaRing, dL: info.lumaIn - info.lumaRing, dRgb, mean: info.mean });
          console.log(`#${i} ${sn.stage.currentSectorId} ${id} 距離=${f(placed.d, 1)}m 敵の画素=${info.count} 輝度 敵=${f(info.lumaIn)} 周囲=${f(info.lumaRing)} 差=${f(info.lumaIn - info.lumaRing)} 色距離=${f(dRgb)} 敵の平均色=(${info.mean.map((v) => Math.round(v)).join(',')}) 周囲=(${info.ringMean.map((v) => Math.round(v)).join(',')})`);
          // 見比べ用に代表を残す
          if ([0, 17, 34].includes(i)) await s.shot(`e-${id}-${String(i).padStart(2, '0')}`, `敵 ${id} 距離 ${f(placed.d, 0)} m 経路 #${i}`);
        }
      }
      const seen = results.filter((r) => r.px >= 150);
      const weak = seen.filter((r) => Math.abs(r.dL) < 0.05 && r.dRgb < 0.08);
      const sorted = seen.map((r) => Math.abs(r.dL)).sort((a, b) => a - b);
      rec('V10', `敵の識別: ${results.length} 例 (経路地点 × 警備ロボット 25 m / 固定砲台 45 m)。敵の画素が 150 以上の ${seen.length} 例での 敵と周囲の輝度差 |ΔL|`, 'info', `min=${f(sorted[0])} median=${f(sorted[Math.floor(sorted.length / 2)])} max=${f(sorted[sorted.length - 1])}`);
      ok('V11', '敵の画素が十分に映る全例で 周囲との輝度差 |ΔL| >= 0.05 または 色距離 (RGB/255) >= 0.08 (両方小さい例は敵が背景に溶ける)', weak.length === 0 && seen.length >= 20, weak.map((r) => `#${r.i}(${r.sector}) ${r.kind} ${f(r.dist, 0)}m ΔL=${f(r.dL)} 色距離=${f(r.dRgb)} 画素=${r.px}`).join(' | ') || `対象 ${seen.length} 例`);
      const tiny = results.filter((r) => r.px < 150);
      rec('V12', '敵の画素が少なくて判定対象外にした例', 'info', tiny.map((r) => `#${r.i} ${r.kind} ${f(r.dist, 0)}m 画素=${r.px}`).join(' | ') || 'なし');
    }

    // ---------------------------------------------------------------- 輝度
    if (want('luma')) {
      const rows: string[] = [];
      let worstDark = 0;
      let worstMean = 1;
      let worstBright = 0;
      const offenders: string[] = [];
      // 脱出領域 (最終地点) へ入るとクリアになりゲームが止まる: 最後の地点は最後に撮る
      for (let i = 0; i < route.length; i++) {
        await teleport(i);
        await s.step(6, 16);
        const sn = await s.snap();
        const file = await s.shot(`s${String(i).padStart(2, '0')}-route`, `経路 #${i} (${route[i].x},${route[i].y},${route[i].z}) 区画 ${sn.stage.currentSectorId}`);
        const l = await img.luma(file);
        worstDark = Math.max(worstDark, l.dark);
        worstMean = Math.min(worstMean, l.mean);
        worstBright = Math.max(worstBright, l.bright);
        rows.push(`#${i} ${sn.stage.currentSectorId} mean=${f(l.mean)} p5=${f(l.p5)} p95=${f(l.p95)} dark=${f(l.dark * 100, 1)}% bright=${f(l.bright * 100, 1)}%`);
        if (l.mean < 0.15 || l.dark >= 0.35 || l.bright >= 0.2 || l.p95 - l.p5 < 0.2) offenders.push(rows[rows.length - 1] + ` (p95-p5=${f(l.p95 - l.p5)})`);
      }
      console.log(rows.join('\n'));
      rec('V01', `経路 ${route.length} 地点のプレイ画面の輝度分布 (最暗の平均・黒つぶれ率最大・白飛び率最大)`, 'info', `min mean=${f(worstMean)} max dark=${f(worstDark * 100, 1)}% max bright=${f(worstBright * 100, 1)}%`);
      ok('V02', '全地点で 平均輝度 >= 0.15・輝度 0.05 未満の黒つぶれ < 35%・0.9 超の白飛び < 20%・p95−p5 >= 0.2 (面と面の境界が判別できる階調)', offenders.length === 0, offenders.join(' | '));
    }

    ok('V03', 'ページ全体で外部リクエスト無し・エラー無し', s.external.length === 0 && s.appProblems().length === 0, `external=${s.external.length} problems=${JSON.stringify(s.appProblems().slice(0, 3))}`);
    await s.close();
  } finally {
    await img.close();
    await browser.close();
    stopServer();
  }
  const fails = checks.filter((c) => c.status === 'fail');
  console.log(`\n== stage-audit: ${checks.length} checks, ${fails.length} fail ==`);
  for (const c of fails) console.log(`FAIL ${c.id} ${c.title} :: ${c.detail}`);
  void images;
}

main().catch((e) => {
  console.error(e);
  stopServer();
  process.exit(1);
});
