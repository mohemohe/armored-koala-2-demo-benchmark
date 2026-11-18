/**
 * キーボード/マウス入力 -> game.input (レベル入力)。エッジ検出は sim 側。
 * - Q / Shift / Space は event.repeat の keydown を無視 (QBがキーリピートで再発動しない)
 * - 出撃/再開のクリックを射撃にしない (ロック取得時にボタンが押されていたら、離されるまで fire 無効)
 * - リスナーは attach() で一度だけ登録 (再出撃で増えない)
 * - 「次の tick の前に離されたキー」を失わない (SPEC §7.2/§11 「Qを短く押して全キーを離しても、噴射・慣性・自動グライドが続く」):
 *   Game.input はレベル入力で、sim は tick ごとにしか見ない。keydown と keyup が同じフレーム内 (次の tick の前) に来ると、
 *   レベルが true→false と変わったことを sim が一度も見られず、QB/ジャンプ/グライド切替/射撃/ブレーキが失われる。
 *   そこで keyup を受けたとき、そのキーの押下をまだ 1 tick も見られていなければ、レベルを true のまま保留して
 *   「1 tick 見られた後」に解放する。
 *     (a) 押し続けている間は通常のレベル入力のまま
 *     (b) 一時停止/ポインターロック喪失/blur などの releaseAll は全入力を即座に解除し、保留も破棄する
 *     (c) キーリピートで再発動しない性質 (edge キーの repeat keydown 無視) は変わらない
 *     (d) 保留中に同じキーの新しい keydown が来たら保留とマージする (二重発動しない)
 *
 * tick の境界の知り方: game.ts は凍結で「tick 完了」を通知しないが、Game.step() は毎 tick の先頭 (A1: requestWeaponSwitch) で
 * 必ず `state.input.weaponSelect = null` を書く (docs/ARCH.md §4)。この input オブジェクトの weaponSelect だけを accessor にして、
 * その書き込みを「tick が始まった」合図 (ハートビート) として数える。したがって Game を純粋に step()/advance() で回すテストでも、
 * アプリのフレームループがなくても保留は正しく解放される。フレームループは advance() の戻り値 (tick 数) > 0 のとき
 * afterAdvance() を呼び、同じ解放を確実にする (ハートビートが使えない場合の保険。両者は同じ規則で冪等)。
 */
import { emptyInput } from '../sim/types';
import type { InputState, WeaponId } from '../sim/types';

export type KeyAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'shift'
  | 'ctrl'
  | 'qb'
  | 'weapon1'
  | 'weapon2'
  | 'weapon3'
  | 'escape';

/** game.input のレベル (boolean) 入力 */
export type LevelKey = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'shift' | 'ctrl' | 'qb' | 'fire';

const LEVEL_KEYS: readonly LevelKey[] = ['forward', 'back', 'left', 'right', 'jump', 'shift', 'ctrl', 'qb', 'fire'];

const CODE_TO_ACTION: Readonly<Record<string, KeyAction>> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'jump',
  ShiftLeft: 'shift',
  ShiftRight: 'shift',
  ControlLeft: 'ctrl',
  KeyQ: 'qb',
  Digit1: 'weapon1',
  Digit2: 'weapon2',
  Digit3: 'weapon3',
  Escape: 'escape',
};

const WEAPON_OF: Record<'weapon1' | 'weapon2' | 'weapon3', WeaponId> = {
  weapon1: 'machinegun',
  weapon2: 'beam',
  weapon3: 'missile',
};

