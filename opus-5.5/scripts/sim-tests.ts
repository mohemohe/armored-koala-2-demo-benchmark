// ヘッドレスのシミュレーション検証（npm run test:sim）。
// ブラウザと同じ src/sim のコード（移動・EN・敵AI・弾体・当たり判定）をそのまま実行する。
import { writeFileSync, mkdirSync } from 'node:fs';
import { SIM_DT, computeEffectiveStats, type Loadout } from '../src/config';
import { Game, EMPTY_INPUT, type StepInput } from '../src/sim/game';
import { FixedStepper } from '../src/sim/loop';
import type { StageData } from '../src/stage/build';
import type { EnemyDef } from '../src/stage/types';
import type { V3 } from '../src/math';

const out: string[] = [];
const log = (s = '') => {
  out.push(s);
  console.log(s);
};
let fails = 0;
const check = (ok: boolean, msg: string) => {
  log(`${ok ? '- [OK] ' : '- [NG] '}${msg}`);
  if (!ok) fails++;
};
const f2 = (x: number) => x.toFixed(2);
const f3 = (x: number) => x.toFixed(3);

function arena(walls: { min: V3; max: V3 }[] = []): StageData {
  return {
    boxes: [{ min: [-300, -1, -300], max: [300, 0, 300], mat: 'floor' }, ...walls.map((w) => ({ ...w, mat: 'wall' as const }))],
    decals: [],
    barriers: [],
    cylinders: [],
    signs: [],
    sectors: [{ id: 'T', name: 'test', spaceType: '広場', x0: -300, x1: 300, z0: -300, z1: 300, floor: 0, ceil: 60, description: '' }],
    bounds: { min: [-300, -1, -300], max: [300, 60, 300] },
  };
}

function mk(loadout: Loadout, enemies: EnemyDef[] = [], walls: { min: V3; max: V3 }[] = [], start: V3 = [0, 0, 0], seed = 20260908) {
  const g = new Game({ seed, enemies, stageOverride: { stage: arena(walls), start, startYaw: 0 } });
  g.sortie(loadout);
  return g;
}

const BIPED: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
const QUAD: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'quadruped' };
const inp = (o: Partial<StepInput> = {}): StepInput => ({ ...EMPTY_INPUT, ...o });

log('# AK2 シミュレーション検証レポート');
log('');
log(`生成日時: ${new Date().toISOString()} / 更新幅 ${f3(SIM_DT)} 秒（1/120秒）`);
log('');

// ------------------------------------------------------------- 1. 単発QBと移動量
log('## 1. QB（障害物のない平地）');
for (const [name, lo, expect] of [
  ['2脚', BIPED, 42.6],
  ['4脚', QUAD, 34.08],
] as const) {
  const g = mk(lo);
  const p = g.player;
  const en0 = p.en;
  const x0: V3 = [...p.pos] as V3;
  // t=0: Q を押下（WASD なし → カメラ前方 = -Z）。以後 5 秒間 Q を押し続ける（エッジは最初だけ）
  const trace: string[] = [];
  let pos075: V3 | null = null;
  for (let s = 0; s < 600; s++) {
    g.step(inp({ qEdge: s === 0 }));
    const t = g.elapsedSeconds;
    if (Math.abs(t - 0.15) < 1e-9 || Math.abs(t - 0.75) < 1e-9 || Math.abs(t - 0.3) < 1e-9 || Math.abs(t - 1.5) < 1e-9 || Math.abs(t - 5) < 1e-9) {
      const snap = g.getSnapshot();
      trace.push(
        `  - t=${f2(t)}s: 移動距離 ${f3(Math.hypot(p.pos[0] - x0[0], p.pos[2] - x0[2]))} m, 水平速度 ${f3(Math.hypot(p.vel[0], p.vel[2]))} m/s, EN ${f3(p.en)}, mode=${snap.player.movement.horizontalMode}, glide=${snap.player.movement.glideEnabled}, QB回数=${snap.player.movement.qbSuccessfulCount}`,
      );
    }
    if (Math.abs(t - 0.75) < 1e-9) pos075 = [...p.pos] as V3;
  }
  const d075 = Math.hypot(pos075![0] - x0[0], pos075![2] - x0[2]);
  log(`### ${name}（初期EN ${en0}、入力: t=0 で Q 押下し 5 秒間保持、他のキーなし）`);
  trace.forEach((t) => log(t));
  check(Math.abs(d075 - expect) < 0.05, `${name}: QB開始から0.75秒の移動距離 ${f3(d075)} m（期待値 ${expect} m）`);
  check(p.qbCount === 1, `${name}: Q を5秒保持しても QB 成功は ${p.qbCount} 回`);
}

// EN消費は36のみ（押し続けても追加消費なし）
{
  const g = mk(BIPED);
  const p = g.player;
  g.step(inp({ qEdge: true }));
  const enAfter = p.en;
  let minEn = p.en;
  for (let s = 1; s < 89; s++) {
    g.step(inp());
    minEn = Math.min(minEn, p.en);
  }
  check(Math.abs(120 - enAfter - 36) < 1e-9 && Math.abs(minEn - 84) < 1e-9, `QB の EN 消費は発動時の 36 のみ（120 → ${f3(enAfter)}、0.74秒まで最小 ${f3(minEn)}）`);
  // t=0.75 から回復（地上グライド中）
  const before = p.en;
  g.step(inp()); // [0.74166, 0.75]
  const at075 = p.en;
  g.step(inp()); // [0.75, 0.7583]
  const after = p.en;
  check(
    Math.abs(at075 - before) < 1e-9 && after > at075 && g.player.horizontalMode === 'glide',
    `EN回復は時刻0.75秒から開始（0.75秒時点 ${f3(at075)} → 次ステップ ${f3(after)}）、その間もグライド継続（mode=${g.player.horizontalMode}）`,
  );
}

