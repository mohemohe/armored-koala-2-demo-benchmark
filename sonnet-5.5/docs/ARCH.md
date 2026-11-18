# AK2 DEMO アーキテクチャ / モジュール契約

`docs/SPEC.md` が唯一の仕様（原文）。本書はその実装方針と、並列開発するモジュール間の契約を定める。
**SPEC と本書が矛盾した場合は SPEC が優先。** 仕様の数値を勝手に変えてはいけない。

## 1. 技術スタック
- TypeScript + Three.js 0.186.0 + Vite 8 + Vitest 5（全て固定バージョン、`package-lock.json` あり）。
- シミュレーション (`src/sim/**`) は **DOM/Three.js に依存しない**純粋なTS。Node(vitest)でヘッドレスに動く。
  → §4.6 の命中試験・QB試験・敵AI試験は本番と同じ `Game` クラスをそのまま Node で動かして行う。
- 描画 (`src/render/**`) と UI (`src/ui/**`, `src/main.ts`) は `GameState` を読むだけ。シミュレーションを変更しない。
- 外部通信・外部アセット禁止。テクスチャ/モデルは全てコード生成（CanvasTexture / プリミティブ組み合わせ）。

## 2. ファイルマップ（担当）
```
src/config.ts            全ゲームパラメーター（単一の真実）              [固定]
src/sim/math.ts          ベクトル数学・yaw規約                            [固定]
src/sim/types.ts         全共有型 (GameState 他)                          [固定・編集禁止]
src/sim/rng.ts           シード付き乱数                                   [固定]
src/sim/stats.ts         実効ステータス                                   [固定]
src/sim/project.ts       画面投影 (FCSとHUDが共有)                        [固定]
src/sim/combat.ts        damageEnemy/damagePlayer/pushEvent               [固定]
src/sim/world.ts         AABB衝突ワールド                                 [world agent]
src/sim/ballistics.ts    偏差・重力ソルバー（純関数）                      [ballistics agent]
src/sim/player.ts        移動・EN・QB・グライド・飛行                      [player agent]
src/sim/camera.ts        TPSカメラ・銃口位置・照準点                       [combat agent]
src/sim/fcs.ts           ロック・射撃管制                                  [combat agent]
src/sim/weapons.ts       3武器の射撃                                       [combat agent]
src/sim/projectiles.ts   プレイヤー弾体(MG/ミサイル)                       [combat agent]
src/sim/enemies.ts       敵生成・AI・敵弾                                  [enemy agent]
src/sim/nav.ts           敵の経路探索                                      [enemy agent]
src/sim/objective.ts     区画追跡・隔壁・ゲート・クリア/失敗               [固定]
src/sim/game.ts          Game: tick順序・状態遷移                          [固定(統合担当のみ変更可)]
src/sim/bench.ts         window.AK2_BENCH.getSnapshot                      [固定]
src/sim/testArena.ts     障害物なし試験アリーナ                            [固定]
src/sim/scenario.ts      §4.6 分離試験シナリオ                              [combat agent]
src/stage/**             ステージ定義・区画ビルダー                        [stage agents]
src/render/**            Three.js 描画                                     [render agent]
src/ui/**, src/main.ts   HUD/格納庫/メニュー/入力/ポインターロック          [ui agent]
tests/**                 vitest                                            [各担当が自モジュールのテストを書く]
tools/**                 検証ツール (tsx)                                  [各担当]
```
**他モジュールのファイルを編集しない。** 必要な変更は最終報告に「要望」として書く。`types.ts` は凍結。追加の状態は `internal` バッグ
（`PlayerState.internal`, `EnemyState.internal`）かモジュールローカル型で持つ。

## 3. 規約
- 単位: m, s, rad(内部)。Y up。**プレイヤー/敵の `pos` は当たり判定中心**（プレイヤーはAABB中心 `PLAYER.HALF`、敵は球中心）。
  足元 = `pos.y - HALF.y`。
- yaw規約は `math.ts` 参照（Three.js `camera.rotation.y` と同じ。yaw=0 は -Z を向く。マウス右 = yaw減少）。
- 時刻: `state.time = state.tick * SIM.DT`（SIM.DT = 1/120 固定）。閾値比較は `1e-9` の許容誤差を持つ。
  `Math.random()` / `Date.now()` をシミュレーション内で使わない。ゲーム進行の乱数は `state.rng` のみ。
