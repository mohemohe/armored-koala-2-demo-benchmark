/**
 * UI ロジック (seed / 格納庫の実効値 / 操作説明 / 入力層)。DOM 不要の部分を実際の実装コードで検証する。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT, DEFAULT_SEED, FCS_PARTS, GENERATOR_PARTS, LEGS_PARTS } from '../src/config';
import { buildSnapshot } from '../src/sim/bench';
import { Game } from '../src/sim/game';
import { computeEffectiveStats } from '../src/sim/stats';
import { createArenaGame } from '../src/sim/testArena';
import { buildStage } from '../src/stage';
import { SNAPSHOT_SHAPE, checkShape, findNonFinite } from '../tools/snapshotShape';
import type { InputState, Loadout } from '../src/sim/types';
import { emptyInput } from '../src/sim/types';
import { helpSections } from '../src/ui/controlsHelp';
import { FCS_IDS, GENERATOR_IDS, LEGS_IDS, fcsCards, garageSummary, generatorCards, legsCards } from '../src/ui/garageLogic';
import { InputController, actionForCode, applyKeyDown, applyKeyUp, pendingReleases, releaseAllInput } from '../src/ui/input';
import { parseSeed } from '../src/ui/seed';
import { parseSeed as parseSeedSim } from '../src/sim/rng';

describe('parseSeed (SPEC §9: 32bit符号なし整数, 未指定は 20260908)', () => {
  it('未指定/空/不正は既定値', () => {
    expect(DEFAULT_SEED).toBe(20260908);
    for (const q of ['', '?', '?foo=1', '?seed=', '?seed=abc', '?seed=-1', '?seed=1.5', '?seed=1e3', '?seed=0x10', '?seed=4294967296', '?seed=99999999999999999999', '?seed= ']) {
      expect(parseSeed(q), q).toBe(DEFAULT_SEED);
    }
  });
  it('有効値', () => {
    expect(parseSeed('?seed=0')).toBe(0);
    expect(parseSeed('?seed=123')).toBe(123);
    expect(parseSeed('?seed=0042')).toBe(42);
    expect(parseSeed('?a=1&seed=4294967295')).toBe(4294967295);
    expect(parseSeed('seed=7')).toBe(7);
  });
  it('UI 側は sim/rng.ts の parseSeed を使う (二重実装なし)。どんな入力でも例外を投げず、結果は sim 側の解釈と一致する', () => {
    const src = readFileSync(new URL('../src/ui/seed.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/from '\.\.\/sim\/rng'/);
    expect(src).not.toMatch(/URLSearchParams|\/\^\[0-9\]|Number\(/); // 独自の解釈を持たない
    const inputs = ['', '?', '?seed=0', '?seed=123', '?seed=4294967295', '?seed=4294967296', '?seed=-5', '?seed=%', '?seed=%E0%A4%A', '?seed=%zz', '?seed=1%202', '?seed=%20%2042%20', '?a=1&seed=9&seed=10', '?seed=9#hash', '?xseed=3', '?seed', '?seed=٣'];
    for (const q of inputs) {
      expect(() => parseSeed(q), q).not.toThrow();
      let sim: number;
      try {
        sim = parseSeedSim(q, DEFAULT_SEED);
      } catch {
        sim = DEFAULT_SEED; // 不正な %XX (URIError) は UI 側で既定値にする
      }
      expect(parseSeed(q), q).toBe(sim);
      expect(Number.isInteger(parseSeed(q))).toBe(true);
      expect(parseSeed(q)).toBeGreaterThanOrEqual(0);
      expect(parseSeed(q)).toBeLessThanOrEqual(0xffffffff);
    }
    expect(parseSeed('?seed=%')).toBe(DEFAULT_SEED);
    expect(parseSeed('?seed=%20%2042%20')).toBe(42);
  });
});

describe('格納庫: 脚部補正適用後の実効値 (18構成)', () => {
  it('全18構成で computeEffectiveStats と config に一致', () => {
    let n = 0;
    for (const fcs of FCS_IDS)
      for (const generator of GENERATOR_IDS)
        for (const legs of LEGS_IDS) {
          const l: Loadout = { fcs, generator, legs };
          const s = garageSummary(l);
          const e = computeEffectiveStats(l);
          expect(s.maxEn).toBe(e.maxEn);
          expect(s.regenPerSecond).toBe(e.regenPerSecond);
          expect(s.lockSeconds).toBe(e.lockSeconds);
          expect(s.speedMult).toBe(e.horizontalSpeedMultiplier);
          expect(s.lockRadiusRatio).toBe(FCS_PARTS[fcs].radiusRatio);
          expect(s.speeds.walk).toBeCloseTo(10 * LEGS_PARTS[legs].speedMult, 12);
          expect(s.speeds.glide).toBeCloseTo(22 * LEGS_PARTS[legs].speedMult, 12);
          expect(s.speeds.air).toBeCloseTo(16 * LEGS_PARTS[legs].speedMult, 12);
          expect(s.speeds.qb).toBeCloseTo(80 * LEGS_PARTS[legs].speedMult, 12);
          expect(s.maxEn).toBe(GENERATOR_PARTS[generator].maxEn);
          n++;
        }
    expect(n).toBe(18);
  });
  it('SPEC §6 の例: 中範囲・均衡・4脚 = 最大EN120, 回復11.25, ロック約0.533秒', () => {
    const s = garageSummary({ fcs: 'medium', generator: 'balanced', legs: 'quadruped' });
    expect(s.maxEn).toBe(120);
    expect(s.regenPerSecond).toBeCloseTo(11.25, 12);
    expect(s.lockSeconds).toBeCloseTo(0.8 / 1.5, 12);
    expect(s.speeds).toMatchObject({ walk: 8, air: 12.8 });
    expect(s.speeds.glide).toBeCloseTo(17.6, 12);
    expect(s.speeds.qb).toBeCloseTo(64, 12);
    expect(s.legCount).toBe(4);
  });
  it('初期選択は 中範囲FCS / 均衡 / 2脚', () => {
    expect(DEFAULT_LOADOUT).toEqual({ fcs: 'medium', generator: 'balanced', legs: 'biped' });
    const s = garageSummary({ ...DEFAULT_LOADOUT });
    expect(s).toMatchObject({ fcsName: '中範囲FCS', generatorName: '均衡ジェネレーター', legsName: '2脚', maxEn: 120, regenPerSecond: 15, legCount: 2 });
  });
  it('カードは FCS3種・ジェネレーター3種・脚部2種で、長所と短所を持つ', () => {
    expect(fcsCards()).toHaveLength(3);
    expect(generatorCards()).toHaveLength(3);
    expect(legsCards()).toHaveLength(2);
    for (const c of [...fcsCards(), ...generatorCards(), ...legsCards()]) {
      expect(c.pros.length).toBeGreaterThan(0);
      expect(c.cons.length).toBeGreaterThan(0);
      expect(c.spec.length).toBeGreaterThan(0);
    }
  });
});

describe('操作説明の必須記述 (SPEC §8)', () => {
  const text = helpSections()
    .flatMap((s) => [s.title, ...s.rows.flatMap((r) => [r.key, r.desc]), ...(s.notes ?? [])])
    .join('\n');
  it.each([
    '対象をFCS円の中に保つだけで偏差と重力を自動補正する',
    '中央の照準を補正マーカーへ手動で合わせる必要はない',
    '単発',
    '36 EN',
    '自動でグライド',
    'グライドは0 EN',
    '左Ctrl',
    'Shift',
    '8 EN',
    '制御砲台6体',
    '最終ゲート',
    '10 m/s',
    '0.2秒',
    '20 EN/秒',
    'Esc',
    '1 / 2 / 3',
    '左クリック',
  ])('含む: %s', (phrase) => {
    expect(text).toContain(phrase);
  });
});

/** InputController を偽の EventTarget で駆動する (実際のキー/マウス処理コードを使う) */
function ev(type: string, props: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  return Object.assign(e, props);
}

