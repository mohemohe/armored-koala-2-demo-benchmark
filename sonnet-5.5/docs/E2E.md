# E2E 結果 (ブラウザ実機の総合検証)

`npx tsx tools/e2e.ts` の出力。Playwright 1.63 + Chrome for Testing (headless) + SwiftShader によるソフトウェア描画。手動の値の書き足しはしていない。

## 環境

- 実行日時: 2026-09-30T05:26:09.107Z
- URL: http://127.0.0.1:5210 (vite build -> vite preview)
- ブラウザ: 149.0.7827.3
- マシン負荷 (loadavg 1/5/15分) 実行前 184.1/133.9/97.4 / 実行後 52.4/77.1/89.3, CPU 10コア (他の作業と並行して実行しているため、fps の絶対値は参考値)
- 所要時間: 780秒

## 方針 (時間と入力)

- SwiftShader の fps はマシン負荷で 0.2〜30 と大きく変わるため、実時間の sleep には頼らず、Playwright の fake clock を停止して `page.clock.fastForward(ms)` で 1フレーム (dt = ms) ずつ進める。時間依存の判定は全て `snapshot.elapsedSeconds` (ゲーム内時間)。fps と実時間比の計測 (9) だけは実時間の rAF で行う。
- 入力は本物のイベント: `page.keyboard` (keydown/keyup。同じキーの2回目の down は `event.repeat=true` になることを確認済み)、`page.mouse` (ポインターロック中の movementX/Y。CDP の mouseMoved は前回位置との差が movement になる)、ボタンは実クリック。
- ポインターロックは context に `Emulation.setFocusEmulationEnabled` を送り、http のページで、実クリックから要求して取得。
- 合成イベントでしか確認できないもの (blur・visibilitychange hidden) は結果を SYNTH として区別する。

## 集計

PASS 141 / FAIL 0 / SYNTH 2 / UNVERIFIED 1 / INFO 9

## 1. 起動と格納庫

| ID | 結果 | 項目 | 実測・詳細 |
|---|---|---|---|
| 1.1 | PASS | 起動〜格納庫表示でコンソールのエラー/警告が出ない (スクリーンショット前) | エラー0 / 警告0 |
| 1.2 | PASS | favicon: インラインの data URI があり、404 / 通信失敗が出ない | icon href=data:image/svg+xml,%3Csvg xm... / 失敗リクエスト 0件 |
| 1.3 | PASS | 起動後は格納庫 (state=garage)、既定のシード 20260908、既定の構成 | state=garage seed=20260908 loadout={"fcs":"medium","generator":"balanced","legs":"biped"} |
| 1.4 | PASS | 初期選択 = 中範囲FCS・均衡ジェネレーター・2脚 (格納庫UIの選択状態) | fcs:medium, generator:balanced, legs:biped |
| 1.5 | INFO | スクリーンショット後に出る GL ドライバー警告 (SwiftShader の ReadPixels 警告。アプリのログではない) | 4件 |
| 1.6 | PASS | 18構成 (FCS3×ジェネレーター3×脚部2) を全て実クリックで選択でき、表示される実効値 (最大EN・EN回復率・ロック所要時間・ロック領域・歩行/グライド/空中/QB速度) が config・snapshot と一致 | 18構成を確認 / 不一致0 |
| 1.7 | INFO | 脚部を変えると3Dモデルが変わる (2脚 / 4脚。4脚は脚が4本) — スクリーンショットの目視で確認 | test-results/e2e/e2e-hangar-biped.png / test-results/e2e/e2e-hangar-quad.png / test-results/e2e/e2e-hangar-quad-turn1.png / test-results/e2e/e2e-hangar-quad-turn2.png |
| 1.8 | PASS | 格納庫の「操作方法を確認」で操作説明が開き、SPEC §8 の必須記述 (自動補正・手動で合わせない・Qは単発36EN・自動グライド・グライドは0EN・左Ctrl/Shift) を含む | visible=true 欠落=なし |
| 1.9 | PASS | 操作説明は Esc で閉じられ、格納庫のまま (state=garage) | closed=true state=garage |
| 1.10 | PASS | 操作説明は「閉じる」ボタンでも閉じられる | closed=true |
| 1.11 | PASS | 格納庫の操作 (構成選択 18通り・操作説明) 中にコンソールのエラー/警告が出ない | エラー0 / 警告0 |

## 2. 出撃とポインターロック

| ID | 結果 | 項目 | 実測・詳細 |
|---|---|---|---|
| 2.0 | PASS | 出撃前 (garage) のスナップショットが SPEC §10 の構造と一致 | キー・型・列挙値が一致 |
| 2.1 | PASS | 出撃ボタンの実クリックからポインターロックを取得し、state=playing になる | pointerLockElement=game-canvas state=playing 経過=0.000s |
| 2.2 | PASS | 出撃ボタンのクリックが射撃にならない (残弾・EN・射撃履歴が変化しない) | 40フレーム後 MG=300 MS=12 EN=120 shots=0 経過=0.633s |
| 2.3 | PASS | playing 中のスナップショットが SPEC §10 の構造と一致 (NaN/Infinity なし) | キー・型・列挙値が一致 |
| 2.4 | PASS | 再開でポインターロックが取れないとき、説明と再試行が出て paused のまま進まない (経過時間・EN・敵が不変) | state=paused 経過 0.633->0.633 表示=マウスのロックを取得できませんでした一時停止のままです。ゲームは進行していません。ブラウザーがポインターロックを許可しな... |
| 2.5 | PASS | 「再試行」で今度はロックを取得でき、再開して playing に戻る | state=playing |
| 2.6 | PASS | 再開ボタンのクリックが射撃にならない (再開後も残弾・射撃履歴が変化しない) | MG=300 shots=0 |
| 2.7 | INFO | focus emulation なしの context で出撃を実クリックしたときの挙動 (参考) | state=playing lockErrorOverlay=false events=lock (state=garage かつ overlay=true なら取得失敗、state=playing ならこの環境では取得できた) |
| 2.8a | PASS | ロックが取れない [pointerlockerror イベント] とき、説明と再試行ボタンが出て、state=garage のまま進まない (経過0・HUD非表示) | overlay=true state=garage 経過=0.000s HUD非表示=true 詳細=ィンドウがアクティブであることを確認し、「再試行」を押してください。Escで解除した直後は、1秒ほど待つと再取得できます。pointerlockerror が発生しました再試行戻る |
| 2.9a | PASS | 再試行 (実クリック) してもロックが取れない間 [pointerlockerror イベント] は garage のまま進行せず、失敗表示が出続ける | state=garage 経過=0.000s overlay=true |
| 2.10 | PASS | 「戻る」で失敗表示が閉じ、出撃ボタンが再び押せる | {"err":false,"disabled":false} |
| 2.11 | PASS | 失敗後にロックが取れる状態へ戻して実クリックで出撃し直すと、ロックを取得でき playing になる | state=playing |
| 2.8b | PASS | ロックが取れない [Promise の reject (NotAllowedError)] とき、説明と再試行ボタンが出て、state=garage のまま進まない (経過0・HUD非表示) | overlay=true state=garage 経過=0.000s HUD非表示=true 詳細=ィブであることを確認し、「再試行」を押してください。Escで解除した直後は、1秒ほど待つと再取得できます。NotAllowedError: blocked by test再試行戻る |
| 2.9b | PASS | 再試行 (実クリック) してもロックが取れない間 [Promise の reject (NotAllowedError)] は garage のまま進行せず、失敗表示が出続ける | state=garage 経過=0.000s overlay=true |
| 2.8c | PASS | ロックが取れない [何も返らない (4秒のタイムアウト)] とき、説明と再試行ボタンが出て、state=garage のまま進まない (経過0・HUD非表示) | overlay=true state=garage 経過=0.000s HUD非表示=true 詳細=ジのウィンドウがアクティブであることを確認し、「再試行」を押してください。Escで解除した直後は、1秒ほど待つと再取得できます。一定時間内にロックの結果が返りませんでした再試行戻る |
| 2.9c | PASS | 再試行 (実クリック) してもロックが取れない間 [何も返らない (4秒のタイムアウト)] は garage のまま進行せず、失敗表示が出続ける | state=garage 経過=0.000s overlay=true |

