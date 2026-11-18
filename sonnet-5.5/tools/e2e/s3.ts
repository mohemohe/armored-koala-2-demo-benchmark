/**
 * e2e 3: 実キー入力 (page.keyboard / page.mouse の本物のイベント)。
 * Q の単発 (5秒押しっぱなし・キーリピート)、離して押し直し、QB の移動量、WASD・グライド・ブレーキ、Space 短押し/長押し、1/2/3、マウス視点。
 * 入力は本物のイベントだが、フレームは fake clock で 1 フレームずつ進める (時間は snapshot.elapsedSeconds)。
 */
import type { Browser } from 'playwright';
import { PLAYER, WEAPONS } from '../../src/config';
import { forwardFromYaw, rightFromYaw } from '../../src/sim/math';
import type { Snapshot } from '../../src/sim/bench';
import { Sess, f, hspeed, near, ok, rec, state } from './lib';

type E2EWin = { __e2e: { keys: { t: string; c: string; r: boolean }[]; events: string[]; rafCalls: number } };

const keyLog = (s: Sess) => s.page.evaluate(() => (window as unknown as E2EWin).__e2e.keys);

export async function section3(browser: Browser, base: string): Promise<void> {
  state.section = 3;
  await qbTests(browser, base);
  await qbDistance(browser, base, 'biped');
  await qbDistance(browser, base, 'quadruped');
  await moveTests(browser, base);
  await tapTests(browser, base);
}