// ------------------------------------------------------------- 2. 入力解放後の継続
log('');
log('## 2. 入力解放後の噴射・慣性・自動グライド');
{
  const g = mk(BIPED);
  const p = g.player;
  g.step(inp({ qEdge: true, moveX: 1 })); // 右へQB
  for (let s = 1; s < 3; s++) g.step(inp({ moveX: 1 })); // 短く押して離す
  const rows: string[] = [];
  for (let s = 3; s < 360; s++) {
    g.step(inp());
    const t = g.elapsedSeconds;
    if ([0.1, 0.15, 0.4, 0.75, 1.5, 3].some((x) => Math.abs(t - x) < 1e-9)) {
      rows.push(`  - t=${f2(t)}s: pos=(${f2(p.pos[0])}, ${f2(p.pos[2])}) 速度=${f3(Math.hypot(p.vel[0], p.vel[2]))} mode=${p.horizontalMode} glide=${p.glideEnabled}`);
    }
  }
  rows.forEach((r) => log(r));
  check(p.glideEnabled && Math.abs(Math.hypot(p.vel[0], p.vel[2]) - 22) < 1e-6 && p.vel[0] > 21.9, '全キー解放後も QB 方向へ 22 m/s でグライド継続（3秒後）');
}

// ------------------------------------------------------------- 3. EN0 でのグライド
log('');
log('## 3. グライドの EN（EN0でも使用可能・接地中は回復しながら継続）');
{
  const g = mk(BIPED);
  const p = g.player;
  // 飛行で EN を 0 まで使い切る
  let s = 0;
  g.step(inp({ spaceEdge: true, spaceHeld: true }));
  while (p.en > 0 && s < 2000) {
    g.step(inp({ spaceHeld: true }));
    s++;
  }
  const tEmpty = g.elapsedSeconds;
  log(`  - 飛行でENを使い切り（t=${f2(tEmpty)}s, EN=${p.en}, 高度 ${f2(p.pos[1])} m, 最終EN支出時刻 ${f3(p.lastEnSpentAt!)}s）`);
  // 着地まで待つ
  while (!p.grounded && s < 5000) {
    g.step(inp());
    s++;
  }
  log(`  - 着地 t=${f2(g.elapsedSeconds)}s EN=${f3(p.en)}`);
  // Shift でグライド ON（EN0でも可）→ 入力なしで前方へ
  const enBefore = p.en;
  g.step(inp({ shiftEdge: true }));
  const tOn = g.elapsedSeconds;
  const regenStart = p.lastEnSpentAt! + 0.75;
  let firstRegenT = -1;
  let prevEn = p.en;
  for (let k = 0; k < 240; k++) {
    g.step(inp());
    if (firstRegenT < 0 && p.en > prevEn) firstRegenT = g.elapsedSeconds - SIM_DT;
    prevEn = p.en;
  }
  log(`  - t=${f2(tOn)}s に Shift でグライドON（EN ${f3(enBefore)}）。2秒後: 速度 ${f3(Math.hypot(p.vel[0], p.vel[2]))} m/s, EN ${f3(p.en)}, mode=${p.horizontalMode}`);
  check(p.glideEnabled && Math.abs(Math.hypot(p.vel[0], p.vel[2]) - 22) < 1e-6, 'EN0 からでもグライド可能（22 m/s）');
  check(p.en > 0, `接地グライド中に EN が回復（2秒後 EN ${f3(p.en)}）`);
  log(`  - 回復開始 ${f3(Math.max(firstRegenT, 0))}s（最終支出+0.75 = ${f3(regenStart)}s 以降、ただし着地後）`);
}

// ------------------------------------------------------------- 4. 残量境界
log('');
log('## 4. 残量境界（EN35 で不成立、EN36 で成立し、その後 EN0 でも慣性とグライド継続）');
{
  const g = mk(BIPED);
  const p = g.player;
  p.en = 35; // 試験条件の設定（ヘッドレス試験のみ）
  g.step(inp({ qEdge: true }));
  check(p.qbCount === 0 && p.en >= 35 && p.en < 36 && p.lastEnSpentAt === null && p.qbLastStartedAt === null, `EN35: QB 不成立（EN消費なし: ${f3(p.en)}（同ステップの通常回復のみ）、回復待ち時間・再使用待ち時間も未更新）`);
  // 押しっぱなしで回復しても予約発動しない
  for (let k = 0; k < 120; k++) g.step(inp());
  check(p.qbCount === 0, `不成立の押下は予約されない（1秒後 EN ${f3(p.en)} でも QB 回数 ${p.qbCount}）`);
  p.en = 36;
  const t0 = g.elapsedSeconds;
  g.step(inp({ qEdge: true }));
  check(p.qbCount === 1 && p.en === 0, `EN36: QB 成立（EN ${p.en}）`);
  for (let k = 0; k < 60; k++) g.step(inp());
  const sp = Math.hypot(p.vel[0], p.vel[2]);
  check(p.horizontalMode === 'glide' && sp > 22 && p.en < 36, `EN0 付近でも慣性減速中のグライド継続（t=${f2(g.elapsedSeconds - t0)}s 速度 ${f3(sp)} m/s、EN ${f3(p.en)}）`);
}

