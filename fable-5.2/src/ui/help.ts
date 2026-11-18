/**
 * Controls help (操作方法) — docs/SPEC.md §7.1 (key table) and §8 (statements that must be explicit).
 *
 * `controlsHelpHtml()` returns a static HTML fragment that the garage (before the sortie) and the pause
 * menu both embed. Every number in it is read from `src/config.ts`; nothing here is a private copy.
 * The fragment is built only from constants (no user input), so assigning it to `innerHTML` is safe.
 *
 * This module has no side effects and touches the DOM only inside the helper functions at the bottom
 * (shared by garage.ts and menus.ts), so `controlsHelpHtml()` can be checked in a Node unit test.
 */
import {
  CONTROLS_REQUIRED,
  FCS_PARTS,
  FCS_RANGE,
  GENERATOR_PARTS,
  LEGS_PARTS,
  PLAYER,
  TOTAL_ENEMIES,
  WEAPONS,
  WEAPON_ORDER,
} from '../config';
import type { Loadout } from '../sim/types';

const f2 = (v: number): string => v.toFixed(2);
const k = (...keys: string[]): string => keys.map((key) => `<kbd>${key}</kbd>`).join('');

/** One row of the §7.1 table. */
function row(action: string, input: string, behaviour: string, en: string): string {
  return `<tr><th scope="row">${action}</th><td class="help-in">${input}</td><td>${behaviour}</td><td class="help-en">${en}</td></tr>`;
}

/**
 * HTML fragment (key table + notes) used by the garage and the pause menu.
 * Root element: `<div class="ak2-help">` (styled by src/ui/ui.css).
 */
