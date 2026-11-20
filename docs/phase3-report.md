# Phase 3 報告：品質向上

日付: 2026-11-20
状態: **完了**（モックモデルの結合テストと STRATA 実機の両方で確認）

## 1. 実装内容

| 依頼 §9 Phase 3 の項目 | 実装 | 主なファイル |
|---|---|---|
| 自動検証と修正 | モデルが作業を終えようとした時点（DSH の `agent/turn-stopping`）で、タスク中に変更されたファイルを検証する。失敗したら `agent.steer()` で失敗内容を返し、同じターンのまま修正させる。修正ラウンド数はモードで上限を設ける（low 0 / medium 1 / high 2 / maximum 4）。上限まで直らなければタスク状態は `verification_failed` | `src/plugins/verify.ts`, `src/verify/verifiers.ts` |
| 検証の種類（実装済み） | Python 構文（py_compile）、Python テスト（pytest があれば pytest、無ければ unittest。ワークスペース内の `test_*.py` / `*_test.py`）、JSON / YAML の構文、LaTeX ビルド、PDF 検査、タスク毎の任意コマンド（`hearth run --verify "<PowerShell コマンド>"`、終了コード 0 で合格） | 同上 |
| 検証の厳格さ | maximum モードは `strictVerification`。Overfull box（1pt 超）、未定義参照・引用、文字欠落、フォント未埋め込み、テキストの無いページも失敗として扱う | `src/config/defaults.ts` |
| LaTeX 連携 | `\bibdata` を検出したら upbibtex を実行し、upLaTeX を再実行する。upbibtex が失敗したらビルド失敗として扱う。ビルド処理はツールと検証器で共通化した | `src/tools/latex.ts` |
| コンテキスト管理 | (1) DSH の全セッションイベントを圧縮せずに `.hearth/history/<session>.jsonl` へ保存。(2) `task_memory` ツール：決定事項・事実・残作業のメモ（`.hearth/notes/<session>.md`）、メモの一覧、圧縮前の履歴の全文検索。(3) DSH が圧縮したら、次のステップにメモを自動で再注入する。メモと履歴はセッション単位なので `hearth resume` 後も残る | `src/plugins/memory.ts` |
| モード別の動作 | 検証ラウンド数・厳格さ・`task_memory` の有無をモードで切り替える。圧縮要約の出力上限（`maxTokens`）を明示し、設定値によって DSH の圧縮が無効になる問題を解消した | `src/dsh/overlay.ts` |
| セッションの保存・再開 | Phase 2 で実装済み。検証コマンドも再開時に引き継ぐ | `src/server/daemon.ts` |
| タイムアウトとループ対策 | Phase 2 の予算上限に加え、サンドボックス準備失敗を検知した時点でタスクを停止する | `src/plugins/budget.ts` |
| 削除・上書きの保護 | `security.deleteMode`（既定 `backup`）。削除・上書きの前に対象を `.hearth/runs/<task>/backup/` へ複製し、`manifest.jsonl` に元のパスを記録する。対象パスが実行時に決まる削除（`Remove-Item $x`）は、バックアップできないので拒否する。`deny` はすべての削除を拒否し、`allow` はバックアップしない。1 タスクあたりの上限は 200 MB | `src/security/backup.ts`, `src/plugins/policy.ts` |
| Web 検索 | DeepSeek キー不要の検索プロバイダを DSH の検索の仕組み（`ctx.web.registerSearchProvider`）に登録した。バックエンドは SearXNG（推奨）または DuckDuckGo | `src/plugins/web-search.ts` |
| **フェイルクローズ（追加）** | DSH は、プラグインのロードに失敗しても警告を出すだけで実行を続ける。Hearth は、全 Hearth プラグインが「ロード完了」を報告するまでタスク本文を DSH に渡さない。1 つでも失敗すれば、モデルへの要求を 1 回も出さずにタスクを止める | `src/runner/dsh-runner.ts` |

## 2. テスト結果

| 種類 | 結果 |
|---|---|
| 型検査 | 成功 |
| 単体テスト | **80 / 80 成功** |
| 結合テスト（モックモデル + 実 DSH） | **18 / 18 成功**（Phase 3 で追加 7 件: 検証→修正→合格、修正上限で `verification_failed`、任意検証コマンド、圧縮をまたぐメモと履歴検索、プラグイン失敗時の起動拒否、SearXNG 経由の `web_search`、削除前バックアップ） |

### STRATA 実機（Qwen3.8-Flash-Next NVFP4, E: ドライブの作業フォルダ）

| タスク | 結果 |
|---|---|
| 検証ループ（high） | モデルは指示された `test_textutil.py` だけを実行して終わろうとした。Hearth の検証器が、別ファイル `test_edge_cases.py` の失敗（空白の連続、空文字列）を検出して差し戻した。モデルが `word_count` を修正し、2 回目の検証で合格（11 ステップ、58 秒）。私の再実行でも 6/6 成功 |
| 参考文献付き日本語 LaTeX（high） | 1 回目は upbibtex が失敗したが、その時点の `latex_compile` は SUCCESS と表示していた（下記の修正 2）。モデルは自分で bib を直し、2 回目でビルド成功、3 ページ、参考文献 2 件。ターン終了時の検証にも合格（3.2 分） |
| 削除（medium） | `Remove-Item 'a','b'` の配列引数が 1 つのパスとして扱われ、拒否された（下記の修正 1）。モデルは 1 ファイルずつ削除し、2 ファイルともバックアップ済み。修正後の再試行では配列引数のまま両方をバックアップして削除できた |

### 実機検証で見つけて直したもの

1. PowerShell の配列リテラル引数（`'a','b'`）を、AST 解析で別々の引数に分けるようにした。
2. upbibtex が失敗した場合は、`latex_compile` もビルド失敗として報告するようにした。
3. `pwsh` の `workdir` 引数がある場合は、削除対象の相対パスをその場所を基準に解決するようにした。
4. 圧縮後のメモ再注入をセッションイベントのリスナー内で行うと DSH のログ追記と衝突する（モックで発見）。次ステップの受付時（`agent/pre-step`）に追加する方式に変えた。

## 3. 未解決の問題・制約

- **Web 検索の既定は無効（`web.search: none`）。** DuckDuckGo は自動アクセスにボット検知ページ（HTTP 202）を返した。Hearth は回避せずエラーとして報告するので、実用にはローカルの SearXNG が必要（[setup-windows.md](setup-windows.md) §8）。`web_fetch` は従来どおり使える。
- 圧縮をまたぐメモ再注入は、モックで小さなコンテキスト長にして確認した。STRATA（131k コンテキスト）で圧縮が実際に起きる長時間タスクでは未検証。
- 検証器が見るのは「タスク中に更新時刻が変わったファイル」。削除だけのタスクや、ワークスペース外の生成物は検証の対象にならない。
- 型検査やリンタ（mypy、ruff、tsc など）は組み込みの検証器に含めていない。`--verify` で任意のコマンドとして指定する。
- `verification_failed` は「Hearth の検証に合格しなかった」ことを示すだけで、作業の正しさを完全に判定するものではない。
