# Hearth アーキテクチャレビュー（Phase 1）

作成日: 2026-11-20
対象: ローカルLLM（STRATA ほか）で長時間の自律作業を行うエージェント環境「Hearth」

この文書は、既存の主要ハーネス5種のソースコード調査、STRATA 環境の確認、開発方式の比較、採用アーキテクチャとモジュール設計を記録する。結論だけ知りたい場合は [§5 結論](#5-結論採用方式) を読めばよい。

---

## 1. 調査対象とバージョン

すべて公式リポジトリを `git clone --depth 1` で取得し、README ではなく実装を読んで判断した。

| 対象 | リポジトリ | コミット | コミット日時 | ライセンス | 実装言語 |
|---|---|---|---|---|---|
| DeepSeek Harness (DSH) | deepseek-ai/deepseek-harness | `2e39e70496aa02986ca6a820c5d497e816b69d7e` | 2026-11-18 | MIT | TypeScript (Node ≥24.9) |
| DSH npm 公開版（実際に導入） | `@deepseek-ai/dsh` | `0.2.2-rc.5`（dist-tag `latest`） | — | MIT | 同上 |
| STRATA 同梱 DSH | `<STRATA のインストール先>\harness` | `0.2.1-alpha.3`（BUNDLE.json, commit 記録なし） | build 2026-10-16 | MIT | 同上（pnpm deploy --prod 済み） |
| Pi | badlogic/pi-mono | `edfe6b2ef32283d31efc9e26db86fe48be19d3b2` | 2026-11-20 | MIT | TypeScript |
| OpenCode | anomalyco/opencode | `eb2dfb2638c8d4d37af804880d89eb70440681a9` | 2026-11-19 | MIT | TypeScript (Bun, Effect) |
| Codex CLI | openai/codex | `a0a30c40e8dbcc44af52e2df64dcce64368d4422` | 2026-11-20 | Apache-2.0 | Rust |
| OpenHands Agent SDK | OpenHands/software-agent-sdk | `fb565cfeac21468a5101dd41497b65315c66ac3b` | 2026-11-20 | MIT | Python |

補足: Codex は Windows のパス長制限により一部のスナップショットテストファイル（`*.snap`）がチェックアウトできなかったが、調査対象のソース（`codex-rs/shell-command`, `windows-sandbox-rs`, `protocol` など）は取得できている。

---

## 2. STRATA 環境の確認結果

読み取りのみで確認し、STRATA の設定・ファイルは一切変更していない。

| 項目 | 確認結果 | 根拠 |
|---|---|---|
| 推論エンジン | `strata-engine`（Qwen3.8-Flash-Next NVFP4, `--max-context 131072`, `--kv int8`） | `~/.strata/data/native-instances/*.json` |
| エンジン API | `http://127.0.0.1:18500/v1`（STRATA 内部用キーで保護。サービング API キーでは 401） | `/v1/models` が `authentication_error` を返す |
| **利用者向け API** | **`http://127.0.0.1:47831/v1`**（STRATA ホスト。サービング API キーで認証、モデル ID `nvfp4-nvfp4`） | Phase 2 後の実機確認で `/v1/models` が 200 |
| 既定とされた `:8080` | **応答なし**（この環境では使われていない） | `curl 127.0.0.1:8080/v1/models` が無応答 |
| STRATA ホスト | `127.0.0.1:47831`（内部エージェント用プロキシ `/api/internal/agent-llm/<route>/v1`） | `profile-*.patch.yml` |
| API キー | STRATA の設定画面に表示されるサービング API キー（Hearth は値を読まず、利用者が DPAPI に別途登録する） | STRATA の設定画面 |
| 内蔵 DSH | `<STRATA のインストール先>\harness`（0.2.1-alpha.3）。STRATA ホストが `DSH_HOME=~/.strata/data/agent/home` で `web` プロファイルを起動 | `harness.log`, `agent/home/profiles/web` |
| 内蔵 DSH のモデル接続 | `@deepseek-ai/dsh-llm-pi-ai` に `strata-local` ルート（`api: openai-completions`, `thinkingFormat: chat-template`, `chatTemplateKwargs.enable_thinking`）を STRATA ホストがパッチ生成 | `~/.strata/data/agent/profile-*.patch.yml` |

**STRATA 内蔵 DSH との関係**

- STRATA は DSH をそのまま GUI エージェントとして同梱している。Hearth は **同じ DSH を別の `DSH_HOME`（`hearth/.hearth/dsh-home`）と別のインストール**で使う。プロファイル、セッション、資格情報、ポートは一切共有しないため競合しない。
- STRATA 同梱版を直接使うことも可能（`config.dsh.entry` で切替可能にした）が、STRATA の更新でバージョンが予告なく変わるため既定にはしない。DSH は pre-stable API（`AGENTS.md`: "Public APIs are pre-stable"）なので、Hearth は npm 版をバージョン固定（`0.2.2-rc.5`）で使う。
- STRATA の接続情報の生成方式（llm-pi-ai のルート定義）は Hearth でも同じ形式を採用し、モデル互換設定（chat-template 思考切替）を踏襲する。
- Hearth の推論キューは Hearth 経由のリクエストだけを制御する。STRATA GUI のエージェントを同時に使うとエンジンへの同時要求は発生しうる（既知の制約として記録）。

---

## 3. 各ハーネスの実装調査

### 3.1 DeepSeek Harness（最優先）

**全体構造**: 61 パッケージ群の pnpm モノレポ。`vendor/` に Cordis（プラグインフレームワーク）をリスコープして同梱。`docs/architecture.md` 自身が「there is no privileged core to patch」と述べる通り、モデルアダプタ・ツールレジストリ・セッションログ・エージェントループ自体がすべてプラグイン。

| 調査項目 | 実装 | 評価 |
|---|---|---|
| Everything is a Plugin / Cordis | `ctx.effect()`・`ctx.on()` による登録はすべて「効果」で、プラグインのアンロードで巻き戻る。依存は `inject: ['tools']` で宣言し、サービス準備後に `apply` が呼ばれる | 拡張点が明確。Hearth 側コードはループ本体に触れずに済む |
| プロファイル / バンドル / パッチ | 実行時の構成は「バンドル順のパッチ層 → プロファイルの `cordis.patch.yml` → `--patch` オーバーレイ」。行 ID 指定で設定を丸ごと置換・挿入できる（`docs/architecture.md` "Profiles and bundles"） | Hearth は **生成した `--patch` YAML** だけで構成を変えられる。pnpm 不要 |
| Agent Loop | `packages/core/agent-loop`。turn = 0 個以上の step、step = 1 回のモデル要求＋ツール呼び出し。`agent/pre-step`（waterfall, reject 可能）、`agent/request-error`（waterfall, retry 可能）、`agent/turn-stopping`（serial, `agent.steer()` で継続させられる）、`tools/pre-execute`・`tools/execute`・`tools/post-execute`（waterfall） | 予算制御・検証ループ・ポリシーをすべて外付けできる |
| LLM Provider | `ctx.llm` にアダプタ登録。`dsh-llm-pi-ai` が Pi の `@earendil-works/pi-ai` を包み、`openai-completions` 等の任意ゲートウェイを設定だけで追加可能。`llm/stream` waterfall でストリームを横取りできる（`dsh-llm/lib/index.js` `streamWithRegistration`） | STRATA / LM Studio / llama.cpp / クラウドを同一経路で扱える |
| Tool Registry | `defineTool` が引数を JSON スキーマ検証してから `execute` を呼ぶ。例外は `isError` 結果としてモデルへ返る。`timeoutMs`・`isConcurrencySafe`・PTC（コードからのツール呼び出し）対応 | 統一インターフェースの要件をそのまま満たす |
| Session / Event | 追記専用 `SessionEvent` ログ（JSONL, zstd 可）。「Model-visible ⟺ logged」原則で、モデルに見えたものは全てログから再構成できる。`--session-id` で再開 | 元履歴の参照・再開要件を満たす |
| コンテキスト圧縮 | `dsh-compaction-basic`（閾値で古い履歴を要約、コンテキスト超過エラー時は要約して再試行）、`tool-result-pruner`、`image-offload`、`spill`（巨大出力をファイルへ退避） | 要約後も元ログは残る（ログが真実源） |
| サンドボックス | Windows: `dsh-sandbox-windows-acl`（capability SID + Low integrity でワークスペース外への書き込み・削除を拒否）、`sandbox-policy`（read-only / workspace-write / danger-full-access）、`fs-sandbox` | 文字列ブラックリストではなく OS 機構による制限 |
| 承認 | `dsh-user-approval` + `dsh-permission-presets`。headless では `--approval-policy never` で承認待ちを拒否扱いにできる | 「無人時は危険操作を自動実行しない」を実現できる |
| ループ対策 | `repeat-tool-reminder`（同一引数の繰り返しで 3/5/8 回目に警告）、`timeout-policy`（ツール単位の協調タイムアウト）、`llm-retry`（有限回リトライ） | ステップ数・時間・トークン・連続失敗の**上限は無い** → Hearth で追加 |
| サブエージェント | `dsh-subagent` + spawn/fork in-process、Codex/Claude Code/ACP への委譲 | 既定では使わない（ルール9） |
| SDK / API | TypeScript / Python SDK（JSON-RPC、`dsh --profile sdk`）、`headless` プロファイル（`--json` で NDJSON イベント列、終了コード） | Hearth のランナーは headless の NDJSON を使う |
| Web 検索 | `ctx.web.registerSearchProvider()` に検索プロバイダを登録する seam。同梱の検索は DeepSeek API キー前提 | ローカル用プロバイダを Hearth で追加する余地 |
| プラグイン追加方法 | (1) `--patch` で絶対パスのモジュールを `insert`、(2) `dsh.bundle` を持つ npm パッケージを `dsh plugin add` | Hearth は (1) を使う（pnpm 非依存） |

**実地検証（モックサーバ使用）**

`hearth/.hearth/spike/` で、自作 TypeScript プラグイン（`.ts` をそのまま Node 24 の型除去でロード）を `--patch` で挿入し、OpenAI 互換モックに対して `dsh --profile headless --json` を実行した。

- ツール呼び出し → 結果返却 → 最終回答まで正常完了（起動〜完了 2.6 秒）。`step_end` イベントにトークン使用量が含まれる。
- **重要な欠点を確認**: モデルが壊れたツール引数 JSON（例 `{"text": hi`）を出すと、`dsh-llm-pi-ai` が `MALFORMED_RESPONSE` を投げ、**ターン全体がエラー終了する**（`dsh-llm-pi-ai/lib/index.js` の `toolcall_end` 処理）。モデルへ「引数が壊れている」と返して再試行する経路が無い。ローカルの量子化モデルでは致命的になりうるため、Hearth で `llm/stream` waterfall による修復＋有限回再試行を実装する。
- headless はセッションタイトル生成のため本処理とは別に LLM 要求を1回出す。推論ゲートは `llm/stream` 全体に掛ける必要がある。

**欠点**: パッケージが巨大（npm 導入で約 1.3 GB, 670 パッケージ）、API が pre-stable、タスク毎のプロセス起動に約 2 秒。ただしいずれも推論時間（ローカル LLM で 1 ステップ数秒〜数十秒）に比べれば小さい。

### 3.2 Pi（pi-mono）

- `packages/agent/src/agent-loop.ts`（952 行）: 外側ループ（follow-up）と内側ループ（ツール＋steering）の二重構造。`beforeToolCall`/`afterToolCall` フック、`validateToolArguments`、ツールの逐次/並列実行、`failToolCallsFromTruncatedMessage`（出力上限で切れたツール呼び出しをエラー結果として返す）。
- `packages/ai/src/utils/json-parse.ts`: `partial-json` によるストリーミング中の部分 JSON 解析と `repairJson`（制御文字・不正エスケープの修復）。ただし引用符の無い値などは修復しない。
- `packages/coding-agent/src/core/compaction/`: ブランチ要約付きの圧縮。
- **評価**: ループが軽量で読みやすい。DSH の `dsh-llm-pi-ai` が Pi の `pi-ai` を内部で使っているため、Hearth は Pi のプロバイダ層を DSH 経由で間接的に再利用することになる。Pi 単体を土台にすると、権限・サンドボックス・セッション永続化を自作する必要がある。

### 3.3 OpenCode

- `packages/core/src/permission.ts`: `evaluate(action, resource, ...rulesets)` が「最後に一致したルール」を採用し、どれにも一致しなければ **`ask`**。無人実行（`Unattended`）時は `ask` を `deny` に変える（"needs approval, and nobody is present to give it"）。
- `packages/core/src/plugin/agent.ts`: `*.env` の読み取りを既定で `ask`。
- `packages/core/src/session/compaction.ts`: コンテキスト上限に近づくと**バックグラウンドで要約を先行生成**し、閾値到達時に差し替える。要約は構造化テンプレート（作業再開用）。
- `packages/latex`: LaTeX 用のパッケージを持つ（Markdown 内数式のレンダリング用で、コンパイル検証ではない）。
- **評価**: 権限ルールの「既定 ask・無人なら deny」は Hearth のポリシーに採用。Effect/Bun 依存が強く、部品単位での再利用は難しい。

### 3.4 Codex CLI

- `codex-rs/shell-command/src/command_safety/windows_dangerous_commands.rs`: PowerShell コマンドを**PowerShell 自身の AST パーサ**（`powershell_parser.ps1` が `[System.Management.Automation.Language.Parser]::ParseInput` を常駐プロセスで実行）でコマンド語列へ落としてから危険判定する。解析不能・未対応構文は「危険」と同じ扱い（fail closed）。
- `codex-rs/protocol/src/protocol.rs` `AskForApproval`: `untrusted`（既知の安全コマンド以外は承認）、`on-request`、`granular`、`never`。
- `codex-rs/windows-sandbox-rs/`: 制限トークン・ACL・専用デスクトップ・DPAPI による Windows サンドボックス。`codex-rs/execpolicy`: 規則ファイルによるコマンド許可。
- `codex-rs/apply-patch`: 独自パッチ形式でのファイル編集。
- **評価**: 「文字列ブラックリストに依存しない」の最良例。Hearth の PowerShell 危険判定は同じ方式（PowerShell AST → コマンド語 → 規則、解析不能は拒否）を TypeScript から PowerShell を呼ぶ形で実装する（コードはコピーせず方式のみ参考。Apache-2.0）。Rust 製で TS/Python からの部品再利用は不可。

### 3.5 OpenHands Agent SDK

- `openhands-sdk/openhands/sdk/conversation/stuck_detector.py`: 「同一アクション＋同一観測の繰り返し」「同一アクションでエラーの繰り返し」「独白の繰り返し」「交互パターン」を閾値で検出。
- `openhands-sdk/openhands/sdk/security/confirmation_policy.py`: `AlwaysConfirm` / `NeverConfirm` / `ConfirmRisky(threshold)`。リスク評価は LLM・ルール・アンサンブル（`security/ensemble.py`）。
- `openhands-sdk/openhands/sdk/workspace/` と `openhands-workspace/`: `LocalWorkspace` / Docker / Apptainer / Remote の差し替え可能なワークスペース。
- `context/condenser/`: 要約コンデンサをパイプライン化。
- **評価**: 停滞検知（連続エラー）は Hearth の予算プラグインの「連続失敗上限」に採用。Python 製でワークスペース分離は Docker 前提が多く、Windows ローカル用途には過剰。

### 3.6 比較まとめ

| 観点 | DSH | Pi | OpenCode | Codex | OpenHands |
|---|---|---|---|---|---|
| ループ拡張点 | ◎ waterfall/serial イベント多数 | ○ フック 2 種 | ○ プラグインフック | △ 内部固定 | ○ |
| ローカル LLM 接続 | ◎ pi-ai 経由で任意 OpenAI 互換 | ◎ | ○ AI SDK | △ Responses API 中心 | ○ LiteLLM |
| 壊れたツール JSON への耐性 | △ ターン終了 | ○ 部分修復 | ○ | ○ | ○ |
| Windows サンドボックス | ◎ ACL + Low IL | × | △ | ◎ 制限トークン | △ Docker |
| 危険コマンド判定 | ○ 承認＋サンドボックス | × | ○ ルール | ◎ PowerShell AST | ○ LLM/ルール |
| 永続化・再開 | ◎ 追記ログ・世代管理 | ○ | ◎ SQLite | ○ | ○ |
| 圧縮 | ○ 要約＋プルーニング | ○ | ◎ 先行要約 | ○ | ○ |
| 予算上限（ステップ/時間/トークン） | × | △ max turns | △ | △ | ○ 最大反復 |
| 推論キュー | × | × | × | × | × |
| 規模・依存 | 大（1.3 GB） | 小 | 中 | 大（Rust） | 中 |

---

## 4. 開発方式の比較

| 評価項目 | A: DSH をプラグインで拡張 | B: DSH を実行基盤として使い独自ハーネスを構築 | C: 軽量ハーネスを新規開発 |
|---|---|---|---|
| 長時間タスクの安定性 | ◎ DSH の圧縮・再開・リトライをそのまま使う | ◎ A と同じ＋外側でプロセス監視・再起動 | △ 圧縮・永続化・再開を一から作り検証する必要 |
| ローカル LLM 適性 | ○ ツール JSON 修復をプラグインで追加 | ◎ 加えて推論キュー・モデル能力プローブを外側に持つ | ○ 自由に作れるが検証コスト大 |
| 拡張性 | ◎ Cordis プラグイン | ◎ Cordis プラグイン＋オーケストレータ API | ○ 独自設計次第 |
| 実行効率・オーバーヘッド | ○ 起動 2 秒程度 | ○ 同左（タスク単位）＋常駐デーモン | ◎ 最小 |
| 開発コスト | ◎ 最小 | ○ 中 | × 大 |
| 保守性 | △ pre-stable API に追従が必要 | ○ 依存面をプラグイン境界と NDJSON に限定 | △ 全コードを自分で保守 |
| セキュリティ | ◎ ACL サンドボックス・承認を流用 | ◎ 同左＋独自ポリシー層 | × サンドボックス自作は危険 |
| ライセンス | MIT | MIT | 参照元の扱いに注意 |
| STRATA 連携 | ◎ STRATA と同じ接続方式 | ◎ 同左、ただし DSH_HOME 分離で衝突なし | ○ |
| 複数クライアント（CLI/Web/Discord）からの集約 | × DSH 単体ではプロセス間キューが無い | ◎ デーモンが集約 | ○ |

A 単体では「推論キュー（プロセス横断）」「タスクキュー」「Discord など他アプリからの集約」「タスク単位の成功率・処理時間計測」が置けない。C はサンドボックス・圧縮・永続化の再実装になり、ルール1（無駄な再実装をしない）に反する。

---

## 5. 結論（採用方式）

**B を採用する。ただし DSH 内部で実装できることはすべて A（DSH プラグイン）として実装する。**

- エージェントループ、ツール実行、セッションログ、圧縮、サンドボックス、承認、MCP、Web 取得、PowerShell 実行は **DSH をそのまま使う**（再実装しない）。
- Hearth 固有の機能のうち、ループ内部で効くもの（予算上限、モード別方針、ツール JSON 修復、推論ゲート、危険操作ポリシー、追加ツール、検証ループ）は **DSH プラグイン**として実装し、生成した `--patch` で注入する。
- DSH にないプロセス横断の機能（タスクキュー、推論リース、設定管理、秘密情報、計測、CLI、将来の Web GUI と Discord）は **Hearth オーケストレータ**（Node/TypeScript）として実装する。DSH とは `dsh --profile headless --json` の NDJSON と、プラグイン→デーモンの HTTP リースだけで接続し、依存面を最小化する。

**実装言語**: TypeScript（Node 24 の型除去でビルドなし実行、`tsc --noEmit` で型検査）。理由: DSH と同一ランタイムでプラグインを直接書ける、依存が少ない、Windows で追加ツールチェーン不要。

---

## 6. アーキテクチャ

```text
 ┌────────────── クライアント ──────────────┐
 │ hearth CLI   (将来) Web GUI   (将来) Discord │
 └───────────────┬──────────────────────────┘
                 │ HTTP (127.0.0.1 + トークン)
 ┌───────────────▼────────────────────────────────────────┐
 │ Hearth デーモン (src/server)                             │
 │  TaskQueue ── 永続化 .hearth/state/tasks/*.json            │
 │  InferenceBroker ── 同時推論数=1, リースTTL+ハートビート      │
 │  DshRunner ── タスク毎に子プロセス起動 / NDJSON 解析 / 計測    │
 └───────────────┬────────────────────────────────────────┘
                 │ spawn: node dsh --profile headless --patch <生成YAML> --json
 ┌───────────────▼────────────────────────────────────────┐
 │ DeepSeek Harness 子プロセス (DSH_HOME=.hearth/dsh-home)     │
 │  agent-loop / tools / session JSONL / compaction / sandbox │
 │  + Hearth プラグイン:                                      │
 │    hearth-toolcall-repair  (llm/stream, agent/request-error)│
 │    hearth-inference-gate   (llm/stream → デーモンのリース)    │
 │    hearth-budget           (pre-step / tools/result)        │
 │    hearth-policy           (tools/pre-execute, 監査ログ)     │
 │    hearth-tools            (python_run, latex_compile, ...) │
 └───────────────┬────────────────────────────────────────┘
                 │ OpenAI 互換 (llm-pi-ai)
        STRATA :18500 / LM Studio / llama.cpp / クラウド
```

### 6.1 ディレクトリ構成

```text
hearth/
  bin/hearth.mjs                 CLI 起動スクリプト
  config/hearth.example.yaml     設定例（APIキーの値は書かない）
  src/
    config/        設定の読込・検証・既定値、モード定義、プロバイダ定義
    dsh/           DSH パッチ生成、DSH 実行ファイルの解決
    plugins/       DSH プラグイン（子プロセス内で動く）
    security/      パス検証、PowerShell AST 危険判定、秘密情報(DPAPI)
    queue/         InferenceBroker, TaskQueue, タスク記録
    runner/        DSH 子プロセス実行、NDJSON 解析、計測
    server/        デーモン HTTP API
    cli/           CLI コマンド
  test/unit/       単体テスト（node:test）
  test/e2e/        モックモデルでの結合テスト
  test/mock/       OpenAI 互換モックサーバ
  scripts/         Windows 用セットアップ・起動スクリプト
  docs/            設計資料・報告書
```

### 6.2 主要な設計判断

| 要件 | 設計 |
|---|---|
| ループ上限（4.1） | `hearth-budget`: `agent/pre-step` で最大ステップ超過を reject、壁時計上限・トークン上限・連続ツール失敗上限で `agent.cancel()`。上限値はモード毎に設定ファイルで変更可能。Maximum も有限 |
| ツール JSON の不正（4.5） | `hearth-toolcall-repair`: `llm/stream` で生の引数差分を蓄積し、`MALFORMED_RESPONSE` 終了を検出したら寛容 JSON 修復（引用符なし値・末尾カンマ・単引用符・コードフェンス・閉じ括弧不足）を試み、成功すればツール呼び出しブロックとして再発行。修復不能なら `agent/request-error` で有限回の再サンプル。スキーマ違反は DSH の `defineTool` 検証がエラー結果としてモデルへ返す |
| 推論キュー（6） | `InferenceBroker`: 同時推論数（既定 1）のセマフォ。リースは TTL＋ハートビート、子プロセス終了時に強制解放、待機者の接続断で待ち行列から除去。`TaskQueue` は同時実行タスク数（既定 1）と待機・キャンセル・タイムアウトを管理し、状態を JSON に永続化 |
| セキュリティ（7） | 第1層: DSH の ACL サンドボックス（workspace-write）。第2層: `hearth-policy` がファイル系ツールのパスを `realpath` で解決しシンボリックリンク・ジャンクション・`..`・UNC/デバイスパス・ADS を検証、上書き・削除を保護。PowerShell は AST 解析で危険コマンドを分類し、無人実行時は拒否（OpenCode 方式）。第3層: 監査ログ（JSONL）。API キーは設定ファイルに書かず環境変数か DPAPI 暗号化ファイル |
| 実行モード（5） | `config/modes`: ツール許可リスト、ステップ・時間・トークン上限、連続失敗上限、修復再試行回数、検証ラウンド数、圧縮設定、思考 effort をモード毎に定義し、DSH パッチ（行の有効/無効と設定値）へ変換する。プロンプト差し替えだけではない |
| 検証・自動修正（4.3, Phase 3） | `agent/turn-stopping` で終了しようとしたときに検証器（構文検査・テスト・LaTeX ログ解析・PDF 検査）を走らせ、失敗なら `agent.steer()` で修正を要求。ラウンド数はモードで上限 |
| 再開（4.1） | DSH セッション ID をタスク記録に保存し、`hearth resume` が `--session-id` で再開。中断時のタスクは `interrupted` として記録 |

### 6.3 第三者コードの利用箇所

| 利用物 | 方法 | ライセンス |
|---|---|---|
| `@deepseek-ai/dsh` 0.2.2-rc.5 と依存パッケージ | npm 依存として利用（改変なし） | MIT（同梱の依存はそれぞれのライセンス。DSH の `THIRD_PARTY_NOTICES.md` 参照） |
| `@earendil-works/pi-ai` | DSH 経由で間接利用 | MIT |
| `yaml` | 設定ファイル解析 | ISC |
| Codex の PowerShell AST による危険判定 | 方式のみ参考（コードの複製なし） | Apache-2.0 |
| OpenCode の権限評価（既定 ask・無人時 deny） | 方式のみ参考 | MIT |
| OpenHands の停滞検知 | 方式のみ参考 | MIT |

ソースコードの直接コピーは行っていない。

---

## 7. リスクと対策

| リスク | 対策 |
|---|---|
| DSH の pre-stable API 変更 | バージョン固定。Hearth プラグインが使う拡張点（`llm/stream`, `agent/pre-step`, `agent/request-error`, `agent/turn-stopping`, `tools/pre-execute`, `tools/result`, `ctx.tools.register`）を一覧化し、e2e テストで検知 |
| ローカルモデルのツール呼び出し品質 | JSON 修復＋有限回再試行、`hearth doctor` によるツール呼び出し能力プローブ |
| STRATA GUI との同時推論 | Hearth キューの対象外であることを明記。将来 STRATA 側 API で状態取得できれば連携 |
| 1 タスク毎の DSH 起動コスト（約 2 秒） | 推論時間に比べ小さいため許容。必要になれば SDK プロファイルの常駐プロセスへ移行可能な設計（ランナーを差し替え） |