function makeController(playing = true, locked = true) {
  const game = createArenaGame();
  const host = {
    playing,
    locked,
    looks: [] as [number, number][],
    escapes: 0,
  };
  const target = new EventTarget();
  const ctl = new InputController({
    input: game.input,
    isPlaying: () => host.playing,
    isLocked: () => host.locked,
    look: (dx, dy) => host.looks.push([dx, dy]),
    onEscape: () => host.escapes++,
  });
  ctl.attach(target as unknown as Window);
  return { game, host, target, ctl, input: game.input };
}

describe('入力層 (repeat 無視 / 全解除 / 射撃の抑止)', () => {
  it('キー割り当て: WASD, Space, Shift(左右), 左Ctrlのみ, Q, 1/2/3', () => {
    expect(actionForCode('KeyW')).toBe('forward');
    expect(actionForCode('KeyA')).toBe('left');
    expect(actionForCode('KeyS')).toBe('back');
    expect(actionForCode('KeyD')).toBe('right');
    expect(actionForCode('Space')).toBe('jump');
    expect(actionForCode('ShiftLeft')).toBe('shift');
    expect(actionForCode('ShiftRight')).toBe('shift');
    expect(actionForCode('ControlLeft')).toBe('ctrl');
    expect(actionForCode('ControlRight')).toBeNull();
    expect(actionForCode('KeyQ')).toBe('qb');
    expect(actionForCode('Digit1')).toBe('weapon1');
    expect(actionForCode('KeyE')).toBeNull();
  });

  it('レベル入力: keydown/keyup が game.input に反映される (押下が 1 tick 見られた後の keyup は即座に解除)', () => {
    const game = createArenaGame();
    const i = game.input;
    for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ControlLeft']) applyKeyDown(i, c, false);
    expect(i).toMatchObject({ forward: true, left: true, back: true, right: true, ctrl: true });
    game.step(); // sim が押下を見る
    for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ControlLeft']) applyKeyUp(i, c);
    expect(i).toMatchObject({ forward: false, left: false, back: false, right: false, ctrl: false });
    expect(applyKeyDown(i, 'Escape', false)).toBe(false);
  });

  it('Q / Shift / Space は repeat の keydown を無視 (QBがキーリピートで再発動しない)', () => {
    const game = createArenaGame();
    const i = game.input;
    // 初回の押下 -> true
    applyKeyDown(i, 'KeyQ', false);
    expect(i.qb).toBe(true);
    // 押したまま: sim がエッジ検出するので level は true のまま。keyup で false
    for (let k = 0; k < 30; k++) {
      applyKeyDown(i, 'KeyQ', true);
      game.step();
    }
    expect(i.qb).toBe(true);
    expect(game.state.player.mv.qbSuccessCount).toBe(1); // 押しっぱなし (repeat) でも1回だけ
    applyKeyUp(i, 'KeyQ');
    expect(i.qb).toBe(false);
    // 離した後に届いた repeat (例: 一時停止からの復帰) は押下として扱わない
    for (const c of ['KeyQ', 'ShiftLeft', 'Space']) {
      expect(applyKeyDown(i, c, true)).toBe(true); // 処理した(=preventDefaultする)が
    }
    expect(i).toMatchObject({ qb: false, shift: false, jump: false });
    // 再び非repeatで押せば有効
    applyKeyDown(i, 'KeyQ', false);
    expect(i.qb).toBe(true);
  });

  it('武器切り替えは一回限り (repeat は無視) で sim が消費する', () => {
    const game = createArenaGame();
    applyKeyDown(game.input, 'Digit2', false);
    expect(game.input.weaponSelect).toBe('beam');
    game.step(); // requestWeaponSwitch が消費
    expect(game.state.player.weapon).toBe('beam');
    expect(game.input.weaponSelect).toBeNull();
    applyKeyDown(game.input, 'Digit3', true);
    expect(game.input.weaponSelect).toBeNull();
  });

  it('game.pause() / resume() の後に Q の repeat が来ても新しい押下にならない', () => {
    const game = createArenaGame();
    const ctl = new InputController({ input: game.input, isPlaying: () => game.state.mode === 'playing', isLocked: () => true, look: () => {}, onEscape: () => {} });
    const target = new EventTarget();
    ctl.attach(target as unknown as Window);
    target.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: false }));
    target.dispatchEvent(ev('keydown', { code: 'KeyW', repeat: false }));
    expect(game.input.qb).toBe(true);
    expect(game.input.forward).toBe(true);
    game.pause();
    ctl.releaseAll();
    expect(game.input).toEqual(emptyInput());
    game.resume();
    expect(game.state.mode).toBe('playing');
    // Qを押し続けたまま復帰 -> repeat の keydown
    target.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: true }));
    target.dispatchEvent(ev('keydown', { code: 'KeyW', repeat: true })); // 移動はレベルなので復帰後に有効
    expect(game.input.qb).toBe(false);
    expect(game.input.forward).toBe(true);
    // 離して押し直せば新しい押下
    target.dispatchEvent(ev('keyup', { code: 'KeyQ' }));
    target.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: false }));
    expect(game.input.qb).toBe(true);
  });

  it('戦闘中でなければキーは無視、keyup は常に解除。既定動作は preventDefault', () => {
    const { target, input, host } = makeController(false);
    const d1 = ev('keydown', { code: 'Space', repeat: false });
    target.dispatchEvent(d1);
    expect(input.jump).toBe(false);
    expect(d1.defaultPrevented).toBe(false); // ボタンのSpace操作を妨げない
    host.playing = true;
    const d2 = ev('keydown', { code: 'Space', repeat: false });
    target.dispatchEvent(d2);
    expect(input.jump).toBe(true);
    expect(d2.defaultPrevented).toBe(true);
    const d3 = ev('keydown', { code: 'ControlLeft', repeat: false });
    target.dispatchEvent(d3);
    expect(d3.defaultPrevented).toBe(true);
    host.playing = false;
    target.dispatchEvent(ev('keyup', { code: 'Space' }));
    expect(input.jump).toBe(false);
  });

  it('Escape は戦闘中のみ onEscape を呼ぶ', () => {
    const { target, host } = makeController(true);
    target.dispatchEvent(ev('keydown', { code: 'Escape', repeat: false }));
    expect(host.escapes).toBe(1);
    host.playing = false;
    target.dispatchEvent(ev('keydown', { code: 'Escape', repeat: false }));
    expect(host.escapes).toBe(1);
  });

  it('マウス移動は戦闘中かつロック中のみ視点へ', () => {
    const { target, host } = makeController(true, true);
    target.dispatchEvent(ev('mousemove', { movementX: 12, movementY: -3 }));
    expect(host.looks).toEqual([[12, -3]]);
    host.locked = false;
    target.dispatchEvent(ev('mousemove', { movementX: 5, movementY: 5 }));
    host.locked = true;
    host.playing = false;
    target.dispatchEvent(ev('mousemove', { movementX: 5, movementY: 5 }));
    target.dispatchEvent(ev('mousemove', { movementX: Number.NaN, movementY: 1 }));
    expect(host.looks).toHaveLength(1);
  });

  it('射撃: ロック中のみ。出撃ボタンのクリック(ボタン押下中にロック取得)を射撃にしない', () => {
    const { target, ctl, input, host, game } = makeController(true, false);
    // ロックしていない状態のクリックは fire にならない
    target.dispatchEvent(ev('mousedown', { button: 0 }));
    expect(input.fire).toBe(false);
    target.dispatchEvent(ev('mouseup', { button: 0 }));
    // ボタンが押されたままロックを取得 (mousedown -> lock 取得 -> まだ押している)
    target.dispatchEvent(ev('mousedown', { button: 0 }));
    host.locked = true;
    ctl.onLockAcquired();
    // 押しっぱなしの間は fire 無効 (追加の mousedown が来ても)
    expect(input.fire).toBe(false);
    target.dispatchEvent(ev('mousedown', { button: 0 }));
    expect(input.fire).toBe(false);
    // 離してから押すと射撃
    target.dispatchEvent(ev('mouseup', { button: 0 }));
    expect(input.fire).toBe(false);
    target.dispatchEvent(ev('mousedown', { button: 0 }));
    expect(input.fire).toBe(true);
    game.step(); // sim が押下を見る
    target.dispatchEvent(ev('mouseup', { button: 0 }));
    expect(input.fire).toBe(false);
    // 右ボタンは無視
    target.dispatchEvent(ev('mousedown', { button: 2 }));
    expect(input.fire).toBe(false);
  });

  it('クリック完了後 (mouseup -> click -> ロック取得) は最初のクリックから射撃できる', () => {
    const { target, ctl, input, host } = makeController(true, false);
    target.dispatchEvent(ev('mousedown', { button: 0 }));
    target.dispatchEvent(ev('mouseup', { button: 0 }));
    host.locked = true;
    ctl.onLockAcquired(); // click ハンドラからのロック取得
    expect(input.fire).toBe(false); // ロック取得時の入力は全解除
    target.dispatchEvent(ev('mousedown', { button: 0 }));
    expect(input.fire).toBe(true);
  });

  it('attach は一度だけ (二重登録しない)。detach で全リスナー解除', () => {
    const game = createArenaGame();
    let looks = 0;
    const target = new EventTarget();
    const ctl = new InputController({ input: game.input, isPlaying: () => true, isLocked: () => true, look: () => looks++, onEscape: () => {} });
    ctl.attach(target as unknown as Window);
    ctl.attach(target as unknown as Window);
    ctl.attach(target as unknown as Window);
    expect(ctl.attached).toBe(true);
    target.dispatchEvent(ev('mousemove', { movementX: 1, movementY: 1 }));
    expect(looks).toBe(1);
    ctl.detach();
    expect(ctl.attached).toBe(false);
    target.dispatchEvent(ev('mousemove', { movementX: 1, movementY: 1 }));
    expect(looks).toBe(1);
    // 再出撃を繰り返しても (detach していなければ) 登録は増えない
    ctl.attach(target as unknown as Window);
    target.dispatchEvent(ev('mousemove', { movementX: 1, movementY: 1 }));
    expect(looks).toBe(2);
  });

  it('releaseAllInput は input オブジェクトを差し替えず全て解除', () => {
    const game = createArenaGame();
    const ref: InputState = game.input;
    applyKeyDown(ref, 'KeyW', false);
    applyKeyDown(ref, 'KeyQ', false);
    ref.fire = true;
    ref.weaponSelect = 'missile';
    releaseAllInput(ref);
    expect(game.input).toBe(ref);
    expect(ref).toEqual(emptyInput());
  });
});

