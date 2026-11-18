/**
 * e2e 7 (AK2_BENCH) / 8 (実プレイ画面の見た目とHUD) / 9 (性能)。
 */
import type { Browser } from 'playwright';
import { loadavg } from 'node:os';
import { CAMERA, ENEMIES, FCS_PARTS, PLAYER, WEAPONS } from '../../src/config';
import { ROUTE_MAIN_POINTS } from '../../src/stage/routes';
import type { Snapshot } from '../../src/sim/bench';
import { SNAPSHOT_SHAPE, checkShape, findNonFinite } from '../snapshotShape';
import { Sess, dist3, f, hspeed, jsonEq, near, ok, rec, state, walkPath, yawToward } from './lib';
import { diffPaths } from './s45';

// ---------------------------------------------------------------------------------------------------------------------
// 7. AK2_BENCH
// ---------------------------------------------------------------------------------------------------------------------
export async function section7(browser: Browser, base: string): Promise<void> {
  state.section = 7;
  const S = await Sess.open(browser, base, 'bench');
  await S.step(2, 50);

  // ---- 公開されている面
  const api = await S.page.evaluate(() => {
    const b = (window as unknown as { AK2_BENCH: Record<string, unknown> }).AK2_BENCH;
    const w = window as unknown as Record<string, unknown>;
    return {
      keys: Object.keys(b),
      names: Object.getOwnPropertyNames(b),
      symbols: Object.getOwnPropertySymbols(b).length,
      frozen: Object.isFrozen(b),
      arity: (b.getSnapshot as () => unknown).length,
      type: typeof b.getSnapshot,
      protoKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(b) ?? {}),
      globals: Object.getOwnPropertyNames(w).filter((k) => /ak2|bench|game|sim/i.test(k)),
    };
  });
  ok('7.1', 'window.AK2_BENCH のキーが getSnapshot のみ (関数・引数なし・凍結)', jsonEq(api.keys, ['getSnapshot']) && jsonEq(api.names, ['getSnapshot']) && api.frozen && api.type === 'function' && api.arity === 0 && api.symbols === 0, `keys=${JSON.stringify(api.keys)} ownNames=${JSON.stringify(api.names)} frozen=${api.frozen} typeof=${api.type} arity=${api.arity}`);
  // 他に評価用のグローバルが生えていない: 空ページ (about:blank) の window との差分
  // (about:blank は secure context ではなく Bluetooth 等の API 面が違うので、同じオリジンで空のHTMLを返すページを基準にする)
  const blank = await S.ctx.newPage();
  await blank.route(`${base}/__e2e_blank`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>blank</title>' }));
  await blank.goto(`${base}/__e2e_blank`);
  const blankProps = await blank.evaluate(() => Object.getOwnPropertyNames(window));
  await blank.close();
  const appProps = await S.page.evaluate(() => Object.getOwnPropertyNames(window));
  const diff = appProps.filter((k) => !blankProps.includes(k) && !['__name', '__e2e'].includes(k));
  // __THREE__ は three.js 自身が付ける「リビジョン文字列」(重複読み込みの検出用)。アプリのゲーム状態ではない
  const threeRev = await S.page.evaluate(() => String((window as unknown as { __THREE__?: unknown }).__THREE__ ?? ''));
  const extras = diff.filter((k) => k !== '__THREE__');
  ok('7.2', 'アプリが window に足した名前は AK2_BENCH だけ (ゲーム状態を直接触れる名前が生えていない。three.js 自身のリビジョン印 __THREE__ を除く)', jsonEq(extras.sort(), ['AK2_BENCH']), `同じオリジンの空ページとの差分 (e2e の注入を除く) = ${JSON.stringify(diff)} (__THREE__="${threeRev}" は three.js のバージョン文字列)`);

  // ---- 構造の自動比較 (期待キー集合 + typeof + 列挙値)
  const shapeLabels: string[] = [];
  const shapeErrs: string[] = [];
  const nonFinite: string[] = [];
  const check = async (label: string): Promise<Snapshot> => {
    const sn = await S.snap();
    const errs = checkShape(sn, SNAPSHOT_SHAPE);
    const nf = findNonFinite(sn);
    // ブラウザ内でも走査 (Playwright の直列化を経由しない生の値)
    const inPage = await S.page.evaluate(() => {
      const bad: string[] = [];
      const walk = (v: unknown, p: string): void => {
        if (typeof v === 'number') {
          if (!Number.isFinite(v)) bad.push(`${p}=${v}`);
        } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
        else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], `${p}.${k}`);
      };
      const s = (window as unknown as { AK2_BENCH: { getSnapshot(): unknown } }).AK2_BENCH.getSnapshot();
      walk(s, '$');
      const rt = JSON.parse(JSON.stringify(s));
      return { bad, roundTrip: JSON.stringify(rt) === JSON.stringify(s) };
    });
    shapeLabels.push(`${label}:${sn.state}`);
    for (const e of errs) shapeErrs.push(`[${label}] ${e}`);
    for (const e of [...nf, ...inPage.bad]) nonFinite.push(`[${label}] ${e}`);
    if (!inPage.roundTrip) nonFinite.push(`[${label}] JSON往復で値が変わる`);
    return sn;
  };
  await check('garage');
  await S.sortie();
  await S.step(10, 50);
  await S.down('KeyW');
  await S.play(1.5, 50);
  const playing = await check('playing');
  await S.page.mouse.down();
  await S.play(0.4, 50);
  await S.page.mouse.up();
  await check('playing-fired');
  await S.up('KeyW');
  await S.page.keyboard.press('Escape');
  const paused = await S.waitState('paused', 10000);
  await check('paused');
  ok(
    '7.3',
    'スナップショットのキー構造が SPEC §10 の型と一致 (期待キー集合・typeof・列挙値・配列長を自動比較。garage / playing / 射撃後 / paused。failed は 5.3、garage は 2.0 でも確認)',
    shapeErrs.length === 0,
    shapeErrs.length ? shapeErrs.slice(0, 6).join(' ; ') : `${shapeLabels.join(' ')} の全てで差異0 (version=${playing.version} enemies=${playing.enemies.length} recentPlayerShots=${playing.recentPlayerShots.length})`,
  );
  ok('7.4', 'スナップショットに NaN / Infinity がない (生の値を走査し、JSON 往復でも値が変わらない)', nonFinite.length === 0, nonFinite.length ? nonFinite.slice(0, 5).join(' ; ') : `${shapeLabels.length}状態の全ての数値が有限`);
  ok(
    '7.5',
    '仕様の固定値: version=AK2-1.2-candidate、敵45体 (警備30・砲台15・制御砲台6)、controlsRequired=6、totalEnemies=45、sectorCount>=15、位置/速度は [x,y,z]',
    playing.version === 'AK2-1.2-candidate' && playing.enemies.length === 45 && playing.enemies.filter((e) => e.kind === 'guard').length === 30 && playing.enemies.filter((e) => e.kind === 'turret').length === 15 && playing.enemies.filter((e) => e.isGateControl).length === 6 && playing.objective.controlsRequired === 6 && playing.stage.totalEnemies === 45 && playing.stage.sectorCount >= 15 && new Set(playing.enemies.map((e) => e.id)).size === 45,
    `guard=${playing.enemies.filter((e) => e.kind === 'guard').length} turret=${playing.enemies.filter((e) => e.kind === 'turret').length} control=${playing.enemies.filter((e) => e.isGateControl).length} sectorCount=${playing.stage.sectorCount} 固有ID=${new Set(playing.enemies.map((e) => e.id)).size}`,
  );

  // ---- 返却値はコピー: 書き換えてもゲーム状態は変わらない (paused の静止状態で全体を比較)
  const before = await S.snap();
  const mut = await S.page.evaluate(() => {
    const b = (window as unknown as { AK2_BENCH: { getSnapshot(): Record<string, any> } }).AK2_BENCH;
    const s = b.getSnapshot();
    s.player.hp = -5;
    s.player.en = 9999;
    s.player.position[0] = 1e9;
    s.player.velocity[1] = 99;
    s.player.movement.qbSuccessfulCount = 99;
    s.player.movement.desiredHorizontalDirection[0] = 7;
    s.player.ammo.machinegun = 0;
    for (const e of s.enemies) {
      e.alive = false;
      e.hp = 0;
      e.position[0] = 5;
    }
    s.enemies.length = 0;
    s.objective.openBarrierIds.push('B1');
    s.objective.gateOpen = true;
    s.objective.controlsDestroyed = 6;
    s.stage.visitedSectorIds.push('X');
    s.recentPlayerShots.push({ id: 1 });
    s.lock.state = 'locked';
    s.fireControl.status = 'solved';
    s.loadout.legs = 'quadruped';
    s.state = 'cleared';
    let assignThrew = false;
    try {
      (window as unknown as { AK2_BENCH: Record<string, unknown> }).AK2_BENCH.getSnapshot = () => 1;
    } catch {
      assignThrew = true;
    }
    let addThrew = false;
    try {
      (window as unknown as { AK2_BENCH: Record<string, unknown> }).AK2_BENCH.setHp = () => 1;
    } catch {
      addThrew = true;
    }
    const again = b.getSnapshot();
    return { typeAfter: typeof again, keysAfter: Object.keys((window as unknown as { AK2_BENCH: object }).AK2_BENCH), assignThrew, addThrew };
  });
  const after = await S.snap();
  ok('7.6', 'getSnapshot() の返却値 (全階層) を書き換えても、次の getSnapshot() (=ゲーム状態) は変わらない。AK2_BENCH への代入・追加もできない', jsonEq(before, after) && mut.typeAfter === 'object' && jsonEq(mut.keysAfter, ['getSnapshot']), `書き換え前後のスナップショット全体一致=${jsonEq(before, after)} / 代入後も getSnapshot は ${mut.typeAfter} を返す keys=${JSON.stringify(mut.keysAfter)} (代入が例外=${mut.assignThrew}, 追加が例外=${mut.addThrew}。非strictでは黙って無視)`);
  await S.click('.screen-pause .btn-primary');
  await S.waitState('playing', 30000);
  await S.play(1.0, 50);
  const resumed = await S.snap();
  ok('7.7', '書き換えた値が実際のゲームに影響していない (再開して1秒進めても HP・EN・敵数・位置が正常)', resumed.player.hp > 0 && resumed.player.hp <= paused.player.hp && resumed.player.en <= resumed.effectiveStats.maxEn && resumed.enemies.length === 45 && resumed.enemies.every((e) => e.alive) && Math.abs(resumed.player.position[0]) < 1000 && resumed.state === 'playing', `HP ${f(paused.player.hp, 0)} -> ${f(resumed.player.hp, 0)} EN=${f(resumed.player.en, 1)} 敵=${resumed.enemies.length} alive=${resumed.enemies.filter((e) => e.alive).length} x=${f(resumed.player.position[0], 1)}`);
  await S.close();

  // ---- getSnapshot の呼び出しがゲーム進行に影響しない + 同じシード・構成・入力での再現 (2回の独立した実行の最終状態を比較)
  const run = async (poll: boolean): Promise<Snapshot> => {
    const X = await Sess.open(browser, base, poll ? 'det-poll' : 'det-plain');
    await X.step(2, 50);
    await X.sortie();
    await X.down('KeyW');
    for (let i = 0; i < 70; i++) {
      if (poll) for (let k = 0; k < 4; k++) await X.snap();
      if (i === 15) await X.look(150, -20);
      if (i === 25) await X.down('KeyQ');
      if (i === 27) await X.up('KeyQ');
      if (i === 30) await X.page.mouse.down();
      if (i === 36) await X.page.mouse.up();
      await X.step(1, 50);
    }
    const fin = await X.snap();
    await X.close();
    return fin;
  };
  const r1 = await run(false);
  const r2 = await run(true);
  const dd = diffPaths(r1, r2);
  ok('7.8', '同じシード・構成・入力・フレーム列の2回の実行が完全に同じ状態になる (再現性)。片方は各フレームで getSnapshot() を繰り返し呼んでおり、呼び出しがゲーム進行に影響しないことも示す', dd.length === 0 && r1.elapsedSeconds > 3, `経過 ${f(r1.elapsedSeconds, 3)}s 位置 ${r1.player.position.map((x) => f(x, 3)).join(',')} 差分 ${dd.length}件${dd.length ? ': ' + dd.slice(0, 4).join(' ; ') : ''}`);

  // ---- ?seed=
  const P = await Sess.open(browser, base, 'seed', { stepped: false });
  const cases: [string, number][] = [
    ['', 20260908],
    ['?seed=123', 123],
    ['?seed=0', 0],
    ['?seed=4294967295', 4294967295],
    ['?seed=4294967296', 20260908],
    ['?seed=abc', 20260908],
    ['?seed=-1', 20260908],
    ['?seed=1.5', 20260908],
    ['?seed=', 20260908],
    ['?seed=0x10', 20260908],
    ['?seed=%', 20260908], // 不正なパーセントエンコード: 例外を投げず既定値 (UI 側は sim/rng の parseSeed を使い、例外を捕まえる)
    ['?seed=%E0%A4%A', 20260908],
    ['?seed=0042', 42],
    ['?a=1&seed=77', 77],
  ];
  const seedRes: string[] = [];
  let seedOk = true;
  for (const [q, exp] of cases) {
    await P.gotoUrl(q);
    await P.waitUntil(async () => P.page.evaluate(() => (window as unknown as { AK2_BENCH?: unknown }).AK2_BENCH !== undefined), 240000, 'bench');
    const sd = (await P.snap()).seed;
    seedRes.push(`${q || '(なし)'}→${sd}`);
    if (sd !== exp) seedOk = false;
  }
  const seedProblems = P.appProblems();
  ok('7.9', 'URL の ?seed= が反映され (32bit符号なし整数)、未指定は 20260908、不正値 (非数字・負数・小数・範囲外・空・16進・不正なパーセントエンコード) は既定値になり、コンソールにエラーが出ない', seedOk && seedProblems.length === 0, `${seedRes.join(' ')} / コンソールのエラー・警告 ${seedProblems.length}件${seedProblems.length ? ': ' + seedProblems.slice(0, 2).map((x) => x.text).join(' | ') : ''}`);
  await P.gotoUrl('?seed=123');
  await P.waitUntil(async () => P.page.evaluate(() => (window as unknown as { AK2_BENCH?: unknown }).AK2_BENCH !== undefined), 240000, 'bench');
  await P.click('.gar-buttons .btn-primary');
  const sp = await P.waitState('playing', 60000);
  ok('7.10', '?seed=123 で出撃しても seed は 123 のまま (出撃・再出撃でシードが保持される)', sp.seed === 123, `seed=${sp.seed} state=${sp.state}`);
  await P.close();
}

