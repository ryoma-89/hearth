# AGENTS.md — Hearth

このリポジトリで作業するエージェント（Codex など）向けの規約。作業を始める前に全部読み、現状と次の作業は [docs/HANDOFF.md](docs/HANDOFF.md) を読むこと。

## このプロジェクトは何か

Hearth は、ローカル LLM（主に STRATA 上の Qwen3.8-Flash-Next NVFP4）で長時間の自律作業をさせるためのエージェントハーネス。**DeepSeek Harness (DSH)** を実行基盤として使い、足りない部分を次の 2 つで補う。

1. **DSH プラグイン**（`src/plugins/`）: DSH の子プロセス内で動く。予算上限、壊れたツール JSON の修復、推論ゲート、ポリシーと監査、追加ツール、自動検証、タスクメモ、Web 検索。
2. **Hearth デーモン**（`src/server/`）: プロセスをまたぐ機能を持つ。タスクキュー、推論リース、DSH 子プロセスの実行と計測、HTTP API、Web GUI。

```text
CLI / Web GUI ─HTTP(127.0.0.1:47900)─▶ daemon ─spawn─▶ dsh --profile headless --patch <生成YAML> --json
                                         │                 └ Hearth プラグイン群（--patch で挿入）
                                         └ TaskQueue / InferenceBroker / DshRunner
```

設計の経緯は [docs/architecture-review.md](docs/architecture-review.md)、各 Phase の結果は `docs/phase*-report.md` にある。

## コマンド

```powershell
npm run typecheck          # tsc --noEmit（strict）
npm test                   # 単体テスト（node:test、約 3 秒）
npm run test:e2e           # 結合テスト: 実デーモン + 実 DSH + モックモデル（約 2 分）
node --check web/app.js    # GUI の構文確認（GUI の JS は tsc の対象外）
node bin/hearth.mjs doctor                    # 環境・STRATA 接続・ツール呼び出し能力の確認
node bin/hearth.mjs run "..." --workspace <dir> --mode medium
node bin/hearth.mjs gui                       # Web GUI（1 回限りのログインリンク）
node bin/hearth.mjs bench --repeat 3          # 評価 8 項目のベンチマーク（STRATA 実機、約 30 分）
node bin/hearth.mjs daemon stop
```

変更したら最低限 `npm run typecheck` と `npm test` を実行する。プラグイン・ランナー・デーモン・オーバーレイを変えたら `npm run test:e2e` も実行する。**実行していないテストを成功と書かない。**

## 技術的な前提（守ること）

- **TypeScript をビルドなしで実行する**（Node 24 の型除去）。使えるのは消去可能な構文だけ（`enum`・名前空間・コンストラクタのパラメータプロパティは不可）。相対 import には `.ts` 拡張子を付ける（`tsconfig.json` の `erasableSyntaxOnly` と `allowImportingTsExtensions`）。
- DSH のバージョンは **`@deepseek-ai/dsh@0.2.2-rc.5` に固定**。DSH は pre-stable API なので、上げるときは e2e で確認し、[docs/known-issues.md](docs/known-issues.md) にある「Hearth が使う拡張点」の一覧を見直す。
- Hearth が DSH の構成を変える方法は、**`src/dsh/overlay.ts` が生成する `--patch` YAML だけ**。DSH 本体や `node_modules` を書き換えない。
- **モデルは `ModelCatalog`（`src/providers/catalog.ts`）経由で解決する。** `config.providers[*].models` はデーモン稼働中に自動取得で増える（減らない）。タスクには `auto` ではなく解決済みの具体的なモデル ID を保存する。e2e テストの設定から実 STRATA プロバイダを外してあるので（`strata: null`）、テストで実サーバーに接続しないこと。
- **DSH の tool-result-pruner は、圧縮の閾値を超えると直前のツール結果まで中間を削る。** 既定（8,192 文字）のままだと、長いファイルを読んだ直後に内容が消え、モデルが値を推測した（実測）。Hearth はモード設定 `toolResultPrune*` で上限を引き上げ、システムプロンプトで読み直しを指示している。
- **システムプロンプト（`overlay.ts` の `personaPrefix`）にタスク固有の情報（パス、ID、時刻）を入れない。** システムプロンプトとツール定義はリクエストの先頭部分で、タスク間で同一にしておくと STRATA のプレフィックスキャッシュが効く（1 ステップ目 −25% を実測）。タスク固有の情報は `taskMessage()` でタスク本文に入れる。単体テストで保証している。
- 依存の追加は慎重に。現在の実行時依存は `@deepseek-ai/dsh` と `yaml` だけ。GUI は依存ゼロ・ビルド不要を保つ。
- **改行は LF**。Windows で Python のテキストモードを使ってファイルを書くと CRLF になるので使わない（実際に混入した）。Git Bash の `grep` は CR を無視するので、CRLF の検出には Node を使う。
- シェルの heredoc 経由で Python や Node のコードを流すと、バックスラッシュや `\b` が壊れる事故が何度も起きた。ファイルの編集は、エディタのツールか、ファイルに書いたスクリプトで行う。

