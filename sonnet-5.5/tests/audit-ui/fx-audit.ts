/**
 * audit-ui 実ブラウザ監査 (3/3): 画面効果 (SPEC §8 後半)。
 *   「マシンガンの弾道、ビームの射線、ミサイルの弾体と噴射、各ブースト、命中、被弾、敵撃破に、区別できる視覚的な反応」
 *   「カメラの過度な揺れや大きすぎるエフェクトで照準を妨げない」「通路や足場の境界と敵を識別できる明るさ」
 * 実 App (harness.html = src/main.ts と同じ手順) で、同じ状態の 「行動の直前」 と 「行動の N フレーム後」 の 2 枚を撮り、
 * 差分画素 (=その行動が画面に起こした変化) の面積・外接矩形・平均色・照準中央への重なり・白飛びを測る。HUD は隠して世界の効果だけを見る。
 * 実行: npx tsx tests/audit-ui/fx-audit.ts
 */
import { ImgAnalyzer } from './img';
import { checks, f, images, launchBrowser, ok, rec, Sess, startServer, stopServer } from './lib';

type Info = Awaited<ReturnType<ImgAnalyzer['diffInfo']>>;

const W = 1280;
const H = 720;
const RGB = (m: [number, number, number]): string => `(${m.map((v) => Math.round(v)).join(',')})`;

/** 色相の名前 (平均色から) */
function hue(m: [number, number, number]): string {
  const [r, g, b] = m;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx - mn < 25) return mx > 200 ? 'white' : 'gray';
  if (b >= r && b >= g) return g > r + 15 ? 'cyan' : 'blue';
  if (r >= g && r >= b) return g > b + 25 ? (g > r * 0.8 ? 'yellow' : 'orange') : 'red';
  return 'green';
}