// ---------------------------------------------------------------------------------------------------------------------
async function qbTests(browser: Browser, base: string): Promise<void> {
  const A = await Sess.open(browser, base, 'qb');
  await A.step(2, 50);
  await A.sortie();
  const s0 = await A.snap();
  ok('3.0', '出撃直後: QB 未使用・EN満タン・待ち時間なし (出撃直後から使用可能)', s0.player.movement.qbSuccessfulCount === 0 && s0.player.en === s0.effectiveStats.maxEn && s0.player.movement.qbCooldownRemainingSeconds === 0, `count=${s0.player.movement.qbSuccessfulCount} EN=${s0.player.en}/${s0.effectiveStats.maxEn} cd=${s0.player.movement.qbCooldownRemainingSeconds}`);

  // ---- Q を押す (keydown, repeat=false)
  await A.down('KeyQ');
  await A.step(1, 16);
  const s1 = await A.snap();
  const mv1 = s1.player.movement;
  const drop = s0.player.en - s1.player.en;
  ok('3.1', 'Q の実キー押下で QB が1回成立し、ENが36だけ低下 (直前と直後の値)', mv1.qbSuccessfulCount === 1 && near(drop, 36, 1e-6), `count=${mv1.qbSuccessfulCount} EN ${f(s0.player.en)} -> ${f(s1.player.en)} (低下 ${f(drop, 6)}) qbLast=${mv1.qbLastStartedAtSeconds} lastEnSpent=${mv1.lastEnSpentAtSeconds}`);
  ok('3.1b', 'QB 直後: horizontalMode=quickboost、噴射残り>0、水平速度≈80m/s', mv1.horizontalMode === 'quickboost' && mv1.qbImpulseRemainingSeconds > 0 && near(hspeed(s1), PLAYER.QB.SPEED, 1.0), `mode=${mv1.horizontalMode} 残り=${f(mv1.qbImpulseRemainingSeconds)}s 速度=${f(hspeed(s1))}m/s`);

  // ---- Q を 5秒 (ゲーム時間) 押しっぱなし。keydown を repeat=true で繰り返し送る (OSのキーリピート相当)
  const qStart = mv1.qbLastStartedAtSeconds ?? s1.elapsedSeconds;
  let sn: Snapshot = s1;
  let minEn = s1.player.en;
  let maxEn = s1.player.en;
  let maxCount = 1;
  let iters = 0;
  const enTrace: { dt: number; en: number; mode: string; glide: boolean; grounded: boolean }[] = [];
  while (sn.elapsedSeconds - qStart < 5.0 && iters < 200) {
    await A.down('KeyQ'); // 押しっぱなしのまま (Playwright は repeat=true にする)
    await A.step(1, 50);
    sn = await A.snap();
    minEn = Math.min(minEn, sn.player.en);
    maxEn = Math.max(maxEn, sn.player.en);
    maxCount = Math.max(maxCount, sn.player.movement.qbSuccessfulCount);
    enTrace.push({ dt: sn.elapsedSeconds - qStart, en: sn.player.en, mode: sn.player.movement.horizontalMode, glide: sn.player.movement.glideEnabled, grounded: sn.player.grounded });
    iters++;
  }
  const keys = await keyLog(A);
  const repeats = keys.filter((k) => k.c === 'KeyQ' && k.r).length;
  ok(
    '3.2',
    'Q を5秒 (ゲーム時間) 押しっぱなし (keydown の repeat を多数送出) にしても、成功する QB は1回だけ。ENは QB の36以外で減らない',
    maxCount === 1 && sn.player.movement.qbSuccessfulCount === 1 && repeats >= 40 && minEn >= s1.player.en - 1e-6,
    `保持 ${f(sn.elapsedSeconds - qStart, 2)}s / repeat=trueのkeydown ${repeats}回 / count最大=${maxCount} / EN 最小 ${f(minEn)} 最大 ${f(maxEn)} 終了時 ${f(sn.player.en)} (36以上に回復しており再発動可能だったが発動せず) cd=${f(sn.player.movement.qbCooldownRemainingSeconds)}`,
    { repeats },
  );

  // ---- EN 回復: QB 発動時刻 (0.0s) が最後の消費。0.75秒までは回復せず、その後グライドしながら回復する (SPEC §6, §11)
  const enBase = s1.player.en;
  const early = enTrace.filter((x) => x.dt < 0.75 - 1e-9);
  const firstUp = enTrace.find((x) => x.en > enBase + 1e-9);
  const glidingWhileRegen = enTrace.filter((x) => x.dt >= 0.9 && x.dt < 2.0);
  const rate = enTrace.length > 2 ? (() => {
    const a0 = enTrace.find((x) => x.dt >= 1.0);
    const a1 = enTrace.find((x) => x.dt >= 2.0);
    return a0 && a1 ? (a1.en - a0.en) / (a1.dt - a0.dt) : NaN;
  })() : NaN;
  ok(
    '3.2b',
    'QB(地上・時刻0)の後、EN は0.75秒まで回復せず、0.75秒以降はグライド中でも回復する (回復率15EN/秒)',
    early.every((x) => near(x.en, enBase, 1e-9)) && !!firstUp && firstUp.dt >= 0.75 - 1e-9 && firstUp.dt <= 0.85 && glidingWhileRegen.length > 0 && glidingWhileRegen.every((x) => x.glide && x.mode === 'glide' && x.grounded) && near(rate, 15, 0.5),
    `0.75秒までのEN=${early.map((x) => f(x.en, 1)).join(',') || '-'} / 最初の増加 ${firstUp ? `t=${f(firstUp.dt, 3)}s EN=${f(firstUp.en, 3)}` : 'なし'} / 回復中のモード=${[...new Set(glidingWhileRegen.map((x) => x.mode))].join(',')} glideEnabled=${glidingWhileRegen.every((x) => x.glide)} 接地=${glidingWhileRegen.every((x) => x.grounded)} / 回復率 ${f(rate, 2)}EN/秒`,
  );

  // ---- 離して、1.0秒以上後 (EN>=36) に再度 Q -> 2回目
  await A.up('KeyQ');
  await A.step(3, 50);
  const b0 = await A.snap();
  await A.down('KeyQ');
  await A.step(1, 16);
  const b1 = await A.snap();
  ok(
    '3.3',
    'Q を離して押し直す (前のQBから1.0秒以上後・EN>=36) と2回目の QB が成立し、ENが36低下',
    b0.player.en >= 36 && b0.player.movement.qbCooldownRemainingSeconds === 0 && b1.player.movement.qbSuccessfulCount === 2 && near(b0.player.en - b1.player.en, 36, 1e-6),
    `前 EN=${f(b0.player.en)} cd=${f(b0.player.movement.qbCooldownRemainingSeconds)} -> 後 count=${b1.player.movement.qbSuccessfulCount} EN=${f(b1.player.en)} (低下 ${f(b0.player.en - b1.player.en, 6)})`,
  );
  await A.up('KeyQ');

  // ---- 1.0秒未満の再押下は不成立 (ENを消費せず、予約もしない)
  await A.step(2, 50); // 0.1s 後
  const c0 = await A.snap();
  await A.down('KeyQ');
  await A.step(1, 16);
  await A.up('KeyQ');
  await A.step(2, 50);
  const c1 = await A.snap();
  ok('3.4', '前のQB開始から1.0秒未満の押下は不成立 (count・ENが変化しない)', c1.player.movement.qbSuccessfulCount === 2 && c1.player.en >= c0.player.en - 1e-9, `count=${c1.player.movement.qbSuccessfulCount} EN ${f(c0.player.en)} -> ${f(c1.player.en)} cd=${f(c1.player.movement.qbCooldownRemainingSeconds)}`);
  // 予約されない: クールダウンが明けても、離した後に自動で発動しない
  await A.play(1.2, 50);
  const c2 = await A.snap();
  ok('3.5', '不成立だった押下は予約されず、クールダウン明けに勝手に発動しない', c2.player.movement.qbSuccessfulCount === 2, `1.2秒後 count=${c2.player.movement.qbSuccessfulCount}`);
  const pr = A.appProblems();
  ok('3.6', 'QB 操作中にコンソールのエラー/警告が出ない', pr.length === 0, pr.length ? pr.map((p) => p.text).join(' | ') : 'エラー0 / 警告0');
  await A.close();
}