## DSH プラグインを書くときのチェックリスト

1. `export const name = 'hearth-xxx'`、`apply(ctx, config)`。依存サービスは `inject` で宣言する（任意の依存は `{ sandbox: { required: false } }` の形）。
2. **`apply` の最後に `emitTelemetry({ event: 'plugin-ready', plugin: name })` を必ず出す。** DSH はプラグインのロード失敗を警告で済ませて実行を続ける。ランナーは全 Hearth プラグインの ready を確認してからタスク本文を送るので、これが無いとタスクが始まらない（60 秒でタイムアウト）。
3. `src/dsh/overlay.ts` の `insert` に行を追加する。行 ID は `hearth-` で始める（ランナーは ready を待つ対象をこの ID から抜き出す）。
4. ツールは `defineTool`（`@deepseek-ai/dsh-tools`）で定義する。戻り値は lossless JSON にすること（`undefined` を含めない。`src/plugins/tools.ts` の `toJson()` を使う）。想定内の失敗はデータとして返し、引数エラーは `ToolArgsError` を投げる。
5. プロセスを起動するツールは `src/tools/sandbox-exec.ts` の `createSandboxExec` を使い、DSH の ACL サンドボックスを通す（フェイルクローズ）。
6. `session/event` のリスナーの中から `agent.inject()` などでセッションに追記しない。DSH のログ追記と衝突する（"session append cannot reenter"）。次のステップに載せたいものは、`agent/pre-step` の waterfall で `messages` に追加する（`src/plugins/memory.ts` 参照）。
7. waterfall のリスナーは必ず `next()` を呼ぶ（呼ばなければ後続が止まる）。
8. ランナーへの通知は stderr のテレメトリ（`@@hearth {json}`、`src/plugins/telemetry.ts`）で行う。stdout は DSH の NDJSON 専用。
9. 単体テスト（純粋なロジック部分）と、モックモデルを使った e2e テスト（`test/e2e/helpers.ts` の `startHarness`）を追加する。

## セキュリティ規則（例外なし）