- NaN / Infinity を状態に入れない（ゼロ除算に注意。`normalize` は fallback を持つ）。
- 全パラメーターは `config.ts`。マジックナンバーの重複定義禁止。
- ファイルは常にコンパイルできる状態に保つ。編集後は `npx tsc --noEmit` で **自分の担当ファイルのエラーがない**ことを確認する
  （他担当ファイルの一時的なエラーは無視してよいが、最終統合で全て解消する）。
- テスト: `npx vitest run tests/<name>.test.ts`。全体は `npm test`。

## 4. Tick 順序（`Game.step()`、SPEC §9/§6/§4 の要件に対応）
状態は tick 開始時刻 T のもの。1 tick で T → T+dt (dt = 1/120) に進む。
```
A. 時刻 T の判断・発射（全ての状態は T の値）
   A1 requestWeaponSwitch            武器切替（残弾/EN/次回発射時刻はリセットしない）
   A2a playerBeginTick               エッジ入力: QB発動(36EN一括)・グライド切替・ジャンプ開始
   A2b playerFireStep                発射: ロック再検証 → 同時刻の値で射撃解を計算 → 弾/ビーム生成 (ビームEN8はここで支払う)
   A3 enemyDecisionStep              敵AI: 射線・記憶・共有・偏差射撃・敵弾生成(時刻T)・希望速度設定
B. T → T+dt の積分
   (prevPos = pos を全員分保存)
   B1 playerIntegrate                飛行EN(QB→ビームの残りから)・移動・衝突・重力・EN回復
   B2 enemyIntegrate                 敵移動
   B3 stepPlayerProjectiles / stepEnemyBullets
                                     弾は [T, T+dt] の区間で、対象の prevPos→pos の移動も考慮して掃引衝突。
                                     A2b/A3 で生成した弾も同じtickで dt だけ進める（=残り区間。余分な前進は無し）
C. T+dt の後処理
   tick++, time = tick*dt
   updateCamera → updateFcs(ロック検証/進捗/HUD用射撃解) → updateProgress(区画/隔壁/ゲート/クリア/失敗)
```
- 射撃時刻 = tick 開始時刻 T。`ShotRecord.firedAtSeconds` と `fc.evaluatedAtSeconds` は `state.time`。
- 「QB → ビーム → 飛行」の EN 判定順は上記 A2a → A2b → B1 で自然に満たされる。
- マウス視点は `Game.look()` が yaw/pitch を更新した直後に `updateCamera` を呼ぶ（次の tick の発射・ロック検証は最新の視点を使う）。
- 弾体・ビーム・敵弾の衝突は **静止ワールド（IWorld）＋移動する敵球/プレイヤーAABB** に対する掃引。重力弾は tick 内で線分近似
  （最大ずれ g·dt²/8 ≈ 0.00016 m < 0.01 m）してよい。
- 一時停止中は `advance()` が何も進めない（時間・待ち時間・記憶は全て state.time 基準なので自動的に止まる）。

## 5. 主要な設計決定
- **銃口位置**: `playerMuzzlePosition(player)` = 中心 + yaw座標系の固定オフセット(`PLAYER.MUZZLE_OFFSET`)。視点ピッチや補正方向で変わらない。
  機体モデルの腕と武器は、この銃口点を通り発射方向を向くように姿勢を決める（見た目と実弾を一致させる）。
- **自由射撃**: カメラ中心レイの最初の衝突点(ワールド/生存敵)を銃口から狙う。銃口手前に壁があれば弾は壁で止まる。
- **機体中心→銃口の線分上の壁 (SPEC §4.5)**: 銃口は機体中心からの固定オフセット(前 1.25 m・右 1.05 m。当たり判定の半幅は 0.8 m)なので、機体に押し当てた薄い壁は
  「銃口の後ろ」に入り、弾が壁の向こう側から出てしまう。発射地点を壁の反対側へ移すことは §4.2 が禁じているので、`playerFireStep` は発射の成立(弾数・EN・次回発射時刻・ShotRecord は通常どおり消費/記録)の前に
  機体中心→銃口の線分を `world.raycast` し、遮られていれば**その壁が最初の衝突**として扱う(ロック補正の有無に関わらない)。ビームは `beamFire.hit='world'`(終点=壁の表面)でダメージなし、
  マシンガン/ミサイルは弾体を生成せず壁への命中イベント(ミサイルは爆発も)だけを出す。線分に交わる全ての箱が対象で、薄い壁に限らない
  (高さ 2.2 m 前後の厚い箱に押し当てて立つと、その上端の角を線分がかすめて止まる姿勢がごく稀にある)。