// ---------------------------------------------------------------------------------------------------------------------
async function qbDistance(browser: Browser, base: string, legs: 'biped' | 'quadruped'): Promise<void> {
  const S = await Sess.open(browser, base, `qbdist-${legs}`);
  await S.step(2, 50);
  if (legs === 'quadruped') await S.click('[data-part="legs:quadruped"]');
  await S.sortie();
  const mult = legs === 'biped' ? 1 : 0.8;
  // 北端 (z≈3) まで S キーで後退し、南向きに 50m 以上の直線を空ける (アルコーブは z 2..56)
  await S.down('KeyS');
  let sn = await S.snap();
  for (let i = 0; i < 80 && sn.player.position[2] > 3.4; i++) {
    await S.step(1, 100);
    sn = await S.snap();
  }
  await S.up('KeyS');
  await S.play(1.0, 50);
  const P0 = await S.snap();
  // W + Q を同時に押し、1フレーム (3 tick) 後に全てのキーを離す。噴射・慣性・自動グライドが入力なしで続くこと
  await S.down('KeyW');
  await S.down('KeyQ');
  await S.step(1, 25);
  await S.up('KeyQ');
  await S.up('KeyW');
  const first = await S.snap();
  const t0 = first.player.movement.qbLastStartedAtSeconds ?? P0.elapsedSeconds;
  const profile: string[] = [];
  const modes = new Set<string>();
  let cur = first;
  let autoGlide = false;
  let minSpeed = 999;
  let dirDot = 1;
  const dir0 = [cur.player.velocity[0], cur.player.velocity[2]];
  const n0 = Math.hypot(dir0[0], dir0[1]) || 1;
  for (let i = 0; i < 40 && cur.elapsedSeconds < t0 + 0.75 - 1e-9; i++) {
    await S.step(1, 25);
    cur = await S.snap();
    modes.add(cur.player.movement.horizontalMode);
    const sp = hspeed(cur);
    if (cur.elapsedSeconds - t0 > 0.16 && cur.player.movement.horizontalMode === 'glide' && cur.player.movement.glideEnabled) autoGlide = true;
    minSpeed = Math.min(minSpeed, sp);
    if (sp > 1) dirDot = Math.min(dirDot, (cur.player.velocity[0] * dir0[0] + cur.player.velocity[2] * dir0[1]) / (sp * n0));
    const dt = cur.elapsedSeconds - t0;
    for (const mark of [0.1, 0.15, 0.2, 0.45, 0.75]) if (Math.abs(dt - mark) < 0.0126) profile.push(`t=${f(dt, 2)}:${cur.player.movement.horizontalMode}/${f(sp, 1)}m/s`);
  }
  const dz = Math.hypot(cur.player.position[0] - P0.player.position[0], cur.player.position[2] - P0.player.position[2]);
  const expect = 42.6 * mult;
  const keysNow = await keyLog(S);
  const lastKeys = keysNow.slice(-4).map((k) => `${k.t}:${k.c}`).join(',');
  const label = legs === 'biped' ? '2脚' : '4脚';
  ok(
    legs === 'biped' ? '3.7' : '3.8',
    `${label}: 障害物のない地上で Q を1回押して全キーを離しても、0.75秒間に約${f(expect, 2)}m (12.0 + 30.6${legs === 'biped' ? '' : ' の0.80倍'}) 移動し、噴射→慣性→自動グライドが続く`,
    near(dz, expect, 1.0) && modes.has('glide') && autoGlide && dirDot > 0.999,
    `移動 ${f(dz, 2)}m (QB開始 ${f(t0, 3)}s -> ${f(cur.elapsedSeconds, 3)}s) / モード ${[...modes].join(',')} / 速度 ${profile.join(' ')} / 最小速度 ${f(minSpeed, 1)} / 方向保持 cos=${f(dirDot, 5)} / 最後のキー操作 ${lastKeys}`,
  );
  // 参考: 衝突の有無 (壁までの距離)
  await S.close();
}