- **API キーを設定ファイル・コード・ログ・テストに書かない。** キーは `apiKey: { secret: NAME }`（DPAPI、`hearth secret set NAME`）か `{ env: NAME }` で参照する。STRATA のキーは DPAPI のシークレット `strata` に保存済み。値を読み出して表示・転記しない。
- **STRATA の環境を変更しない**（`~/.strata/`、`<STRATA のインストール先>\`、STRATA の DSH ホーム）。読み取りのみ可。
- **ファイルやフォルダの ACL などセキュリティ設定を変更しない。** 必要なときは手順を書いて利用者に依頼する（`E:\development` へのフルコントロール付与は利用者が実施済み）。
- デーモンはループバック限定（`daemon.host` に外部アドレスを指定すると検証エラーになる）。**外部公開・Tailscale 公開・ポート開放は、利用者の承認なしに行わない。**
- 危険コマンドの判定は文字列照合ではなく PowerShell の AST（`src/security/ps-ast.ps1`）で行う。判定ルールを緩める変更には、拒否されるべきケースのテストを付ける。
- ボット検知・CAPTCHA を回避するコードを書かない（DuckDuckGo の件は回避せずエラー扱いにしている）。

## 作業の進め方

- 大規模な破壊的変更、外部公開、利用者の設定（`hearth.yaml`）の書き換えは、事前に利用者の承認を得る。
- 既存の DSH の機能で済むものは自作しない（依頼時の原則）。DSH の機能を調べるときは `node_modules/@deepseek-ai/<pkg>/README.md` と `lib/types/*.d.ts` を読む。
- 不要なマルチエージェント構成を入れない（サブエージェント系の DSH 行は全モードで無効化している）。
- 設定値をハードコードしない。新しい調整項目は `src/config/types.ts`、`defaults.ts`、`load.ts`（検証付き）の 3 か所に追加する。
- エラーを握りつぶさない。空の `catch` には理由をコメントで書く。
- 作業結果は `docs/` に記録する。「実装済み」と「未対応」、「実機で検証済み」と「モックでのみ検証」をはっきり区別して書く。
- このフォルダは git リポジトリではない（`git init` するかは利用者の判断）。
- 会話と文書は日本語。コード、識別子、コメントは英語。

## 主要ファイル

| パス | 役割 |
|---|---|
| `src/config/{types,defaults,load}.ts` | 設定の型・既定値（モード定義を含む）・読込と検証 |
| `src/dsh/overlay.ts` | タスク毎の DSH パッチ生成（プロバイダ、モード別の DSH 行、Hearth プラグイン） |
| `src/runner/dsh-runner.ts` | DSH 子プロセスの起動、プラグインの ready 待ち、NDJSON とテレメトリの解析、計測、状態判定 |
| `src/queue/` | `InferenceBroker`（リース）、`TaskQueue`、`TaskStore`、リースクライアント |
| `src/server/daemon.ts` | HTTP API、GUI 配信、認証（ベアラー / クッキー + CSRF）、会話、アップロード、設定、リソース |
| `src/plugins/` | DSH プラグイン（上記） |
| `src/verify/verifiers.ts` | ターン終了時の検証器 |
| `src/security/` | パス検証、AST による危険判定、バックアップ、DPAPI、作業フォルダの ACL 確認 |
| `src/tools/` | プロセス実行、サンドボックス経由の実行、LaTeX ビルドとログ解析 |
| `web/` | Web GUI |
| `test/mock/mock-openai.ts` | シナリオで動かす OpenAI 互換モック（ツール呼び出し、壊れた JSON、遅延、HTTP エラー） |

## 環境メモ（この PC）

- Windows 11、Node 24.18、Python 3.12、TeX Live 2025（uplatex / upbibtex / dvipdfmx / pdfinfo / pdffonts / pdftotext）、RTX 5070 Ti 16GB、RAM 96GB。
- STRATA の利用者向け API は **`http://127.0.0.1:47831/v1`**、モデル ID は `nvfp4-nvfp4`。`:18500` はエンジン内部ポートで、別のキーで保護されている。依頼文にあった `:8080` は応答しない。
- DSH の作業領域: 本番は `.hearth/dsh-home`、e2e テストは `.hearth/test-dsh-home`。
- DSH の Windows ACL サンドボックスは、作業フォルダへのフルコントロール（WRITE_OWNER）を要求する。新しい場所では `hearth doctor --workspace <dir>` で確認する。
- 実機での検証用の作業フォルダ: `E:\development\hearth-trials\`、`%USERPROFILE%\hearth-trials\`。