export function controlsHelpHtml(): string {
  const P = PLAYER;
  const beam = WEAPONS.beam;
  const quad = LEGS_PARTS.quadruped;
  const weaponNames = WEAPON_ORDER.map((w) => WEAPONS[w].label).join(' / ');

  const lead = `
<div class="help-lead">
  <div class="help-lead-h"><span class="en">KEY POINTS</span>まず覚える 5 項目</div>
  <ol>
    <li><b>${k('Q')} は単発入力</b>で、発動時に <b>${P.qbCost} EN を一括消費</b>します（長押しでは連続発動しません）。</li>
    <li><b>QB 後は自動でグライドへ移行</b>します。キーを離しても滑走を続けます。</li>
    <li><b>グライドの EN 消費は 0</b> です（EN が 0 でも使用でき、接地中は EN 回復も妨げません）。</li>
    <li><b>停止するには ${k('左Ctrl')}（ブレーキ）</b>を押すか、<b>${k('Shift')} でグライドを解除</b>します。</li>
    <li>射撃は<b>対象を FCS 領域（中央の円）内に保つだけ</b>。ロック完了後は偏差と重力落下を FCS が自動補正します。</li>
  </ol>
</div>`;

  const table = `
<table class="help-keys">
  <caption>キー割り当て<span class="help-cap-note">数値は 2脚での基準値（${quad.label}は水平速度 ×${f2(quad.speedMult)}）</span></caption>
  <thead><tr><th scope="col">操作</th><th scope="col">入力</th><th scope="col">挙動</th><th scope="col">EN消費</th></tr></thead>
  <tbody>
    ${row('通常移動', k('W', 'A', 'S', 'D'), `${P.walkSpeed} m/s。カメラの水平方向が基準`, '0')}
    ${row('視点・照準', 'マウス移動', 'TPSカメラの旋回', '0')}
    ${row('ジャンプ', `接地中に ${k('Space')} を押す`, `上向き初速 ${P.jumpSpeed} m/s`, '0')}
    ${row('グライドの手動切り替え', `${k('Shift')} を1回押す`, `地上 ${P.glideSpeed} m/s。押し続ける必要はない`, '0')}
    ${row('ブレーキ', `${k('左Ctrl')} を押す`, 'グライド解除と慣性を伴う減速', '0')}
    ${row('飛行', `${k('Space')} を ${f2(P.flyHoldSeconds)} 秒以上長押し`, `空中水平移動 ${P.airSpeed} m/s、上昇速度 ${P.flyClimbSpeed} m/s`, `${P.flyEnPerSecond} EN/秒`)}
    ${row('QB（クイックブースト）', `${k('Q')} を1回押す`, `初速 ${P.qbSpeed} m/s、噴射 ${f2(P.qbImpulseSeconds)} 秒、その後自動グライド`, `発動時に ${P.qbCost} EN を1回だけ`)}
    ${row('射撃', 'マウス左ボタン', '押している間、武器の射撃間隔で発射', `武器による（ビームは 1 射 ${beam.enCost} EN）`)}
    ${row('武器切り替え', `${k('1')} / ${k('2')} / ${k('3')}`, weaponNames, '0')}
    ${row('一時停止', k('Esc'), 'ポインターロック解除と一時停止', '0')}
    ${row('音声の ON / OFF', k('M'), '効果音のミュートを切り替え（どの画面でも有効）', '—')}
  </tbody>
</table>`;

  const sec = (title: string, en: string, items: string[]): string =>
    `<section class="help-sec"><h3><span class="en">${en}</span>${title}</h3><ul>${items.join('')}</ul></section>`;
  /** Mandatory statement (highlighted with a marker and bold text, not by colour alone). */
  const key = (html: string): string => `<li class="key"><span class="help-mark" aria-hidden="true">要点</span>${html}</li>`;
  const li = (html: string): string => `<li>${html}</li>`;

  const sections = [
    sec('クイックブースト（QB）', 'QUICK BOOST', [
      key(`${k('Q')} は単発入力で、発動時に ${P.qbCost} EN を一括消費します（長押しでは連続発動しません。再発動には Q を離して押し直します）。`),
      key('QB 後は自動でグライドへ移行します。WASD も Shift も押さなくても、速度を引き継いで移動を続けます。'),
      li(`再使用は前回の発動から ${f2(P.qbCooldownSeconds)} 秒後。EN が ${P.qbCost} 未満のとき、またはブレーキ（左Ctrl）中は発動せず、EN も消費しません（予約もされません）。`),
      li('方向は発動時の WASD（無入力ならカメラの水平前方）。地上でも空中でも使用できます。'),
    ]),
    sec('グライドと停止', 'GLIDE / BRAKE', [
      key('グライドの EN 消費は 0 です（EN が 0 でも使用でき、接地中は EN 回復も妨げません）。'),
      key(`停止するには ${k('左Ctrl')}（ブレーキ）を押すか、${k('Shift')} でグライドを解除します。`),
      li('グライド中は入力を離しても最後の移動方向へ進み続けます。WASD で進行方向を変えられます（視点を回すだけでは変わりません）。'),
      li(`${k('Shift')} は押すたびに ON / OFF が切り替わります（押し続ける必要はありません）。`),
    ]),
    sec('ジャンプと飛行', 'JUMP / FLIGHT', [
      key(`飛行は ${k('Space')} を ${f2(P.flyHoldSeconds)} 秒以上長押し（${P.flyEnPerSecond} EN/秒）。短く押して離すと通常ジャンプです。`),
      li(
        `地上で ${k('Space')} を押すとまずジャンプし（上向き ${P.jumpSpeed} m/s）、そのまま押し続けると ${f2(P.flyHoldSeconds)} 秒後から上昇速度 ${P.flyClimbSpeed} m/s の飛行に移ります。` +
          `空中で押し直した場合も、押してから ${f2(P.flyHoldSeconds)} 秒後に飛行へ移ります（空中でジャンプは出ません）。`,
      ),
      li(`${k('Space')} を離すか EN が尽きると、その時の上下速度を引き継いで落下します。`),
      li(`地上から飛び立つには新しい押下が必要です。EN 切れで着地したあとは、${k('Space')} を押したままでも機体は浮き上がりません。いったん離して押し直してください。`),
      li(`ただし ${k('Space')} を押したまま足場の端から外へ出た場合は、空中に出た時点で（押し直さなくても）飛行に移ります。`),
      li('高い足場へは飛行で上がります。空中では EN は回復しないので、足場に接地して回復してください。'),
    ]),
    sec('EN（エネルギー）', 'ENERGY', [
      li(`EN を消費するのは QB（${P.qbCost} EN）・飛行（${P.flyEnPerSecond} EN/秒）・ビーム（1 射 ${beam.enCost} EN）だけです。`),
      li(`EN は接地中、最後の消費から ${f2(P.enRegenDelaySeconds)} 秒後に回復を始めます。歩行・グライド・マシンガン・ミサイルは回復を妨げません。`),
      li('HP の自然回復、弾薬の補給はありません。'),
    ]),
    sec('FCS（ロックと射撃補正）', 'FIRE CONTROL', [
      key('対象を FCS 領域（中央の円）内に保てばロックが進み、ロック完了後は偏差（移動予測）と重力落下を自動補正します。中央照準を補正マーカーへ手動で合わせる必要はありません。'),
      li(`ロックは自動で進みます（ボタン操作なし、射程 ${FCS_RANGE} m）。対象が円の外へ出る・遮蔽される・破壊されると解除され、次の対象は 0 からやり直しです。`),
      li('ロック完了後に表示される補正マーカーは、FCS が実際に撃ち出す方向を示す表示です（「補正解なし」のときは対象の現在位置へ直接撃ちます）。'),
      li('未ロックでも、マシンガンとビームは画面中央の照準点へ自由射撃できます（自動補正なし）。'),
      key('ミサイルはロック完了時のみ発射可能です（未ロックでは発射されず、弾数も減りません）。'),
      key(`ビームは 1 射 ${beam.enCost} EN を消費します（弾数制限なし。EN が ${beam.enCost} 未満では発射できません）。`),
    ]),
    sec('目標とクリア条件', 'OBJECTIVE', [
      key(`制御砲台 ${CONTROLS_REQUIRED} 基をすべて破壊すると最終搬出ゲートが開きます。その先の脱出領域に入るとクリアです。`),
      li(`制御砲台を 1 基破壊するたびに対応する隔壁が開き、次の区間へ進めます。敵は全 ${TOTAL_ENEMIES} 体ですが、全滅させる必要はありません。`),
      li(`HP（最大 ${P.maxHp}）が 0 になるか、ステージ外へ落下すると失敗です。`),
    ]),
    sec('進路と目標のマーカー', 'ROUTE / OBJECTIVE', [
      key('「目標」マーカー（中に点のある逆三角形のピン）は、次に破壊する制御砲台の位置です。「進路」マーカー（線だけの二重の山形）は、そこへ向かう推奨経路の「次に向かう地点」です。'),
      li(`目標マーカーには「目標 T01」のように砲台の名前と距離が付きます。制御砲台 ${CONTROLS_REQUIRED} 基をすべて破壊すると「脱出 EXIT」に変わり、脱出領域を指します。`),
      li(
        '進路マーカーの文字の意味: 「進路 NEXT」= その地点へ進む ／ 「▲ 飛行 FLY +n m」= n m 上へ飛行で上がる ／ 「▼ 降下 DROP n m」= n m 下へ降りる ／ ' +
          '「射撃位置 FIRE POS」= 閉じた隔壁の手前で、その隔壁の制御砲台を狙える位置 ／ 「戻る BACK」= 射撃位置を通り過ぎたので戻る ／ 「合流 REJOIN」= 推奨経路から離れたので、経路へ戻る地点。',
      ),
      li('どちらのマーカーも、地点が画面の外や背後にあるときは、画面の端に矢印と距離で方向を示します。'),
      li('HUD 左上の「目標」行と「進路」行にも、同じ内容を文字で表示します。「進路」行の「残り n m」は、現在の目標（次の制御砲台の射撃位置、または脱出領域）までの経路の残り距離です。'),
      li('進路マーカーは照準の邪魔にならないよう FCS の円の中では薄くなり、制御砲台が見えている射撃位置では消えて目標マーカーだけになります。推奨経路以外の通路（分岐・環状経路）を通ってもかまいません。'),
    ]),
    sec('一時停止と再開', 'PAUSE', [
      key(`${k('Esc')} で一時停止します（マウスカーソルの固定も解除されます）。`),
      li('ウィンドウのフォーカスを失ったとき、タブを切り替えたときも自動で一時停止します。停止中はゲーム内の時間は進みません。'),
      li('再開時に押したままのキーは、いったん離してから押し直すまで入力として扱いません。'),
      li(`${k('左Ctrl')} を押しながら ${k('W')} を押すと、ブラウザーの「タブを閉じる」操作になります。出撃中は確認ダイアログが出るので、キャンセルして続行してください。`),
    ]),
    sec('音声', 'AUDIO', [
      key(`${k('M')} で効果音の ON / OFF（ミュート）を切り替えます。どの画面でも有効です。`),
      li(`現在の状態は、格納庫の下部と一時停止メニューに「${audioStatusText(false)}」または「${audioStatusText(true)}」と文字で表示します。切り替えたときは画面上部にも短く表示します。`),
      li('音は最初の「出撃」のクリック以降に鳴ります。一時停止中はゲーム内の音も止まります。BGM はありません。'),
      li(`${k('左Ctrl')}（ブレーキ）などの修飾キーを押している間は、${k('M')} は反応しません（ブラウザーのショートカットと区別するためです）。`),
    ]),
  ];

  return `<div class="ak2-help">${lead}${table}<div class="help-secs">${sections.join('')}</div></div>`;
}