## 3. 実キー入力

| ID | 結果 | 項目 | 実測・詳細 |
|---|---|---|---|
| 3.0 | PASS | 出撃直後: QB 未使用・EN満タン・待ち時間なし (出撃直後から使用可能) | count=0 EN=120/120 cd=0 |
| 3.1 | PASS | Q の実キー押下で QB が1回成立し、ENが36だけ低下 (直前と直後の値) | count=1 EN 120.000 -> 84.000 (低下 36.000000) qbLast=0 lastEnSpent=0 |
| 3.1b | PASS | QB 直後: horizontalMode=quickboost、噴射残り>0、水平速度≈80m/s | mode=quickboost 残り=0.142s 速度=80.000m/s |
| 3.2 | PASS | Q を5秒 (ゲーム時間) 押しっぱなし (keydown の repeat を多数送出) にしても、成功する QB は1回だけ。ENは QB の36以外で減らない | 保持 5.01s / repeat=trueのkeydown 100回 / count最大=1 / EN 最小 84.000 最大 120.000 終了時 120.000 (36以上に回復しており再発動可能だったが発動せず) cd=0.000 |
| 3.2b | PASS | QB(地上・時刻0)の後、EN は0.75秒まで回復せず、0.75秒以降はグライド中でも回復する (回復率15EN/秒) | 0.75秒までのEN=84.0,84.0,84.0,84.0,84.0,84.0,84.0,84.0,84.0,84.0,84.0,84.0,84.0,84.0 / 最初の増加 t=0.758s EN=84.125 / 回復中のモード=glide glideEnabled=true 接地=true / 回復率 15.00EN/秒 |
| 3.3 | PASS | Q を離して押し直す (前のQBから1.0秒以上後・EN>=36) と2回目の QB が成立し、ENが36低下 | 前 EN=120.000 cd=0.000 -> 後 count=2 EN=84.000 (低下 36.000000) |
| 3.4 | PASS | 前のQB開始から1.0秒未満の押下は不成立 (count・ENが変化しない) | count=2 EN 84.000 -> 84.000 cd=0.767 |
| 3.5 | PASS | 不成立だった押下は予約されず、クールダウン明けに勝手に発動しない | 1.2秒後 count=2 |
| 3.6 | PASS | QB 操作中にコンソールのエラー/警告が出ない | エラー0 / 警告0 |
| 3.7 | PASS | 2脚: 障害物のない地上で Q を1回押して全キーを離しても、0.75秒間に約42.60m (12.0 + 30.6) 移動し、噴射→慣性→自動グライドが続く | 移動 42.60m (QB開始 2.200s -> 2.950s) / モード quickboost,glide / 速度 t=0.10:quickboost/80.0m/s t=0.15:glide/80.0m/s t=0.20:glide/75.2m/s t=0.45:glide/51.0m/s t=0.75:glide/22.0m/s / 最小速度 22.0 / 方向保持 cos=1.00000 / 最後のキー操作 kd:KeyW,kd:KeyQ,ku:KeyQ,ku:KeyW |
| 3.8 | PASS | 4脚: 障害物のない地上で Q を1回押して全キーを離しても、0.75秒間に約34.08m (12.0 + 30.6 の0.80倍) 移動し、噴射→慣性→自動グライドが続く | 移動 34.08m (QB開始 2.400s -> 3.150s) / モード quickboost,glide / 速度 t=0.10:quickboost/64.0m/s t=0.15:glide/64.0m/s t=0.20:glide/60.1m/s t=0.45:glide/40.8m/s t=0.75:glide/17.6m/s / 最小速度 17.6 / 方向保持 cos=1.00000 / 最後のキー操作 kd:KeyW,kd:KeyQ,ku:KeyQ,ku:KeyW |
| 3.9 | PASS | 1/2/3 の実キーで武器 (machinegun/beam/missile) が切り替わる | Digit2->beam Digit3->missile Digit1->machinegun |
| 3.10 | PASS | 武器キーの keydown repeat では切り替わらない (押しっぱなしのリピートを無視) | Digit2(押下)→Digit1→Digit2(repeat) 後の武器=machinegun |
| 3.11 | PASS | マウス移動 (ポインターロック中の movementX) で視点が回る: 右へ200px -> yaw が 0.44rad 減少 (感度 0.0022rad/px) | yaw 3.1416 -> 2.7016 (差 0.4400rad, 期待 0.4400) |
| 3.12 | PASS | マウス移動 (movementY) でピッチが回る: 上へ150px -> 自由射撃の発射方向の仰角が約 +0.33rad 上がる | 発射方向の仰角 -0.0725 -> 0.2663 (差 0.3387rad, 期待 約0.33) |
| 3.13 | PASS | 左ボタンを押している間、マシンガンが射撃間隔0.10秒で連射される (1.0秒で10〜11発) | 残弾 298 -> 288 (消費 10) / 1.000s 押下 |
| 3.13b | PASS | 押している間だけ撃つ (離すと止まる) | 離して0.3秒後の残弾 288 で変化なし |
| 3.14 | PASS | ビーム: 左ボタン1回で1射、ENが8低下 (弾数は消費しない) | EN 120.000 -> 112.000 (低下 8.000000) shots=1 |
| 3.15 | PASS | ミサイル: 未ロックで発射すると弾を消費せず、NO LOCK が表示される | ミサイル 12 -> 12 / 通知=NO LOCK  未ロックのためミサイルは発射できません |
| 3.16 | PASS | Space 短押し = 通常ジャンプ (上向き初速10m/s、頂点≈2.8m、飛行にならず EN を消費しない) | 初速 9.70m/s 頂点 +2.78m モード rising,falling,grounded EN最小 120.000 (開始 120.000) |
| 3.17 | PASS | Space 長押し (0.20秒以上) = 飛行: 上昇速度8m/s、EN消費20EN/秒 | モード rising,flying / 飛行開始まで 0.25s / 上昇速度 8.00m/s / EN消費 20.00EN/秒 (EN 120.000 -> 110.000) |
| 3.18 | PASS | Space を離すと推進を止めて落下し、接地する (重力18m/s²) | 離した後のモード rising,falling,grounded 接地=true |
| 3.19 | PASS | EN回復は接地中かつ最後の消費から0.75秒以上経ってからだけ (飛行後の空中・待ち時間内では回復しない) | 飛行終了後 69サンプル: 増加14回 違反なし / 最後の消費 7.142s / 最初の増加 8.542s (最後の消費から 1.400s, 接地=true) |
| 3.20 | PASS | W/A/S/D の実キーで、カメラ向き基準に 10m/s (斜め移動でも増えない) | W(前) 10.00m/s cos=1.0000 / S(後) 10.00m/s cos=1.0000 / D(右) 10.00m/s cos=1.0000 / A(左) 10.00m/s cos=1.0000 / 斜め(W+D) 10.00m/s |
| 3.21 | PASS | 入力を離すと通常移動は停止へ向かって減速する (グライドOFF) | 離して0.3秒後 0.000m/s |
| 3.22 | PASS | Shift 1回押しでグライドON (押し続けなくてよい)、keydown の repeat では切り替わらず、離しても維持。もう1回押すとOFF、さらに押すとON | 初期=false 押下=true(glide) repeat×6後=true 離した後=true 再押下=false さらに押下=true |
| 3.23 | PASS | グライド: W で地上22m/s、W を離しても最後の方向へ速度を保って進み続ける。EN は減らない (0 EN) | W中 22.00m/s / 離して0.3秒後 22.00m/s / EN 120.000 -> 120.000 |
| 3.24 | PASS | 左Ctrl: グライドを解除して減速し、0へ向かう (horizontalMode=walk、速度は単調に減少) | 解除=true mode=walk 速度 20.0>17.0>14.0>11.0>8.0>5.0>2.0>0.0 最終 0.000m/s |
| 3.25 | PASS | 入力操作中にコンソールのエラー/警告が出ない | エラー0 / 警告0 |
| 3.26 | INFO | Space の keydown repeat (押しっぱなし) で空中ジャンプが再発動しない | 本ツールでは実機未検証 (sim 側は tests/player.test.ts / tests/audit-movement.test.ts、入力層は tests/uiLogic.test.ts の repeat 無視の試験で検証)。左Ctrl 中のQB不成立と HUD の BRAKE 表示は 3.35 で実機確認 |
| 3.30 | PASS | Q を keyboard.press (keydown と keyup がフレームを挟まず連続) で押すだけで QB が1回成立し (EN-36)、噴射・慣性・自動グライドが続いて0.75秒で約42.6m移動する | キー kd:KeyQ,ku:KeyQ (その間の rAF 0回) / 押下直後(フレーム前) count=0 -> 1フレーム後 count=1 EN低下 36.000000 / モード quickboost,glide 自動グライド=true / 0.75秒の移動 42.60m (期待 42.6) / 最終 count=1 |
| 3.31 | PASS | Space を keyboard.press (keydown/keyup が連続) で押すと通常ジャンプが1回起き (上向き初速≈10m/s)、飛行にならず EN を消費しない | 1フレーム後の上向き速度 9.85m/s モード rising,falling,grounded EN最小 118.500 (開始 118.500) |
| 3.32 | PASS | Shift を keyboard.press で押すとグライドが ON になり (離しても維持、保留の解放で再トグルされない)、もう1回 press で OFF に戻る | 初期=false press後=true 0.3秒後=true 2回目press後=false |
| 3.33 | PASS | 左クリック (mouse down+up が連続) でマシンガンが1発だけ発射される (押し続けていないので連射にならない) | 残弾 300 -> 299 -> 0.5秒後 299 / 射撃履歴 +1 |
| 3.35 | PASS | 左Ctrl (ブレーキ) を押している間は新しい QB が不成立 (EN・待ち時間を変えない) で、HUD の QB 表示は READY ではなく BRAKE。離すと READY に戻り、Q で QB が成立する | HUD: 通常「READY」 -> Ctrl押下中「BRAKE Ctrl解除」(data-qb=BRAKE) -> 離した後「READY」 / Ctrl押下中に Q を press: count 1 -> 1 EN 120.000 -> 120.000 / 離して press: count -> 2 |
| 3.36 | PASS | 素早いタップ入力の試験中にコンソールのエラー/警告が出ない | エラー0 / 警告0 |