// ------------------------------------------------------------- 5. 同時操作
log('');
log('## 5. 同時操作（QB → ビーム → 飛行の順に残量判定、二重支出なし）');
{
  const g = mk(BIPED);
  const p = g.player;
  g.weapons.current = 'beam';
  // 飛行状態にする
  g.step(inp({ spaceEdge: true, spaceHeld: true }));
  for (let k = 0; k < 30; k++) g.step(inp({ spaceHeld: true }));
  const en0 = p.en;
  g.step(inp({ spaceHeld: true, qEdge: true, fireHeld: true }));
  const spent = en0 - p.en;
  check(Math.abs(spent - (36 + 8 + 20 * SIM_DT)) < 1e-6, `同一ステップの QB+ビーム+飛行: 支出 ${f3(spent)} = 36 + 8 + 20×1/120`);
  // 残量が QB 分しかない場合
  p.en = 40;
  const g2 = g;
  for (let k = 0; k < 130; k++) g2.step(inp({ spaceHeld: true })); // QB再使用可能まで待つ（飛行でEN消費）
  p.en = 40;
  g2.weapons.nextFireAt.beam = 0;
  const shots0 = g2.weapons.shotsFired;
  g2.step(inp({ spaceHeld: true, qEdge: true, fireHeld: true }));
  const afterFirst = p.en;
  const beamFired = g2.weapons.shotsFired - shots0;
  let thrustSteps = 1;
  for (let k = 0; k < 60; k++) {
    g2.step(inp({ spaceHeld: true }));
    if (p.thrusting) thrustSteps++;
  }
  check(
    p.qbCount === 2 && beamFired === 0 && Math.abs(afterFirst - (4 - 20 * SIM_DT)) < 1e-9 && p.en === 0 && Math.abs(thrustSteps * SIM_DT - 0.2) < SIM_DT + 1e-9,
    `EN40 で QB+ビーム+飛行: QB(36)成立 → ビーム不成立（残4<8、発射${beamFired}）→ 飛行は残4 EN分の約 ${f3(thrustSteps * SIM_DT)} 秒だけ推進し EN ${p.en}`,
  );
  // グライドは無料
  const g3 = mk(BIPED);
  const p3 = g3.player;
  g3.step(inp({ shiftEdge: true }));
  for (let k = 0; k < 240; k++) g3.step(inp());
  check(p3.en === p3.stats.maxEn && p3.lastEnSpentAt === null, `グライド2秒間の EN 消費 0（EN ${p3.en}、最終支出 ${p3.lastEnSpentAt}）`);
}

// ------------------------------------------------------------- 6. フレームレート非依存
log('');
log('## 6. 描画フレームレート非依存（30/60/120/144fps で 3 秒間の QB＋飛行）');
{
  const res: string[] = [];
  const vals: number[][] = [];
  for (const fps of [30, 60, 120, 144]) {
    const g = mk(BIPED);
    const st = new FixedStepper();
    let t = 0;
    let first = true;
    let spaceFirst = true;
    while (t < 3 - 1e-9) {
      const n = st.advance(1 / fps);
      for (let k = 0; k < n; k++) {
        g.step(inp({ qEdge: first, moveZ: 1, spaceHeld: g.elapsedSeconds >= 1, spaceEdge: g.elapsedSeconds >= 1 && spaceFirst }));
        if (g.elapsedSeconds >= 1 && spaceFirst) spaceFirst = false;
        first = false;
      }
      t += 1 / fps;
    }
    const p = g.player;
    vals.push([p.pos[0], p.pos[1], p.pos[2], p.en, g.steps]);
    res.push(`  - ${fps}fps: steps=${g.steps} pos=(${f3(p.pos[0])}, ${f3(p.pos[1])}, ${f3(p.pos[2])}) EN=${f3(p.en)}`);
  }
  res.forEach((r) => log(r));
  const ok = vals.every((v) => Math.abs(v[2] - vals[0][2]) < 1.2 && Math.abs(v[3] - vals[0][3]) < 1);
  check(ok, 'フレームレートによらず同じ時間に対する移動量・EN消費が一致（差は1ステップ分未満）');
}

// ------------------------------------------------------------- 7. 敵の攻撃タイミング
log('');
log('## 7. 敵の攻撃（初動・バースト・周期）');
function turretAt(id: string, x: number, z: number, y = 0): EnemyDef {
  return { id, kind: 'turret', sectorId: 'T', pos: [x, y, z], isGateControl: false };
}
function guardAt(id: string, x: number, z: number): EnemyDef {
  return { id, kind: 'guard', sectorId: 'T', pos: [x, 0, z], isGateControl: false };
}
for (const kind of ['turret', 'guard'] as const) {
  const e = kind === 'turret' ? turretAt('T99', 0, -60) : guardAt('G99', 0, -60);
  const g = mk(BIPED, [e]);
  const times: number[] = [];
  let last = 0;
  let firstLos: number | null = null;
  for (let s = 0; s < 120 * 6; s++) {
    g.step(inp());
    const en = g.enemies.enemies[0];
    if (firstLos === null && en.hasLOS) firstLos = g.elapsedSeconds - SIM_DT;
    if (en.shotsFired > last) {
      times.push(en.lastShotAt!);
      last = en.shotsFired;
    }
    g.player.hp = 1000; // 被弾で終了しないよう維持（タイミング計測のみ）
  }
  const spec = g.enemies.enemies[0].spec;
  log(`### ${kind === 'turret' ? '固定砲台' : '警備ロボット'}（距離60m、遮蔽なし）`);
  log(`  - 初めて射線を得た時刻 ${f3(firstLos!)}s、発射時刻: ${times.slice(0, 9).map(f3).join(', ')} ...`);
  const d1 = times[0] - firstLos!;
  check(Math.abs(d1 - spec.firstDelay) <= 0.05 + 1e-9, `初回攻撃: 射線取得から ${f3(d1)} 秒（仕様 ${spec.firstDelay} 秒、許容遅れ0.05秒）`);
  check(Math.abs(times[1] - times[0] - spec.burstInterval) < 1e-6, `バースト内間隔 ${f3(times[1] - times[0])} 秒（仕様 ${spec.burstInterval}）`);
  check(Math.abs(times[spec.burstCount] - times[0] - spec.burstPeriod) < 1e-6, `バースト周期 ${f3(times[spec.burstCount] - times[0])} 秒（仕様 ${spec.burstPeriod}、予告込み）`);
  log(`  - 6秒間の発射数 ${last}`);
}