/** 戦闘中にブラウザ既定動作(スクロール・フォーカス移動)を抑止するキー */
const BLOCK_DEFAULT = new Set(['Space', 'ControlLeft', 'ShiftLeft', 'ShiftRight', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ']);

export function actionForCode(code: string): KeyAction | null {
  return CODE_TO_ACTION[code] ?? null;
}

/** 一度押して押し続けるとキーリピートが来るエッジ系のキー */
const EDGE_ACTIONS: ReadonlySet<KeyAction> = new Set<KeyAction>(['qb', 'shift', 'jump']);

const isLevelAction = (a: KeyAction): a is Exclude<LevelKey, 'fire'> =>
  a === 'forward' || a === 'back' || a === 'left' || a === 'right' || a === 'jump' || a === 'shift' || a === 'ctrl' || a === 'qb';

// ---------------------------------------------------------------------------
// 押下の保留 (レベルを最低 1 tick は sim に見せる)
// ---------------------------------------------------------------------------
interface Hold {
  /** 押下時点で完了していた tick 数。これより多くの tick が完了して初めて「見られた」 */
  pressTick: number;
  /** keyup を受けたが、まだ見られていないためレベルを保留している */
  releaseRequested: boolean;
}

interface Latch {
  /** Game.step() の先頭で weaponSelect=null が書かれた回数 (= 開始した tick 数) */
  ticks: number;
  holds: Partial<Record<LevelKey, Hold>>;
  /** weaponSelect の実際の値 (accessor の裏側) */
  weapon: WeaponId | null;
}

const latches = new WeakMap<InputState, Latch>();

/** input のラッチを取得 (初回に weaponSelect を tick ハートビート付きの accessor にする) */
function latchOf(input: InputState): Latch {
  const found = latches.get(input);
  if (found) return found;
  const latch: Latch = { ticks: 0, holds: {}, weapon: input.weaponSelect };
  Object.defineProperty(input, 'weaponSelect', {
    configurable: true,
    enumerable: true,
    get: (): WeaponId | null => latch.weapon,
    set: (v: WeaponId | null): void => {
      latch.weapon = v;
      // sim が武器切替要求を消費する (null を書く) のは毎 tick の先頭。ここから tick M が始まる = M-1 tick が完了している
      if (v === null) {
        latch.ticks++;
        settle(input, latch, true);
      }
    },
  });
  latches.set(input, latch);
  return latch;
}

/** 解放待ちで、かつ 1 tick 以上 sim に見られたレベルを false に戻す。inTick: tick の先頭 (その tick はまだ完了していない) から呼ばれた */
function settle(input: InputState, latch: Latch, inTick: boolean): void {
  const done = inTick ? latch.ticks - 1 : latch.ticks;
  for (const k of LEVEL_KEYS) {
    const h = latch.holds[k];
    if (h && h.releaseRequested && done > h.pressTick) {
      input[k] = false;
      delete latch.holds[k];
    }
  }
}

/** レベル入力を押下として立てる。保留中の同じ入力があれば保留とマージする (二重発動しない) */
export function pressLevel(input: InputState, key: LevelKey): void {
  const latch = latchOf(input);
  settle(input, latch, false);
  const h = latch.holds[key];
  if (input[key] && h) {
    h.releaseRequested = false; // 押し直し: 保留とマージ
    return;
  }
  input[key] = true;
  latch.holds[key] = { pressTick: latch.ticks, releaseRequested: false };
}

/**
 * レベル入力を解放する。押下を 1 tick も見られていなければ、見られるまでレベルを true のまま保留する。
 * immediate: 戦闘中でない (tick が進まない) ときなど、保留しても見られる見込みがなく true が残るだけの場合の即時解放
 */
export function releaseLevel(input: InputState, key: LevelKey, immediate = false): void {
  const latch = latchOf(input);
  const h = latch.holds[key];
  if (!immediate && h && input[key] && latch.ticks <= h.pressTick) {
    h.releaseRequested = true;
    return;
  }
  input[key] = false;
  delete latch.holds[key];
}

/** 保留を、見られていれば解放する (フレームループから advance() の後に呼ぶ) */
export function settleInput(input: InputState): void {
  const latch = latches.get(input);
  if (latch) settle(input, latch, false);
}

/** 解放待ちで保留中のレベル (テスト・診断用) */
export function pendingReleases(input: InputState): LevelKey[] {
  const latch = latches.get(input);
  if (!latch) return [];
  return LEVEL_KEYS.filter((k) => latch.holds[k]?.releaseRequested === true && input[k]);
}

/** keydown を input に反映。処理した(=ゲームが扱うキー)なら true。Escape はここでは扱わない(false)。 */
export function applyKeyDown(input: InputState, code: string, repeat: boolean): boolean {
  const a = actionForCode(code);
  if (a === null || a === 'escape') return false;
  if (EDGE_ACTIONS.has(a) && repeat) return true; // 押しっぱなしのキーリピートは新しい押下ではない
  if (isLevelAction(a)) {
    pressLevel(input, a);
  } else if (!repeat) {
    input.weaponSelect = WEAPON_OF[a];
  }
  return true;
}

export function applyKeyUp(input: InputState, code: string, immediate = false): boolean {
  const a = actionForCode(code);
  if (a === null || a === 'escape') return false;
  if (isLevelAction(a)) releaseLevel(input, a, immediate);
  return true;
}

/** 全入力を即座に解除し、保留も破棄する (stable な input オブジェクトを書き換える。差し替えない) */
export function releaseAllInput(input: InputState): void {
  const latch = latches.get(input);
  if (latch) latch.holds = {};
  Object.assign(input, emptyInput());
}

export interface InputHost {
  /** game.input (安定オブジェクト) */
  readonly input: InputState;
  /** 戦闘中(mode==='playing')か */
  isPlaying(): boolean;
  /** canvas がポインターロック中か */
  isLocked(): boolean;
  look(dx: number, dy: number): void;
  /** 戦闘中に Escape の keydown が届いたとき (通常はポインターロック解除が先に起きる) */
  onEscape(): void;
}

export class InputController {
  private ac: AbortController | null = null;
  /** マウス左ボタンが物理的に押されているか (ロック中かどうかに関係なく追跡) */
  private mouseDown = false;
  /** false の間は左ボタンを fire にしない */
  private fireArmed = true;

  constructor(private host: InputHost) {}

  get attached(): boolean {
    return this.ac !== null;
  }

  /** イベントリスナーを一度だけ登録 (二重呼び出しは無視) */
  attach(target: Window = window): void {
    if (this.ac) return;
    const ac = new AbortController();
    this.ac = ac;
    const opt = { capture: true, signal: ac.signal } as const;
    target.addEventListener('keydown', (e) => this.onKeyDown(e), opt);
    target.addEventListener('keyup', (e) => this.onKeyUp(e), opt);
    target.addEventListener('mousedown', (e) => this.onMouseDown(e), opt);
    target.addEventListener('mouseup', (e) => this.onMouseUp(e), opt);
    target.addEventListener('mousemove', (e) => this.onMouseMove(e), opt);
    target.addEventListener('contextmenu', (e) => this.onContextMenu(e), opt);
    target.addEventListener('blur', () => this.onBlur(), opt);
  }

  detach(): void {
    this.ac?.abort();
    this.ac = null;
  }

  /** 一時停止/ロック喪失/フォーカス喪失時: 全入力を即座に解除 (保留中の押下も破棄) */
  releaseAll(): void {
    releaseAllInput(this.host.input);
  }

  /**
   * フレームループから game.advance() の直後に呼ぶ。tick が 1 つ以上実行された (ticks > 0) なら、
   * 押下を見られた保留中のレベルを解放する。ticks = 0 のフレームでは何もしない (まだ sim に見られていない)。
   */
  afterAdvance(ticks: number): void {
    if (ticks > 0) settleInput(this.host.input);
  }

  /** ポインターロック取得直後: 入力をクリアし、ボタンが押されたままなら離されるまで射撃しない */
  onLockAcquired(): void {
    this.releaseAll();
    this.fireArmed = !this.mouseDown;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.host.isPlaying()) return;
    if (e.code === 'Escape') {
      this.host.onEscape();
      return;
    }
    const handled = applyKeyDown(this.host.input, e.code, e.repeat);
    if (handled || BLOCK_DEFAULT.has(e.code)) e.preventDefault();
  }

  private onKeyUp(e: KeyboardEvent): void {
    // 解放は常に反映 (どのモードでも入力が残らないように)。1 tick も見られていない押下だけは見られるまで保留される
    const handled = applyKeyUp(this.host.input, e.code, !this.host.isPlaying());
    if (handled && this.host.isPlaying() && BLOCK_DEFAULT.has(e.code)) e.preventDefault();
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    this.mouseDown = true;
    if (this.host.isPlaying() && this.host.isLocked()) {
      e.preventDefault();
      if (this.fireArmed) pressLevel(this.host.input, 'fire');
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button !== 0) return;
    this.mouseDown = false;
    this.fireArmed = true;
    releaseLevel(this.host.input, 'fire', !this.host.isPlaying());
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.host.isPlaying() || !this.host.isLocked()) return;
    const dx = e.movementX;
    const dy = e.movementY;
    if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) this.host.look(dx, dy);
  }

  private onContextMenu(e: MouseEvent): void {
    if (this.host.isPlaying()) e.preventDefault();
  }

  private onBlur(): void {
    this.mouseDown = false;
  }
}