## 4-5. 一時停止 / 失敗・結果 / 再出撃

| ID | 結果 | 項目 | 実測・詳細 |
|---|---|---|---|
| 4.0 | PASS | 実ステージで出撃: 敵45体・全員 alive・制御砲台0/6・隔壁なし | 敵=45 alive=45 位置=12.0,1.5,14.0 |
| 4.1 | PASS | 実ステージを W + マウス視点で歩き、警備ロボットの攻撃を受ける (被弾方向・予告のHUDも確認) | t=6.1s 位置=37.6,1.5,61.5 HP=964 alert=G01,G02 |
| 4.1a | PASS | 一時停止 [Esc キー (page.keyboard.press)]: state=paused、一時停止画面が出て、ロックが解除される | state=paused 画面=true ロック=released 理由=「Escキーが押されました」 HUD表示=true |
| 4.1b | PASS | 一時停止中 (3秒分のフレームを実行) に 経過時間・HP・EN・ロック・QB待ち時間・敵の位置/HP/射撃数 が進まない (スナップショット全体が不変) | 経過 8.2000 -> 8.2000 / HP 964.0 -> 964.0 / EN 104.25 -> 104.25 / 敵 alive 45 全体一致=true / その間の rAF 30回 (ループは動作中) / 直前の1秒に動いていた敵=true |
| 4.1c | PASS | 再開ボタンの実クリックでロックを再取得して playing。停止中の時間はまとめて加算されず (再開時点で経過時間が同じ、1フレーム後も +0.05秒以内)、クリックが射撃にならない | ロック=game-canvas 経過 8.2000 -> 再開直後 8.2000 -> +1フレーム 8.2500 / MG 300 -> 300 / 射撃履歴 0 -> 0 |
| 4.1d | PASS | 一時停止で入力状態が解除される: 再開後、新しいキー操作が来るまで移動入力は無効 (S を押したままでも desiredDirection=[0,0]。グライド中は保持したグライド方向のまま) | 停止前 desiredDir=-0.57,-0.82 -> 再開後(キー操作なし) -0.5706,-0.8212 (グライド保持 (glideEnabled=true mode=glide)) |
| 4.1e | PASS | 復帰時に Q を押しっぱなし (keydown repeat) にしていても新しい押下として扱われず QB が発動しない (EN>=36・待ち時間0で再発動可能な状態) | qbCount 1 -> 1 / 復帰時 EN=105.0 cd=0.00 / 移動入力は復帰 desiredDir=-0.57,-0.82 |
| 4.2a | PASS | 一時停止 [ポインターロック喪失 (document.exitPointerLock。keydown なし)]: state=paused、一時停止画面が出て、ロックが解除される | state=paused 画面=true ロック=released 理由=「ポインターロックが解除されました (Esc)」 HUD表示=true |
| 4.2b | PASS | 一時停止中 (3秒分のフレームを実行) に 経過時間・HP・EN・ロック・QB待ち時間・敵の位置/HP/射撃数 が進まない (スナップショット全体が不変) | 経過 9.7500 -> 9.7500 / HP 964.0 -> 964.0 / EN 120.00 -> 120.00 / 敵 alive 45 全体一致=true / その間の rAF 30回 (ループは動作中) / 直前の1秒に動いていた敵=true |
| 4.2c | PASS | 再開ボタンの実クリックでロックを再取得して playing。停止中の時間はまとめて加算されず (再開時点で経過時間が同じ、1フレーム後も +0.05秒以内)、クリックが射撃にならない | ロック=game-canvas 経過 9.7500 -> 再開直後 9.7500 -> +1フレーム 9.8000 / MG 300 -> 300 / 射撃履歴 0 -> 0 |
| 4.2d | PASS | 一時停止で入力状態が解除される: 再開後、新しいキー操作が来るまで移動入力は無効 (S を押したままでも desiredDirection=[0,0]。グライド中は保持したグライド方向のまま) | 停止前 desiredDir=-0.57,-0.82 -> 再開後(キー操作なし) -0.5706,-0.8212 (グライド保持 (glideEnabled=true mode=glide)) |
| 4.2e | PASS | 復帰時に Q を押しっぱなし (keydown repeat) にしていても新しい押下として扱われず QB が発動しない (EN>=36・待ち時間0で再発動可能な状態) | qbCount 1 -> 1 / 復帰時 EN=120.0 cd=0.00 / 移動入力は復帰 desiredDir=-0.57,-0.82 |
| 4.3a | PASS | 一時停止 [ウィンドウのフォーカス喪失 (別タブを前面化 -> ポインターロック喪失)]: state=paused、一時停止画面が出て、ロックが解除される | state=paused 画面=true ロック=released 理由=「ポインターロックが解除されました (Esc)」 HUD表示=true |
| 4.3b | PASS | 一時停止中 (3秒分のフレームを実行) に 経過時間・HP・EN・ロック・QB待ち時間・敵の位置/HP/射撃数 が進まない (スナップショット全体が不変) | 経過 11.3000 -> 11.3000 / HP 964.0 -> 964.0 / EN 120.00 -> 120.00 / 敵 alive 45 全体一致=true / その間の rAF 30回 (ループは動作中) / 直前の1秒に動いていた敵=true |
| 4.3c | PASS | 再開ボタンの実クリックでロックを再取得して playing。停止中の時間はまとめて加算されず (再開時点で経過時間が同じ、1フレーム後も +0.05秒以内)、クリックが射撃にならない | ロック=game-canvas 経過 11.3000 -> 再開直後 11.3000 -> +1フレーム 11.3500 / MG 300 -> 300 / 射撃履歴 0 -> 0 |
| 4.3d | PASS | 一時停止で入力状態が解除される: 再開後、新しいキー操作が来るまで移動入力は無効 (S を押したままでも desiredDirection=[0,0]。グライド中は保持したグライド方向のまま) | 停止前 desiredDir=-0.57,-0.82 -> 再開後(キー操作なし) -0.5706,-0.8212 (グライド保持 (glideEnabled=true mode=glide)) |
| 4.3e | PASS | 復帰時に Q を押しっぱなし (keydown repeat) にしていても新しい押下として扱われず QB が発動しない (EN>=36・待ち時間0で再発動可能な状態) | qbCount 1 -> 1 / 復帰時 EN=120.0 cd=0.00 / 移動入力は復帰 desiredDir=-0.57,-0.82 |
| 4.4a | SYNTH | 一時停止 [window の blur イベント (合成)] (合成イベント): state=paused、一時停止画面が出て、ロックが解除される | state=paused 画面=true ロック=released 理由=「ウィンドウがフォーカスを失いました」 HUD表示=true |
| 4.4b | PASS | 一時停止中 (3秒分のフレームを実行) に 経過時間・HP・EN・ロック・QB待ち時間・敵の位置/HP/射撃数 が進まない (スナップショット全体が不変) | 経過 12.8500 -> 12.8500 / HP 964.0 -> 964.0 / EN 120.00 -> 120.00 / 敵 alive 45 全体一致=true / その間の rAF 30回 (ループは動作中) / 直前の1秒に動いていた敵=true |
| 4.4c | PASS | 再開ボタンの実クリックでロックを再取得して playing。停止中の時間はまとめて加算されず (再開時点で経過時間が同じ、1フレーム後も +0.05秒以内)、クリックが射撃にならない | ロック=game-canvas 経過 12.8500 -> 再開直後 12.8500 -> +1フレーム 12.9000 / MG 300 -> 300 / 射撃履歴 0 -> 0 |
| 4.4d | PASS | 一時停止で入力状態が解除される: 再開後、新しいキー操作が来るまで移動入力は無効 (S を押したままでも desiredDirection=[0,0]。グライド中は保持したグライド方向のまま) | 停止前 desiredDir=-0.57,-0.82 -> 再開後(キー操作なし) -0.5706,-0.8212 (グライド保持 (glideEnabled=true mode=glide)) |
| 4.4e | PASS | 復帰時に Q を押しっぱなし (keydown repeat) にしていても新しい押下として扱われず QB が発動しない (EN>=36・待ち時間0で再発動可能な状態) | qbCount 1 -> 1 / 復帰時 EN=120.0 cd=0.00 / 移動入力は復帰 desiredDir=-0.57,-0.82 |
| 4.5a | SYNTH | 一時停止 [visibilitychange (document.hidden=true。合成)] (合成イベント): state=paused、一時停止画面が出て、ロックが解除される | state=paused 画面=true ロック=released 理由=「タブが非表示になりました」 HUD表示=true |
| 4.5b | PASS | 一時停止中 (3秒分のフレームを実行) に 経過時間・HP・EN・ロック・QB待ち時間・敵の位置/HP/射撃数 が進まない (スナップショット全体が不変) | 経過 14.4000 -> 14.4000 / HP 910.0 -> 910.0 / EN 120.00 -> 120.00 / 敵 alive 45 全体一致=true / その間の rAF 30回 (ループは動作中) / 直前の1秒に動いていた敵=true |
| 4.5c | PASS | 再開ボタンの実クリックでロックを再取得して playing。停止中の時間はまとめて加算されず (再開時点で経過時間が同じ、1フレーム後も +0.05秒以内)、クリックが射撃にならない | ロック=game-canvas 経過 14.4000 -> 再開直後 14.4000 -> +1フレーム 14.4500 / MG 300 -> 300 / 射撃履歴 0 -> 0 |
| 4.5d | PASS | 一時停止で入力状態が解除される: 再開後、新しいキー操作が来るまで移動入力は無効 (S を押したままでも desiredDirection=[0,0]。グライド中は保持したグライド方向のまま) | 停止前 desiredDir=-0.57,-0.82 -> 再開後(キー操作なし) -0.5706,-0.8212 (グライド保持 (glideEnabled=true mode=glide)) |
| 4.5e | PASS | 復帰時に Q を押しっぱなし (keydown repeat) にしていても新しい押下として扱われず QB が発動しない (EN>=36・待ち時間0で再発動可能な状態) | qbCount 1 -> 1 / 復帰時 EN=120.0 cd=0.00 / 移動入力は復帰 desiredDir=-0.57,-0.82 |
| 4.6 | PASS | 一時停止の試験中、交戦中の敵が実際に動いていた (敵位置の不変が自明でないことの確認) | 動いた敵あり=true |
| 4.7 | PASS | 一時停止画面の「操作方法」から操作説明が見られる (Q単発36EN・自動グライド等を含む) | visible=true |
| 4.8 | PASS | その操作説明を Esc で閉じても一時停止のまま (勝手に再開しない) | state=paused |
| 4.9 | PASS | 一時停止の全試験後も、ここまで警備ロボットの攻撃で HP が減っている (実際の被弾) | HP=856 |
| 5.1 | PASS | 敵の射線に入って HP 0 まで実際に到達し、state=failed になる (hp<=0) | state=failed HP=0.00 経過=26.97s 位置=24.8,1.5,2.8 |
| 5.2 | PASS | 結果画面: MISSION FAILED・理由 (HP 0)・経過時間・撃破数・制御砲台数と、「同じ構成で再出撃」「格納庫へ戻る」が出る。HP0後、戦闘の更新は停止し、ロックも解除される | title=MISSION FAILED 理由=「機体が大破しました (HP 0)」 行={"経過時間":"00:27.0","撃破数":"0 / 45","制御砲台":"0 / 6","被ダメージ":"1008","通過区画数":"1 / 20"} ボタン=同じ構成で再出撃 / 格納庫へ戻る 経過(stateのformatTime)=00:27.0 失敗後20フレームの経過 26.9750 -> 26.9750 HUD非表示=true ロック=null |
| 5.3 | PASS | failed 状態のスナップショットが SPEC §10 の構造と一致 (NaN/Infinity なし) | キー・型・列挙値が一致 |
| 5.4 | UNVERIFIED | クリア (cleared) の結果画面・再出撃 | 実ステージのクリア (6体の制御砲台の破壊 + 15区画・1500m の踏破) には本ツールの歩行ドライバーでは到達できなかったため実機では未確認。結果画面の表示モデルは tests/hud.test.ts の「6体全て破壊 → 最終ゲート開放 → 脱出可能表示 → 脱出領域でクリア (結果画面の値も state 由来)」で実際の Game を使って検証済み (DOM 表示は failed と同じコード経路) |
| 5.5a | PASS | 再出撃 1回目: 位置・速度・HP・EN・弾数・全45体・隔壁・ゲート・目標・ロック・QB・経過時間が出撃直後と完全に同じ (スナップショット全体の差分0)、ロック再取得、結果画面が消える | 差分 0件 / 位置=12,1.5,14 (出撃位置=12,1.5,14) HP=1000 EN=120 弾=300/12 敵alive=45 隔壁=[] ゲート=false 経過=0 qb=0 glide=false ロック=game-canvas |
| 5.5b | PASS | 再出撃 1回目: 更新ループが重複していない — 5フレーム(各dt=100ms)で elapsedSeconds が0.5秒だけ進み (2倍速でない)、rAF は1フレームにつき1回 | Δelapsed=0.5000 (期待0.5000) / rAF 5回 (期待5) |
| 5.5c | PASS | 再出撃 1回目: イベントリスナーが重複していない — Q 1回押下で QB 成功1回 (EN-36)、マウス100pxで yaw 0.22rad、window/document のリスナー数と DOM の主要ノード数が1回目の出撃時と同じ | qbCount=1 EN低下=36.0000 / yaw差=0.2200rad (期待0.2200) / リスナー差分=なし (window/document 合計 31件) / DOM差分=なし |
| 5.5d | PASS | 再出撃 1回目の後も、再び HP 0 まで実際に到達して失敗の結果画面が出る | state=failed 経過=17.1s 画面=true MISSION FAILED |
| 5.6a | PASS | 再出撃 2回目: 位置・速度・HP・EN・弾数・全45体・隔壁・ゲート・目標・ロック・QB・経過時間が出撃直後と完全に同じ (スナップショット全体の差分0)、ロック再取得、結果画面が消える | 差分 0件 / 位置=12,1.5,14 (出撃位置=12,1.5,14) HP=1000 EN=120 弾=300/12 敵alive=45 隔壁=[] ゲート=false 経過=0 qb=0 glide=false ロック=game-canvas |
| 5.6b | PASS | 再出撃 2回目: 更新ループが重複していない — 5フレーム(各dt=100ms)で elapsedSeconds が0.5秒だけ進み (2倍速でない)、rAF は1フレームにつき1回 | Δelapsed=0.5000 (期待0.5000) / rAF 5回 (期待5) |
| 5.6c | PASS | 再出撃 2回目: イベントリスナーが重複していない — Q 1回押下で QB 成功1回 (EN-36)、マウス100pxで yaw 0.22rad、window/document のリスナー数と DOM の主要ノード数が1回目の出撃時と同じ | qbCount=1 EN低下=36.0000 / yaw差=0.2200rad (期待0.2200) / リスナー差分=なし (window/document 合計 31件) / DOM差分=なし |
| 5.6d | PASS | 再出撃 2回目の後も、再び HP 0 まで実際に到達して失敗の結果画面が出る | state=failed 経過=17.1s 画面=true MISSION FAILED |
| 5.7a | PASS | 再出撃 3回目: 位置・速度・HP・EN・弾数・全45体・隔壁・ゲート・目標・ロック・QB・経過時間が出撃直後と完全に同じ (スナップショット全体の差分0)、ロック再取得、結果画面が消える | 差分 0件 / 位置=12,1.5,14 (出撃位置=12,1.5,14) HP=1000 EN=120 弾=300/12 敵alive=45 隔壁=[] ゲート=false 経過=0 qb=0 glide=false ロック=game-canvas |
| 5.7b | PASS | 再出撃 3回目: 更新ループが重複していない — 5フレーム(各dt=100ms)で elapsedSeconds が0.5秒だけ進み (2倍速でない)、rAF は1フレームにつき1回 | Δelapsed=0.5000 (期待0.5000) / rAF 5回 (期待5) |
| 5.7c | PASS | 再出撃 3回目: イベントリスナーが重複していない — Q 1回押下で QB 成功1回 (EN-36)、マウス100pxで yaw 0.22rad、window/document のリスナー数と DOM の主要ノード数が1回目の出撃時と同じ | qbCount=1 EN低下=36.0000 / yaw差=0.2200rad (期待0.2200) / リスナー差分=なし (window/document 合計 31件) / DOM差分=なし |
| 5.7d | PASS | 再出撃 3回目の後も、再び HP 0 まで実際に到達して失敗の結果画面が出る | state=failed 経過=17.1s 画面=true MISSION FAILED |
| 5.8 | PASS | 「格納庫へ戻る」で格納庫 (state=garage、経過0、敵45体alive) に戻り、結果画面・HUDが消える | state=garage 経過=0 格納庫=true 結果画面=false HUD=false |
| 5.9 | PASS | 格納庫からの再出撃でも出撃直後の状態と完全に同じ (差分0) | 差分 0件 |
| 5.10 | PASS | 再出撃を繰り返しても JS ヒープ (GC後) が増え続けない (3回目が1回目の再出撃時と比べ +8MB 以内、かつ +30% 以内) | 1回目の出撃 (t=0): 29.8MB / 再出撃1回目 (t≈1s): 37.4MB / 再出撃2回目 (t≈1s): 37.7MB / 再出撃3回目 (t≈1s): 37.8MB / 格納庫経由の出撃 (t≈0.5s): 37.8MB |
| 5.11 | PASS | 戦闘・一時停止・失敗・再出撃の全体を通して、コンソールのエラー/警告が出ない | エラー0 / 警告0 |