// ───────────────────────── helpers shared by garage.ts and menus.ts ─────────────────────────

/** The one wording of the sound state, used by the garage, the pause menu, the toast and the help: text, not colour. */
export function audioStatusText(muted: boolean): string {
  return muted ? '音声 OFF [M]' : '音声 ON [M]';
}

/** Display labels of a loadout, read from the part tables in config. */
export function loadoutLabels(loadout: Loadout): { fcs: string; generator: string; legs: string } {
  return {
    fcs: FCS_PARTS[loadout.fcs].label,
    generator: GENERATOR_PARTS[loadout.generator].label,
    legs: LEGS_PARTS[loadout.legs].label,
  };
}

/** Tiny DOM builder: element with a class name and optional text content. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
  parent?: Element,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

const POINTER_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel'] as const;

/**
 * Keeps pointer events that hit a UI overlay from bubbling on to the game (canvas / document / window
 * listeners registered in the bubbling phase), so a click on a menu button can never be taken for a shot.
 * Also swallows the browser context menu and makes auto-repeating Space / Enter harmless: a key that is
 * still held when a menu appears (e.g. Space = flight) must not "press" a focused button.
 */
export function shieldUiEvents(root: HTMLElement): void {
  const stop = (e: Event): void => {
    e.stopPropagation();
    if (e.type === 'contextmenu') e.preventDefault();
  };
  for (const type of POINTER_EVENTS) root.addEventListener(type, stop);
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.repeat && (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter')) e.preventDefault();
  });
}

/**
 * Adds a "more below" marker to a scrollable container (the controls help). The marker disappears once
 * the end is reached. Returns a function that re-evaluates it (call after showing / resizing the container).
 */
export function attachScrollHint(scroller: HTMLElement): () => void {
  const hint = el('div', 'ui-scroll-hint is-end', undefined, scroller);
  hint.setAttribute('aria-hidden', 'true');
  el('span', undefined, '▼ スクロールで続きを表示', hint);
  const update = (): void => {
    const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 12;
    hint.classList.toggle('is-end', atEnd);
  };
  scroller.addEventListener('scroll', update, { passive: true });
  return update;
}

/**
 * Milliseconds after an overlay appeared during which the follow-up clicks of a multi-click series
 * (`MouseEvent.detail` ≥ 2: a player who was just tapping the fire button, or a double click on the button
 * that opened the overlay) are ignored. A single click (`detail` 1) and keyboard activation always count.
 */
export const UI_ARM_DELAY_MS = 350;

/** Monotonic milliseconds for UI-only timing (never used by the simulation). */
export function uiNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
