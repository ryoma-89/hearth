# Hearth

ローカル LLM（STRATA / LM Studio / llama.cpp / OpenAI 互換 API）で、Codex や Claude Code のように長時間の自律作業を行うためのエージェントハーネス。

エージェントループ・ツール実行・セッション永続化・圧縮・Windows サンドボックスは **DeepSeek Harness (DSH)** をそのまま使い、ローカル LLM 運用に足りない部分を **DSH プラグイン**と**常駐デーモン**で補う構成です。設計の経緯は [docs/architecture-review.md](docs/architecture-review.md) を参照してください。

> 現状: **Phase 1〜5 完了**。STRATA（Qwen3.8-Flash-Next NVFP4）実機で、依頼文の評価 8 項目のベンチマークが **24/24 合格**（[docs/phase5-report.md](docs/phase5-report.md)）。自動検証と修正のループ、参考文献付き LaTeX、圧縮をまたぐタスクメモ、削除・上書き前のバックアップ、チャット型 Web GUI（ローカルホスト限定）を備える。**作業フォルダには自分のアカウントのフルコントロール権限が必要**です（[docs/setup-windows.md §4.1](docs/setup-windows.md)）。

## 何をするか

```text
hearth CLI ──HTTP──▶ Hearth デーモン ──spawn──▶ DSH headless（タスク毎）──▶ STRATA :47831
                    ├ タスクキュー（永続化・キャンセル・再開）      └ Hearth プラグイン
                    └ 推論リース（同時推論数 1、TTL・ハートビート）        ├ 予算上限（ステップ/時間/トークン/連続失敗）
                                                                          ├ 壊れたツール引数 JSON の修復・再試行
                                                                          ├ ポリシー（パス検証・PowerShell AST 危険判定・削除前バックアップ・監査ログ）
                                                                          ├ ターン終了時の自動検証 → 失敗を差し戻して修正させる
                                                                          ├ タスクメモと圧縮前履歴の検索
                                                                          └ ツール（python_run / latex_compile / pdf_inspect / git / task_memory）
```

DSH から引き継ぐ機能: ファイル読み書き・編集（`read` `write` `edit` `apply_patch`）、検索（`grep` `glob`）、PowerShell 実行（`pwsh`）、Web 取得（`web_fetch`）、todo、セッションログと再開、コンテキスト圧縮、Windows ACL サンドボックス、リトライ、同一ツール繰り返しの警告、MCP。

## 必要なもの

- Windows 11、Node.js 24.9 以上
- Python 3（`python_run` 用）、TeX Live（`uplatex` `dvipdfmx` `pdfinfo` `pdffonts` `pdftotext`）
- OpenAI 互換の推論サーバ（STRATA の場合は STRATA ホストの `http://127.0.0.1:47831/v1` とサービング API キー）

## セットアップ（Windows）

```powershell
cd E:\development\hearth
.\scripts\setup.ps1                 # npm install、hearth.yaml 作成、環境チェック
.\scripts\hearth.ps1 secret set strata   # STRATA の API キーを DPAPI で暗号化保存（入力は非表示）
.\scripts\hearth.ps1 doctor         # モデル一覧とツール呼び出し能力を確認
```

詳しくは [docs/setup-windows.md](docs/setup-windows.md)。

## 使い方

### Web GUI

```powershell
.\scripts\hearth.ps1 gui      # デーモンを起動し、1 回限りのログインリンクでブラウザを開く
```

会話一覧、ファイル添付（ドラッグ＆ドロップ可）、モデル・モード選択、ツール実行ログのライブ表示、トークン数・生成速度、キュー状態、CPU・RAM・GPU 使用率、設定画面があります。同じ会話で続けて入力すると、保存されたセッションの続きとして実行します。

### モデルの自動取得と切り替え

STRATA など OpenAI 互換サーバーが読み込んでいるモデルは、`/v1/models` から自動で取り込みます（`discoverModels: true`、1 分ごとと GUI の ↻ で更新）。`hearth.yaml` に書かなくても選べます。