## 6. リサイズ

| ID | 結果 | 項目 | 実測・詳細 |
|---|---|---|---|
| 6.g1280x720 | PASS | 格納庫 1280x720: canvas が全面に追従、パネルと出撃ボタンが画面内、ページのスクロールなし、lock.radiusCssPx = 0.20 x min(w,h) | canvas 表示 1280x720 描画 1280x720 / 画面外のパネル=なし / scroll 1280x720 / radius 144.000 (期待 144.000) / パネル内部スクロール 589/589 589/589 |
| 6.g1600x900 | PASS | 格納庫 1600x900: canvas が全面に追従、パネルと出撃ボタンが画面内、ページのスクロールなし、lock.radiusCssPx = 0.20 x min(w,h) | canvas 表示 1600x900 描画 1600x900 / 画面外のパネル=なし / scroll 1600x900 / radius 180.000 (期待 180.000) / パネル内部スクロール 737/737 737/737 |
| 6.g1920x1080 | PASS | 格納庫 1920x1080: canvas が全面に追従、パネルと出撃ボタンが画面内、ページのスクロールなし、lock.radiusCssPx = 0.20 x min(w,h) | canvas 表示 1920x1080 描画 1920x1080 / 画面外のパネル=なし / scroll 1920x1080 / radius 216.000 (期待 216.000) / パネル内部スクロール 886/886 886/886 |
| 6.g2560x1440 | PASS | 格納庫 2560x1440: canvas が全面に追従、パネルと出撃ボタンが画面内、ページのスクロールなし、lock.radiusCssPx = 0.20 x min(w,h) | canvas 表示 2560x1440 描画 2560x1440 / 画面外のパネル=なし / scroll 2560x1440 / radius 288.000 (期待 288.000) / パネル内部スクロール 1182/1182 1182/1182 |
| 6.g1024x768 | PASS | 格納庫 1024x768: canvas が全面に追従、パネルと出撃ボタンが画面内、ページのスクロールなし、lock.radiusCssPx = 0.20 x min(w,h) | canvas 表示 1024x768 描画 1024x768 / 画面外のパネル=なし / scroll 1024x768 / radius 153.600 (期待 153.600) / パネル内部スクロール 629/629 629/629 |
| 6.p1280x720 | PASS | プレイ中 1280x720: FCS円の画面上の半径 = 0.20 x min(w,h) (DOM の円 = snapshot.lock.radiusCssPx)・中心が画面中央、canvas と HUD が追従、HUD が画面外へはみ出さない・重ならない | 円 r=144.00px (期待 144.00) 中心 (640.0,360.0) / canvas 1280x720 描画 1280x720 / HUDパネル面積 13.3% / 画面外0・重なり0 |
| 6.p1600x900 | PASS | プレイ中 1600x900: FCS円の画面上の半径 = 0.20 x min(w,h) (DOM の円 = snapshot.lock.radiusCssPx)・中心が画面中央、canvas と HUD が追従、HUD が画面外へはみ出さない・重ならない | 円 r=180.00px (期待 180.00) 中心 (800.0,450.0) / canvas 1600x900 描画 1600x900 / HUDパネル面積 13.1% / 画面外0・重なり0 |
| 6.p1920x1080 | PASS | プレイ中 1920x1080: FCS円の画面上の半径 = 0.20 x min(w,h) (DOM の円 = snapshot.lock.radiusCssPx)・中心が画面中央、canvas と HUD が追従、HUD が画面外へはみ出さない・重ならない | 円 r=216.00px (期待 216.00) 中心 (960.0,540.0) / canvas 1920x1080 描画 1920x1080 / HUDパネル面積 13.0% / 画面外0・重なり0 |
| 6.p2560x1440 | PASS | プレイ中 2560x1440: FCS円の画面上の半径 = 0.20 x min(w,h) (DOM の円 = snapshot.lock.radiusCssPx)・中心が画面中央、canvas と HUD が追従、HUD が画面外へはみ出さない・重ならない | 円 r=288.00px (期待 288.00) 中心 (1280.0,720.0) / canvas 2560x1440 描画 2560x1440 / HUDパネル面積 12.9% / 画面外0・重なり0 |
| 6.p1024x768 | PASS | プレイ中 1024x768: FCS円の画面上の半径 = 0.20 x min(w,h) (DOM の円 = snapshot.lock.radiusCssPx)・中心が画面中央、canvas と HUD が追従、HUD が画面外へはみ出さない・重ならない (下限未満でも壊れない) | 円 r=153.60px (期待 153.60) 中心 (512.0,384.0) / canvas 1024x768 描画 1024x768 / HUDパネル面積 17.4% / 画面外0・重なり0 |
| 6.dlg | PASS | 一時停止ダイアログが 1024x768 でも画面内に収まる | rect=225,280-799,488 内部スクロール=false |
| 6.back | PASS | 縮小・拡大を繰り返した後 1280x720 に戻すと円の半径も元 (144px) に戻る | snapshot=144.000 DOM=144.00 |
| 6.log | PASS | リサイズ中にコンソールのエラー/警告が出ない | エラー0 / 警告0 |
| 6.sum | INFO | 各サイズの判定円 | 1280x720: 円 r=144.0 (期待 144.0) HUDパネルの面積率 13.3% ; 1600x900: 円 r=180.0 (期待 180.0) HUDパネルの面積率 13.1% ; 1920x1080: 円 r=216.0 (期待 216.0) HUDパネルの面積率 13.0% ; 2560x1440: 円 r=288.0 (期待 288.0) HUDパネルの面積率 12.9% ; 1024x768: 円 r=153.6 (期待 153.6) HUDパネルの面積率 17.4% |