// ---------------------------------------------------------------------------------------------------------------------
async function moveTests(browser: Browser, base: string): Promise<void> {
  const B = await Sess.open(browser, base, 'move');
  await B.step(2, 50);
  await B.sortie();
  await B.step(2, 50);

  const tapFrame = async (code: string, ms = 16): Promise<Snapshot> => {
    await B.down(code);
    await B.step(1, ms);
    await B.up(code);
    await B.step(1, ms);
    return B.snap();
  };

  // ---- 武器切り替え 1/2/3
  const seq: [string, string][] = [['Digit2', 'beam'], ['Digit3', 'missile'], ['Digit1', 'machinegun']];
  const got: string[] = [];
  for (const [k, w] of seq) {
    const sn = await tapFrame(k);
    got.push(`${k}->${sn.player.weapon}`);
    if (sn.player.weapon !== w) got.push('NG');
  }
  ok('3.9', '1/2/3 の実キーで武器 (machinegun/beam/missile) が切り替わる', !got.includes('NG'), got.join(' '));
  // キーリピート: Digit2 を押しっぱなし(repeat) にしたまま Digit1 を押しても、Digit2 の repeat では切り替わらない
  await B.down('Digit2'); // beam
  await B.step(1, 16);
  await B.down('Digit1'); // machinegun
  await B.step(1, 16);
  await B.down('Digit2'); // repeat=true
  await B.step(1, 16);
  const wRep = (await B.snap()).player.weapon;
  await B.up('Digit2');
  await B.up('Digit1');
  ok('3.10', '武器キーの keydown repeat では切り替わらない (押しっぱなしのリピートを無視)', wRep === 'machinegun', `Digit2(押下)→Digit1→Digit2(repeat) 後の武器=${wRep}`);

  // ---- マウス視点 (ポインターロック中の movementX/Y)
  const yawBefore = await B.calibrateYaw();
  const startYaw = B.yaw;
  await B.look(200, 0); // 右へ 200px -> yaw が 200*0.0022=0.44rad 減る
  const expectYaw = B.yaw;
  const yawAfter = await B.calibrateYaw();
  ok('3.11', 'マウス移動 (ポインターロック中の movementX) で視点が回る: 右へ200px -> yaw が 0.44rad 減少 (感度 0.0022rad/px)', near(yawAfter, expectYaw, 0.004) && near(startYaw - yawAfter, 0.44, 0.005), `yaw ${f(yawBefore, 4)} -> ${f(yawAfter, 4)} (差 ${f(startYaw - yawAfter, 4)}rad, 期待 0.4400)`);
  // pitch: 自由射撃の発射方向 (recentPlayerShots.launchDirection) の仰角で見る
  const fireOnce = async (): Promise<Snapshot> => {
    await B.page.mouse.down();
    await B.step(1, 16);
    await B.page.mouse.up();
    await B.step(2, 16);
    return B.snap();
  };
  const f0 = await fireOnce();
  const d0 = f0.recentPlayerShots[f0.recentPlayerShots.length - 1]?.launchDirection;
  await B.look(0, -150); // 上へ 150px -> pitch +0.33rad
  await B.step(3, 100); // マシンガンの射撃間隔 0.1秒を空ける
  const f1 = await fireOnce();
  const d1 = f1.recentPlayerShots[f1.recentPlayerShots.length - 1]?.launchDirection;
  const p0 = d0 ? Math.asin(d0[1]) : NaN;
  const p1 = d1 ? Math.asin(d1[1]) : NaN;
  ok('3.12', 'マウス移動 (movementY) でピッチが回る: 上へ150px -> 自由射撃の発射方向の仰角が約 +0.33rad 上がる', Number.isFinite(p0) && Number.isFinite(p1) && near(p1 - p0, 0.33, 0.08), `発射方向の仰角 ${f(p0, 4)} -> ${f(p1, 4)} (差 ${f(p1 - p0, 4)}rad, 期待 約0.33)`);
  await B.look(0, 150); // 元に戻す
  await B.look(-200, 0); // yaw も南向き (アルコーブの軸方向) に戻す: 壁に斜めに当たると速度の測定値が下がるため
  await B.step(3, 100);

  // ---- 射撃 (左ボタン) と3武器
  const m0 = await B.snap();
  await B.page.mouse.down();
  const t0 = m0.elapsedSeconds;
  let mg = await B.snap();
  for (let i = 0; i < 40 && mg.elapsedSeconds - t0 < 1.0 - 1e-9; i++) {
    await B.step(1, 50);
    mg = await B.snap();
  }
  await B.page.mouse.up();
  await B.step(2, 50);
  const mgUsed = m0.player.ammo.machinegun - mg.player.ammo.machinegun;
  ok('3.13', '左ボタンを押している間、マシンガンが射撃間隔0.10秒で連射される (1.0秒で10〜11発)', mgUsed >= 10 && mgUsed <= 11 && near(mg.elapsedSeconds - t0, 1.0, 0.01), `残弾 ${m0.player.ammo.machinegun} -> ${mg.player.ammo.machinegun} (消費 ${mgUsed}) / ${f(mg.elapsedSeconds - t0, 3)}s 押下`);
  const afterMg = await B.snap();
  ok('3.13b', '押している間だけ撃つ (離すと止まる)', (await B.play(0.3, 50)).player.ammo.machinegun === afterMg.player.ammo.machinegun, `離して0.3秒後の残弾 ${afterMg.player.ammo.machinegun} で変化なし`);

  await tapFrame('Digit2');
  const e0 = await B.snap();
  await fireOnce();
  const e1 = await B.snap();
  ok('3.14', 'ビーム: 左ボタン1回で1射、ENが8低下 (弾数は消費しない)', near(e0.player.en - e1.player.en, WEAPONS.beam.enCost, 1e-6) && e1.player.ammo.machinegun === e0.player.ammo.machinegun, `EN ${f(e0.player.en)} -> ${f(e1.player.en)} (低下 ${f(e0.player.en - e1.player.en, 6)}) shots=${e1.recentPlayerShots.length - e0.recentPlayerShots.length}`);

  await tapFrame('Digit3');
  const n0 = await B.snap();
  await fireOnce();
  await B.step(2, 16);
  const n1 = await B.snap();
  const notice = await B.page.evaluate(() => Array.from(document.querySelectorAll('.hud-notice')).map((e) => e.textContent ?? ''));
  ok('3.15', 'ミサイル: 未ロックで発射すると弾を消費せず、NO LOCK が表示される', n1.player.ammo.missile === n0.player.ammo.missile && n1.recentPlayerShots.length === n0.recentPlayerShots.length && notice.some((t) => t.includes('NO LOCK')), `ミサイル ${n0.player.ammo.missile} -> ${n1.player.ammo.missile} / 通知=${notice.join(' | ')}`);
  await tapFrame('Digit1');
  await B.play(1.2, 50); // ENの回復を待たず、ジャンプ試験へ

  // ---- Space: 短押し (ジャンプ) と 長押し (飛行)
  await B.play(1.0, 50);
  const j0 = await B.snap();
  await B.down('Space');
  await B.step(1, 16);
  await B.up('Space');
  let jn = await B.snap();
  const jModes = new Set<string>([jn.player.movement.verticalMode]);
  const vy0 = jn.player.velocity[1];
  let peak = jn.player.position[1];
  let jEnMin = jn.player.en;
  for (let i = 0; i < 60 && !(jn.player.grounded && i > 2); i++) {
    await B.step(1, 50);
    jn = await B.snap();
    jModes.add(jn.player.movement.verticalMode);
    peak = Math.max(peak, jn.player.position[1]);
    jEnMin = Math.min(jEnMin, jn.player.en);
  }
  ok('3.16', 'Space 短押し = 通常ジャンプ (上向き初速10m/s、頂点≈2.8m、飛行にならず EN を消費しない)', vy0 > 8.5 && !jModes.has('flying') && jModes.has('rising') && near(peak - j0.player.position[1], 100 / 36, 0.25) && jEnMin >= j0.player.en - 1e-9, `初速 ${f(vy0, 2)}m/s 頂点 +${f(peak - j0.player.position[1], 2)}m モード ${[...jModes].join(',')} EN最小 ${f(jEnMin)} (開始 ${f(j0.player.en)})`);

  await B.play(0.5, 50);
  const l0 = await B.snap();
  await B.down('Space');
  const fModes = new Set<string>();
  const trace: { t: number; en: number; vy: number; mode: string }[] = [];
  let ln = l0;
  for (let i = 0; i < 14; i++) {
    await B.step(1, 50);
    ln = await B.snap();
    fModes.add(ln.player.movement.verticalMode);
    trace.push({ t: ln.elapsedSeconds, en: ln.player.en, vy: ln.player.velocity[1], mode: ln.player.movement.verticalMode });
  }
  const flying = trace.filter((x) => x.mode === 'flying');
  let slope = NaN;
  if (flying.length >= 3) slope = (flying[0].en - flying[flying.length - 1].en) / (flying[flying.length - 1].t - flying[0].t);
  const vyFly = flying.length ? flying[flying.length - 1].vy : NaN;
  const holdSec = l0 ? (flying.length ? flying[0].t - l0.elapsedSeconds : NaN) : NaN;
  ok('3.17', 'Space 長押し (0.20秒以上) = 飛行: 上昇速度8m/s、EN消費20EN/秒', fModes.has('flying') && near(vyFly, PLAYER.FLIGHT_ASCENT, 0.6) && near(slope, PLAYER.FLIGHT_EN_PER_SEC, 1.5), `モード ${[...fModes].join(',')} / 飛行開始まで ${f(holdSec, 2)}s / 上昇速度 ${f(vyFly, 2)}m/s / EN消費 ${f(slope, 2)}EN/秒 (EN ${f(l0.player.en)} -> ${f(ln.player.en)})`);
  await B.up('Space');
  let fall = await B.snap();
  const afterModes = new Set<string>();
  const regenTrace: { t: number; en: number; grounded: boolean; spent: number | null }[] = [{ t: fall.elapsedSeconds, en: fall.player.en, grounded: fall.player.grounded, spent: fall.player.movement.lastEnSpentAtSeconds }];
  for (let i = 0; i < 80 && !(fall.player.grounded && i > 2); i++) {
    await B.step(1, 50);
    fall = await B.snap();
    afterModes.add(fall.player.movement.verticalMode);
    regenTrace.push({ t: fall.elapsedSeconds, en: fall.player.en, grounded: fall.player.grounded, spent: fall.player.movement.lastEnSpentAtSeconds });
  }
  ok('3.18', 'Space を離すと推進を止めて落下し、接地する (重力18m/s²)', afterModes.has('falling') && fall.player.grounded && !afterModes.has('flying'), `離した後のモード ${[...afterModes].join(',')} 接地=${fall.player.grounded}`);
  for (let i = 0; i < 40; i++) {
    await B.step(1, 50);
    const x = await B.snap();
    regenTrace.push({ t: x.elapsedSeconds, en: x.player.en, grounded: x.player.grounded, spent: x.player.movement.lastEnSpentAtSeconds });
  }
  // EN回復は「接地中 かつ 最後の消費から0.75秒以上」だけ。空中や待ち時間内に増えてはいけない
  let violation = '';
  let increased = 0;
  for (let i = 1; i < regenTrace.length; i++) {
    const a1 = regenTrace[i - 1];
    const b1 = regenTrace[i];
    if (b1.en > a1.en + 1e-9) {
      increased++;
      const sinceSpent = b1.spent === null ? Infinity : a1.t - b1.spent; // 増加が始まったフレームの開始時点での経過
      if (!a1.grounded && !b1.grounded) violation = `空中で増加 (t=${f(b1.t, 3)})`; // 着地したフレームでの増加は接地後の分
      else if (sinceSpent < 0.75 - 0.051) violation = `待ち時間内に増加 (t=${f(b1.t, 3)} 最後の消費から ${f(sinceSpent, 3)}s)`;
    }
  }
  const firstInc = regenTrace.find((x, i) => i > 0 && x.en > regenTrace[i - 1].en + 1e-9);
  ok(
    '3.19',
    'EN回復は接地中かつ最後の消費から0.75秒以上経ってからだけ (飛行後の空中・待ち時間内では回復しない)',
    !violation && increased > 0,
    `飛行終了後 ${regenTrace.length}サンプル: 増加${increased}回 ${violation || '違反なし'} / 最後の消費 ${f(regenTrace[regenTrace.length - 1].spent ?? NaN, 3)}s / 最初の増加 ${firstInc ? f(firstInc.t, 3) + 's (最後の消費から ' + f(firstInc.t - (firstInc.spent ?? 0), 3) + 's, 接地=' + firstInc.grounded + ')' : 'なし'}`,
  );

  // ---- WASD の移動速度と方向
  await B.calibrateYaw();
  const yaw = B.yaw;
  const fwd = forwardFromYaw(yaw);
  const rgt = rightFromYaw(yaw);
  const cases: [string, string, { x: number; z: number }][] = [
    ['KeyW', 'W(前)', { x: fwd.x, z: fwd.z }],
    ['KeyS', 'S(後)', { x: -fwd.x, z: -fwd.z }],
    ['KeyD', 'D(右)', { x: rgt.x, z: rgt.z }],
    ['KeyA', 'A(左)', { x: -rgt.x, z: -rgt.z }],
  ];
  const wasd: string[] = [];
  let wasdOk = true;
  for (const [code, label, ex] of cases) {
    await B.down(code);
    await B.play(0.3, 50);
    const sn = await B.snap();
    const sp = hspeed(sn);
    const dot = sp > 0 ? (sn.player.velocity[0] * ex.x + sn.player.velocity[2] * ex.z) / sp : 0;
    if (!(near(sp, PLAYER.WALK_SPEED, 0.1) && dot > 0.999)) wasdOk = false;
    wasd.push(`${label} ${f(sp, 2)}m/s cos=${f(dot, 4)}`);
    await B.up(code);
    await B.play(0.3, 50);
  }
  await B.down('KeyW');
  await B.down('KeyD');
  await B.play(0.3, 50);
  const diag = await B.snap();
  await B.up('KeyW');
  await B.up('KeyD');
  await B.play(0.3, 50);
  ok('3.20', 'W/A/S/D の実キーで、カメラ向き基準に 10m/s (斜め移動でも増えない)', wasdOk && near(hspeed(diag), PLAYER.WALK_SPEED, 0.1), `${wasd.join(' / ')} / 斜め(W+D) ${f(hspeed(diag), 2)}m/s`);
  const stopped = await B.snap();
  ok('3.21', '入力を離すと通常移動は停止へ向かって減速する (グライドOFF)', hspeed(stopped) < 0.5, `離して0.3秒後 ${f(hspeed(stopped), 3)}m/s`);

  // ---- Shift: グライド切替 (キーリピートでは切り替わらない)
  const gl0 = await B.snap();
  await B.down('ShiftLeft');
  await B.step(1, 16);
  const gl1 = await B.snap();
  for (let i = 0; i < 6; i++) {
    await B.down('ShiftLeft'); // repeat=true
    await B.step(1, 16);
  }
  const gl2 = await B.snap();
  await B.up('ShiftLeft');
  await B.step(2, 16);
  const gl3 = await B.snap();
  await B.down('ShiftLeft');
  await B.step(1, 16);
  const gl4 = await B.snap();
  await B.up('ShiftLeft');
  await B.step(1, 16);
  await B.down('ShiftLeft');
  await B.step(1, 16);
  await B.up('ShiftLeft');
  await B.step(1, 16);
  const gl5 = await B.snap();
  ok(
    '3.22',
    'Shift 1回押しでグライドON (押し続けなくてよい)、keydown の repeat では切り替わらず、離しても維持。もう1回押すとOFF、さらに押すとON',
    !gl0.player.movement.glideEnabled && gl1.player.movement.glideEnabled && gl1.player.movement.horizontalMode === 'glide' && gl2.player.movement.glideEnabled && gl3.player.movement.glideEnabled && !gl4.player.movement.glideEnabled && gl5.player.movement.glideEnabled,
    `初期=${gl0.player.movement.glideEnabled} 押下=${gl1.player.movement.glideEnabled}(${gl1.player.movement.horizontalMode}) repeat×6後=${gl2.player.movement.glideEnabled} 離した後=${gl3.player.movement.glideEnabled} 再押下=${gl4.player.movement.glideEnabled} さらに押下=${gl5.player.movement.glideEnabled}`,
  );
  // グライド中: W で 22m/s、離しても方向と速度を保つ。EN 消費 0
  const enG0 = (await B.snap()).player.en;
  await B.down('KeyW');
  await B.play(0.9, 50);
  const gw = await B.snap();
  await B.up('KeyW');
  await B.play(0.3, 50);
  const gr = await B.snap();
  ok('3.23', 'グライド: W で地上22m/s、W を離しても最後の方向へ速度を保って進み続ける。EN は減らない (0 EN)', near(hspeed(gw), PLAYER.GLIDE_SPEED_GROUND, 0.3) && near(hspeed(gr), PLAYER.GLIDE_SPEED_GROUND, 0.3) && gr.player.en >= enG0 - 1e-9, `W中 ${f(hspeed(gw), 2)}m/s / 離して0.3秒後 ${f(hspeed(gr), 2)}m/s / EN ${f(enG0)} -> ${f(gr.player.en)}`);
  // 左Ctrl: ブレーキ (グライドOFF + 減速)
  await B.down('ControlLeft');
  await B.step(1, 16);
  const br1 = await B.snap();
  let br = br1;
  const speeds: number[] = [hspeed(br1)];
  for (let i = 0; i < 12 && hspeed(br) > 0.05; i++) {
    await B.step(1, 25);
    br = await B.snap();
    speeds.push(hspeed(br));
  }
  await B.up('ControlLeft');
  const mono = speeds.every((v, i) => i === 0 || v <= speeds[i - 1] + 1e-6);
  ok('3.24', '左Ctrl: グライドを解除して減速し、0へ向かう (horizontalMode=walk、速度は単調に減少)', !br1.player.movement.glideEnabled && br1.player.movement.horizontalMode === 'walk' && hspeed(br) < 0.5 && mono, `解除=${!br1.player.movement.glideEnabled} mode=${br1.player.movement.horizontalMode} 速度 ${speeds.map((v) => f(v, 1)).join('>')} 最終 ${f(hspeed(br), 3)}m/s`);

  const pr = B.appProblems();
  ok('3.25', '入力操作中にコンソールのエラー/警告が出ない', pr.length === 0, pr.length ? pr.map((p) => p.text).join(' | ') : 'エラー0 / 警告0');
  rec('3.26', 'Space の keydown repeat (押しっぱなし) で空中ジャンプが再発動しない', 'info', '本ツールでは実機未検証 (sim 側は tests/player.test.ts / tests/audit-movement.test.ts、入力層は tests/uiLogic.test.ts の repeat 無視の試験で検証)。左Ctrl 中のQB不成立と HUD の BRAKE 表示は 3.35 で実機確認');
  await B.close();
}

