# tools/ 検証ツール一覧

すべて `npx tsx tools/<name>.ts` で実行する開発用ツールです(本番ビルドには含まれません)。
画像などの生成物は `test-results/`(`.gitignore` 済み)に出力します。`docs/` に書き出すのは、サイズの小さい生成文書
(`docs/STAGE.md` / `docs/PLAYTHROUGH.md` / `docs/TURRET_KILL.md` / `docs/E2E.md`)だけです。

| ツール | npm script | 用途 | 出力 |
| --- | --- | --- | --- |
| `stage-report.ts` | `npm run stage:report` | ステージ(20区画・敵45体)の検証レポート。`validateStage(buildStage())` を実行 | `docs/STAGE.md` (`--no-write` で書かない) |
| `playthrough.ts` | `npm run playthrough` | 実際の `Game` を tick 実行するボットで、スタートから脱出領域まで通し走破(全18構成・敵撃破済み/あり・隔壁/ゲート試験)。`tests/playthrough.test.ts` がライブラリとして使う | 標準出力。`--report docs/PLAYTHROUGH.md` で文書更新、`--json <path>` でJSON |
| `perf-bench.ts` | `npm run perf` | 実ステージでの tick 処理時間・メモリ・World クエリ数の計測(Node、ヘッドレス)。`--quick` で短縮 | 標準出力。`--md docs/PLAYTHROUGH.md` で性能の節を更新 |
| `turret-kill.ts` | - | 制御砲台6体の遠隔破壊(狙撃位置の探索・3武器・掩蔽ボット・生存時間)。`tests/turret-kill.test.ts` がライブラリとして使う | 標準出力 |
| `route-probe.ts` | - | 3Dボクセル + A* による最短経路・隔壁の遮断・外周の確認(`probeStage` / `barrierCuts` / `perimeterLeak` は `tests/stage-blueprint.test.ts` が使う)。`--emit` は `src/stage/routes.ts` を書き換えるので通常は使わない | 標準出力 |
| `snapshotShape.ts` | - | SPEC §10 の Snapshot 型の期待形状(ライブラリ。`tools/e2e/` と `tests/uiLogic.test.ts` / `tests/audit-ui.test.ts` が使う) | - |
| `e2e.ts` + `e2e/*.ts` | `npm run e2e` | Playwright + Chrome for Testing でビルド済みゲームを実ブラウザ操作して総合検証(`vite build` → `vite preview` を 5210 で起動し終了時に停止) | `test-results/e2e/e2e-*.png`、`docs/E2E.md`(`--only=1,2` では書かない) |
| `render-shots.ts` | - | `viewer.html`(開発用の描画ビューア。`src/render/viewer*.ts`)のスクリーンショットと描画負荷の計測(`--bench` `--leak` `--tex` `--dpr`)。別途 HMR 無しの vite サーバー(既定 `http://127.0.0.1:5220`、`VIEWER_URL` で変更)が必要 | `test-results/render-shots/`(第1引数で変更) |
| `startup-bench.ts` | - | ページ読み込みから格納庫の最初の1枚が出るまでの起動時間の計測 | 標準出力(`--shot=test-results/startup.png` で画像) |

## ブラウザが必要なもの

`e2e.ts` / `render-shots.ts` / `startup-bench.ts` と `tests/audit-ui-browser.test.ts` は Chrome for Testing を使います。
実行ファイルは環境変数 `CHROME_PATH` で指定します(未指定なら macOS の Playwright 既定
`~/Library/Caches/ms-playwright/chromium-1224/chrome-mac-arm64/...`)。実行ファイルが無い環境では、テストは skip されます(理由を標準出力に出す)。
ブラウザ入りのキャッシュが無いときは `npx playwright install chromium` で取得できます(この手順は依存関係を変えません)。

## 補足

- `viewer.html` は開発用ビューアで、`index.html` だけを入力とする本番ビルド(`npm run build`)には含まれません。
- 区画作り込み中に使った使い捨てスクリプト(`a*-*.ts` / `plan-*` / `check-*` / `shots-a*` / `sim-a*` / `viewer-a*` など)は整理のため削除済みです。