- **`strata/auto`**: STRATA で今読み込んでいるモデルを使います。STRATA 側でモデルを替えると、Hearth も次のタスクから追従します（既定値）。
- 読み込まれていないモデルを指定すると、タスクを開始せずにエラー（`MODEL_NOT_LOADED`）を返します。
- **会話の途中で切り替え**: GUI のモデル欄を替えて送信すると、同じセッションの続きを新しいモデルで実行します。実行中なら「モデル切替」ボタンでタスクを止め、そのまま新しいモデルで続けます。CLI では `hearth resume <task-id> "..." --model strata/<id>`（実行中なら `--interrupt` を付ける）。

```powershell
.\scripts\hearth.ps1 models --refresh     # 設定済み・自動取得したモデルと、読み込み状態の一覧
```

### ベンチマーク

```powershell
.\scripts\hearth.ps1 bench --repeat 3            # 評価 8 項目 × 3 回（STRATA で約 30 分）
.\scripts\hearth.ps1 bench --task 1,2 --mode high  # 項目とモードを指定
```

合否はモデルの自己申告ではなく、生成物を直接検査して判定します。結果は `docs\bench\` に表で出力されます。

### CLI

```powershell
# タスク実行（デーモンは自動起動）。進捗・ツール呼び出し・トークン数・検証結果を表示
.\scripts\hearth.ps1 run "data.csv を読んで列ごとの平均を出す Python スクリプトを作り、実行して確認して" --workspace E:\work\demo --mode high

# 完了条件を自分で指定（PowerShell コマンドが終了コード 0 になるまで差し戻す）
.\scripts\hearth.ps1 run "ログ解析ツールを作って" --workspace E:\work\demo --verify "python -m pytest -q"

