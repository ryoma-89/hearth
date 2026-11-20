# 既知の問題と未実装機能

最終更新: 2026-11-20（Phase 5 完了時点）

## 未検証

| 項目 | 状況 |
|---|---|
| 実モデル（STRATA / Qwen3.8-Flash-Next NVFP4）での動作 | 評価 8 項目 × 3 回のベンチマークで 24/24 合格（[phase5-report.md](phase5-report.md)）。数時間規模のタスクは未検証。各項目 3 回なので成功率の統計的な信頼度は低い |
| STRATA 実機でのコンテキスト圧縮 | 計測用に閾値を下げた設定（約 2.6 万トークン）で確認済み（[phase5-report.md](phase5-report.md) §5）。通常の閾値（約 9 万トークン）に達する長時間タスクは未検証。圧縮後のメモ再注入は、モデルがメモを使わなかったため実機では未発生 |
| STRATA の `x-strata-budget` ヘッダ | 未使用 |
| LM Studio / llama.cpp / クラウド API | 設定例のみ。接続は DSH（pi-ai）側で対応済みだが実機未確認 |
| SearXNG 実機 | モックの SearXNG 応答でのみ確認。実際の SearXNG インスタンスとの接続は未確認 |

## 未実装（予定 Phase）

| 機能 | Phase | 備考 |
|---|---|---|
| 型検査・リンタの組み込み検証器（mypy、ruff、tsc など） | 4 以降 | `--verify` で任意コマンドとして指定すれば使える |
| PDF 上の図表はみ出しの描画範囲検査 | 未定 | LaTeX ログの Overfull box で代替（maximum では失敗扱い） |
| latexmk / biber / makeindex | 未定 | upbibtex のみ対応 |
| ユーザー管理・利用制限・Tailscale 経由アクセス | 5 以降 | デーモンはループバック限定（設定で外部アドレスを指定すると検証エラー）。外部公開は利用者の承認後に設計する（[phase4-report.md](phase4-report.md) §4） |
| MCP サーバ設定の Hearth 側 UI | 5 以降 | DSH の MCP クライアントは同梱。設定は `dsh.extraPatches` で DSH パッチを追加すれば可能 |
| 実行中タスクへの承認（ask） | 5 以降 | headless には承認チャネルが無いため、危険操作は常に拒否。将来 GUI から承認できるようにする |
| バックアップからの復元コマンド / GUI | 5 以降 |
| トークン単位のストリーミング表示 | 未定 | DSH headless の `--json` はステップ確定時にテキストを出すため、GUI もステップ単位で更新する |
| 画像添付を Vision 入力として渡す | 未定 | 添付は作業フォルダへの保存のみ | 現状は `.hearth\runs\<task-id>\backup\manifest.jsonl` を見て手で戻す |

## 既知の制約

- **長いツール出力の切り詰め（DSH の tool-result-pruner）**: 圧縮の閾値を超えると、`toolResultPruneThresholdChars`（既定 24,000 文字）を超えるツール出力の中間が `[... tool result middle pruned ...]` に置き換わる。直前の結果も対象。Hearth はシステムプロンプトで「省略部分は読み直す」と指示しているが、モデルが従わず推測する可能性は残る。大きなファイルは `offset`/`limit` で分割して読むのが確実。

- **会話の途中でモデルを替えた場合**: DSH は、新しいモデルのコンテキスト長に履歴が収まらないとき、**前のモデル**で履歴を要約してから切り替える（DSH の仕様）。STRATA で前のモデルをすでに外していると、その要約ができず `MODEL_SWITCH_COMPACTION_FAILED` で失敗する。前のモデルを読み込み直すか、新しい会話で始める。履歴が収まる場合は問題ない。
- **自動取得したモデルの性能値は推定**: STRATA と LM Studio の `/v1/models` はコンテキスト長を返さないため、`discoveredModelDefaults` を使う（llama.cpp の `n_ctx` は使う）。実際と違う場合は `models:` に書いて上書きする。
- **元のモデルが外れた会話の再開**: 選択なしで再開すると、元のモデルが読み込まれていないため `MODEL_NOT_LOADED` で即座に断る。`--model strata/auto`（GUI では「自動」を選ぶ）で、今のモデルに切り替えて続けられる。2026-11-20 に STRATA 実機で、`nvfp4-nvfp4` で始めた会話を `unsloth-ud-iq4_xs-v31` で続け、前の計算結果を覚えていることを確認した。

