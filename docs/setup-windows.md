# Windows セットアップ手順

## 1. 前提ソフトウェア

| ソフト | 用途 | 確認コマンド |
|---|---|---|
| Node.js 24.9+ | Hearth と DeepSeek Harness の実行 | `node --version` |
| Python 3 | `python_run` ツール | `python --version` |
| TeX Live 2025 | `latex_compile`（upLaTeX, dvipdfmx）と `pdf_inspect`（pdfinfo, pdffonts, pdftotext） | `uplatex --version` |
| Git | `git` ツール | `git --version` |
| Windows PowerShell 5.1 | コマンド危険判定（AST 解析）と DPAPI | 標準搭載 |

`hearth doctor --no-probe` でまとめて確認できます。

## 2. インストール

```powershell
git clone https://github.com/ryoma-89/hearth.git
cd hearth
.\scripts\setup.ps1
```

- `npm install` で DeepSeek Harness `0.2.2-rc.5` が `node_modules` に入ります（約 1.3 GB）。STRATA 同梱の DSH（`<STRATA のインストール先>\harness`）には触れません。
- DSH の作業領域は `hearth\.hearth\dsh-home` で、STRATA の `~/.strata/data/agent/home` とは別です。
- `hearth.yaml` が無ければ `config\hearth.example.yaml` からコピーされます。

## 3. STRATA との接続

この PC で確認した STRATA の構成（2026-11-20、実機で接続確認済み）:

- **利用者向け OpenAI 互換 API: `http://127.0.0.1:47831/v1`**（STRATA ホストが提供し、STRATA 設定のサービング API キーで認証）。モデル ID は `nvfp4-nvfp4`。
- `http://127.0.0.1:18500/v1` は推論エンジンの内部ポートで、STRATA 内部用の別キーで保護されています（サービング API キーでは 401）。Hearth からは使いません。
- 依頼文にあった `http://127.0.0.1:8080/v1` は応答しませんでした。STRATA の設定でポートを変えた場合は `hearth.yaml` の `providers.strata.baseURL` を変更してください。

API キーは STRATA の設定画面（サービング API キー）で確認し、Hearth に保存します。

```powershell
.\scripts\hearth.ps1 secret set strata
```

入力は表示されません。キーは Windows DPAPI（現在のユーザーのみ復号可能）で `%LOCALAPPDATA%\Hearth\secrets\strata.dpapi` に保存され、タスク実行時に DSH 子プロセスの環境変数としてだけ渡されます。環境変数で渡したい場合は `apiKey: { env: STRATA_API_KEY }` にしてください。

接続確認:

```powershell
.\scripts\hearth.ps1 doctor
```

- `GET /models` の結果から、`hearth.yaml` の `models[].id` を実際のモデル ID に合わせてください（例では `qwen3.8-flash-next-nvfp4-nvfp4`）。
- `tool calling` 行は、ツールを 1 つ渡した短いリクエストでネイティブなツール呼び出しが返るか、引数 JSON が正しいかを確認します。`WARN`（修復が必要）でも Hearth は実行時に修復しますが、`FAIL` のモデルは長時間タスクに向きません。

### 3.1 モデルの自動取得

`discoverModels: true`（STRATA の既定）なら、STRATA で読み込んだモデルが自動で選択肢に入ります。STRATA の GUI で別のモデル（例: IQ3_S 版）を読み込み、`hearth models --refresh` または GUI の ↻ を押すと確認できます。`defaultModel: strata/auto` にしておくと、常に読み込み中のモデルを使います。自動取得したモデルのコンテキスト長などは `discoveredModelDefaults` の値になるので、違う場合は `models:` に ID を書いて上書きしてください。

## 4. 作業フォルダの許可

### 4.1 フルコントロール権限（サンドボックスの前提条件）

DSH の Windows ACL サンドボックスは、作業フォルダに Low 整合性ラベルと専用の書き込み権限を設定してからコマンドを実行します。ラベルの設定には **WRITE_OWNER（フルコントロール）** が必要で、フォルダの所有者でも「変更」権限しかない場合は失敗します（`SetNamedSecurityInfoW failed (Win32 5)`。DSH の `dsh-sandbox-windows-acl` README に記載の仕様）。

開発時の PC では作業ドライブ（`E:\development`）以下のユーザー権限が「変更」だけ（`Authenticated Users: Modify` の継承）なので、そのままでは `pwsh` / `python_run` / `latex_compile` がすべて失敗します。`C:\Users\<ユーザー>` 以下はフルコントロールがあるので動きます。

確認（読み取りのみ）:

```powershell
.\scripts\hearth.ps1 doctor --no-probe --workspace E:\work\project
```

`FAIL ... lacks Full Control` と出た場合の対処は次のどちらかです。

1. 自分のアカウントにフルコントロールを付与する（フォルダの権限が変わるので、内容を理解したうえでご自身で実行してください）:
   ```powershell
   icacls "D:\work" /grant "${env:USERDOMAIN}\${env:USERNAME}:(OI)(CI)F"
   ```