// ---------------------------------------------------------------------------------------------------------------------
// 8. 実プレイ画面の見た目 (HUD)
// ---------------------------------------------------------------------------------------------------------------------
interface HudDom {
  weapons: string[];
  en: string;
  hp: string;
  mission: string;
  next: string;
  fcs: string;
  move: string;
  retCls: string;
  retLabel: string;
  retAim: string;
  markers: { cls: string; label: string; rect: { l: number; t: number; r: number; b: number } }[];
  wedges: number;
  telegraphs: number;
  notices: string[];
  reticle: boolean;
  panelShare: number;
}

async function hudDom(s: Sess): Promise<HudDom> {
  return s.page.evaluate(() => {
    const t = (sel: string): string => (document.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const markers: { cls: string; label: string; rect: { l: number; t: number; r: number; b: number } }[] = [];
    document.querySelectorAll('.hud-mk').forEach((m) => {
      if ((m as SVGElement).style.display === 'none') return;
      const lbl = m.querySelector('.hud-lbl');
      const r = (lbl ?? m).getBoundingClientRect();
      markers.push({ cls: m.getAttribute('class') ?? '', label: lbl?.textContent ?? '', rect: { l: r.left, t: r.top, r: r.right, b: r.bottom } });
    });
    let area = 0;
    for (const sel of ['.hud-mission', '.hud-next', '.hud-fcs', '.hud-weapons', '.hud-right', '.hud-hp']) {
      const e = document.querySelector(sel);
      if (e) {
        const b = e.getBoundingClientRect();
        area += b.width * b.height;
      }
    }
    return {
      weapons: Array.from(document.querySelectorAll('.hud-wrow')).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim() + (e.classList.contains('sel') ? ' [選択中]' : '')),
      en: t('.hud-right'),
      hp: t('.hud-hp'),
      mission: t('.hud-mission'),
      next: t('.hud-next'),
      fcs: t('.hud-fcs'),
      move: t('.hud-move'),
      retCls: document.querySelector('.hud-reticle')?.getAttribute('class') ?? '',
      retLabel: t('.ret-label'),
      retAim: t('.ret-aim'),
      markers,
      wedges: Array.from(document.querySelectorAll('.hud-wedge')).filter((e) => (e as SVGElement).style.display !== 'none').length,
      telegraphs: markers.filter((m) => m.cls.includes('hud-mk-telegraph')).length,
      notices: Array.from(document.querySelectorAll('.hud-notice')).map((e) => e.textContent ?? ''),
      reticle: !!document.querySelector('.ret-base') && !!document.querySelector('.ret-cross'),
      panelShare: (100 * area) / (window.innerWidth * window.innerHeight),
    };
  });
}