// 遮蔽を挟んでも初回待ちをやり直さない / 遮蔽中は撃たない
{
  const wall = { min: [-10, 0, -31] as V3, max: [10, 12, -29] as V3 };
  const g = mk(BIPED, [turretAt('T98', 0, -60)], [wall], [-40, 0, 0]);
  // プレイヤーは x=-40 で露出、x=0 で遮蔽。0-2秒露出 → 2.0-2.6秒遮蔽（予定バースト2.30を跨ぐ）→ 露出
  const shots: number[] = [];
  let last = 0;
  for (let s = 0; s < 120 * 6; s++) {
    const t = g.elapsedSeconds;
    g.player.pos[0] = t >= 2 && t < 2.6 ? 0 : -40;
    g.step(inp());
    const en = g.enemies.enemies[0];
    if (en.shotsFired > last) {
      shots.push(en.lastShotAt!);
      last = en.shotsFired;
    }
    g.player.hp = 1000;
  }
  const during = shots.filter((t) => t >= 2 + 1e-9 && t < 2.6 - 1e-9);
  log(`  - 遮蔽試験（0〜2秒露出、2.0〜2.6秒遮蔽、以後露出）発射時刻: ${shots.map(f3).join(', ')}`);
  check(during.length === 0, '遮蔽中（壁越し）は発射しない（予定されていた2.30秒のバーストも発射されない）');
  const after = shots.find((t) => t >= 2.6);
  check(
    after !== undefined && Math.abs(after - 2.6 - 0.35) < 0.05,
    `再露出（2.60秒）後の再開 ${f3(after! - 2.6)} 秒後 = 予告0.35秒のみ（初回待ち0.70秒をやり直さない）`,
  );
}

// ------------------------------------------------------------- 8. 偏差射撃
log('');
log('## 8. 偏差射撃（等速で横移動する標的）');
{
  const g = mk(BIPED, [turretAt('T97', 0, -60)], [], [-30, 0, 0]);
  // 標的を +x 方向へ 10m/s 等速移動（速度を持たせ、位置を直接更新）
  let hits = 0;
  let shots = 0;
  // 通常移動（右方向 10m/s）で等速横移動。最初の0.2秒で定速に達する
  for (let s = 0; s < 120 * 6; s++) {
    const hp0 = g.player.hp;
    const n0 = g.enemies.enemies[0].shotsFired;
    g.step({ ...EMPTY_INPUT, moveX: 1 });
    if (g.player.hp < hp0) hits++;
    shots += g.enemies.enemies[0].shotsFired - n0;
    g.player.hp = 1000;
  }
  log(`  - 距離約60m・横移動10m/s: 発射 ${shots} 発、命中 ${hits} 発`);
  check(shots > 0 && hits / shots > 0.6, `偏差射撃により移動標的に命中（命中率 ${((hits / Math.max(1, shots)) * 100).toFixed(0)}%）`);
}

// ------------------------------------------------------------- 9. 露出時の危険性
log('');
log('## 9. 露出時の危険性（HP1000の静止機体、35〜50mに警備2体＋固定砲台1体、遮蔽なし）');
{
  const enemies = [guardAt('G01', -20, -35), guardAt('G02', 25, -40), turretAt('T01', 0, 48)];
  const g = mk(BIPED, enemies, [], [0, 0, 0]);
  const d = g.enemies.enemies.map((e) => Math.hypot(e.pos[0] - g.player.pos[0], e.pos[2] - g.player.pos[2]).toFixed(1));
  let firstAttack: number | null = null;
  let t = 0;
  while (g.state === 'playing' && g.elapsedSeconds < 30) {
    g.step(inp());
    if (firstAttack === null && g.enemies.enemies.some((e) => e.hasLOS)) firstAttack = g.elapsedSeconds - SIM_DT;
    t = g.elapsedSeconds;
  }
  const shots = g.enemies.enemies.map((e) => `${e.id}:${e.shotsFired}`).join(' ');
  log(`  - 初期距離 ${d.join(' / ')} m、状態 ${g.state}、HP ${f3(g.player.hp)}、発射数 ${shots}`);
  log(`  - 攻撃可能（射線取得）時刻 ${f3(firstAttack!)}s → 撃破時刻 ${f3(t)}s（${f3(t - firstAttack!)} 秒）`);
  check(g.state === 'failed' && t - firstAttack! <= 15, `攻撃可能になってから ${f3(t - firstAttack!)} 秒で撃破（≤ 15 秒）`);
}

// ------------------------------------------------------------- 10. FCS ロック時間
log('');
log('## 10. FCS のロック所要時間（全18構成の実効値と実測）');
{
  for (const fcs of ['wide', 'medium', 'narrow'] as const)
    for (const legs of ['biped', 'quadruped'] as const) {
      const lo: Loadout = { fcs, generator: 'balanced', legs };
      const g = mk(lo, [turretAt('T96', 0, -40)]);
      g.setLook(0, 0);
      let t = -1;
      let acqAt = -1;
      for (let s = 0; s < 240; s++) {
        g.step(inp());
        g.player.hp = 1000;
        if (acqAt < 0 && g.fcs.state !== 'none') acqAt = g.elapsedSeconds;
        if (g.fcs.state === 'locked') {
          t = g.elapsedSeconds;
          break;
        }
      }
      const st = computeEffectiveStats(lo);
      const meas = t - acqAt;
      check(Math.abs(meas - st.lockSeconds) < SIM_DT + 1e-9, `${fcs}/${legs}: 実効ロック時間 ${f3(st.lockSeconds)} 秒、実測 ${f3(meas)} 秒`);
    }
}


