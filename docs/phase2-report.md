# Phase 2 報告：動作する最小構成

日付: 2026-11-20
状態: **完了（モックモデルと実モデル STRATA の両方で検証済み）**。実モデルの結果は [real-model-results.md](real-model-results.md) を参照。

## 1. 実装内容

| 要件（依頼 §9 Phase 2） | 実装 | 主なファイル |
|---|---|---|
| STRATA への API 接続 | DSH の `dsh-llm-pi-ai` に OpenAI 互換ルートを生成（STRATA 同梱 DSH と同じ互換設定）。キーは環境変数か DPAPI。`hearth doctor` で `/models` とツール呼び出し能力をプローブ | `src/dsh/overlay.ts`, `src/security/secrets.ts`, `src/cli/doctor.ts` |
| Agent Loop | DSH の agent-loop を使用（再実装なし）。Hearth はステップ数・壁時計時間・トークン・連続ツール失敗の上限を追加 | `src/plugins/budget.ts` |
| 基本的なツール実行 | DSH の read/write/edit/apply_patch/grep/glob/pwsh/web_fetch/todo に加え、`python_run` `latex_compile` `pdf_inspect` `git` を DSH ツールとして追加。プロセスは DSH の ACL サンドボックス経由で起動 | `src/plugins/tools.ts`, `src/tools/` |
| ツール結果のモデルへの返却 | DSH のツールパイプライン。Hearth ツールは非ゼロ終了も stdout/stderr ごとデータとして返す | 同上 |
| エラー処理 | 壊れたツール引数 JSON の修復（`llm/stream`）と有限回の再サンプル（`agent/request-error`）。ポリシー拒否は理由付きでモデルへ返す | `src/plugins/toolcall-repair.ts`, `src/plugins/json-repair.ts` |
| 実行ログ | タスク毎に `events.jsonl`（DSH イベント＋プラグインのテレメトリ）、`stderr.log`、`audit.jsonl`（全ツール判断と結果）、`patch.yml` | `src/runner/dsh-runner.ts`, `src/plugins/policy.ts` |
| CLI | `run / resume / cancel / tasks / show / logs / status / daemon / doctor / secret / config / modes`、`--json` 出力 | `src/cli/main.ts` |
| 推論キュー | デーモンの推論ブローカ（同時推論数 1、FIFO、TTL＋ハートビート、最大保持時間、プロセス終了時解放）。全 DSH 子プロセスの `llm/stream` がリースを取得。タスクキュー（同時タスク数 1、永続化、キャンセル、再起動時の復元） | `src/queue/`, `src/server/daemon.ts`, `src/plugins/inference-gate.ts` |
| セキュリティ | DSH ACL サンドボックス（workspace-write）＋ Hearth ポリシー（realpath によるパス検証・ジャンクション/シンボリックリンク/UNC/ADS/予約名の拒否、保護パス、PowerShell AST による危険コマンド判定、無人実行では承認待ちを拒否扱い）、監査ログ、キーの DPAPI 保管、デーモンはループバック＋ベアラートークン | `src/security/`, `src/plugins/policy.ts` |
| 実行モード | low/medium/high/maximum。DSH の行の有効/無効、圧縮閾値、繰り返し警告、思考 effort、再試行回数、予算上限を切り替える | `src/config/defaults.ts`, `src/dsh/overlay.ts` |

## 2. 実行したテストと結果

すべて 2026-11-20 にこの PC（Windows 11, Node 24.18.0）で実行。

| 種類 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功（エラー 0） |
| 単体テスト | `npm test` | **65 / 65 成功**（実機検証後の修正を含む） |
| 結合テスト（モックモデル） | `npm run test:e2e` | **11 / 11 成功**（約 40 秒） |
| CLI 手動スモーク | `hearth run`（デーモン自動起動）→ `status` → `tasks` → `daemon stop` | 成功（3 ステップ、ツール 2 回、2.4 秒） |
| 実モデル（STRATA） | `hearth doctor` と実タスク 9 件 | **Phase 5 の 8 項目すべて成功**（[real-model-results.md](real-model-results.md)）。E: ドライブの作業フォルダではサンドボックスに権限が足りないことが判明（同文書 §3.1） |

結合テストは本物のデーモン・キュー・ブローカ・DSH 子プロセス・DSH ツール・サンドボックス・Python・upLaTeX を使い、LLM だけをスクリプト化したモックに置き換えている。依頼 §9 Phase 5 の評価項目との対応:

| Phase 5 項目 | 結合テスト | 結果 |
|---|---|---|
| 1. 複数ファイルを読んで回答 | 「multi-step task」（書く→実行→読む） | 成功（モックなので回答内容の質は未評価） |
| 2. Python 生成・実行・修正 | 「re-samples after an unrepairable tool call…」（例外 → トレースバックがモデルに届く → 修正版を実行） | 成功 |
| 3. LaTeX → PDF | 「compiles LaTeX…」（未定義マクロでエラー行番号付き失敗 → 修正 → 1 ページの PDF） | 成功 |
| 4. エラーからの復旧 | 壊れた JSON 修復、再サンプル、ツールエラー返却 | 成功 |
| 5. 20 回以上のツール呼び出し | 「more than 20 tool calls」（23 回） | 成功 |
| 6. 中断後の状態復元 | 「resumes a finished task in its saved session」、キュー単体テストの再起動復元 | 成功 |
| 7. 複数タスクのキュー登録 | 「serializes inference across queued tasks」（3 タスク同時投入でもモデルへの同時要求は最大 1） | 成功 |
| 8. 危険なファイル操作の防止 | 「blocks dangerous operations…」（再帰削除・`..` 脱出・`.git` 書込・文字列連結による難読化削除をすべて拒否）、「runs Hearth tools inside the DSH sandbox」（Python からワークスペース外への書込が OS レベルで失敗） | 成功 |

各タスクのメトリクス（成功/失敗の種類、処理時間、ステップ数、ツール呼び出し数とエラー数、入出力トークン、推論スロット待ち時間、JSON 修復回数、再サンプル回数、ポリシー拒否数、予算超過の種類）は `TaskRecord.metrics` に保存され、`hearth tasks` / `hearth show` / `--json` で取得できる。

## 3. 調査中に判明した DSH の挙動

- 壊れたツール引数 JSON で `dsh-llm-pi-ai` が `MALFORMED_RESPONSE` を出し、ターン全体が終了する。Hearth の修復プラグインで回避（e2e で確認）。
- headless はセッションタイトル生成のために追加の LLM 要求を出す。ローカル推論を節約するため既定で無効化（`dsh.titleGeneration`）。
- `dsh-compaction-basic` の `headroomTokens` 既定値は 65536 で、131k コンテキストでは約 32k トークンで圧縮が始まる。Hearth は 8192 にして約 90k まで使えるようにした。
- タスク毎の DSH 起動は約 2 秒。

## 4. 未解決の問題

[known-issues.md](known-issues.md) にまとめた。Phase 2 時点で特に重要なもの:

1. **E: ドライブの作業フォルダ**では、ユーザーがフルコントロールを持たないため DSH の ACL サンドボックスが使えない。利用者がフォルダ権限を付与するか、ユーザープロファイル配下で作業する必要がある。
2. 検証ループ（`verificationRounds`）はまだ設定値とプロンプト指示のみで、`agent/turn-stopping` による自動検証は Phase 3。
3. Web 検索: DSH の `web_search` は DeepSeek API キー前提。ローカル用の検索プロバイダは未実装（`web_fetch` は使える）。