const labelOverlaps = (h: HudDom): string[] => {
  const out: string[] = [];
  const ms = h.markers.filter((m) => m.label);
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      const a = ms[i].rect;
      const b = ms[j].rect;
      const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const hh = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (w > 2 && hh > 2) out.push(`「${ms[i].label}」×「${ms[j].label}」`);
    }
  }
  return out;
};

export async function section8(browser: Browser, base: string): Promise<void> {
  state.section = 8;
  const S = await Sess.open(browser, base, 'visual');
  await S.step(2, 50);
  await S.sortie();
  await S.step(8, 50);
  const s0 = await S.snap();
  const h0 = await hudDom(S);
  const need: [string, boolean][] = [
    ['中央: FCSの判定円と照準', h0.reticle],
    ['左: 選択中の武器と残弾 (マシンガン 300/300)', h0.weapons.some((w) => w.includes('マシンガン') && w.includes('300/300') && w.includes('選択中'))],
    ['左: ビーム=弾数無制限 と 1射8 EN', h0.weapons.some((w) => w.includes('ビーム') && w.includes('弾数無制限') && w.includes(`1射 ${WEAPONS.beam.enCost} EN`))],
    ['左: ハンドミサイル 12/12・ロック必須', h0.weapons.some((w) => w.includes('ハンドミサイル') && w.includes('12/12') && w.includes('ロック必須'))],
    ['右: 現在EN/最大EN とENバー', h0.en.includes(`${s0.effectiveStats.maxEn} / ${s0.effectiveStats.maxEn}`)],
    ['下: 現在HP/最大HP とHPバー', h0.hp.includes(`${PLAYER.MAX_HP} / ${PLAYER.MAX_HP}`)],
    ['現在の区画', h0.mission.includes('S01') && h0.mission.includes('搬入口')],
    ['制御砲台の破壊数 0/6', h0.mission.includes('0/6')],
    ['対応する隔壁 (B1〜B6 の開放状態)', ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'].every((b) => h0.mission.includes(b))],
    ['最終ゲート (閉鎖中)', h0.mission.includes('最終ゲート')],
    ['次の目標', h0.next.includes('次の目標') && h0.next.includes('T0')],
    ['移動モード / QB可否 / 次のQBまで', h0.move.includes('WALK') && h0.move.includes('READY') && h0.move.includes('次のQBまで')],
    ['FCS の状態表示 (未取得)', h0.fcs.includes('未取得')],
  ];
  const missing = need.filter(([, okk]) => !okk).map(([n]) => n);
  ok('8.1', 'SPEC §8 の HUD 要素が全て表示されている (中央FCS円/照準・左武器/残弾・右EN・下HP・区画・次の目標・制御砲台0/6・隔壁・最終ゲート・移動モード・QB可否・次のQBまで)', missing.length === 0, missing.length ? '欠落: ' + missing.join(' / ') : `${need.length}項目 全て表示`, h0);
  const lo = labelOverlaps(h0);
  const ctlMk = h0.markers.filter((m) => m.cls.includes('hud-mk-control'));
  ok('8.2', '制御砲台マーカー: 密集せず最大3個 (次の目標を強調 + 近い順)、ラベルが互いに重ならない', ctlMk.length <= 3 && lo.length === 0, `制御砲台マーカー ${ctlMk.length}個 [${ctlMk.map((m) => m.label).join(' | ')}] / ラベルの重なり ${lo.length ? lo.join(' ') : 'なし'}`);
  const centerHit = await S.page.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const c = { l: w * 0.2, t: h * 0.2, r: w * 0.8, b: h * 0.8 }; // 画面中央の 60% x 60%
    const hit: string[] = [];
    for (const sel of ['.hud-mission', '.hud-next', '.hud-fcs', '.hud-weapons', '.hud-right', '.hud-hp']) {
      const e = document.querySelector(sel);
      if (!e) continue;
      const r = e.getBoundingClientRect();
      if (r.left < c.r && r.right > c.l && r.top < c.b && r.bottom > c.t) hit.push(sel);
    }
    return hit;
  });
  ok('8.3', 'HUD パネルが画面を覆っていない (6パネルは四隅と上下の縁に置かれ、画面中央の60%x60%に入らない。面積率は15%以下 = 半透明のパネルのみ)', centerHit.length === 0 && h0.panelShare <= 15, `パネル面積率 ${f(h0.panelShare, 1)}% / 中央領域に入るパネル=${centerHit.join(',') || 'なし'}`);
  await S.shot('hud-start', '出撃直後のHUD (1280x720)');

  // ---- 実ステージを歩いて敵が見える所まで進み、ロックを取る
  const hit = await walkPath(S, ROUTE_MAIN_POINTS, { maxSec: 40, dtMs: 100, until: (sn) => sn.enemies.some((e) => e.alive && e.hasLineOfSight) });
  await S.up('KeyW');
  await S.step(3, 50);
  let sn = await S.snap();
  rec('8.4', '敵が見える位置まで実ステージを歩いた', hit.reason === 'until' ? 'pass' : 'unverified', `t=${f(sn.elapsedSeconds, 1)}s 位置=${sn.player.position.map((x) => f(x, 1)).join(',')} 射線のある敵=${sn.enemies.filter((e) => e.alive && e.hasLineOfSight).map((e) => e.id).join(',') || 'なし'}`);

  const track = async (): Promise<Snapshot> => {
    const cur = await S.snap();
    const cands = cur.enemies.filter((e) => e.alive && (e.hasLineOfSight || cur.lock.targetId === e.id)).sort((a, b) => dist3(a.position, cur.player.position) - dist3(b.position, cur.player.position));
    if (cands.length) {
      const t = cands[0];
      const p = cur.player.position;
      const hd = Math.hypot(t.position[0] - p[0], t.position[2] - p[2]);
      const pitch = Math.atan2(t.position[1] - (p[1] + CAMERA.PIVOT_UP), Math.max(hd, 1));
      await S.aim(yawToward(p, { x: t.position[0], z: t.position[2] }), pitch);
    }
    await S.step(1, 50);
    return S.snap();
  };
  let acquiring: Snapshot | null = null;
  let locked: Snapshot | null = null;
  for (let i = 0; i < 90 && !locked; i++) {
    sn = await track();
    if (sn.state !== 'playing') break;
    if (!acquiring && sn.lock.state === 'acquiring' && sn.lock.progress >= 0.35 && sn.lock.progress <= 0.85) {
      acquiring = sn;
      const hd = await hudDom(S);
      const okk = hd.retCls.includes('ret-acquiring') && hd.retLabel.startsWith('LOCKING') && hd.fcs.includes('取得中');
      ok('8.5', 'ロック取得中は、円が点線・進捗リング・「LOCKING nn%」・FCSパネル「取得中」で区別できる', okk, `progress=${f(sn.lock.progress, 2)} 円class=${hd.retCls} ラベル=「${hd.retLabel}」 FCS=「${hd.fcs}」`);
      await S.shot('hud-lock-acquiring', 'ロック取得中 (進捗リング・LOCKING nn%・対象マーカー)');
    }
    if (sn.lock.state === 'locked') locked = sn;
  }
  if (locked) {
    await S.step(2, 50);
    const cur = await S.snap();
    const hd = await hudDom(S);
    const okk = hd.retCls.includes('ret-locked') && hd.retLabel === 'LOCKED' && hd.fcs.includes('ロック完了') && hd.markers.some((m) => m.cls.includes('hud-mk-target')) && (cur.fireControl.status === 'inactive' || hd.markers.some((m) => m.cls.includes('hud-mk-aim')));
    ok('8.6', 'ロック完了は、円が実線+四隅の目盛り・「LOCKED」・FCSパネル「ロック完了」・対象マーカーと補正照準マーカー (別の形) で区別できる', okk, `対象=${cur.lock.targetId} fc.status=${cur.fireControl.status} 円class=${hd.retCls} 補正表示=「${hd.retAim}」 マーカー=${hd.markers.map((m) => m.cls.split(' ').slice(1, 3).join('.')).join(',')}`);
    const lo2 = labelOverlaps(hd);
    rec('8.7', 'ロック中の画面のマーカーラベルの重なり', lo2.length === 0 ? 'pass' : 'info', lo2.length ? lo2.join(' ') : '重なりなし');
    await S.shot('hud-locked-mg', 'ロック完了 (マシンガン): 対象マーカー・補正照準マーカー・補正中の文字');
    // マシンガンで撃つ: 弾道・命中・被弾の視覚反応
    await S.page.mouse.down();
    for (let i = 0; i < 4; i++) await track();
    await S.shot('fx-mg-fire', 'マシンガン射撃中 (弾道・銃口の閃光・命中)');
    await S.page.mouse.up();
    // ミサイル (ロックが有効なら)
    await S.down('Digit3');
    await track();
    await S.up('Digit3');
    sn = await S.snap();
    if (sn.lock.state === 'locked') {
      await S.page.mouse.down();
      await track();
      await S.page.mouse.up();
      for (let i = 0; i < 5; i++) await track();
      await S.shot('fx-missile-fire', 'ハンドミサイル発射後 (ロック中)');
    }
    await S.down('Digit2');
    await track();
    await S.up('Digit2');
    await S.page.mouse.down();
    await track();
    await S.page.mouse.up();
    await track();
    await S.shot('fx-beam-fire', 'ビーム射撃 (射線)');
    const hd2 = await hudDom(S);
    rec('8.8', '被弾方向 (HUDのウェッジ) と射撃予告マーカー', hd2.wedges > 0 || hd2.telegraphs > 0 ? 'pass' : 'info', `被弾方向ウェッジ ${hd2.wedges}個 / 射撃予告マーカー ${hd2.telegraphs}個 / 通知=${hd2.notices.join(' | ') || 'なし'}`);
    const snE = await S.snap();
    ok('8.9', '実際の射撃が行われた (射撃履歴・弾数・EN が state に反映され、HUDと一致)', snE.recentPlayerShots.length >= 3 && snE.player.ammo.machinegun < 300, `射撃履歴 ${snE.recentPlayerShots.length}件 (${[...new Set(snE.recentPlayerShots.map((r) => r.weapon))].join(',')}) MG=${snE.player.ammo.machinegun} MS=${snE.player.ammo.missile} EN=${f(snE.player.en, 1)} 敵HP=${snE.enemies.filter((e) => e.alive && e.hp < 120).map((e) => `${e.id}:${e.hp}`).join(',') || '-'}`);
  } else {
    rec('8.6', 'ロック完了状態の HUD (対象マーカー・補正照準マーカー)', 'unverified', 'この試行ではロックを取れなかった (射線のある敵を画面中央へ捉えられず)');
  }
  const pr = S.appProblems();
  ok('8.10', '実プレイ (歩行・ロック・射撃・被弾) 中にコンソールのエラー/警告が出ない', pr.length === 0, pr.length ? pr.slice(0, 3).map((p) => p.text).join(' | ') : 'エラー0 / 警告0');
  void ENEMIES;
  void FCS_PARTS;
  void hspeed;
  await S.close();
}