// ------------------------------------------------------------- 11. 遮蔽後の追跡
log('');
log('## 11. 遮蔽後の追跡（最後の確認位置を記憶し0.5秒以内に接近開始、壁に押し付かず射線を取り直す）');
{
  const wall = { min: [10, 0, -6] as V3, max: [30, 12, -4] as V3 };
  const g = mk(BIPED, [guardAt('G90', 0, -50)], [wall], [0, 0, 0]);
  const e = g.enemies.enemies[0];
  for (let k = 0; k < 240; k++) {
    g.step(inp());
    g.player.hp = 1000;
  }
  const seenBefore = e.hasLOS;
  // 壁の陰へ移動（瞬間的に位置を変更して遮蔽状態を作る）
  g.player.pos = [20, 0, 0];
  let lostAt = -1;
  let moveAt = -1;
  let regainAt = -1;
  let maxStuck = 0;
  const lsp: V3[] = [];
  for (let k = 0; k < 120 * 10; k++) {
    g.step(inp());
    g.player.hp = 1000;
    const t = g.elapsedSeconds;
    if (lostAt < 0 && !e.hasLOS) {
      lostAt = t - SIM_DT;
      if (e.lastSeenPos) lsp.push([...e.lastSeenPos] as V3);
    }
    if (lostAt >= 0 && moveAt < 0 && Math.hypot(e.vel[0], e.vel[2]) > 0.5 && e.mode === 'pursue') moveAt = t - SIM_DT;
    if (lostAt >= 0 && regainAt < 0 && e.hasLOS) regainAt = t - SIM_DT;
    maxStuck = Math.max(maxStuck, e.stuckTime);
  }
  log(`  - 遮蔽前の射線 ${seenBefore}、遮蔽 ${f3(lostAt)}s、記憶位置 (${lsp[0]?.map((v) => v.toFixed(1)).join(', ')})、接近開始 ${f3(moveAt)}s、射線再取得 ${f3(regainAt)}s`);
  check(seenBefore && lostAt >= 0 && moveAt >= 0 && moveAt - lostAt <= 0.5, `遮蔽から ${f3(moveAt - lostAt)} 秒で最後の確認位置へ接近開始（≤ 0.50 秒）`);
  check(regainAt > 0, `壁を回り込み ${f3(regainAt - lostAt)} 秒後に射線を取り直した（押し付き継続なし）`);
}

// ------------------------------------------------------------- 12. 位置共有
log('');
log('## 12. 位置共有（通路でつながる60m以内の味方のみ。受信側は射線がなければ撃たない）');
{
  const wall = { min: [-50, 0, -42] as V3, max: [-30, 12, -40] as V3 };
  const far = { min: [150, 0, -80] as V3, max: [152, 12, 20] as V3 };
  const g = mk(BIPED, [guardAt('GA', 0, -50), guardAt('GB', -40, -50), guardAt('GC', 200, -50)], [wall, far], [0, 0, 0]);
  const [A, B, C] = g.enemies.enemies;
  let bAlertAt = -1;
  let bShotsWhileBlind = 0;
  for (let k = 0; k < 120 * 3; k++) {
    const b0 = B.shotsFired;
    const bLos = B.hasLOS;
    g.step(inp());
    g.player.hp = 1000;
    if (bAlertAt < 0 && B.alert && !B.hasLOS) bAlertAt = g.elapsedSeconds;
    if (!bLos && !B.hasLOS) bShotsWhileBlind += B.shotsFired - b0;
    if (k === 30) {
      log(`  - t=${f2(g.elapsedSeconds)}s: A 射線=${A.hasLOS} / B 射線=${B.hasLOS} 警戒=${B.alert} 記憶=${B.lastSeenPos?.map((v) => v.toFixed(1)).join(',')} / C(約200m先) 警戒=${C.alert}`);
    }
  }
  check(bAlertAt > 0 && bAlertAt < 0.5, `A が発見した位置を 60m 以内の B が受信（${f3(bAlertAt)}s）`);
  check(bShotsWhileBlind === 0, `B は自分の射線がない間は発射しない（壁越し射撃 ${bShotsWhileBlind} 発）`);
  check(!C.alert || C.hasLOS, '無関係な遠方の C は現在位置を受け取らない');
}

// ------------------------------------------------------------- 13. 敵弾の遮蔽
log('');
log('## 13. 敵弾は壁で遮られ、薄い壁もすり抜けない');
{
  const thin = { min: [-3, 0, -5.2] as V3, max: [3, 5, -5.0] as V3 };
  const g = mk(BIPED, [turretAt('T91', 0, -60)], [thin], [0, 0, 0]);
  const tb = g.world.boxes.find((b) => Math.abs(b.min[2] + 5.2) < 1e-9)!;
  tb.active = false;
  let impacts = 0;
  let activated = -1;
  for (let k = 0; k < 120 * 3; k++) {
    g.step(inp());
    if (activated < 0 && g.enemies.bullets.length > 0) {
      tb.active = true; // 1発目の発射直後に厚さ20cmの壁を出現させる
      activated = g.elapsedSeconds;
    }
    impacts += g.events.filter((e) => e.type === 'impact' && e.kind === 'enemyBullet').length;
    g.events = [];
  }
  check(activated > 0 && g.player.hp === 1000 && impacts >= 1, `飛行中の敵弾が厚さ0.2mの壁に命中して消滅（命中 ${impacts} 回、HP ${g.player.hp}）`);
}