describe('入力層: 次の tick の前に離されたキーを失わない (SPEC §7.2/§11 「Qを短く押して全キーを離しても」)', () => {
  const evCount = (g: Game, type: string): number => g.state.events.filter((e) => e.type === type).length;
  const press = (target: EventTarget, code: string): void => {
    target.dispatchEvent(ev('keydown', { code, repeat: false }));
    target.dispatchEvent(ev('keyup', { code }));
  };

  it('Q: keydown と keyup が同じフレーム内 (次の tick の前) でも QB が1回成立し、ENは36だけ減る。その後にレベルは落ちる', () => {
    const { game, target, input } = makeController();
    const en0 = game.state.player.en;
    press(target, 'KeyQ');
    expect(input.qb).toBe(true); // 保留: sim はまだ見ていない
    expect(pendingReleases(input)).toEqual(['qb']);
    game.step(); // tick 1: 押下を見る
    expect(game.state.player.mv.qbSuccessCount).toBe(1);
    expect(game.state.player.en).toBeCloseTo(en0 - 36, 9); // QB の分の 36 だけ (回復待ち 0.75 s 以内)
    expect(input.qb).toBe(true); // 見られた tick の間は true
    game.step(); // tick 2 の先頭で解放される
    expect(input.qb).toBe(false);
    expect(pendingReleases(input)).toEqual([]);
    for (let i = 0; i < 300; i++) game.step();
    expect(game.state.player.mv.qbSuccessCount).toBe(1); // 保留の解放で再発動しない
    expect(game.state.player.mv.qbLastStartedAt).toBe(0);
  });

  it('Q: 全キーを離しても噴射・慣性・自動グライドが続く (0.75秒で約42.6m)', () => {
    const { game, target } = makeController();
    press(target, 'KeyQ');
    const p0 = { ...game.state.player.pos };
    for (let i = 0; i < 90; i++) game.step(); // 0.75 s
    const p = game.state.player.pos;
    const d = Math.hypot(p.x - p0.x, p.z - p0.z);
    expect(d).toBeGreaterThan(42.6 - 1.2); // 1 tick 遅れの誤差程度
    expect(d).toBeLessThan(42.6 + 1.2);
    expect(game.state.player.mv.glideEnabled).toBe(true);
    expect(game.state.player.mv.qbSuccessCount).toBe(1);
  });

  it('Space: 短いタップ (押して離すのが次の tick の前) でもジャンプが1回起き、飛行 (長押し) にならない。遅いフレーム (0.25秒=30tick) でも同じ', () => {
    const { game, target } = makeController();
    press(target, 'Space');
    const en0 = game.state.player.en;
    expect(game.advance(0.25)).toBe(30);
    expect(evCount(game, 'jump')).toBe(1);
    expect(game.state.player.mv.verticalMode).not.toBe('flying');
    expect(game.state.player.mv.jumpHeldSeconds).toBeLessThan(0.05);
    expect(game.state.player.en).toBeCloseTo(en0, 9); // 飛行のENは使っていない
    expect(game.input.jump).toBe(false);
  });

  it('Shift: タップでグライドが1回だけ切り替わる (次の tick の前に離されても)', () => {
    const { game, target } = makeController();
    press(target, 'ShiftLeft');
    game.advance(1 / 60);
    expect(game.state.player.mv.glideEnabled).toBe(true);
    game.advance(0.5);
    expect(game.state.player.mv.glideEnabled).toBe(true); // 保留の解放で再度トグルされない
    press(target, 'ShiftLeft');
    game.advance(1 / 60);
    expect(game.state.player.mv.glideEnabled).toBe(false); // 2回目のタップは別の押下 (OFFに戻る)
  });

  it('左Ctrl: 次の tick の前に離されたブレーキも sim に見える (1 tick の間 QB 不成立)', () => {
    const { game, target, input } = makeController();
    press(target, 'ControlLeft');
    expect(input.ctrl).toBe(true);
    // Ctrl が見えている tick の Q は不成立 (ENも消費しない)
    target.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: false }));
    const en0 = game.state.player.en;
    game.step();
    expect(game.state.player.mv.qbSuccessCount).toBe(0);
    expect(game.state.player.en).toBeLessThanOrEqual(en0);
    target.dispatchEvent(ev('keyup', { code: 'KeyQ' }));
    game.step();
    expect(input.ctrl).toBe(false);
  });

  it('WASD: タップでも 1 tick は移動入力が見える', () => {
    const { game, target } = makeController();
    press(target, 'KeyW');
    game.step();
    expect(game.state.player.mv.desiredDir.x !== 0 || game.state.player.mv.desiredDir.z !== 0).toBe(true);
    game.step();
    expect(game.state.player.mv.desiredDir).toEqual({ x: 0, z: 0 });
  });

  it('射撃: クリックの押下と解放が次の tick の前でも1発は撃つ (ロック中のみ)', () => {
    const { game, target, host, input } = makeController(true, true);
    const ammo0 = game.state.player.ammo.machinegun;
    target.dispatchEvent(ev('mousedown', { button: 0 }));
    target.dispatchEvent(ev('mouseup', { button: 0 }));
    expect(input.fire).toBe(true); // 保留
    game.step();
    expect(game.state.player.ammo.machinegun).toBe(ammo0 - 1);
    game.step();
    expect(input.fire).toBe(false);
    for (let i = 0; i < 60; i++) game.step();
    expect(game.state.player.ammo.machinegun).toBe(ammo0 - 1); // 押し続けていないので連射にならない
    // ロックしていなければ押下自体が無効
    host.locked = false;
    target.dispatchEvent(ev('mousedown', { button: 0 }));
    target.dispatchEvent(ev('mouseup', { button: 0 }));
    expect(input.fire).toBe(false);
  });

  it('(a) 押し続けている間は通常のレベル入力のまま: tick が何回進んでも true。離せば (見られた後なので) 即座に false', () => {
    const { game, target, input } = makeController();
    target.dispatchEvent(ev('keydown', { code: 'KeyW', repeat: false }));
    for (let i = 0; i < 50; i++) {
      game.step();
      expect(input.forward).toBe(true);
    }
    target.dispatchEvent(ev('keyup', { code: 'KeyW' }));
    expect(input.forward).toBe(false);
    expect(pendingReleases(input)).toEqual([]);
  });

  it('(b) 全解除 (一時停止/ロック喪失/blur) は保留も即座に破棄する: 保留中のQは sim に見えず、後から発動しない', () => {
    const { game, target, ctl, input } = makeController();
    press(target, 'KeyQ');
    press(target, 'Space');
    expect(pendingReleases(input).sort()).toEqual(['jump', 'qb']);
    ctl.releaseAll();
    expect(input).toEqual(emptyInput());
    expect(pendingReleases(input)).toEqual([]);
    for (let i = 0; i < 30; i++) game.step();
    expect(game.state.player.mv.qbSuccessCount).toBe(0);
    expect(evCount(game, 'jump')).toBe(0);
    // game.pause() 経由 (Game 自身が input を解除) でも、保留の残りが復帰後に再発動しない
    press(target, 'KeyQ');
    game.pause();
    game.resume();
    for (let i = 0; i < 30; i++) game.step();
    expect(game.state.player.mv.qbSuccessCount).toBe(0);
    expect(input.qb).toBe(false);
  });

  it('(c) キーリピートでは再発動しない: 保留の解放後に届く repeat の keydown は無視される (Q / Shift / Space)', () => {
    const { game, target, input } = makeController();
    press(target, 'KeyQ');
    game.step();
    game.step();
    for (let i = 0; i < 200; i++) {
      target.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: true }));
      target.dispatchEvent(ev('keydown', { code: 'ShiftLeft', repeat: true }));
      target.dispatchEvent(ev('keydown', { code: 'Space', repeat: true }));
      game.step();
    }
    expect(input).toMatchObject({ qb: false, shift: false, jump: false });
    expect(game.state.player.mv.qbSuccessCount).toBe(1);
    expect(game.state.player.mv.glideEnabled).toBe(true); // QB後の自動グライドだけ (Shift のリピートで切り替わっていない)
  });

  it('(d) 保留中に同じキーの新しい keydown が来たら保留とマージ: 二重発動せず、押し続ければレベルは true のまま、離せば解放される', () => {
    const { game, target, input } = makeController();
    target.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: false }));
    target.dispatchEvent(ev('keyup', { code: 'KeyQ' }));
    target.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: false })); // 保留中の押し直し
    expect(pendingReleases(input)).toEqual([]); // 保留は取り消され、押し続けている状態
    for (let i = 0; i < 20; i++) game.step();
    expect(game.state.player.mv.qbSuccessCount).toBe(1);
    expect(input.qb).toBe(true); // まだ押している
    target.dispatchEvent(ev('keyup', { code: 'KeyQ' }));
    expect(input.qb).toBe(false); // 見られた後の解放は即時
    // 保留 -> マージ -> 保留のまま離す: 二重に発動せず、最後に解放される
    const g2 = makeController();
    for (let i = 0; i < 3; i++) {
      g2.target.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: false }));
      g2.target.dispatchEvent(ev('keyup', { code: 'KeyQ' }));
    }
    for (let i = 0; i < 400; i++) g2.game.step();
    expect(g2.game.state.player.mv.qbSuccessCount).toBe(1);
    expect(g2.input.qb).toBe(false);
  });

  it('アプリのフレームループ相当 (advance の戻り値 > 0 で afterAdvance): 0 tick のフレームでは保留を解放せず、1 tick 以上で解放する', () => {
    const { game, target, ctl, input } = makeController();
    press(target, 'KeyQ');
    let n = game.advance(0.001); // 1/120 秒に満たない: tick なし
    expect(n).toBe(0);
    ctl.afterAdvance(n);
    expect(input.qb).toBe(true); // まだ sim に見られていない
    expect(game.state.player.mv.qbSuccessCount).toBe(0);
    n = game.advance(0.008); // 累積 >= 1/120 で 1 tick
    expect(n).toBe(1);
    expect(game.state.player.mv.qbSuccessCount).toBe(1);
    ctl.afterAdvance(n);
    expect(input.qb).toBe(false);
    expect(pendingReleases(input)).toEqual([]);
  });

  it('一時停止中・戦闘中でない間に離されたキーは保留せず即座に解除 (tick が進まないので保留しても見られない)', () => {
    const { target, host, input } = makeController(true);
    target.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: false }));
    host.playing = false;
    target.dispatchEvent(ev('keyup', { code: 'KeyQ' }));
    expect(input.qb).toBe(false);
    expect(pendingReleases(input)).toEqual([]);
  });

  it('武器切替 (weaponSelect) は tick で消費されて null に戻り、Game.step が使う accessor と矛盾しない', () => {
    const { game, target, input } = makeController();
    target.dispatchEvent(ev('keydown', { code: 'Digit3', repeat: false }));
    expect(input.weaponSelect).toBe('missile');
    game.step();
    expect(game.state.player.weapon).toBe('missile');
    expect(input.weaponSelect).toBeNull();
    expect(JSON.parse(JSON.stringify(input))).toMatchObject({ weaponSelect: null, qb: false });
  });

  it('実ステージの Game でも (Q を毎フレームの合間にタップ): 1 回だけ成立し、リスナーは重複していない', () => {
    const g = new Game({ stage: buildStage(), viewportW: 1280, viewportH: 720 });
    g.sortie();
    const target = new EventTarget();
    const ctl = new InputController({ input: g.input, isPlaying: () => g.state.mode === 'playing', isLocked: () => true, look: () => {}, onEscape: () => {} });
    ctl.attach(target as unknown as Window);
    ctl.attach(target as unknown as Window);
    press(target, 'KeyQ');
    for (let f = 0; f < 60; f++) ctl.afterAdvance(g.advance(1 / 60));
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
    expect(g.state.time).toBeCloseTo(1, 9);
    ctl.detach();
  });
});