## 7. AK2_BENCH

| ID | 結果 | 項目 | 実測・詳細 |
|---|---|---|---|
| 7.1 | PASS | window.AK2_BENCH のキーが getSnapshot のみ (関数・引数なし・凍結) | keys=["getSnapshot"] ownNames=["getSnapshot"] frozen=true typeof=function arity=0 |
| 7.2 | PASS | アプリが window に足した名前は AK2_BENCH だけ (ゲーム状態を直接触れる名前が生えていない。three.js 自身のリビジョン印 __THREE__ を除く) | 同じオリジンの空ページとの差分 (e2e の注入を除く) = ["__THREE__","AK2_BENCH"] (__THREE__="186" は three.js のバージョン文字列) |
| 7.3 | PASS | スナップショットのキー構造が SPEC §10 の型と一致 (期待キー集合・typeof・列挙値・配列長を自動比較。garage / playing / 射撃後 / paused。failed は 5.3、garage は 2.0 でも確認) | garage:garage playing:playing playing-fired:playing paused:paused の全てで差異0 (version=AK2-1.2-candidate enemies=45 recentPlayerShots=0) |
| 7.4 | PASS | スナップショットに NaN / Infinity がない (生の値を走査し、JSON 往復でも値が変わらない) | 4状態の全ての数値が有限 |
| 7.5 | PASS | 仕様の固定値: version=AK2-1.2-candidate、敵45体 (警備30・砲台15・制御砲台6)、controlsRequired=6、totalEnemies=45、sectorCount>=15、位置/速度は [x,y,z] | guard=30 turret=15 control=6 sectorCount=20 固有ID=45 |
| 7.6 | PASS | getSnapshot() の返却値 (全階層) を書き換えても、次の getSnapshot() (=ゲーム状態) は変わらない。AK2_BENCH への代入・追加もできない | 書き換え前後のスナップショット全体一致=true / 代入後も getSnapshot は object を返す keys=["getSnapshot"] (代入が例外=false, 追加が例外=false。非strictでは黙って無視) |
| 7.7 | PASS | 書き換えた値が実際のゲームに影響していない (再開して1秒進めても HP・EN・敵数・位置が正常) | HP 1000 -> 1000 EN=120.0 敵=45 alive=45 x=12.0 |
| 7.8 | PASS | 同じシード・構成・入力・フレーム列の2回の実行が完全に同じ状態になる (再現性)。片方は各フレームで getSnapshot() を繰り返し呼んでおり、呼び出しがゲーム進行に影響しないことも示す | 経過 3.500s 位置 2.800,1.500,41.200 差分 0件 |
| 7.9 | PASS | URL の ?seed= が反映され (32bit符号なし整数)、未指定は 20260908、不正値 (非数字・負数・小数・範囲外・空・16進・不正なパーセントエンコード) は既定値になり、コンソールにエラーが出ない | (なし)→20260908 ?seed=123→123 ?seed=0→0 ?seed=4294967295→4294967295 ?seed=4294967296→20260908 ?seed=abc→20260908 ?seed=-1→20260908 ?seed=1.5→20260908 ?seed=→20260908 ?seed=0x10→20260908 ?seed=%→20260908 ?seed=%E0%A4%A→20260908 ?seed=0042→42 ?a=1&seed=77→77 / コンソールのエラー・警告 0件 |
| 7.10 | PASS | ?seed=123 で出撃しても seed は 123 のまま (出撃・再出撃でシードが保持される) | seed=123 state=playing |