// ---------------------------------------------------------------------------------------------------------------------
/**
 * 「次の tick の前に離されたキー」を失わない (audit-movement F1): page.keyboard.press / page.mouse の down+up は、間にフレームを挟まず
 * 連続して届く (fake clock を止めているので rAF は1つも走らない)。Game.input はレベル入力なので、入力層が保留しないと sim に一度も見えない。
 * 「Qを短く押して全キーを離しても、噴射・慣性・自動グライドが続く」(SPEC §11) の実機確認。
 */
async function tapTests(browser: Browser, base: string): Promise<void> {
  const T = await Sess.open(browser, base, 'tap');
  await T.step(2, 50);
  await T.sortie();
  await T.step(2, 50);
  // 北端 (z≈3) まで S キーで後退し、南向きに 50m 以上の直線を空ける (3.7 と同じ)
  await T.down('KeyS');
  let sn = await T.snap();
  for (let i = 0; i < 80 && sn.player.position[2] > 3.4; i++) {
    await T.step(1, 100);
    sn = await T.snap();
  }
  await T.up('KeyS');
  await T.play(1.0, 50);
  const P0 = await T.snap();
  const kl0 = (await keyLog(T)).length;
  const frames0 = await T.page.evaluate(() => (window as unknown as E2EWin).__e2e.rafCalls);

  // ---- Q: keyboard.press (down+up が同じフレーム内)。フレームを進める前は sim はまだ何も見ていない
  await T.page.keyboard.press('KeyQ');
  const frames1 = await T.page.evaluate(() => (window as unknown as E2EWin).__e2e.rafCalls);
  const pre = await T.snap();
  const kl = (await keyLog(T)).slice(kl0);
  await T.step(1, 25);
  const q1 = await T.snap();
  const t0 = q1.player.movement.qbLastStartedAtSeconds ?? P0.elapsedSeconds;
  let cur = q1;
  const modes = new Set<string>([q1.player.movement.horizontalMode]);
  let autoGlide = false;
  for (let i = 0; i < 40 && cur.elapsedSeconds < t0 + 0.75 - 1e-9; i++) {
    await T.step(1, 25);
    cur = await T.snap();
    modes.add(cur.player.movement.horizontalMode);
    if (cur.elapsedSeconds - t0 > 0.16 && cur.player.movement.horizontalMode === 'glide' && cur.player.movement.glideEnabled) autoGlide = true;
  }
  const dist = Math.hypot(cur.player.position[0] - P0.player.position[0], cur.player.position[2] - P0.player.position[2]);
  const drop = P0.player.en - q1.player.en;
  ok(
    '3.30',
    'Q を keyboard.press (keydown と keyup がフレームを挟まず連続) で押すだけで QB が1回成立し (EN-36)、噴射・慣性・自動グライドが続いて0.75秒で約42.6m移動する',
    frames1 === frames0 && kl.map((k) => k.t).join() === 'kd,ku' && pre.player.movement.qbSuccessfulCount === 0 && q1.player.movement.qbSuccessfulCount === 1 && near(drop, 36, 1e-6) && modes.has('quickboost') && modes.has('glide') && autoGlide && near(dist, 42.6, 1.5) && cur.player.movement.qbSuccessfulCount === 1,
    `キー ${kl.map((k) => `${k.t}:${k.c}`).join(',')} (その間の rAF ${frames1 - frames0}回) / 押下直後(フレーム前) count=${pre.player.movement.qbSuccessfulCount} -> 1フレーム後 count=${q1.player.movement.qbSuccessfulCount} EN低下 ${f(drop, 6)} / モード ${[...modes].join(',')} 自動グライド=${autoGlide} / 0.75秒の移動 ${f(dist, 2)}m (期待 42.6) / 最終 count=${cur.player.movement.qbSuccessfulCount}`,
  );
  await T.play(1.5, 50); // 待ち時間 (1.0s) を空ける

  // ---- Space: 短いタップ (press) でも通常ジャンプ (飛行にならず EN を消費しない)。地上へ戻ってから
  const guard = async (): Promise<Snapshot> => {
    let g = await T.snap();
    for (let i = 0; i < 60 && !(g.player.grounded && Math.hypot(g.player.velocity[0], g.player.velocity[2]) < 0.5); i++) {
      await T.step(1, 50);
      g = await T.snap();
    }
    return g;
  };
  await T.down('ControlLeft'); // 慣性が残っていたら止める
  await T.play(0.8, 50);
  await T.up('ControlLeft');
  const j0 = await guard();
  await T.page.keyboard.press('Space');
  await T.step(1, 16);
  let jn = await T.snap();
  const jModes = new Set<string>([jn.player.movement.verticalMode]);
  const vy0 = jn.player.velocity[1];
  let jEnMin = jn.player.en;
  for (let i = 0; i < 40 && !(jn.player.grounded && i > 2); i++) {
    await T.step(1, 50);
    jn = await T.snap();
    jModes.add(jn.player.movement.verticalMode);
    jEnMin = Math.min(jEnMin, jn.player.en);
  }
  ok('3.31', 'Space を keyboard.press (keydown/keyup が連続) で押すと通常ジャンプが1回起き (上向き初速≈10m/s)、飛行にならず EN を消費しない', vy0 > 8.5 && jModes.has('rising') && !jModes.has('flying') && jEnMin >= j0.player.en - 1e-9, `1フレーム後の上向き速度 ${f(vy0, 2)}m/s モード ${[...jModes].join(',')} EN最小 ${f(jEnMin)} (開始 ${f(j0.player.en)})`);

  // ---- Shift: press でグライドが1回だけ切り替わる (もう1回 press でOFFに戻る)
  await guard();
  const s0 = await T.snap();
  await T.page.keyboard.press('ShiftLeft');
  await T.step(1, 16);
  const s1 = await T.snap();
  await T.step(6, 50);
  const s2 = await T.snap();
  await T.page.keyboard.press('ShiftLeft');
  await T.step(1, 16);
  const s3 = await T.snap();
  ok('3.32', 'Shift を keyboard.press で押すとグライドが ON になり (離しても維持、保留の解放で再トグルされない)、もう1回 press で OFF に戻る', !s0.player.movement.glideEnabled && s1.player.movement.glideEnabled && s2.player.movement.glideEnabled && !s3.player.movement.glideEnabled, `初期=${s0.player.movement.glideEnabled} press後=${s1.player.movement.glideEnabled} 0.3秒後=${s2.player.movement.glideEnabled} 2回目press後=${s3.player.movement.glideEnabled}`);
  if (s3.player.movement.glideEnabled) {
    await T.down('ControlLeft');
    await T.step(4, 50);
    await T.up('ControlLeft');
  }

  // ---- 射撃: 左ボタンの down+up が連続 (クリック) でも1発は撃つ
  await guard();
  await T.play(0.5, 50);
  const m0 = await T.snap();
  await T.page.mouse.down();
  await T.page.mouse.up();
  await T.step(2, 16);
  const m1 = await T.snap();
  await T.step(10, 50);
  const m2 = await T.snap();
  ok('3.33', '左クリック (mouse down+up が連続) でマシンガンが1発だけ発射される (押し続けていないので連射にならない)', m0.player.ammo.machinegun - m1.player.ammo.machinegun === 1 && m2.player.ammo.machinegun === m1.player.ammo.machinegun && m1.recentPlayerShots.length === m0.recentPlayerShots.length + 1, `残弾 ${m0.player.ammo.machinegun} -> ${m1.player.ammo.machinegun} -> 0.5秒後 ${m2.player.ammo.machinegun} / 射撃履歴 +${m1.recentPlayerShots.length - m0.recentPlayerShots.length}`);

  // ---- Ctrl 押下中の QB は不成立で、HUD は READY と出さない (BRAKE)。離せば READY で、成立する
  await T.play(1.5, 50);
  const hudQb = (): Promise<string> => T.page.evaluate(() => (document.querySelector('.hud-qb')?.textContent ?? '').trim());
  const hudQbData = (): Promise<string | null> => T.page.evaluate(() => document.querySelector('.hud-qb')?.getAttribute('data-qb') ?? null);
  const c0 = await T.snap();
  const hReady = await hudQb();
  await T.down('ControlLeft');
  await T.step(3, 50);
  const hBrake = await hudQb();
  const hBrakeData = await hudQbData();
  await T.page.keyboard.press('KeyQ');
  await T.step(3, 50);
  const c1 = await T.snap();
  await T.up('ControlLeft');
  await T.step(3, 50);
  const hAfter = await hudQb();
  await T.page.keyboard.press('KeyQ');
  await T.step(3, 50);
  const c2 = await T.snap();
  ok(
    '3.35',
    '左Ctrl (ブレーキ) を押している間は新しい QB が不成立 (EN・待ち時間を変えない) で、HUD の QB 表示は READY ではなく BRAKE。離すと READY に戻り、Q で QB が成立する',
    hReady === 'READY' && hBrake.includes('BRAKE') && hBrakeData === 'BRAKE' && c1.player.movement.qbSuccessfulCount === c0.player.movement.qbSuccessfulCount && c1.player.en >= c0.player.en - 1e-9 && hAfter === 'READY' && c2.player.movement.qbSuccessfulCount === c0.player.movement.qbSuccessfulCount + 1,
    `HUD: 通常「${hReady}」 -> Ctrl押下中「${hBrake}」(data-qb=${hBrakeData}) -> 離した後「${hAfter}」 / Ctrl押下中に Q を press: count ${c0.player.movement.qbSuccessfulCount} -> ${c1.player.movement.qbSuccessfulCount} EN ${f(c0.player.en)} -> ${f(c1.player.en)} / 離して press: count -> ${c2.player.movement.qbSuccessfulCount}`,
  );
  const pr = T.appProblems();
  ok('3.36', '素早いタップ入力の試験中にコンソールのエラー/警告が出ない', pr.length === 0, pr.length ? pr.map((p) => p.text).join(' | ') : 'エラー0 / 警告0');
  await T.close();
}