2. 作業フォルダをユーザープロファイル配下（例 `C:\Users\<ユーザー>\work`）に置く。

注意: DSH はサンドボックスのために作業フォルダへ Low 整合性ラベルを恒久的に設定します（DSH の仕様で、同じユーザーの他の Low 整合性プロセスもそのフォルダに書き込めるようになります）。`security.sandbox: danger-full-access` にすればサンドボックス自体を使いませんが、コマンドがワークスペース外にも書き込めるので推奨しません。

### 4.2 許可する作業フォルダ

タスクは `security.allowedWorkspaceRoots` の配下でしか実行できません（既定は `defaultWorkspace` のみ）。例:

```yaml
security:
  allowedWorkspaceRoots:
    - D:/work
    - E:/work
```

## 5. 動作確認

```powershell
mkdir E:\work\hearth-demo
.\scripts\hearth.ps1 run "hello.py を作って実行し、出力を報告して" --workspace E:\work\hearth-demo
```

## 5.1 Web GUI

```powershell
.\scripts\hearth.ps1 gui
```

デーモンを起動し、1 回限り（60 秒有効）のログインリンクを既定のブラウザで開きます。以後はブラウザのセッションクッキー（12 時間）で使えます。リンクを手で開く場合は `--no-open` を付けて表示された URL を開きます。GUI は `http://127.0.0.1:47900/` だけで提供され、他の PC やスマートフォンからはアクセスできません（Tailscale 等による公開は未実装）。

## 6. 他のツールから呼ぶ

`scripts\hearth.cmd` は cmd/PowerShell/他プロセスから呼べます。

```powershell
<hearth のフォルダ>\scripts\hearth.cmd run --json --mode low --workspace E:\work\x "..."
```

`--json` では 1 行 1 イベントの NDJSON を標準出力に出し、最後の `{"type":"task", ...}` 行に最終状態・メトリクスが入ります。

## 7. トラブルシューティング

| 症状 | 確認 |
|---|---|
| `API key for provider strata: environment variable ... is not set` / `secret "strata" is not stored` | `hearth secret set strata` を実行 |
| タスクが `budget_exhausted`（`sandbox-unavailable`）で止まる / `SANDBOX_PREPARATION_FAILED` | 作業フォルダのフルコントロール不足。§4.1 を参照 |
| `strata: GET /models` が 401 | `baseURL` が `:18500`（エンジン内部ポート）になっていないか確認。利用者向けは `:47831` |
| `the Hearth daemon did not start within 20 s` | 別ターミナルで `hearth daemon run` を実行してエラーを確認。ポート 47900 が使用中なら `daemon.port` を変更 |
| `workspace ... is outside security.allowedWorkspaceRoots` | `hearth.yaml` に作業フォルダの親を追加 |
| タスクが `failed` で `MALFORMED_RESPONSE` | モデルのツール呼び出し品質の問題。`hearth logs <id>` で修復ログを確認、`modes.<mode>.malformedToolCallRetries` を増やすか別の量子化を試す |
| タスクが `verification_failed` | 自動検証に修正ラウンドの上限まで合格しなかった。`hearth show <id>` で失敗した検証を確認し、`hearth resume <id>` で続行するか、上位モードで再実行する |
| `Hearth plugin(s) did not load` | Hearth プラグインのロードに失敗したため、安全のためタスクを開始しなかった。`.hearth\runs\<task-id>\stderr.log` を確認 |
| 削除したファイルを戻したい | `.hearth\runs\<task-id>\backup\manifest.jsonl` に元のパス（`original`）とバックアップ（`backup`）が記録されている |
| 各タスクの詳細 | `.hearth\runs\<task-id>\` に `events.jsonl`（全イベント）、`stderr.log`（DSH 診断）、`audit.jsonl`（ツール監査）、`patch.yml`（使った DSH 構成）、`backup\`（削除・上書き前の複製） |

## 8. Web 検索（任意）

`web_search` は既定で無効です（`web_fetch` は使えます）。DuckDuckGo は自動アクセスにボット検知ページを返すことがあり、Hearth はそれを回避しないため、ローカルの [SearXNG](https://docs.searxng.org/) を推奨します。検索語は SearXNG から各検索エンジンへ送られます。

1. Docker Desktop で SearXNG を起動する（イメージのダウンロードが発生します）。
   ```powershell
   docker run -d --name searxng -p 127.0.0.1:8888:8080 searxng/searxng
   ```
2. コンテナ内の `/etc/searxng/settings.yml` で、`search.formats` に `json` を追加して再起動する。
3. `hearth.yaml` に追記する。
   ```yaml
   web:
     search: searxng
     searxngURL: http://127.0.0.1:8888
   ```
4. `.\scripts\hearth.ps1 doctor` の `web search` 行が PASS になることを確認する。

DuckDuckGo を試す場合は `web.search: duckduckgo` にします。ボット検知で失敗した場合は、そのエラーがツール結果としてモデルに返ります。