- **作業フォルダにはフルコントロールが必要。** DSH の ACL サンドボックスは作業フォルダに整合性ラベルを付けるため WRITE_OWNER を要求する。この PC の `E:\development` 以下は当初ユーザーに `Modify` しかなく、`pwsh` / `python_run` / `latex_compile` がすべて失敗した（2026-11-20 に利用者がフルコントロールを付与して解消。新しいドライブやフォルダでは同じ確認が必要）。`hearth doctor --workspace <dir>` で事前に確認でき、実行中に検知した場合はタスクを即座に止める。権限の付与は利用者の操作（[setup-windows.md §4.1](setup-windows.md)）。DSH は作業フォルダに Low 整合性ラベルを恒久的に残す（DSH の仕様）。
- **Web 検索は既定で無効。** DuckDuckGo は自動アクセスにボット検知ページを返すことがあり、Hearth は回避しない。実用にはローカルの SearXNG を使う（[setup-windows.md §8](setup-windows.md)）。
- **削除の分割。** 危険判定は再帰・強制・ワイルドカードの削除を要承認とするが、ワークスペース内のファイルを個別に削除する操作は許可される。そのため既定の `deleteMode: backup` で、削除・上書きの前に必ずバックアップを取る（1 タスク 200 MB まで。超える削除は拒否）。対象が実行時に決まる削除（変数・式）はバックアップできないので拒否する。削除自体を禁止したい場合は `deleteMode: deny`。`python_run` のコードや外部プログラムが内部で行う削除・上書きはバックアップの対象外（サンドボックスがワークスペース外への書き込みだけを防ぐ）。
- **`succeeded` の意味。** 「DSH のターンが正常終了し、Hearth の自動検証（行われた場合）に合格した」ことを意味する。検証器が確認できない観点（仕様どおりか、テストが十分か）は保証しない。
- **検証の対象は、タスク中に更新時刻が変わったファイル。** 削除だけのタスクや、ワークスペース外の生成物は対象にならない。テストは変更されたファイルに Python があるときだけ、ワークスペース全体の `test_*.py` / `*_test.py` を実行する。
- **危険コマンド判定は承認トリガーであり、境界ではない。** 実際の書き込み制限は DSH の ACL サンドボックス（workspace-write）が担う。判定は PowerShell の AST で行い、解析できない構文（動的なコマンド名、`Invoke-Expression`、エンコード済みコマンド、構文エラー）は危険扱い。`bash` ツールは簡易トークナイザで判定（Windows では通常 DSH が無効化）。
- **DSH はプラグインのロード失敗を警告で済ませる。** Hearth は全 Hearth プラグインの「ロード完了」を確認してからタスク本文を渡す。失敗時はモデルへの要求を 1 回も出さずに止める。DSH 本体のプラグイン（圧縮など）の失敗は警告として `events.jsonl` に記録するだけで、タスクは止めない。
- **ハードリンク**は経路検査では検出できない（DSH ACL サンドボックスの README でも部分的保証と明記）。
- **python_run の `code` 実行**は、コード内容のパスを Hearth ポリシーでは検査しない（サンドボックスが書き込みを制限。読み取りはワークスペース外も可能）。
- **STRATA GUI 内蔵エージェントとの同時利用**: Hearth の推論キューは Hearth 経由のリクエストだけを制御する。STRATA GUI のエージェントと同時に使うとエンジンへの同時要求が起こりうる。
- **デーモン停止時**は実行中タスクを `cancelled` として終了する（セッションは保存されているので `hearth resume` で続行可能）。デーモンが異常終了した場合は次回起動時に `interrupted` として記録される。
- **DSH のバージョン**: `0.2.2-rc.5` に固定。DSH は pre-stable API のため、更新時は e2e テストで確認すること。Hearth が使う DSH の拡張点: `llm/stream`, `agent/pre-step`, `agent/request-error`, `agent/turn-stopping`, `agent.steer()`, `session/event`, `tools/pre-execute`, `tools/result`, `ctx.tools.register`, `ctx.sandbox.confine`, `ctx.web.registerSearchProvider`、および headless の `--json` 出力。
- **起動オーバーヘッド**: タスク毎に DSH を起動するため約 2 秒。
- **ディスク**: `npm install` で約 1.3 GB（npm は DSH の pnpm 配布ほど重複排除しない）。履歴アーカイブ（`.hearth\history`）とバックアップ（`.hearth\runs\*\backup`）は自動削除しない。
- `pdftotext` は TeX Live 同梱版を使う想定。Git for Windows 同梱の古い版（xpdf 4.00）が先に見つかる環境では `doctor` が WARN を出すが動作する。
