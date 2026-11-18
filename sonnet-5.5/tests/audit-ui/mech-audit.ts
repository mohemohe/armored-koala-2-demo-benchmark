/**
 * audit-ui 実ブラウザ監査 (1b/3): プレイ中の機体 (SPEC §3 「プレイ中も機体の存在と脚数を確認できる」「歩行時には脚が動く」)。
 * 2 脚 / 4 脚それぞれで 実クリックで出撃 → 静止と歩行 (実キー W) の画面を撮り、
 *  - 描画される脚の本数 (three.js のシーンで可視な thigh メッシュ) が脚部の選択どおり (2 / 4)
 *  - 歩行中は機体の領域が時間で変化し (脚が動く)、静止中は変化しない
 * を確かめる。実行: npx tsx tests/audit-ui/mech-audit.ts
 */
import { ImgAnalyzer } from './img';
import { checks, f, images, launchBrowser, ok, Sess, startServer, stopServer } from './lib';

async function main(): Promise<void> {
  await startServer();
  const browser = await launchBrowser();
  const img = new ImgAnalyzer(browser);
  try {
    for (const legs of ['biped', 'quadruped'] as const) {
      const s = await Sess.open(browser, { w: 1280, h: 720, path: 'tests/audit-ui/harness.html' });
      await s.page.click(`.card[data-part="legs:${legs}"]`);
      await s.sortie();
      await s.app((app) => {
        for (const e of app.game.state.enemies) e.scripted = true;
      });
      await s.step(20, 16);
      // 背景 (ステージ) を消して、歩行で床や壁が流れる分を画素差に入れない = 機体そのものの動きだけを測る
      const hid = await s.app((app) => {
        const r = app as unknown as { renderer: { scene: { getObjectByName: (n: string) => { visible: boolean } | undefined } } };
        const g = r.renderer.scene.getObjectByName('stage');
        if (g) g.visible = false;
        return !!g;
      });
      ok(`M-${legs}-bg`, `${legs}: 背景 (stage グループ) を非表示にして機体だけを撮る`, hid, '');
      await s.step(2, 16);
      const count = await s.app((app) => {
        const r = app as unknown as { renderer: { mech: { root: { traverse: (fn: (o: { name: string; visible: boolean; isMesh?: boolean; parent: unknown }) => void) => void } } } };
        const vis = (o: { visible: boolean; parent: unknown }): boolean => {
          for (let p = o as { visible: boolean; parent: unknown } | null; p; p = p.parent as typeof p) if (!p.visible) return false;
          return true;
        };
        let thigh = 0;
        let thighQ = 0;
        r.renderer.mech.root.traverse((o) => {
          if (!o.isMesh || !vis(o)) return;
          if (o.name.startsWith('thigh/')) thigh++;
          if (o.name.startsWith('thighQ/')) thighQ++;
        });
        return { thigh, thighQ, rootVisible: vis(r.renderer.mech.root as never) };
      });
      const wantLegs = legs === 'biped' ? 2 : 4;
      ok(`M-${legs}-count`, `${legs}: プレイ中に描画される脚のメッシュ = ${wantLegs} 本 (2脚は thigh 2 / 4脚は thighQ 4)`, count.rootVisible && (legs === 'biped' ? count.thigh === 2 && count.thighQ === 0 : count.thighQ === 4 && count.thigh === 0), JSON.stringify(count));
      const idle0 = await s.shot(`m-${legs}-idle0`, `${legs} 静止 (プレイ中)`);
      await s.step(6, 50);
      const idle1 = await s.shot(`m-${legs}-idle1`, `${legs} 静止 0.3 秒後`);
      const roi = { x: 430, y: 300, w: 260, h: 250 };
      const dIdle = await img.diffInfo(idle0, idle1, { rect: roi, thr: 24 });
      await s.down('KeyW');
      await s.step(12, 50); // 加速して歩行速度へ
      const w0 = await s.shot(`m-${legs}-walk0`, `${legs} 歩行 (W 押下)`);
      await s.step(4, 50);
      const w1 = await s.shot(`m-${legs}-walk1`, `${legs} 歩行 0.2 秒後`);
      await s.step(4, 50);
      const w2 = await s.shot(`m-${legs}-walk2`, `${legs} 歩行 0.4 秒後`);
      const sn = await s.snap();
      const dWalk = Math.max((await img.diffInfo(w0, w1, { rect: { x: 430, y: 420, w: 260, h: 130 }, thr: 24 })).frac, (await img.diffInfo(w1, w2, { rect: { x: 430, y: 420, w: 260, h: 130 }, thr: 24 })).frac);
      ok(`M-${legs}-idle`, `${legs}: 静止中は機体の領域がほぼ変化しない (脚が勝手に動き続けない)`, dIdle.frac < 0.03, `変化画素=${f(dIdle.frac * 100, 2)}%`);
      ok(`M-${legs}-walk`, `${legs}: 歩行中は 脚の領域が 0.2 秒ごとに変化する (脚が動く)。水平速度 ${f(Math.hypot(sn.player.velocity[0], sn.player.velocity[2]), 2)} m/s`, dWalk > 0.02, `脚領域の最大変化画素=${f(dWalk * 100, 2)}%`);
      await s.close();
      void images;
    }
  } finally {
    await img.close();
    await browser.close();
    stopServer();
  }
  const fails = checks.filter((c) => c.status === 'fail');
  console.log(`\n== mech-audit: ${checks.length} checks, ${fails.length} fail ==`);
  for (const c of fails) console.log(`FAIL ${c.id} ${c.title} :: ${c.detail}`);
}

main().catch((e) => {
  console.error(e);
  stopServer();
  process.exit(1);
});