## 8. 実プレイ画面の見た目 (HUD)

| ID | 結果 | 項目 | 実測・詳細 |
|---|---|---|---|
| 8.1 | PASS | SPEC §8 の HUD 要素が全て表示されている (中央FCS円/照準・左武器/残弾・右EN・下HP・区画・次の目標・制御砲台0/6・隔壁・最終ゲート・移動モード・QB可否・次のQBまで) | 13項目 全て表示 |
| 8.2 | PASS | 制御砲台マーカー: 密集せず最大3個 (次の目標を強調 + 近い順)、ラベルが互いに重ならない | 制御砲台マーカー 3個 [NEXT T03 310m ← \| T11 227m \| T08 484m] / ラベルの重なり なし |
| 8.3 | PASS | HUD パネルが画面を覆っていない (6パネルは四隅と上下の縁に置かれ、画面中央の60%x60%に入らない。面積率は15%以下 = 半透明のパネルのみ) | パネル面積率 13.3% / 中央領域に入るパネル=なし |
| 8.4 | PASS | 敵が見える位置まで実ステージを歩いた | t=5.5s 位置=31.2,1.5,53.3 射線のある敵=G01 |
| 8.5 | PASS | ロック取得中は、円が点線・進捗リング・「LOCKING nn%」・FCSパネル「取得中」で区別できる | progress=0.35 円class=hud-reticle ret-acquiring ラベル=「LOCKING 35%」 FCS=「FCS取得中 35%LOCK IDG01 警備ロボット 45m補正待機」 |
| 8.6 | PASS | ロック完了は、円が実線+四隅の目盛り・「LOCKED」・FCSパネル「ロック完了」・対象マーカーと補正照準マーカー (別の形) で区別できる | 対象=G01 fc.status=solved 円class=hud-reticle ret-locked 補正表示=「補正中 偏差+重力」 マーカー=hud-mk-control.next,hud-mk-control.dim,hud-mk-control.dim,hud-mk-target.locked,hud-mk-aim.solved |
| 8.7 | PASS | ロック中の画面のマーカーラベルの重なり | 重なりなし |
| 8.8 | PASS | 被弾方向 (HUDのウェッジ) と射撃予告マーカー | 被弾方向ウェッジ 3個 / 射撃予告マーカー 0個 / 通知=なし |
| 8.9 | PASS | 実際の射撃が行われた (射撃履歴・弾数・EN が state に反映され、HUDと一致) | 射撃履歴 4件 (machinegun,missile,beam) MG=298 MS=11 EN=112.0 敵HP=G01:56 |
| 8.10 | PASS | 実プレイ (歩行・ロック・射撃・被弾) 中にコンソールのエラー/警告が出ない | エラー0 / 警告0 |

