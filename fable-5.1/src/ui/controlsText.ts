/**
 * 操作説明（格納庫・一時停止画面で表示）。
 * 数値は全て src/params.ts から取る（UI専用の架空の数値を書かない）。
 * §8 の必須文言（FCS の自動補正、QB の単発・36 EN、グライド 0 EN、停止方法）を含む。
 */
import { ENEMIES, FCS, GENERATORS, LEGS, OBJECTIVE, PLAYER, WEAPONS } from '../params';

const f2 = (n: number): string => n.toFixed(2);
const f1 = (n: number): string => n.toFixed(1);

const quad = LEGS.quadruped;
const mg = WEAPONS.machinegun;
const beam = WEAPONS.beam;
const ms = WEAPONS.missile;
const guard = ENEMIES.guard;
const turret = ENEMIES.turret;

/** §8 必須文言: FCS は偏差と重力を自動補正し、中央照準を補正マーカーへ手動で合わせる必要はない */
export const FCS_AUTO_CORRECTION_TEXT =
  '対象をFCS円内に保てばロックが自動で進み、ロック完了後は偏差と重力（マシンガン）を自動補正して発射します。' +
  '中央の照準を補正マーカーへ手動で合わせる必要はありません。' +
  'ビームは現在位置へ即時命中、ミサイルはロック完了時のみ発射可能で偏差方向へ発射後に誘導されます。';

/** §8 必須文言: QB は単発・36 EN、QB 後は自動グライド、グライドは 0 EN、停止は左Ctrl または Shift 解除 */
export const QB_SUMMARY_TEXT =
  `Qは1回の押下で1回だけ発動する単発のQBで、発動時に ${PLAYER.qb.cost} EN を一括消費します。` +
  `QB後は自動でグライドへ移行し、グライドの EN 消費は 0 です。` +
  `停止するには左Ctrl（ブレーキ）またはShift（グライド解除）を使います。`;