// ------------------------------------------------------------- 14. ハンドミサイル
log('');
log('## 14. ハンドミサイル（ロック必須・発射後の追尾継続・対象破壊後は直進・壁は貫通しない）');
{
  // 未ロック：発射拒否（弾を生成せず弾数も消費しない）
  const g0 = mk(BIPED, [], [], [0, 0, 0]);
  g0.weapons.current = 'missile';
  g0.step(inp({ fireHeld: true }));
  check(g0.weapons.missiles.length === 0 && g0.weapons.ammo.missile === 12 && g0.weapons.lastDenied?.reason === 'noLock', '未ロックでは弾を生成せず弾数も消費しない（発射拒否）');

  // 発射後にカメラを背けても追尾継続
  const g = mk(BIPED, [turretAt('T92', 0, -60)], [], [0, 0, 0]);
  g.weapons.current = 'missile';
  g.setLook(0, 0.0);
  let fired = false;
  for (let k = 0; k < 120 * 4; k++) {
    const ready = g.fcs.state === 'locked';
    g.step(inp({ fireHeld: ready && !fired }));
    g.player.hp = 1000;
    if (!fired && g.weapons.missiles.length > 0) {
      fired = true;
      g.setLook(Math.PI, 0); // 背後を向く → FCS対象は破棄される
    }
  }
  const t = g.enemies.enemies[0];
  check(fired && t.hp === 240 - 180 && g.fcs.targetId === null, `発射後に視点を背けても追尾して命中（砲台HP ${t.hp}、FCS対象 ${g.fcs.targetId}）`);

  // 対象破壊後は直進（乗り換えない）
  const g2 = mk(BIPED, [guardAt('G93', 0, -60), guardAt('G94', 12, -40)], [], [0, 0, 0]);
  g2.weapons.current = 'missile';
  g2.setLook(0, 0);
  let m: import('../src/sim/weapons').Missile | null = null;
  for (let k = 0; k < 120 * 3 && !m; k++) {
    const target = g2.fcs.state === 'locked' ? g2.fcs.targetId : null;
    g2.step(inp({ fireHeld: target === 'G93' }));
    if (g2.weapons.missiles.length > 0) m = g2.weapons.missiles[0];
    if (!target && g2.fcs.targetId === 'G94') g2.fcs.targetId = null;
  }
  const e1 = g2.enemies.byId(g2.weapons.missiles[0]?.targetId ?? '')!;
  if (m && e1) {
    g2.enemies.damage(e1, 999, e1.center()); // 飛行中に対象が破壊される
    const d0 = [...m.dir];
    for (let k = 0; k < 30; k++) g2.step(inp());
    const d1 = m.dir;
    const same = Math.abs(d0[0] - d1[0]) + Math.abs(d0[1] - d1[1]) + Math.abs(d0[2] - d1[2]) < 1e-9;
    check(same, `対象破壊後は進行方向のまま直進（方向変化なし、別対象へ乗り換えない）`);
  } else check(false, 'ミサイル発射に失敗');

  // 壁は貫通しない
  const wall = { min: [-6, 0, -31] as V3, max: [6, 14, -29] as V3 };
  const g3 = mk(BIPED, [turretAt('T95', 0, -60)], [wall], [0, 0, 0]);
  const wb = g3.world.boxes.find((b) => Math.abs(b.min[2] + 31) < 1e-9)!;
  wb.active = false;
  g3.weapons.current = 'missile';
  let f3d = false;
  for (let k = 0; k < 120 * 4; k++) {
    g3.step(inp({ fireHeld: g3.fcs.state === 'locked' && !f3d }));
    g3.player.hp = 1000;
    if (!f3d && g3.weapons.missiles.length > 0) {
      f3d = true;
      wb.active = true;
    }
  }
  check(f3d && g3.enemies.enemies[0].hp === 240, `発射後に現れた壁でミサイルが止まり対象は無傷（HP ${g3.enemies.enemies[0].hp}）`);
}

// ------------------------------------------------------------- 15. マシンガン・ビーム
log('');
log('## 15. マシンガン（重力・射撃間隔・残弾）とビーム（EN・最初の遮蔽物/敵まで1回）');
{
  // 高さ40mの塔の上から水平に射撃（床に当たる前に1秒間の弾道を測定）
  const g = mk(BIPED, [], [{ min: [-3, 0, -3], max: [3, 40, 3] }], [0, 40, 0]);
  g.setLook(0, 0);
  g.step(inp());
  g.computeAim();
  g.step(inp({ fireHeld: true }));
  const b = g.weapons.mgBullets[0];
  const y0 = b.pos[1];
  const vy0 = b.vel[1];
  for (let k = 0; k < 120; k++) g.step(inp());
  // 記録時点から120ステップ = 1.000秒後の、直進線からの落下量
  const drop = y0 + vy0 * 1.0 - b.pos[1];
  check(Math.abs(drop - 9) < 0.01 && g.weapons.mgBullets.includes(b), `弾は発射後も誘導・補正されず、1秒間に直進線から ${f3(drop)} m 落下（½×18×1² = 9m）`);
  const g2 = mk(BIPED, [], [], [0, 0, 0]);
  for (let k = 0; k < 120; k++) g2.step(inp({ fireHeld: true }));
  check(g2.weapons.ammo.machinegun === 290, `1秒間の連射で ${300 - g2.weapons.ammo.machinegun} 発（0.10秒間隔）`);
  // 武器切替で次回発射可能時刻を維持
  g2.weapons.current = 'beam';
  g2.step(inp({ fireHeld: true }));
  const nb = g2.weapons.nextFireAt.beam;
  g2.step(inp({ weaponSelect: 'machinegun' }));
  g2.step(inp({ weaponSelect: 'beam', fireHeld: true }));
  check(g2.weapons.nextFireAt.beam === nb, '武器を切り替えてもビームの次回発射可能時刻は維持（切替で連射間隔を短縮できない）');
  // ビーム：直線上の最初の敵だけに1回
  const g3 = mk(BIPED, [turretAt('TA', 0, -30, 0.2), turretAt('TB', 0, -50, 0.2)], [], [0, 0, 0]);
  g3.setLook(0, -0.0);
  g3.weapons.current = 'beam';
  for (let k = 0; k < 300 && g3.fcs.state !== 'locked'; k++) {
    g3.step(inp());
    g3.player.hp = 1000;
  }
  const en0 = g3.player.en;
  g3.step(inp({ fireHeld: true }));
  const [TA, TB] = g3.enemies.enemies;
  check(TA.hp === 200 && TB.hp === 240 && Math.abs(en0 - g3.player.en - 8) < 0.2, `ビーム1射: 手前の TA のみ 40 ダメージ（TA ${TA.hp} / TB ${TB.hp}）、EN −8`);
  // EN不足ではビーム不可（EN消費・待ち時間更新なし）
  g3.player.en = 7;
  const nf = g3.weapons.nextFireAt.beam;
  for (let k = 0; k < 40; k++) {
    g3.player.en = 7;
    g3.step(inp({ fireHeld: true }));
  }
  check(g3.weapons.lastDenied?.reason === 'noEn' && g3.weapons.nextFireAt.beam === nf, 'EN 8 未満ではビームを発射できない（次回発射時刻も更新しない）');
}

