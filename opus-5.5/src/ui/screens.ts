// 格納庫・一時停止・結果・ポインターロック失敗の各画面。
import {
  FCS,
  GENERATORS,
  LEGS,
  PLAYER,
  WEAPONS,
  WEAPON_ORDER,
  computeEffectiveStats,
  type FcsId,
  type GeneratorId,
  type LegsId,
  type Loadout,
} from '../config';
import type { Game } from '../sim/game';
import { SECTORS } from '../stage/layout';

const $ = (id: string) => document.getElementById(id)!;

export const CONTROLS_HTML = `
<table class="controls">
<tr><th>WASD</th><td>移動（カメラの水平方向基準。斜めでも速度は増えない）。離すと減速して停止</td></tr>
<tr><th>マウス</th><td>視点・照準（TPSカメラ旋回）</td></tr>
<tr><th>Space</th><td>接地中に押すとジャンプ（初速10m/s）。<b>0.20秒以上長押しで飛行</b>（上昇8m/s・空中16m/s・<b>20 EN/秒</b>）</td></tr>
<tr><th>Q</th><td><b>クイックブースト：単発・1回押すごとに36 ENを一括消費</b>（初速80m/s・噴射0.15秒・再使用1.00秒）。押し続けても1回だけ。<b>QB後は自動でグライドへ移行</b>し、キーを離しても慣性で進み続ける</td></tr>
<tr><th>Shift</th><td>グライドのON/OFFを1回押して切替（地上22m/s）。<b>グライドは0 EN</b>（EN0でも使用可・接地中はENも回復）。押し続ける必要なし</td></tr>
<tr><th>左Ctrl</th><td>ブレーキ：押している間グライドを解除して減速。<b>停止は左Ctrl、またはShiftでグライド解除</b></td></tr>
<tr><th>左クリック</th><td>射撃（押している間、武器ごとの間隔で連射）</td></tr>
<tr><th>1 / 2 / 3</th><td>マシンガン / ビーム / ハンドミサイル（切替で残弾・EN・射撃間隔はリセットされない）</td></tr>
<tr><th>Esc</th><td>一時停止（ポインターロック解除）</td></tr>
</table>
<p class="note">FCS：画面中央の円内に敵を捉えると自動でロックが進行（捕捉中は進捗％、完了で「LOCK」）。ロック完了中のマシンガンは FCS が目標の移動と弾道落下を計算して発射（偏差射撃は不要）。ハンドミサイルはロック完了時のみ発射可能。<br>
目標：6体の<b>制御砲台（シアンのビーコン・CTRL表示）</b>を破壊して対応する隔壁を開き、最終搬出ゲートの先の脱出領域へ到達する。敵の射撃予告は銃口の明滅と「!」表示、被弾方向は画面中央の赤い弧で示す。</p>`;

export class Screens {
  private garage = $('garage');
  private pause = $('pause');
  private result = $('result');
  private lockFail = $('lockfail');
  private loadout: Loadout;
  onLoadoutChange: ((l: Loadout) => void) | null = null;

  constructor(initial: Loadout, seed: number) {
    this.loadout = { ...initial };
    $('controls-garage').innerHTML = CONTROLS_HTML;
    $('controls-pause').innerHTML = CONTROLS_HTML;
    $('seed-label').textContent = `SEED ${seed}（URLの ?seed= で指定）`;
    this.buildParts();
    this.updateStats();
  }

  private card(group: string, id: string, name: string, pros: string, cons: string, spec: string) {
    return `<label class="part" data-group="${group}" data-id="${id}">
      <input type="radio" name="${group}" value="${id}">
      <div class="pname">${name}</div>
      <div class="pspec">${spec}</div>
      <div class="ppro">＋ ${pros}</div>
      <div class="pcon">－ ${cons}</div>
    </label>`;
  }