## 9. 性能

| ID | 結果 | 項目 | 実測・詳細 |
|---|---|---|---|
| 9.1 | INFO | 実ステージ (1280x720, SwiftShader ソフトウェア描画) の実時間の fps とゲーム時間/実時間 | 8.0秒間: rAF 39回 = 4.87fps / ゲーム時間 7.80s = 実時間の 0.974倍 (fpsが低いときは1フレームの進行を0.25秒に制限するため1倍未満) / マシン負荷 loadavg 48->48 (他の作業と並行のため参考値。SwiftShader は GPU ではなく CPU で描く) |
| 9.2 | PASS | ゲーム時間が実時間より速く進まない (更新ループの重複なし。実時間比 <= 1.05) | 実時間比 0.974 |
| 9.3 | INFO | 実ステージ歩行中の1フレーム (dt=16ms) あたりのメインスレッド時間 (CDP Performance.getMetrics の差分 / 120フレーム) | LayoutDuration 0.00ms / RecalcStyleDuration 0.01ms / DevToolsCommandDuration 185.27ms / ScriptDuration 0.00ms / V8CompileDuration 0.00ms / TaskDuration 185.47ms / TaskOtherDuration 0.19ms (TaskDuration の大半は SwiftShader への描画コマンド発行と同期待ちで、マシン負荷 loadavg 51 の影響を強く受ける参考値。JS の sim/HUD だけの時間ではない) |
| 9.4 | INFO | 参考: 性能計測時の状態 | elapsed=2.40s speed=10.0m/s HP=1000 |
| 9.5 | INFO | 再出撃を繰り返したときの JS ヒープ (GC後) | 5.10 を参照 (performance.memory ではなく CDP の Runtime.getHeapUsage を HeapProfiler.collectGarbage の直後に測定) |