- **`snapshot.player.movement.desiredHorizontalDirection` の解釈 (SPEC §10)**: 「水平移動系が現在向かおうとしている方向」(`player.ts` の `headingDirection`)。
  優先順位は、ブレーキ中は `[0,0]` → QB 噴射中は噴射方向(WASD を途中で変えても変わらない) → WASD 入力があればその方向 → グライド中(手動 Shift・QB 後の自動グライド・慣性減速を含む)は保持した
  グライド/QB 方向 → 歩行で入力なしは `[0,0]`。WASD 入力そのものではない(QB 後に全キーを離しても、移動を続けている間は非ゼロ)。
- **FCS補正射撃**: ロック完了かつ対象有効なら、射撃イベントごとに最新の (m, p, v) から再計算する。`computeFireSolution` を
  HUD(`state.fc`)・実射撃・スナップショットが共有する（診断用に別計算しない）。
- **プレイヤー当たり判定**: AABB(`PLAYER.HALF`)。敵とプレイヤーは互いに衝突しない（押し出し無し）。敵の球当たり判定 = `hitRadius`。
- **敵の速度**: `enemy.vel` = 実際に位置更新に使った当たり判定中心の速度。固定砲台は 0。
- **試験用標的**: `EnemyState.scripted = true`（半径 `TEST_TARGET_RADIUS`=0.5、AI無し・等速）。本編の45体には使わない。
- **ステージ**: すべて AABB 箱。描画メッシュ = 衝突箱（見た目と衝突の一致）。装飾は `StageDef.decor`（衝突なし）で、
  通行可能空間に入れてはいけない（壁面から 0.15m 以内・壁/天井スラブ内・到達不能空間のみ）。
- **プレイヤー寸法**: 当たり判定 1.6 × 3.0 × 1.6 m。ステージの通路は最小でも幅 5m×高さ 6m、扉は原則 幅8m×高さ7m 以上。
- **座標の慣例**: ステージは x 東+, z 南+, y 上+。区画の地面高は `floorY`。区画殻は床スラブ(厚2m)・壁(厚2m)・天井スラブ(厚2m)。
  隣接区画は境界面を共有し、開口(portal)の位置・幅・高さを両側で一致させる。

## 6. 描画・UI契約
```ts
// src/render/renderer.ts
export class GameRenderer {
  constructor(canvas: HTMLCanvasElement);
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  setStage(stage: StageDef): void;                    // 静的メッシュを1回だけ生成
  showHangar(loadout: Loadout): void;                 // 格納庫3Dビュー (機体は正面から頭部が見える、ゆっくり回転)
  setHangarLoadout(loadout: Loadout): void;           // 2脚/4脚モデル切替
  showGame(): void;
  render(state: GameState, events: GameEvent[], frameDt: number): void;   // mode==='garage' なら格納庫を描く
  dispose(): void;
}
// src/ui/hud.ts
export class Hud { constructor(root: HTMLElement); update(state: GameState): void; setVisible(v: boolean): void; }
```
- HUD のマーカー位置は `projectToScreen(state.camera, worldPoint)` を使う（FCS判定と同一の投影）。
- 入力は `Game.input`（安定オブジェクト）にレベルで書く。エッジ検出はシミュレーション側。**Q/Shift/Space は keydown の `event.repeat` を無視**し、
  一時停止/フォーカス喪失/ポインターロック喪失で全入力を解除する。クリックで出撃・再開したとき、そのクリックを射撃にしない。
- `window.AK2_BENCH = { getSnapshot }` のみ公開（`bench.ts` の `buildSnapshot`）。他のメソッドを足さない。

## 7. 検証の原則
- 数式だけでなく **実際の Game を tick 実行して** 検証する（弾体生成→掃引衝突→HP減少まで）。
- README の検証節には、実際に走らせた条件・発射数・命中数・残差・未実施項目を記録する。未測定の値を実測として書かない。