  private buildParts() {
    const fcs = (Object.keys(FCS) as FcsId[])
      .map((k) => this.card('fcs', k, FCS[k].name, FCS[k].pros, FCS[k].cons, `ロック円 半径 ${FCS[k].radiusFactor.toFixed(2)}D ／ 2脚ロック ${FCS[k].baseLockSeconds.toFixed(2)}秒`))
      .join('');
    const gen = (Object.keys(GENERATORS) as GeneratorId[])
      .map((k) =>
        this.card('generator', k, GENERATORS[k].name, GENERATORS[k].pros, GENERATORS[k].cons, `最大EN ${GENERATORS[k].maxEn} ／ 基本回復 ${GENERATORS[k].regenPerSecond} EN/秒`),
      )
      .join('');
    const legs = (Object.keys(LEGS) as LegsId[])
      .map((k) =>
        this.card(
          'legs',
          k,
          LEGS[k].name,
          LEGS[k].pros,
          LEGS[k].cons,
          `水平速度×${LEGS[k].horizontalSpeedMultiplier.toFixed(2)} ／ EN回復×${LEGS[k].regenMultiplier.toFixed(2)} ／ ロック速度×${LEGS[k].lockSpeedMultiplier.toFixed(2)}`,
        ),
      )
      .join('');
    $('parts-fcs').innerHTML = fcs;
    $('parts-gen').innerHTML = gen;
    $('parts-legs').innerHTML = legs;
    this.garage.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const g = inp.name as keyof Loadout;
        (this.loadout as unknown as Record<string, string>)[g] = inp.value;
        this.syncChecked();
        this.updateStats();
        this.onLoadoutChange?.({ ...this.loadout });
      });
    });
    this.syncChecked();
  }

  private syncChecked() {
    this.garage.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach((inp) => {
      const g = inp.name as keyof Loadout;
      inp.checked = this.loadout[g] === inp.value;
      inp.closest('.part')!.classList.toggle('sel', inp.checked);
    });
  }

  updateStats() {
    const st = computeEffectiveStats(this.loadout);
    const D = Math.min(window.innerWidth, window.innerHeight);
    const m = st.horizontalSpeedMultiplier;
    $('stats').innerHTML = `
      <div class="sel-parts">
        <div>FCS：<b>${FCS[this.loadout.fcs].name}</b></div>
        <div>ジェネレーター：<b>${GENERATORS[this.loadout.generator].name}</b></div>
        <div>脚部：<b>${LEGS[this.loadout.legs].name}</b></div>
      </div>
      <table class="stat">
        <tr><th>最大EN</th><td>${st.maxEn}</td></tr>
        <tr><th>EN回復率</th><td>${st.regenPerSecond.toFixed(2)} EN/秒 <small>（${GENERATORS[this.loadout.generator].regenPerSecond}×${LEGS[this.loadout.legs].regenMultiplier.toFixed(2)}）</small></td></tr>
        <tr><th>ロック所要時間</th><td>${st.lockSeconds.toFixed(3)} 秒 <small>（${FCS[this.loadout.fcs].baseLockSeconds.toFixed(2)}÷${LEGS[this.loadout.legs].lockSpeedMultiplier.toFixed(2)}）</small></td></tr>
        <tr><th>ロック円半径</th><td>${st.lockRadiusFactor.toFixed(2)}D ＝ ${(st.lockRadiusFactor * D).toFixed(0)} px <small>（現在の表示領域）</small></td></tr>
        <tr><th>水平移動速度</th><td>×${m.toFixed(2)}：歩行 ${(PLAYER.walkSpeed * m).toFixed(1)} ／ グライド ${(PLAYER.glideSpeedGround * m).toFixed(1)} ／ 空中 ${(PLAYER.airSpeed * m).toFixed(1)} ／ QB初速 ${(PLAYER.qbSpeed * m).toFixed(0)} m/s</td></tr>
        <tr><th>HP</th><td>${PLAYER.maxHp}（自然回復なし）</td></tr>
      </table>
      <div class="weap">携行武器（3種全て携行・1〜3で切替）：${WEAPON_ORDER.map((w) => `<div>${WEAPONS[w].key}. ${WEAPONS[w].name} — ${WEAPONS[w].damage}ダメージ／${WEAPONS[w].interval.toFixed(2)}秒／${WEAPONS[w].ammo === null ? '弾数無制限・1射8EN' : `${WEAPONS[w].ammo}発`}${WEAPONS[w].requiresLock ? '・ロック必須' : ''}</div>`).join('')}</div>
      <div class="stage-info">ステージ：廃工場 ${SECTORS.length}区画・敵45体（警備30・砲台15）・制御砲台6</div>`;
  }

  getLoadout(): Loadout {
    return { ...this.loadout };
  }

  showGarage() {
    this.garage.classList.remove('hidden');
    this.pause.classList.add('hidden');
    this.result.classList.add('hidden');
    this.hideLockFail();
    this.updateStats();
  }
  hideAll() {
    this.garage.classList.add('hidden');
    this.pause.classList.add('hidden');
    this.result.classList.add('hidden');
    this.hideLockFail();
  }
  showPause() {
    this.pause.classList.remove('hidden');
  }
  showResult(game: Game) {
    const cleared = game.state === 'cleared';
    const t = game.elapsedSeconds;
    $('result-title').textContent = cleared ? 'MISSION CLEAR — 脱出成功' : 'MISSION FAILED — 機体大破';
    $('result-title').className = cleared ? 'clear' : 'fail';
    $('result-body').innerHTML = `
      <table class="stat">
        <tr><th>結果</th><td>${cleared ? '最終搬出ゲートを抜け脱出領域へ到達' : game.failReason === 'fall' ? '復帰不能な落下' : 'HPが0以下'}</td></tr>
        <tr><th>経過時間</th><td>${Math.floor(t / 60)}分${(t % 60).toFixed(1)}秒</td></tr>
        <tr><th>残りHP</th><td>${Math.max(0, game.player.hp).toFixed(0)} / ${PLAYER.maxHp}</td></tr>
        <tr><th>制御砲台</th><td>${game.controlsDestroyed} / 6</td></tr>
        <tr><th>撃破数</th><td>${game.kills} / 45</td></tr>
        <tr><th>通過区画</th><td>${game.visited.length} / ${SECTORS.length}</td></tr>
        <tr><th>機体構成</th><td>${FCS[game.loadout.fcs].name} ／ ${GENERATORS[game.loadout.generator].name} ／ ${LEGS[game.loadout.legs].name}</td></tr>
      </table>`;
    this.result.classList.remove('hidden');
  }
  showLockFail(msg: string) {
    $('lockfail-msg').textContent = msg;
    this.lockFail.classList.remove('hidden');
  }
  hideLockFail() {
    this.lockFail.classList.add('hidden');
  }
  setPending(on: boolean) {
    document.body.classList.toggle('pending-lock', on);
  }
}