async function main(): Promise<void> {
  await startServer();
  const browser = await launchBrowser();
  const img = new ImgAnalyzer(browser);
  try {
    const s = await Sess.open(browser, { w: W, h: H, path: 'tests/audit-ui/harness.html' });
    await s.sortie();
    const hud = await s.page.addStyleTag({ content: '#hud { display: none !important; }' });
    const hudOn = async (on: boolean): Promise<void> => {
      await hud.evaluate((el, v) => ((el as HTMLStyleElement).disabled = v), on);
    };
    await hudOn(false);

    // ---- 全敵の AI を止める (scripted: 位置固定・射撃なし) → 必要な敵だけ AI を戻す
    await s.app((app) => {
      for (const e of app.game.state.enemies) e.scripted = true;
      app.game.state.player.hp = 1000;
    });

    /** プレイヤーを置いて、カメラ正面 dist m に敵 id を置いてその方を向く */
    const stage = async (o: { pos: { x: number; y: number; z: number }; yaw: number; id: string; dist: number; yOff?: number; right?: number }): Promise<void> => {
      await s.appWith(o, (app, a) => {
        const st = app.game.state;
        const t = (window as unknown as { __t: { updateCamera: (s: unknown, w: unknown) => void } }).__t;
        st.player.pos = { x: a.pos.x, y: a.pos.y, z: a.pos.z };
        st.player.vel = { x: 0, y: 0, z: 0 };
        st.player.yaw = a.yaw;
        st.player.pitch = 0;
        st.player.hp = 1000;
        st.player.en = st.stats.maxEn;
        app.game.look(0, 0);
        const e = st.enemies.find((x) => x.id === a.id)!;
        e.alive = true;
        e.hp = e.maxHp;
        e.scripted = true;
        e.alert = false;
        e.telegraph = 0;
        const c = st.camera;
        e.pos = {
          x: c.pos.x + c.forward.x * a.dist + c.right.x * (a.right ?? 0),
          y: (a.yOff ?? 0) + 1.5 + (c.pos.y - 2.7),
          z: c.pos.z + c.forward.z * a.dist + c.right.z * (a.right ?? 0),
        };
        // 敵を画面中央へ (2 回: カメラが動くため)
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
        void t;
      });
    };
    const shot = async (name: string, note: string): Promise<string> => s.shot(name, note);
    const snap = async (): Promise<Awaited<ReturnType<Sess['snap']>>> => s.snap();
    const fmt = (i: Info): string => `変化画素=${f(i.frac * 100, 2)}% bbox=${i.bbox ? `${i.bbox.x1 - i.bbox.x0 + 1}x${i.bbox.y1 - i.bbox.y0 + 1}` : '-'} 平均色=${RGB(i.mean)}(${hue(i.mean)}) 中央(r40)=${f(i.center * 100, 0)}% 白飛び=${f(i.whiteFrac * 100, 0)}%`;

    /** レンダラーのカメラ (実際に描画される) とシミュレーションのカメラのずれ: 位置 [m]・向き [rad]・画角 [deg]。揺れ演出があれば 0 にならない */
    const camDev = async (): Promise<{ dp: number; da: number; dfov: number }> =>
      s.app((app) => {
        const r = (app as unknown as { renderer: { camera: { position: { x: number; y: number; z: number }; fov: number; matrixWorld: { elements: number[] } } } }).renderer.camera;
        const c = app.game.state.camera;
        const e = r.matrixWorld.elements;
        const d = { x: -e[8], y: -e[9], z: -e[10] }; // カメラの向き = -Z 軸
        const dot = d.x * c.forward.x + d.y * c.forward.y + d.z * c.forward.z;
        return {
          dp: Math.hypot(r.position.x - c.pos.x, r.position.y - c.pos.y, r.position.z - c.pos.z),
          da: Math.acos(Math.max(-1, Math.min(1, dot))),
          dfov: Math.abs(r.fov - c.fovYDeg),
        };
      });
    const dev = { dp: 0, da: 0, dfov: 0, frames: 0 };
    const sampleDev = async (): Promise<void> => {
      const d = await camDev();
      dev.dp = Math.max(dev.dp, d.dp);
      dev.da = Math.max(dev.da, d.da);
      dev.dfov = Math.max(dev.dfov, d.dfov);
      dev.frames++;
    };

    // 開始位置 (搬入口: 長い広間) に置き、警備ロボット G01 を 30 m 先へ。ロック完了まで待つ
    const START = { x: 12, y: 1.5, z: 14 };
    await stage({ pos: START, yaw: Math.PI, id: 'G01', dist: 30 });
    await s.step(70, 16);
    let sn = await snap();
    ok('X00', '試験準備: 30 m 先の警備ロボットをロック完了 (FCS)', sn.lock.state === 'locked' && sn.lock.targetId === 'G01', `lock=${sn.lock.state} target=${sn.lock.targetId} hp=${sn.player.hp}`);
    const base0 = await shot('x00-base', '基準 (ロック完了・効果なし)');
    await s.step(1, 16);
    const base1 = await shot('x00-base2', '基準 2 枚目 (雑音の確認)');
    const noise = await img.diffInfo(base0, base1);
    rec('X01', '効果の無い連続 2 フレームの画素差 (雑音の下限)', 'info', fmt(noise));

    // ---------------------------------------------------------------- マシンガン
    const results: Record<string, Info> = {};
    const record = async (key: string, before: string, after: string, note: string): Promise<Info> => {
      const i = await img.diffInfo(before, after);
      results[key] = i;
      rec(`X-${key}`, note, 'info', fmt(i));
      return i;
    };

    await s.appWith({}, (app) => {
      app.game.input.fire = true;
    });
    await s.step(2, 16);
    await sampleDev();
    const mg2 = await shot('x10-mg-2f', 'マシンガン 発射 2 フレーム後 (銃口炎+曳光弾)');
    for (let i = 0; i < 6; i++) {
      await s.step(1, 16);
      await sampleDev();
    }
    const mg8 = await shot('x11-mg-8f', 'マシンガン 8 フレーム後 (連射)');
    for (let i = 0; i < 14; i++) {
      await s.step(1, 16);
      await sampleDev();
    }
    const mg22 = await shot('x12-mg-22f', 'マシンガン 22 フレーム後 (着弾の火花)');
    await s.appWith({}, (app) => {
      app.game.input.fire = false;
    });
    const iMg2 = await record('mg2', base0, mg2, 'マシンガン: 発射 2 フレーム後 - 基準 (曳光弾+銃口炎)');
    const iMg8 = await record('mg8', base0, mg8, 'マシンガン: 8 フレーム後');
    const iMg22 = await record('mg22', base0, mg22, 'マシンガン: 22 フレーム後 (着弾を含む)');
    sn = await snap();
    rec('X13', 'マシンガン射撃で実際に弾が出て命中した (ゲーム状態)', sn.recentPlayerShots.some((x) => x.weapon === 'machinegun') && sn.enemies.find((e) => e.id === 'G01')!.hp < 100 ? 'pass' : 'fail', `shots=${sn.recentPlayerShots.length} G01.hp=${sn.enemies.find((e) => e.id === 'G01')!.hp}`);

    // ---------------------------------------------------------------- ビーム
    await stage({ pos: START, yaw: Math.PI, id: 'G01', dist: 30 });
    await s.step(70, 16);
    const b0 = await shot('x20-beam-base', 'ビーム 基準');
    await s.appWith({}, (app) => {
      app.game.input.weaponSelect = 'beam';
    });
    await s.step(2, 16);
    const b0b = await shot('x20-beam-base2', 'ビーム 武器切替後の基準');
    await s.appWith({}, (app) => {
      app.game.input.fire = true;
    });
    await s.step(1, 17);
    await s.appWith({}, (app) => {
      app.game.input.fire = false;
    });
    const beam1 = await shot('x21-beam-1f', 'ビーム 発射直後 (射線)');
    await s.step(3, 16);
    const beam4 = await shot('x22-beam-4f', 'ビーム 4 フレーム後');
    await s.step(6, 16);
    const beam10 = await shot('x23-beam-10f', 'ビーム 10 フレーム後 (消えている)');
    const iBeam1 = await record('beam1', b0b, beam1, 'ビーム: 発射直後 - 基準 (射線+命中)');
    const iBeam4 = await record('beam4', b0b, beam4, 'ビーム: 4 フレーム後');
    const iBeam10 = await record('beam10', b0b, beam10, 'ビーム: 10 フレーム後 (残像なし)');
    void b0;
    sn = await snap();
    rec('X24', 'ビーム: 発射して EN を 8 消費・敵 HP が 40 減った', 'info', `en=${f(sn.player.en)} G01.hp=${sn.enemies.find((e) => e.id === 'G01')!.hp} shots=${sn.recentPlayerShots.map((x) => x.weapon).join(',')}`);

    // ---------------------------------------------------------------- ミサイル
    await stage({ pos: START, yaw: Math.PI, id: 'G01', dist: 34 });
    await s.appWith({}, (app) => {
      app.game.input.weaponSelect = 'missile';
    });
    await s.step(70, 16);
    sn = await snap();
    const m0 = await shot('x30-missile-base', 'ミサイル 基準 (ロック完了)');
    await s.appWith({}, (app) => {
      app.game.input.fire = true;
    });
    await s.step(1, 17);
    await s.appWith({}, (app) => {
      app.game.input.fire = false;
    });
    const ms2 = await shot('x31-missile-2f', 'ミサイル 発射直後');
    await s.step(9, 16);
    const ms12 = await shot('x32-missile-12f', 'ミサイル 12 フレーム後 (飛翔+噴射+煙)');
    await s.step(14, 16);
    const ms26 = await shot('x33-missile-26f', 'ミサイル 26 フレーム後');
    await s.step(14, 16);
    const ms40 = await shot('x34-missile-40f', 'ミサイル 40 フレーム後 (着弾付近)');
    await s.step(6, 16);
    const ms46 = await shot('x35-missile-46f', 'ミサイル 46 フレーム後');
    await record('ms2', m0, ms2, 'ミサイル: 発射直後 - 基準 (発射炎)');
    await record('ms12', m0, ms12, 'ミサイル: 12 フレーム後 (弾体・噴射・煙)');
    await record('ms26', m0, ms26, 'ミサイル: 26 フレーム後');
    await record('ms40', m0, ms40, 'ミサイル: 40 フレーム後');
    await record('ms46', m0, ms46, 'ミサイル: 46 フレーム後');
    sn = await snap();
    rec('X36', 'ミサイル: 発射して弾数 11・(命中で) 敵 HP 減', 'info', `missileAmmo=${sn.player.ammo.missile} G01.hp=${sn.enemies.find((e) => e.id === 'G01')!.hp} alive=${sn.enemies.find((e) => e.id === 'G01')!.alive}`);

    // ---------------------------------------------------------------- 敵撃破
    await stage({ pos: START, yaw: Math.PI, id: 'G01', dist: 30 });
    await s.appWith({}, (app) => {
      app.game.input.weaponSelect = 'machinegun';
    });
    await s.step(20, 16);
    const k0 = await shot('x40-kill-base', '撃破 基準');
    await s.appWith({}, (app) => {
      const st = app.game.state;
      const e = st.enemies.find((x) => x.id === 'G01')!;
      (window as unknown as { __t: { damageEnemy: (s: unknown, e: unknown, n: number, w: string) => boolean } }).__t.damageEnemy(st, e, 9999, 'machinegun');
    });
    await s.step(1, 16);
    const k1 = await shot('x41-kill-1f', '撃破 1 フレーム後 (爆発)');
    await s.step(3, 16);
    const k4 = await shot('x42-kill-4f', '撃破 4 フレーム後');
    await s.step(10, 16);
    const k14 = await shot('x43-kill-14f', '撃破 14 フレーム後');
    await s.step(40, 16);
    const k54 = await shot('x44-kill-54f', '撃破 54 フレーム後 (残骸・煙)');
    const iK1 = await record('kill1', k0, k1, '撃破: 1 フレーム後 - 基準 (爆発)');
    const iK4 = await record('kill4', k0, k4, '撃破: 4 フレーム後');
    await record('kill14', k0, k14, '撃破: 14 フレーム後');
    await record('kill54', k0, k54, '撃破: 54 フレーム後 (残骸)');

    // ---------------------------------------------------------------- QB / ブースト
    await stage({ pos: START, yaw: Math.PI, id: 'G01', dist: 60 });
    await s.appWith({}, (app) => {
      const st = app.game.state;
      st.enemies.find((x) => x.id === 'G01')!.pos = { x: 5000, y: -500, z: 5000 }; // 使わない
      st.player.pitch = 0;
      app.game.look(0, 0);
    });
    await s.step(20, 16);
    const q0 = await shot('x50-qb-base', 'QB 基準');
    await s.appWith({}, (app) => {
      app.game.input.forward = true;
      app.game.input.qb = true;
    });
    await s.step(1, 16);
    await s.appWith({}, (app) => {
      app.game.input.qb = false;
    });
    await sampleDev();
    const q1 = await shot('x51-qb-1f', 'QB 1 フレーム後 (噴射)');
    for (let i = 0; i < 4; i++) {
      await s.step(1, 16);
      await sampleDev();
    }
    const q5 = await shot('x52-qb-5f', 'QB 5 フレーム後 (噴射終了付近・グライドへ)');
    for (let i = 0; i < 10; i++) {
      await s.step(1, 16);
      await sampleDev();
    }
    const q15 = await shot('x53-qb-15f', 'QB 15 フレーム後 (自動グライド)');
    const iQ1 = await record('qb1', q0, q1, 'QB: 1 フレーム後 - 基準');
    await record('qb5', q0, q5, 'QB: 5 フレーム後');
    await record('qb15', q0, q15, 'QB: 15 フレーム後');
    void iQ1;
    await s.appWith({}, (app) => {
      app.game.input.forward = false;
    });

    // ---------------------------------------------------------------- ジャンプ・飛行 (推進器の炎)
    await stage({ pos: START, yaw: Math.PI, id: 'G01', dist: 60 });
    await s.appWith({}, (app) => {
      app.game.state.enemies.find((x) => x.id === 'G01')!.pos = { x: 5000, y: -500, z: 5000 };
      app.game.state.player.pitch = -0.1;
      app.game.look(0, 0);
    });
    await s.step(30, 16);
    const f0 = await shot('x60-fly-base', '飛行 基準 (接地)');
    await s.appWith({}, (app) => {
      app.game.input.jump = true;
    });
    await s.step(40, 16); // 0.2 秒以上の長押し -> 飛行
    const f1 = await shot('x61-fly-40f', '飛行 (Space 長押し 約 0.64 秒)');
    sn = await snap();
    rec('X62', '飛行中の垂直状態', 'info', `vertical=${sn.player.movement.verticalMode} y=${f(sn.player.position[1])} en=${f(sn.player.en)}`);
    await record('fly', f0, f1, '飛行: 接地の基準との差 (機体の高さ・炎)');
    await s.appWith({}, (app) => {
      app.game.input.jump = false;
    });

    // ---------------------------------------------------------------- 被弾 (実際の敵の弾) と敵の射撃予告
    await hudOn(true);
    await stage({ pos: START, yaw: Math.PI, id: 'T01', dist: 45 });
    // 直前の QB/飛行でグライドが残っている: 左 Ctrl のブレーキで止めてから (カメラが動くと画素差で効果を測れない)
    await s.appWith({}, (app) => {
      app.game.input.ctrl = true;
    });
    await s.step(30, 16);
    await s.appWith({}, (app) => {
      app.game.input.ctrl = false;
      const st = app.game.state;
      const e = st.enemies.find((x) => x.id === 'T01')!;
      e.scripted = false; // 実際の AI を戻す (固定砲台)
      st.player.hp = 1000;
      st.player.vel = { x: 0, y: st.player.vel.y, z: 0 };
    });
    const still = await snap();
    rec('X70', '被弾シナリオ前に機体が止まっている (水平速度)', Math.hypot(still.player.velocity[0], still.player.velocity[2]) < 0.5 ? 'pass' : 'fail', `speed=${f(Math.hypot(still.player.velocity[0], still.player.velocity[2]), 3)} mode=${still.player.movement.horizontalMode}`);
    let tele: string | null = null;
    let bullet: string | null = null;
    let hit: string | null = null;
    let hitInfo = '';
    await s.step(3, 16);
    const noAttack = await shot('x70-turret-idle', '固定砲台 (攻撃前)');
    for (let i = 0; i < 400 && !hit; i++) {
      await s.step(1, 16);
      await sampleDev();
      const st = await s.appWith({}, (app) => {
        const g = app.game.state;
        const e = g.enemies.find((x) => x.id === 'T01')!;
        return { tele: e.telegraph, bullets: g.enemyBullets.length, hp: g.player.hp, t: g.time, alive: e.alive, los: e.hasLineOfSight, wedges: g.damageIndicators.length };
      });
      if (!tele && st.tele > 0.2) tele = await shot('x71-turret-telegraph', `固定砲台の射撃予告 (t=${f(st.t, 2)} telegraph=${f(st.tele, 2)})`);
      if (!bullet && st.bullets > 0) bullet = await shot('x72-turret-bullet', `敵弾の飛翔 (t=${f(st.t, 2)})`);
      if (st.hp < 1000) {
        hit = await shot('x73-player-hit', `被弾直後 (HUD あり)`);
        hitInfo = `t=${f(st.t, 2)} hp=${st.hp} wedges=${st.wedges}`;
        await s.step(3, 16);
        await shot('x74-player-hit-3f', '被弾 3 フレーム後');
      }
    }
    rec('X75', '固定砲台の 予告 → 敵弾 → 被弾 の一連を実際の AI で再現', tele && bullet && hit ? 'pass' : 'fail', `telegraph=${!!tele} bullet=${!!bullet} hit=${!!hit} ${hitInfo}`);
    if (tele) {
      const iTele = await img.diffInfo(noAttack, tele, {});
      rec('X-tele', '固定砲台の予告: 攻撃前との差 (砲口の発光)', 'info', fmt(iTele));
      results.tele = iTele;
    }
    if (bullet) {
      const iBul = await img.diffInfo(noAttack, bullet, {});
      rec('X-bullet', '敵弾: 攻撃前との差', 'info', fmt(iBul));
      results.bullet = iBul;
    }
    await hudOn(false);

    // ---------------------------------------------------------------- 判定
    // 1) どの効果も画面に見える (基準との差が 40 画素以上かつ雑音の 5 倍以上。カメラが動く QB/飛行は基準との差分では測れないので対象外 = 画像を目視)
    const floorPx = Math.max(noise.count * 5, 40);
    const need: [string, Info | undefined][] = [
      ['マシンガン 曳光弾/銃口炎 (発射 2 フレーム後)', results.mg2],
      ['ビーム 射線 (発射直後 or 4 フレーム後)', results.beam1 && results.beam4 && results.beam4.count > results.beam1.count ? results.beam4 : results.beam1],
      ['ミサイル 発射炎 (発射直後)', results.ms2],
      ['ミサイル 弾体・噴射 (12 フレーム後)', results.ms12],
      ['撃破 爆発', results.kill1],
      ['固定砲台の予告', results.tele],
      ['敵弾', results.bullet],
    ];
    for (const [name, i] of need) ok(`Y-visible-${name}`, `${name}: 画面に見える変化がある (差分 >= max(雑音×5, 40 画素))`, !!i && i.count >= floorPx, i ? fmt(i) : 'n/a');

    // 2) 効果の色相 (参考)
    rec('Y-hues', '効果の平均色相 (参考)', 'info', `MG(22f)=${hue(results.mg22?.mean ?? [0, 0, 0])} ビーム(直後)=${hue(results.beam1?.mean ?? [0, 0, 0])} ビーム(4f)=${hue(results.beam4?.mean ?? [0, 0, 0])} 爆発=${hue(results.kill1?.mean ?? [0, 0, 0])} ミサイル(12f)=${hue(results.ms12?.mean ?? [0, 0, 0])} 敵弾=${hue(results.bullet?.mean ?? [0, 0, 0])}`);

    // 3) 大きすぎない / 白飛びしない / 照準中央を塞がない
    const limits: [string, Info | undefined, number, number][] = [
      ['マシンガン 8f', results.mg8, 0.06, 0.6],
      ['マシンガン 22f', results.mg22, 0.06, 0.6],
      ['ビーム 直後', results.beam1, 0.08, 0.6],
      ['ビーム 4f', results.beam4, 0.08, 0.6],
      ['ミサイル 12f', results.ms12, 0.08, 0.6],
      ['撃破 1f (30 m)', results.kill1, 0.25, 0.9],
      ['撃破 4f (30 m)', results.kill4, 0.25, 0.9],
      ['敵弾', results.bullet, 0.1, 0.6],
    ];
    for (const [name, i, maxFrac, maxCenter] of limits) {
      ok(`Y-size-${name}`, `${name}: 効果の面積が画面の ${maxFrac * 100}% 以下・照準中央 (r=40px) の ${maxCenter * 100}% 以下`, !!i && i.frac <= maxFrac && i.center <= maxCenter, i ? fmt(i) : 'n/a');
    }
    void iMg2;
    void iMg8;
    void iMg22;
    void iBeam1;
    void iBeam4;
    void iBeam10;
    void iK1;
    void iK4;

    ok('Y-nocamshake', `カメラ揺れ・画角変化の演出が無い: 射撃・QB・被弾を含む ${dev.frames} フレームで、描画カメラとシミュレーションのカメラのずれ = 位置 ${dev.dp.toExponential(2)} m / 向き ${dev.da.toExponential(2)} rad / 画角 ${dev.dfov.toExponential(2)} deg`, dev.dp < 1e-6 && dev.da < 1e-6 && dev.dfov < 1e-9, `dp=${dev.dp} da=${dev.da} dfov=${dev.dfov} frames=${dev.frames}`);
    ok('Z-net', '全リクエストが 127.0.0.1:5230 内・コンソールエラーなし', s.external.length === 0 && s.appProblems().length === 0, `external=${s.external.length} problems=${JSON.stringify(s.appProblems().slice(0, 3))}`);
    await s.close();
  } finally {
    await img.close();
    await browser.close();
    stopServer();
  }
  const fails = checks.filter((c) => c.status === 'fail');
  console.log(`\n== fx-audit: ${checks.length} checks, ${fails.length} fail ==`);
  for (const c of fails) console.log(`FAIL ${c.id} ${c.title} :: ${c.detail}`);
  console.log('images:\n' + images.map((i) => `  ${i.path}  ${i.note}`).join('\n'));
}

main().catch((e) => {
  console.error(e);
  stopServer();
  process.exit(1);
});