export const CONTROLS_SECTIONS: { title: string; lines: string[] }[] = [
  {
    title: `移動（数値は2脚の基準値。4脚は水平移動速度 ×${f2(quad.speedMul)}）`,
    lines: [
      `WASD: 通常移動 ${PLAYER.walkSpeed} m/s（カメラの水平方向が基準。斜め移動でも速度は増えない）。入力を離すと減速して停止。EN 0`,
      'マウス移動: 視点・照準（TPSカメラの旋回）。EN 0',
      `Space（接地中に押す）: ジャンプ。上向き初速 ${PLAYER.jumpSpeed} m/s（脚部倍率なし）。EN 0`,
      `Shift（1回押す）: グライドの切り替え。地上 ${PLAYER.glideGroundSpeed} m/s、空中 ${PLAYER.airSpeed} m/s。押し続ける必要はなく、離しても続く。EN 0（ENが0でも使用でき、接地中はEN回復も妨げない）`,
      '左Ctrl（押している間）: ブレーキ。グライドを解除し、慣性を伴って減速して停止する（WASDより優先）。EN 0',
      `Space（${f2(PLAYER.flightHoldSeconds)}秒以上長押し）: 飛行。上昇 ${PLAYER.flightRiseSpeed} m/s、空中水平 ${PLAYER.airSpeed} m/s、${PLAYER.flightEnPerSecond} EN/秒。離すかENが尽きると重力（${PLAYER.gravity} m/s²）で落下。空中で押し直した場合も ${f2(PLAYER.flightHoldSeconds)} 秒の長押しが必要`,
    ],
  },
  {
    title: 'クイックブースト（QB）',
    lines: [
      `Q（1回押す）: 単発のQB。発動時に ${PLAYER.qb.cost} EN を1回だけ消費し、その瞬間のWASD方向（入力がなければカメラ前方）へ初速 ${PLAYER.qb.speed} m/s で ${f2(PLAYER.qb.impulseSeconds)} 秒噴射する。垂直速度は変わらない`,
      `噴射終了後は自動でグライドへ移行し、速度を保ったまま ${f2(PLAYER.qb.decelSeconds)} 秒でグライド速度（地上 ${PLAYER.glideGroundSpeed} m/s、空中 ${PLAYER.airSpeed} m/s）へ滑らかに減速する。WASDもShiftも押していなくても移動は続く`,
      QB_SUMMARY_TEXT,
      `再発動には前のQB開始から ${f2(PLAYER.qb.cooldownSeconds)} 秒以上、EN ${PLAYER.qb.cost} 以上が必要。押し続けてもキーリピートでも再発動しない（いったん離して押し直す）。左Ctrl押下中や噴射中は不成立で、ENも消費しない`,
      `2脚・平地でのQB開始から ${f2(PLAYER.qb.impulseSeconds + PLAYER.qb.decelSeconds)} 秒間の移動距離: 噴射 ${f1(PLAYER.qb.speed * PLAYER.qb.impulseSeconds)} m + 慣性減速 ${f1(((PLAYER.qb.speed + PLAYER.glideGroundSpeed) / 2) * PLAYER.qb.decelSeconds)} m`,
    ],
  },
  {
    title: '射撃とFCS',
    lines: [
      'マウス左ボタン: 押している間、武器の射撃間隔で発射する',
      '1 / 2 / 3: マシンガン / ビーム / ハンドミサイル。切り替えても残弾・EN・武器ごとの次回発射時刻はリセットされず、切り替え自体のEN消費はない',
      FCS_AUTO_CORRECTION_TEXT,
      `ロックはボタン操作なしで自動進行する。対象の条件: 生存中、銃口から ${FCS.range} m 以内、カメラ前方、当たり判定中心が中央のFCS円内、カメラと銃口の双方から遮蔽なし。円外・遮蔽・破壊・範囲外で即座に解除され、次の対象は0から始まる`,
      `FCS円の半径（D=表示領域の短辺）: ${FCS.kinds.wide.label} ${f2(FCS.kinds.wide.radiusFactor)}D / ${FCS.kinds.medium.label} ${f2(FCS.kinds.medium.radiusFactor)}D / ${FCS.kinds.narrow.label} ${f2(FCS.kinds.narrow.radiusFactor)}D。2脚でのロック所要時間 ${f2(FCS.kinds.wide.lockSeconds)} / ${f2(FCS.kinds.medium.lockSeconds)} / ${f2(FCS.kinds.narrow.lockSeconds)} 秒（4脚はロック速度 ×${f2(quad.lockSpeedMul)} で所要時間が短い）`,
      'HUD: 対象マーカー [ ] は対象の現在位置、◇ は実際の射出方向に対応する補正照準点（「補正中」または「解なし」を文字で表示）。ロック完了前は補正されず、カメラ中央への自由射撃になる。マーカーが画面外のときは画面端に方向矢印を表示する',
      'ロック完了でも寿命内の射撃解がない場合は「解なし」となり、マシンガンは対象の現在位置へ直接照準して発射する（ロックは維持）',
    ],
  },
  {
    title: '武器',
    lines: [
      `マシンガン: 威力 ${mg.damage}、最短間隔 ${f2(mg.interval)} 秒、総弾数 ${mg.ammo}（補給なし）、初速 ${mg.speed} m/s、重力あり（${Math.abs(mg.gravity[1])} m/s²）、寿命 ${mg.lifetime} 秒。ロック完了時は偏差・重力を自動補正。EN 0`,
      `ビーム: 威力 ${beam.damage}、最短間隔 ${f2(beam.interval)} 秒、弾数無制限、1射 ${beam.enCost} EN、射程 ${beam.range} m、即時命中（EN ${beam.enCost} 未満は発射不可）`,
      `ハンドミサイル: 威力 ${ms.damage}、最短間隔 ${f2(ms.interval)} 秒、総弾数 ${ms.ammo}、速度 ${ms.speed} m/s、旋回上限 ${ms.turnRateDeg}°/秒、寿命 ${ms.lifetime} 秒。ロック完了時のみ発射でき、未ロックでは弾も弾数も消費しない。EN 0`,
    ],
  },
  {
    title: 'EN とシステム',
    lines: [
      `ENを使う動作はQB（${PLAYER.qb.cost} EN）、飛行（${PLAYER.flightEnPerSecond} EN/秒）、ビーム（${beam.enCost} EN/射）だけ。通常移動・ジャンプ・グライド・ロック・マシンガン・ミサイルはEN 0`,
      `EN回復: 接地中で、最後の実際のEN消費から ${f2(PLAYER.enRegenDelaySeconds)} 秒以上経過していると回復する。空中（上昇・飛行・慣性・落下）では回復しない。地上グライド中も回復する`,
      `ジェネレーター: ${GENERATORS.capacity.label} 最大EN ${GENERATORS.capacity.maxEn}・回復 ${GENERATORS.capacity.regen} EN/秒 / ${GENERATORS.balanced.label} ${GENERATORS.balanced.maxEn}・${GENERATORS.balanced.regen} / ${GENERATORS.recovery.label} ${GENERATORS.recovery.maxEn}・${GENERATORS.recovery.regen}。脚部: ${LEGS.biped.label} 速度×${f2(LEGS.biped.speedMul)}・回復×${f2(LEGS.biped.regenMul)}・ロック速度×${f2(LEGS.biped.lockSpeedMul)} / ${quad.label} 速度×${f2(quad.speedMul)}・回復×${f2(quad.regenMul)}・ロック速度×${f2(quad.lockSpeedMul)}`,
      `HP ${PLAYER.maxHp}。自然回復・弾薬補給・EN補充アイテムはない。HP 0 以下、または復帰不能な落下で失敗`,
      'Esc: 一時停止（ポインターロック解除）。ポインターロック喪失・ウィンドウのフォーカス喪失・タブの非表示でも一時停止する。再開ボタンでポインターロックを再取得する',
    ],
  },
  {
    title: '敵の攻撃と目標',
    lines: [
      `敵は射撃前に予告する（砲口の明滅と HUD の「!」マーカー）: 警備ロボット ${f2(guard.telegraphSeconds)} 秒、固定砲台 ${f2(turret.telegraphSeconds)} 秒。被弾すると画面中央の周囲に赤いくさび形の被弾方向インジケーターと画面端の赤い縁取りが出る（上=前方、時計回り）`,
      `警備ロボット: 索敵 ${guard.detectRange} m、ダメージ ${guard.damage}、弾速 ${guard.bulletSpeed} m/s、${guard.burstCount}発バースト（周期 ${f2(guard.burstPeriod)} 秒）。固定砲台: 索敵 ${turret.detectRange} m、ダメージ ${turret.damage}、弾速 ${turret.bulletSpeed} m/s、${turret.burstCount}発バースト（周期 ${f2(turret.burstPeriod)} 秒）`,
      `敵弾は偏差射撃（予測上限 ${f2(guard.leadMaxSeconds)} 秒）の直進弾で、発射後の誘導はない。急な方向転換・QB・高低差・遮蔽物で回避できる。カメラ外の敵も距離と射線が有効なら攻撃する`,
      `制御砲台（${OBJECTIVE.controlsRequired}体、HUD に「制御」マーカー）を破壊すると対応する隔壁が開く。${OBJECTIVE.controlsRequired}体全て破壊で最終ゲートが開き、脱出領域へ入るとクリア。敵 ${OBJECTIVE.totalEnemies} 体の全滅は不要`,
    ],
  },
];