// ---------------------------------------------------------------------------
// index.html: インラインの data URI favicon (/favicon.ico の 404 を出さない)
// ---------------------------------------------------------------------------
describe('index.html の favicon', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const m = html.match(/<link[^>]*rel="icon"[^>]*href="([^"]+)"/s);
  it('rel="icon" が data URI で、外部ファイルを参照しない', () => {
    expect(m).not.toBeNull();
    const href = m![1];
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);
    expect(html).not.toMatch(/favicon\.ico/);
    // 外部URLを取得しない (data: 以外の http(s) の href/src がない)
    expect(html).not.toMatch(/(?:href|src)="https?:/);
  });
  it('data URI は有効な SVG (xmlns・viewBox を持つ) にデコードできる', () => {
    const svg = decodeURIComponent(m![1].slice('data:image/svg+xml,'.length));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"'.replace(/"/g, "'"));
    expect(svg).toContain('viewBox');
    expect(svg.endsWith('</svg>')).toBe(true);
    expect((svg.match(/</g) ?? []).length).toBe((svg.match(/>/g) ?? []).length);
  });
});

// ---------------------------------------------------------------------------
// window.AK2_BENCH.getSnapshot() の返却構造 (tools/e2e.ts がブラウザ実機で使うものと同じチェッカーを Node 上の buildSnapshot で検証)
// ---------------------------------------------------------------------------
describe('Snapshot の構造チェッカー (SPEC §10) と buildSnapshot の一致', () => {
  it('実ステージの Game: garage / playing / 射撃・移動後 / paused / failed の全てで構造が一致し、NaN/Infinity がない', () => {
    const g = new Game({ stage: buildStage(), viewportW: 1280, viewportH: 720 });
    expect(checkShape(buildSnapshot(g.state))).toEqual([]);
    g.sortie();
    expect(checkShape(buildSnapshot(g.state))).toEqual([]);
    g.input.forward = true;
    g.input.qb = true;
    g.input.fire = true;
    for (let i = 0; i < 240; i++) g.step();
    const playing = buildSnapshot(g.state);
    expect(checkShape(playing)).toEqual([]);
    expect(findNonFinite(playing)).toEqual([]);
    expect(playing.state).toBe('playing');
    expect(playing.recentPlayerShots.length).toBeGreaterThan(0);
    g.pause();
    expect(checkShape(buildSnapshot(g.state))).toEqual([]);
    expect(buildSnapshot(g.state).state).toBe('paused');
    g.resume();
    g.state.player.hp = 0;
    g.step();
    const failed = buildSnapshot(g.state);
    expect(failed.state).toBe('failed');
    expect(checkShape(failed)).toEqual([]);
    expect(failed.enemies).toHaveLength(45);
    expect(failed.stage.sectorCount).toBeGreaterThanOrEqual(15);
  });

  it('チェッカーは食い違いを検出する: キー欠落・余分なキー・型違い・列挙値違い・NaN・配列長違い・固定値違い', () => {
    const g = createArenaGame();
    const base = JSON.parse(JSON.stringify(buildSnapshot(g.state)));
    expect(checkShape(base)).toEqual([]);
    const mutate = (f: (s: any) => void): string[] => {
      const s = JSON.parse(JSON.stringify(base));
      f(s);
      return checkShape(s);
    };
    expect(mutate((s) => delete s.player.hp).join()).toContain('$.player.hp: missing key');
    expect(mutate((s) => (s.player.extra = 1)).join()).toContain('$.player.extra: unexpected key');
    expect(mutate((s) => (s.player.hp = '1000')).join()).toContain('expected number');
    expect(mutate((s) => (s.state = 'dead')).join()).toContain('$.state');
    expect(mutate((s) => (s.player.weapon = 'sword')).join()).toContain('$.player.weapon');
    expect(mutate((s) => (s.player.position = [1, 2])).join()).toContain('expected length 3');
    expect(mutate((s) => (s.version = 'x')).join()).toContain('$.version');
    expect(mutate((s) => (s.stage.totalEnemies = 44)).join()).toContain('$.stage.totalEnemies');
    expect(mutate((s) => (s.objective.controlsRequired = 5)).join()).toContain('controlsRequired');
    expect(mutate((s) => (s.player.en = Number.NaN)).join()).toContain('non-finite');
    expect(mutate((s) => (s.player.velocity[1] = Number.POSITIVE_INFINITY)).join()).toContain('non-finite');
    expect(mutate((s) => (s.lock.targetId = 5)).join()).toContain('$.lock.targetId');
    expect(mutate((s) => (s.player.movement.qbLastStartedAtSeconds = null)).join()).toBe(''); // null 可のフィールド
    expect(mutate((s) => (s.fireControl.aimPoint = [0, 0, 0])).join()).toBe('');
    expect(mutate((s) => (s.recentPlayerShots = new Array(33).fill(0))).join()).toContain('exceeds 32');
    expect(findNonFinite({ a: [1, Number.NaN], b: { c: Number.NEGATIVE_INFINITY } })).toEqual(['$.a[1]=NaN', '$.b.c=-Infinity']);
    expect(SNAPSHOT_SHAPE.t).toBe('obj');
  });

  it('返却値はコピー: 書き換えても次のスナップショット (=ゲーム状態) は変わらない', () => {
    const g = new Game({ stage: buildStage(), viewportW: 1280, viewportH: 720 });
    g.sortie();
    for (let i = 0; i < 30; i++) g.step();
    const a = buildSnapshot(g.state);
    const before = JSON.stringify(a);
    a.player.hp = -1;
    a.player.position[0] = 1e9;
    a.enemies.pop();
    a.objective.openBarrierIds.push('B1');
    a.stage.visitedSectorIds.length = 0;
    expect(JSON.stringify(buildSnapshot(g.state))).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 起動時の表示 (読み込み中) と、描画の準備を最初の 1 フレームの後へ回す構造 (静的確認)。実挙動は tools/startup-bench.ts
// ---------------------------------------------------------------------------
describe('起動: 読み込み中の表示と描画の遅延生成', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/ui/app.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('index.html に「読み込み中」の DOM (#boot-loading) があり、クリックを塞がない (pointer-events: none)', () => {
    expect(html).toMatch(/<div id="boot-loading"[^>]*>[\s\S]*読み込み中[\s\S]*<\/div>/);
    expect(css).toMatch(/\.boot-loading\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.boot-loading\s*\{[^}]*position:\s*fixed/);
  });

  it('WebGL の初期化 (new GameRenderer) はコンストラクターではなく ensureRenderer() だけで行い、最初のフレームの後のタスクで呼ぶ', () => {
    expect(app.match(/new GameRenderer\(/g)?.length).toBe(1);
    const ctorStart = app.indexOf('constructor(');
    const ensureStart = app.indexOf('private ensureRenderer()');
    expect(ctorStart).toBeGreaterThan(0);
    expect(ensureStart).toBeGreaterThan(ctorStart);
    const ctorBody = app.slice(ctorStart, app.indexOf('  }\n', ctorStart));
    expect(ctorBody).not.toMatch(/GameRenderer|ensureRenderer|setStage/);
    expect(app.slice(ensureStart, ensureStart + 900)).toMatch(/new GameRenderer\(this\.canvas\)/);
    // frame() は描画が無い間は setTimeout で ensureRenderer を呼ぶ (rAF は増やさない)
    expect(app).toMatch(/this\.renderTimer = window\.setTimeout\(\(\) => \{[\s\S]*this\.ensureRenderer\(\)/);
    // 出撃・再出撃・格納庫へ戻る経路は、描画が未作成でも同期的に作る
    expect(app.match(/this\.ensureRenderer\(\)\.(showGame|showHangar)/g)?.length).toBe(3);
    // 格納庫の最初の 1 枚が出たら「読み込み中」を消す
    expect(app).toMatch(/getElementById\('boot-loading'\)\?\.remove\(\)/);
  });

  it('ステージの 3D は格納庫の表示後に作る (setStage(stage, false) → compileStage())。GameRenderer.setStage は既定では従来どおり作ってコンパイルする', () => {
    expect(app).toMatch(/r\.setStage\(this\.game\.state\.stage, false\)/);
    expect(app).toMatch(/r\.compileStage\(\)/);
    const r = readFileSync(new URL('../src/render/renderer.ts', import.meta.url), 'utf8');
    expect(r).toMatch(/setStage\(stage: StageDef, compile = true\): void/);
    expect(r).toMatch(/compileStage\(\): void/);
  });
});

describe('格納庫のレイアウト (静的確認): パネル幅を画面幅でも上限にして、5:4 / 4:3 でも頭部を覆わない', () => {
  const css = readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8');
  const m = /\.garage\s*\{[^}]*grid-template-columns:\s*([^;]+);/.exec(css);
  it('左右の列は minmax(18em, min(30em, 28.7vw)) (16:9 では 30em と 28.7vw が同じ値なので従来と変わらない)', () => {
    expect(m).not.toBeNull();
    const cols = m![1].replace(/\s+/g, ' ').trim();
    expect(cols).toBe('minmax(18em, min(30em, 28.7vw)) minmax(0, 1fr) minmax(18em, min(30em, 28.7vw))');
  });
  it('16:9 の各サイズで 30em (= 51vmin) と 28.7vw は同じ (誤差 0.5% 以内)。5:4 (1280x1024) では 28.7vw が 30em より小さい', () => {
    const u = (w: number, h: number): number => Math.min(32, Math.max(12, 0.017 * Math.min(w, h)));
    for (const [w, h] of [[1280, 720], [1600, 900], [1920, 1080], [2560, 1440]] as const) {
      expect(Math.abs(30 * u(w, h) - 0.287 * w) / (0.287 * w), `${w}x${h}`).toBeLessThan(0.005);
    }
    expect(0.287 * 1280).toBeLessThan(30 * u(1280, 1024));
    expect(0.287 * 1600).toBeLessThan(30 * u(1600, 1200));
  });
});