.\scripts\hearth.ps1 status            # 推論スロットとキューの状態
.\scripts\hearth.ps1 tasks             # タスク一覧（状態・ステップ数・トークン・所要時間）
.\scripts\hearth.ps1 show <task-id>    # 記録と最終回答
.\scripts\hearth.ps1 logs <task-id> -f # イベントログ（追従）
.\scripts\hearth.ps1 cancel <task-id>
.\scripts\hearth.ps1 resume <task-id> "続きをやって"   # 保存されたセッションから再開
.\scripts\hearth.ps1 daemon stop
```

`Ctrl+C` で実行中タスクをキャンセルします（もう一度押すと待たずに切り離し）。`--detach` で投入だけ行い、`--json` で全コマンドを機械可読出力にできます（Claude Code や Codex から外部ツールとして呼ぶ用途）。終了コードは成功 0、失敗 1、キャンセル 130、設定エラー 2。

### 実行モード

| モード | ステップ上限 | 時間上限 | トークン上限 | 連続失敗上限 | 推論 effort | 計画 | 自動検証の修正ラウンド | 追加ツール |
|---|---|---|---|---|---|---|---|---|
| low | 15 | 15 分 | 30 万 | 3 | off | なし | 0（`--verify` 指定時のみ検証） | python_run, git（todo/skill 無効） |
| medium | 40 | 45 分 | 150 万 | 4 | medium | なし | 1 | 全部 |
| high | 80 | 2 時間 | 400 万 | 5 | high | todo_write で計画 | 2 | 全部 |
| maximum | 150 | 4 時間 | 800 万 | 6 | high | todo_write で計画 | 4（厳格: Overfull box・未定義参照・フォント未埋め込みも失敗扱い） | 全部 |

モードは DSH の構成そのもの（有効なツール行、圧縮閾値、繰り返し警告閾値、思考 effort、壊れた JSON の再試行回数）、予算プラグインの上限、自動検証の回数と厳格さを変えます。どのモードでも上限は有限です。すべて `hearth.yaml` の `modes:` で変更できます。`hearth modes` で現在値を表示します。

### 自動検証（Phase 3）

モデルが作業を終えようとした時点で、Hearth はタスク中に変更されたファイルを検証します。Python は構文とテスト（pytest または unittest）、JSON/YAML は構文、`.tex` は upLaTeX（参考文献があれば upbibtex も）でビルド、PDF は検査、`--verify` で指定したコマンドは終了コードを見ます。失敗すると内容をモデルに返して同じターンで修正させ、モードごとの上限まで直らなければ `verification_failed` で終わります。

### 削除・上書きの保護

既定（`security.deleteMode: backup`）では、ファイルを削除・上書きする前に `.hearth\runs\<task-id>\backup\` へ複製し、`manifest.jsonl` に元のパスを記録します。誤って消されたファイルはここから戻せます。`deny` にすると削除そのものを拒否します。

## 設定

[config/hearth.example.yaml](config/hearth.example.yaml) を `hearth.yaml` にコピーして編集します。API キーは設定ファイルに書けません（`{ env: 名前 }` か `{ secret: 名前 }` のみ受け付け、直書きは検証エラー）。Web 検索は既定で無効です。使う場合はローカルの SearXNG を設定してください（[docs/setup-windows.md §8](docs/setup-windows.md)）。

## 開発

```powershell
npm run typecheck   # tsc --noEmit
npm test            # 単体テスト（node:test）
npm run test:e2e    # モックモデル + 実 DSH での結合テスト（ベンチの模擬実行を含む、約 2 分）
```

ソースは TypeScript を Node 24 の型除去でビルドなしに実行します。ディレクトリ構成:

| パス | 内容 |
|---|---|
| `src/config/` | 設定の読込・検証・既定値（モード定義を含む） |
| `src/dsh/overlay.ts` | タスク毎の DSH `--patch` 生成 |
| `src/plugins/` | DSH 子プロセス内で動くプラグイン |
| `src/security/` | パス検証、PowerShell AST 危険判定（`ps-ast.ps1`）、作業フォルダ権限確認、削除前バックアップ、DPAPI 秘密情報 |
| `src/verify/` | ターン終了時の検証器 |
| `src/tools/` | プロセス実行、サンドボックス経由実行、LaTeX ビルドとログ解析 |
| `src/queue/` | 推論ブローカ、タスクキュー、タスク記録 |
| `src/runner/` | DSH 子プロセスの起動・NDJSON 解析・計測 |
| `src/server/` | デーモン HTTP API、GUI 認証、アップロード、設定、リソース計測、クライアント |
| `web/` | Web GUI（HTML / CSS / ES モジュール、ビルド不要） |
| `src/cli/` | CLI と doctor |
| `test/` | 単体・結合テスト、OpenAI 互換モックサーバ |

## ドキュメント

- [AGENTS.md](AGENTS.md) — 開発エージェント（Codex など）向けの規約と落とし穴
- [docs/HANDOFF.md](docs/HANDOFF.md) — 引き継ぎメモ（現状・検証状況・次の作業）
- [docs/architecture-review.md](docs/architecture-review.md) — 既存ハーネス調査と設計判断（Phase 1）
- [docs/phase2-report.md](docs/phase2-report.md) — Phase 2 の実装・テスト結果
- [docs/phase3-report.md](docs/phase3-report.md) — Phase 3 の実装・テスト結果
- [docs/phase4-report.md](docs/phase4-report.md) — Phase 4（Web GUI）の実装・テスト結果
- [docs/phase5-report.md](docs/phase5-report.md) — Phase 5（ベンチマークと最適化）の結果
- [docs/bench/](docs/bench/) — ベンチマークの実行結果
- [docs/real-model-results.md](docs/real-model-results.md) — STRATA 実機での検証結果
- [docs/setup-windows.md](docs/setup-windows.md) — Windows セットアップ手順
- [docs/known-issues.md](docs/known-issues.md) — 既知の問題と未実装機能

## ライセンスと第三者コード

Hearth 自身のコードはこのリポジトリの作者に帰属します（ライセンス未設定）。依存する DeepSeek Harness（MIT）とその依存パッケージは npm からそのまま利用しており、改変・コピーはしていません。Codex（Apache-2.0）・OpenCode（MIT）・OpenHands（MIT）・Pi（MIT）は設計の参考にしたのみで、コードは含みません。