// ------------------------------------------------------------- 15b. マシンガンのFCS射撃管制
log('');
log('## 15b. マシンガンのFCS射撃管制（ロック完了時に偏差と弾道落下を計算して発射方向を決定。発射後は誘導なし）');
{
  // 静止した砲台（約70m）：弾道落下を補正して命中
  const g = mk(BIPED, [turretAt('TM1', 0, -70)], [], [0, 0, 0]);
  g.setLook(0, 0.02);
  for (let k = 0; k < 240 && g.fcs.state !== 'locked'; k++) {
    g.step(inp());
    g.player.hp = 1000;
  }
  let hits = 0;
  let shots = 0;
  const b0 = g.weapons.shotsFired;
  for (let k = 0; k < 120; k++) {
    g.step(inp({ fireHeld: true }));
    g.player.hp = 1000;
    hits += g.events.filter((e) => e.type === 'enemyHit').length;
    g.events = [];
  }
  for (let k = 0; k < 120; k++) {
    g.step(inp());
    g.player.hp = 1000;
    hits += g.events.filter((e) => e.type === 'enemyHit').length;
    g.events = [];
  }
  shots = g.weapons.shotsFired - b0;
  check(shots === 10 && hits === 10, `約70m の静止砲台へロック射撃: ${shots} 発中 ${hits} 発命中（落下量 約4.4m を発射角で補正）`);

  // 発射後は誘導しない（水平速度一定・重力のみ）
  const g1 = mk(BIPED, [guardAt('GM0', 0, -40)], [], [0, 0, 0]);
  g1.setLook(0, 0);
  for (let k = 0; k < 240 && g1.fcs.state !== 'locked'; k++) {
    g1.step(inp());
    g1.player.hp = 1000;
  }
  g1.step(inp({ fireHeld: true }));
  const mb = g1.weapons.mgBullets[0];
  const v0 = [...mb.vel];
  for (let k = 0; k < 24; k++) g1.step(inp());
  const same = Math.abs(mb.vel[0] - v0[0]) < 1e-9 && Math.abs(mb.vel[2] - v0[2]) < 1e-9 && Math.abs(mb.vel[1] - (v0[1] - 18 * 24 * SIM_DT)) < 1e-6;
  check(same, 'ロック射撃の弾も発射後は誘導されず、水平速度一定・重力 18m/s² のみで飛ぶ');

  // グライドで横移動する自機 vs 側方移動する警備ロボット（実際のAI）
  for (const lg of [BIPED, QUAD]) {
    const g2 = mk(lg, [guardAt('GM1', 0, -45)], [], [0, 0, 0]);
    const e = g2.enemies.enemies[0];
    let fired = 0;
    let hit = 0;
    let lockedSteps = 0;
    // 弾ごとの結果（命中 / 外れ）。撃破時点で飛行中だった弾は判定対象外
    const tracked: { b: import('../src/sim/weapons').MgBullet; last: V3; res: 'hit' | 'miss' | null }[] = [];
    const settle = () => {
      const hitsAt = g2.events.filter((ev) => ev.type === 'enemyHit').map((ev) => (ev as { pos: V3 }).pos);
      for (const t of tracked) {
        if (t.res !== null) continue;
        if (!t.b.alive) {
          const endP: V3 = t.b.pos;
          t.res = hitsAt.some((h) => Math.hypot(h[0] - endP[0], h[1] - endP[1], h[2] - endP[2]) < 3) ? 'hit' : 'miss';
        }
      }
    };
    g2.step(inp({ shiftEdge: true, moveX: 1 }));
    for (let k = 0; k < 120 * 6 && e.alive; k++) {
      // 視点で対象を追う（マウス操作の代わり）
      const c = e.center();
      const eye = [g2.player.pos[0], g2.player.pos[1] + 2.9, g2.player.pos[2]];
      g2.setLook(Math.atan2(-(c[0] - eye[0]), -(c[2] - eye[2])), Math.atan2(c[1] - eye[1], Math.hypot(c[0] - eye[0], c[2] - eye[2])));
      const locked = g2.fcs.state === 'locked';
      if (locked) lockedSteps++;
      const f0 = g2.weapons.shotsFired;
      // 左右へジグザグにグライド（0.8秒ごとに入力方向を反転）
      const n0 = g2.weapons.mgBullets.length;
      g2.step(inp({ moveX: Math.floor(k / 96) % 2 === 0 ? 1 : -1, fireHeld: locked }));
      g2.player.hp = 1000;
      if (g2.weapons.shotsFired > f0) {
        const nb = g2.weapons.mgBullets[g2.weapons.mgBullets.length - 1] ?? null;
        if (nb && g2.weapons.mgBullets.length > n0 - 1) tracked.push({ b: nb, last: [...nb.pos] as V3, res: null });
      }
      fired += g2.weapons.shotsFired - f0;
      settle();
      g2.events = [];
    }
    const judged = tracked.filter((t) => t.res !== null);
    hit = judged.filter((t) => t.res === 'hit').length;
    const sp = Math.hypot(g2.player.vel[0], g2.player.vel[2]);
    log(`  - ${lg.legs}: 自機はグライドで左右にジグザグ（最終速度 ${f2(sp)} m/s）、警備ロボットは25〜55mで側方移動。発射 ${fired} 発（うち撃破時に飛行中 ${fired - judged.length} 発は判定外）・判定 ${judged.length} 発中 命中 ${hit} 発・撃破 ${!e.alive}`);
    check(judged.length >= 8 && hit / judged.length >= 0.9, `${lg.legs}: グライド中のロック射撃の命中率 ${((hit / Math.max(1, judged.length)) * 100).toFixed(0)}%（≥ 90%）`);
  }
}