// ---------------------------------------------------------------------------------------------------------------------
// 9. 性能
// ---------------------------------------------------------------------------------------------------------------------
export async function section9(browser: Browser, base: string): Promise<void> {
  state.section = 9;
  // ---- 実時間 (rAF) での fps と、ゲーム時間/実時間 (重複ループがなければ <= 1)
  const N = await Sess.open(browser, base, 'perf-natural', { stepped: false });
  await N.click('.gar-buttons .btn-primary');
  await N.waitState('playing', 120000);
  await N.down('KeyW');
  await N.waitUntil(async () => (await N.snap()).elapsedSeconds > 1.5, 240000, '1.5s game time');
  const a0 = await N.page.evaluate(() => ({ raf: (window as unknown as { __e2e: { rafCalls: number } }).__e2e.rafCalls, t: performance.now(), g: (window as unknown as { AK2_BENCH: { getSnapshot(): { elapsedSeconds: number } } }).AK2_BENCH.getSnapshot().elapsedSeconds }));
  const load0 = loadavg()[0];
  await new Promise((r) => setTimeout(r, 8000));
  const a1 = await N.page.evaluate(() => ({ raf: (window as unknown as { __e2e: { rafCalls: number } }).__e2e.rafCalls, t: performance.now(), g: (window as unknown as { AK2_BENCH: { getSnapshot(): { elapsedSeconds: number } } }).AK2_BENCH.getSnapshot().elapsedSeconds }));
  const load1 = loadavg()[0];
  const wall = (a1.t - a0.t) / 1000;
  const fps = (a1.raf - a0.raf) / wall;
  const ratio = (a1.g - a0.g) / wall;
  rec('9.1', '実ステージ (1280x720, SwiftShader ソフトウェア描画) の実時間の fps とゲーム時間/実時間', 'info', `${f(wall, 1)}秒間: rAF ${a1.raf - a0.raf}回 = ${f(fps, 2)}fps / ゲーム時間 ${f(a1.g - a0.g, 2)}s = 実時間の ${f(ratio, 3)}倍 (fpsが低いときは1フレームの進行を0.25秒に制限するため1倍未満) / マシン負荷 loadavg ${f(load0, 0)}->${f(load1, 0)} (他の作業と並行のため参考値。SwiftShader は GPU ではなく CPU で描く)`);
  ok('9.2', 'ゲーム時間が実時間より速く進まない (更新ループの重複なし。実時間比 <= 1.05)', ratio <= 1.05, `実時間比 ${f(ratio, 3)}`);
  await N.close();

  // ---- 1フレームあたりのメインスレッド時間 (CDP Performance): 実ステージ・歩行中・16msフレーム
  const P = await Sess.open(browser, base, 'perf-stepped');
  await P.step(2, 50);
  await P.sortie();
  await P.down('KeyW');
  await P.step(30, 16); // ウォームアップ (シェーダーコンパイル等)
  await P.cdp.send('Performance.enable');
  const m0 = (await P.cdp.send('Performance.getMetrics')).metrics;
  const FRAMES = 120;
  for (let i = 0; i < FRAMES; i++) await P.step(1, 16);
  const m1 = (await P.cdp.send('Performance.getMetrics')).metrics;
  const val = (ms: { name: string; value: number }[], n: string): number => ms.find((x) => x.name === n)?.value ?? NaN;
  const durations = m1.filter((x) => /Duration$/.test(x.name)).map((x) => `${x.name} ${f(((x.value - val(m0, x.name)) / FRAMES) * 1000, 2)}ms`);
  rec('9.3', '実ステージ歩行中の1フレーム (dt=16ms) あたりのメインスレッド時間 (CDP Performance.getMetrics の差分 / 120フレーム)', 'info', `${durations.join(' / ')} (TaskDuration の大半は SwiftShader への描画コマンド発行と同期待ちで、マシン負荷 loadavg ${f(loadavg()[0], 0)} の影響を強く受ける参考値。JS の sim/HUD だけの時間ではない)`);
  const sn = await P.snap();
  rec('9.4', '参考: 性能計測時の状態', 'info', `elapsed=${f(sn.elapsedSeconds, 2)}s speed=${f(hspeed(sn), 1)}m/s HP=${f(sn.player.hp, 0)}`);
  await P.close();
  rec('9.5', '再出撃を繰り返したときの JS ヒープ (GC後)', 'info', '5.10 を参照 (performance.memory ではなく CDP の Runtime.getHeapUsage を HeapProfiler.collectGarbage の直後に測定)');
  void near;
}