## 撮影した画像

- `test-results/e2e/e2e-hangar-boot.png` — 起動直後の格納庫 (実時間描画)
- `test-results/e2e/e2e-hangar-biped.png` — 格納庫: 2脚 (中範囲FCS・均衡・2脚)
- `test-results/e2e/e2e-hangar-quad.png` — 格納庫: 4脚 (中範囲FCS・均衡・4脚)
- `test-results/e2e/e2e-hangar-quad-turn1.png` — 格納庫: 4脚 (回転後 4.5秒)
- `test-results/e2e/e2e-hangar-quad-turn2.png` — 格納庫: 4脚 (回転後 8.5秒)
- `test-results/e2e/e2e-help.png` — 格納庫から開いた操作説明
- `test-results/e2e/e2e-lockerror-resume.png` — ポインターロック取得失敗の表示 (再開時)
- `test-results/e2e/e2e-lockerror-sortie.png` — ポインターロック取得失敗の表示 (出撃時)
- `test-results/e2e/e2e-combat-first-hit.png` — 交戦開始 (最初の被弾。ロック・補正マーカー・予告・被弾方向)
- `test-results/e2e/e2e-pause-help.png` — 一時停止画面から開いた操作説明
- `test-results/e2e/e2e-pause.png` — 一時停止画面
- `test-results/e2e/e2e-result-failed.png` — 失敗の結果画面
- `test-results/e2e/e2e-retry-start.png` — 再出撃直後 (初期化された状態のHUD)
- `test-results/e2e/e2e-garage-1920x1080.png` — 格納庫 1920x1080
- `test-results/e2e/e2e-garage-1024x768.png` — 格納庫 1024x768 (下限未満)
- `test-results/e2e/e2e-hud-1920x1080.png` — プレイ中のHUD 1920x1080
- `test-results/e2e/e2e-hud-2560x1440.png` — プレイ中のHUD 2560x1440
- `test-results/e2e/e2e-hud-1024x768.png` — プレイ中のHUD 1024x768
- `test-results/e2e/e2e-hud-start.png` — 出撃直後のHUD (1280x720)
- `test-results/e2e/e2e-hud-lock-acquiring.png` — ロック取得中 (進捗リング・LOCKING nn%・対象マーカー)
- `test-results/e2e/e2e-hud-locked-mg.png` — ロック完了 (マシンガン): 対象マーカー・補正照準マーカー・補正中の文字
- `test-results/e2e/e2e-fx-mg-fire.png` — マシンガン射撃中 (弾道・銃口の閃光・命中)
- `test-results/e2e/e2e-fx-missile-fire.png` — ハンドミサイル発射後 (ロック中)
- `test-results/e2e/e2e-fx-beam-fire.png` — ビーム射撃 (射線)

## JSON (要約。全文は標準出力 / node_modules/.cache/ak2-e2e/result.json)

```json
{"meta":{"date":"2026-09-30T05:26:09.107Z","url":"http://127.0.0.1:5210","chromium":"149.0.7827.3","loadavg":{"before":[184.1,133.9,97.4],"after":[52.4,77.1,89.3]},"cpus":10,"seconds":780,"summary":{"pass":141,"fail":0,"synthetic":2,"unverified":1,"info":9}},"status":{"1.1":"pass","1.2":"pass","1.3":"pass","1.4":"pass","1.5":"info","1.6":"pass","1.7":"info","1.8":"pass","1.9":"pass","1.10":"pass","1.11":"pass","2.0":"pass","2.1":"pass","2.2":"pass","2.3":"pass","2.4":"pass","2.5":"pass","2.6":"pass","2.7":"info","2.8a":"pass","2.9a":"pass","2.10":"pass","2.11":"pass","2.8b":"pass","2.9b":"pass","2.8c":"pass","2.9c":"pass","3.0":"pass","3.1":"pass","3.1b":"pass","3.2":"pass","3.2b":"pass","3.3":"pass","3.4":"pass","3.5":"pass","3.6":"pass","3.7":"pass","3.8":"pass","3.9":"pass","3.10":"pass","3.11":"pass","3.12":"pass","3.13":"pass","3.13b":"pass","3.14":"pass","3.15":"pass","3.16":"pass","3.17":"pass","3.18":"pass","3.19":"pass","3.20":"pass","3.21":"pass","3.22":"pass","3.23":"pass","3.24":"pass","3.25":"pass","3.26":"info","3.30":"pass","3.31":"pass","3.32":"pass","3.33":"pass","3.35":"pass","3.36":"pass","4.0":"pass","4.1":"pass","4.1a":"pass","4.1b":"pass","4.1c":"pass","4.1d":"pass","4.1e":"pass","4.2a":"pass","4.2b":"pass","4.2c":"pass","4.2d":"pass","4.2e":"pass","4.3a":"pass","4.3b":"pass","4.3c":"pass","4.3d":"pass","4.3e":"pass","4.4a":"synthetic","4.4b":"pass","4.4c":"pass","4.4d":"pass","4.4e":"pass","4.5a":"synthetic","4.5b":"pass","4.5c":"pass","4.5d":"pass","4.5e":"pass","4.6":"pass","4.7":"pass","4.8":"pass","4.9":"pass","5.1":"pass","5.2":"pass","5.3":"pass","5.4":"unverified","5.5a":"pass","5.5b":"pass","5.5c":"pass","5.5d":"pass","5.6a":"pass","5.6b":"pass","5.6c":"pass","5.6d":"pass","5.7a":"pass","5.7b":"pass","5.7c":"pass","5.7d":"pass","5.8":"pass","5.9":"pass","5.10":"pass","5.11":"pass","6.g1280x720":"pass","6.g1600x900":"pass","6.g1920x1080":"pass","6.g2560x1440":"pass","6.g1024x768":"pass","6.p1280x720":"pass","6.p1600x900":"pass","6.p1920x1080":"pass","6.p2560x1440":"pass","6.p1024x768":"pass","6.dlg":"pass","6.back":"pass","6.log":"pass","6.sum":"info","7.1":"pass","7.2":"pass","7.3":"pass","7.4":"pass","7.5":"pass","7.6":"pass","7.7":"pass","7.8":"pass","7.9":"pass","7.10":"pass","8.1":"pass","8.2":"pass","8.3":"pass","8.4":"pass","8.5":"pass","8.6":"pass","8.7":"pass","8.8":"pass","8.9":"pass","8.10":"pass","9.1":"info","9.2":"pass","9.3":"info","9.4":"info","9.5":"info"}}
```