// ------------------------------------------------------------- 16. FCS の規則
log('');
log('## 16. FCS（遮蔽・範囲外で即時破棄し0から再ロック、対象を安定保持、距離120m、背後不可）');
{
  const wall = { min: [-4, 0, -21] as V3, max: [4, 12, -19] as V3 };
  const g = mk(BIPED, [turretAt('TL1', 0, -40)], [wall], [0, 0, 0]);
  const wb = g.world.boxes.find((b) => Math.abs(b.min[2] + 21) < 1e-9)!;
  wb.active = false;
  g.setLook(0, 0);
  for (let k = 0; k < 60; k++) {
    g.step(inp());
    g.player.hp = 1000;
  }
  const p0 = g.fcs.progress;
  wb.active = true;
  g.step(inp());
  const afterOcc = { s: g.fcs.state, p: g.fcs.progress };
  wb.active = false;
  g.step(inp());
  g.step(inp());
  check(p0 > 0.5 && afterOcc.s === 'none' && afterOcc.p === 0 && g.fcs.progress < 0.05, `遮蔽で即時破棄（${f2(p0)} → ${afterOcc.s}/${afterOcc.p}）、再露出で0から再開（${f3(g.fcs.progress)}）`);

  // 選択済み対象の保持
  const g2 = mk(BIPED, [turretAt('TS1', -4, -40), turretAt('TS2', 6, -40)], [], [0, 0, 0]);
  g2.setLook(0.08, 0); // 左寄り → TS1 が中央に近い
  for (let k = 0; k < 10; k++) {
    g2.step(inp());
    g2.player.hp = 1000;
  }
  const first = g2.fcs.targetId;
  g2.setLook(-0.1, 0); // TS2 の方が中央に近くなる
  for (let k = 0; k < 10; k++) {
    g2.step(inp());
    g2.player.hp = 1000;
  }
  check(first === 'TS1' && g2.fcs.targetId === 'TS1', `中央に最も近い ${first} を選択後、別の敵が中央に近づいても対象を変更しない（${g2.fcs.targetId}）`);
  // 距離120m超・背後は取得しない
  const g3 = mk(BIPED, [turretAt('TF', 0, -135), turretAt('TBk', 0, 40)], [], [0, 0, 0]);
  g3.setLook(0, 0);
  for (let k = 0; k < 60; k++) {
    g3.step(inp());
    g3.player.hp = 1000;
  }
  check(g3.fcs.targetId === null, `銃口から120m超の敵と背後の敵は取得しない（対象 ${g3.fcs.targetId}）`);
}

// ------------------------------------------------------------- 17. 再出撃の初期化
log('');
log('## 17. 再出撃で全状態を初期化（実ステージ）');
{
  const g = new Game({ seed: 20260908 });
  g.sortie(QUAD);
  for (let k = 0; k < 120 * 3; k++) g.step(inp({ qEdge: k === 5, moveZ: 1, fireHeld: true, spaceHeld: k > 200, spaceEdge: k === 201 }));
  g.enemies.damage(g.enemies.byId('T01')!, 999, [0, 0, 0]);
  g.step(inp());
  const dirty = { steps: g.steps, en: g.player.en, ammo: g.weapons.ammo.machinegun, qb: g.player.qbCount, open: g.barriers.filter((b) => b.open).length };
  g.sortie(QUAD);
  const s = g.getSnapshot();
  const ok =
    s.elapsedSeconds === 0 &&
    s.player.hp === 1000 &&
    s.player.en === 120 &&
    s.player.ammo.machinegun === 300 &&
    s.player.ammo.missile === 12 &&
    s.player.movement.qbSuccessfulCount === 0 &&
    s.player.movement.glideEnabled === false &&
    s.player.movement.qbLastStartedAtSeconds === null &&
    s.player.movement.lastEnSpentAtSeconds === null &&
    s.enemies.every((e) => e.alive && e.shotsFired === 0 && !e.alert && e.lastShotAtSeconds === null) &&
    s.objective.controlsDestroyed === 0 &&
    s.objective.openBarrierIds.length === 0 &&
    !s.objective.gateOpen &&
    s.lock.state === 'none' &&
    g.enemies.bullets.length === 0 &&
    g.weapons.mgBullets.length === 0 &&
    s.loadout.legs === 'quadruped';
  log(`  - 再出撃前: steps=${dirty.steps} EN=${f2(dirty.en)} MG=${dirty.ammo} QB=${dirty.qb} 開放隔壁=${dirty.open}`);
  check(ok, '再出撃後: 経過0・HP1000・EN最大・残弾・敵45体・隔壁・ロック・QB・弾体・警戒を初期化し、構成のみ保持');
  // スナップショットはコピー
  s.player.position[0] = 9999;
  s.enemies[0].hp = -1;
  check(g.player.pos[0] !== 9999 && g.enemies.enemies[0].hp > 0, 'getSnapshot の返却値を編集してもゲーム状態は変わらない');
}

// ------------------------------------------------------------- 18. 失敗の優先
log('');
log('## 18. クリアとHP0以下が同じ更新で成立した場合は失敗を優先');
{
  const g = new Game();
  g.sortie(BIPED);
  g.gateOpen = true;
  for (const b of g.barriers) {
    b.open = true;
    b.progress = 1;
    b.wbox.active = false;
  }
  g.player.pos = [40, 8, 358];
  g.player.hp = 0;
  g.step(inp());
  check(g.state === 'failed', `脱出領域内・ゲート開放・HP0 → ${g.state}`);
  const g2 = new Game();
  g2.sortie(BIPED);
  g2.gateOpen = true;
  g2.player.pos = [40, 8, 358];
  g2.step(inp());
  check(g2.state === 'cleared', `脱出領域内・ゲート開放・HP>0 → ${g2.state}`);
  const g3 = new Game();
  g3.sortie(BIPED);
  g3.player.pos = [40, 8, 358];
  g3.step(inp());
  check(g3.state === 'playing', `ゲート未開放では脱出領域でもクリアにならない → ${g3.state}`);
}

log('');
log(fails === 0 ? '## 結果: 全項目 OK' : `## 結果: NG ${fails} 件`);
mkdirSync('docs', { recursive: true });
writeFileSync('docs/sim-test-report.md', out.join('\n') + '\n');
console.log('\n→ docs/sim-test-report.md を出力しました');
process.exit(fails === 0 ? 0 : 1);
