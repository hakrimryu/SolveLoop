# SolveLoop

社内の問い合わせと解決履歴を、再利用できるナレッジへつなぐ業務支援システム。

架空企業「株式会社 柳」を題材にした個人ポートフォリオです。社員・問い合わせ・社内文書には合成データを使用します。

## 開発状況

共通レイアウト・ダッシュボード・問い合わせ管理・ナレッジ検索・レビュー・デモアカウント選択の画面モックを用意しました。問い合わせの登録・対応・解決から、手動の下書き保存、人による承認、公開文書の検索までを合成データで確認できます。

操作結果は同じタブの画面間で共有され、再読み込み・タブを閉じると初期化されます。DB保存・認証・セッション・パスワード検証・サーバーの権限検査・AI 推論・Radar の分析処理は未実装です。検索はキーワードの部分一致です。

ローカルDBは PostgreSQL 17.11 / pgvector 0.8.7 の起動・ベクトル演算・永続化まで検証済みです。バックエンドはDB接続・状態確認API・初期マイグレーションの基盤を用意しました。業務テーブル・業務API・画面との接続はまだありません。

## フロントエンドの起動

検証環境: Windows / PowerShell、Node.js 22.19.0、npm 10.9.3。Node.js は 22 系を使用し、検証したバージョンを `frontend/.node-version` に記録しています。このファイルだけで Node.js がインストール・切り替えされるわけではありません。

リポジトリのルートから実行します。

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev
```

[http://127.0.0.1:5173/](http://127.0.0.1:5173/) を開くとダッシュボードが表示されます。終了は `Ctrl+C` です。ポートが使用中の場合はエラーで終了します。

- ヘッダーの「デモ設定」を開き、「デモ用の役割切替」で担当者・社員を切り替えます。再読み込みすると担当者に戻ります。実際のログインや権限変更ではありません。
- 担当者の「根拠を確認」で Radar のサンプルを開きます。「閉じる」またはパネル内の `Escape` で元のリンクに戻ります。
- 「表示を確認」を開き、「表示確認（デモ用）」でデータなし・読み込み中・読み込みエラーを再現できます。「再試行」は通常表示に戻すシミュレーションです。
- 小さい画面ではメニューを開閉できます。問い合わせ表は表の領域だけを横にスクロールします。

初期資料は問い合わせ12件・承認済み文書3件・下書き2件・差し戻し1件・Radar候補1件です。初期基準日時は `2026/10/30 09:00 JST`、問い合わせとナレッジの操作日時は共通の合成時刻で1分ずつ進みます。実際の処理時間を示すものではありません。問い合わせ・確認待ちの件数はこのタブ内の資料から計算します。Radar の候補・文書対応状況は固定サンプルで、承認後も再分析されません。

### 問い合わせの確認手順

1. 担当者の Dashboard で「未割り当て」を開きます。未解決・未割り当ての3件が表示されます。「自分の担当（未解決）」は2件です。
2. キーワード・状態・担当部署・担当者で絞り込みます。検索は「検索」または変換確定後の Enter で反映します。条件・ページはURLに残り、詳細の一覧復帰リンクやブラウザーの戻る操作で保持されます。既定は20件/ページ・更新順です。
3. 「問い合わせを登録」で件名・内容・担当部署を入力します。必須項目の検証後、新しい詳細へ進みます。「次の登録を失敗させる（デモ用）」で入力を保持した再試行も確認できます。
4. 詳細で担当者を選び「割り当てを反映」→「対応を開始」→解決内容を入力→「解決内容を記録して解決」と進みます。空白だけの解決内容は受け付けません。解決記録・変更者・合成時刻と、一覧・Dashboardの件数に反映されます。
5. 未保存の入力がある状態で閉じる・画面移動・ブラウザーの戻る・役割変更を行うと、破棄の確認が出ます。ブラウザー自体の再読み込み・終了時の確認はブラウザーの仕様に依存します。自動保存・復元はありません。
6. 社員に切り替えると自己の問い合わせだけが表示され、未解決分の本文を編集できます。担当者向けの割り当て・状態変更・下書き操作は表示しません。表示制御のモックであり、実際のアクセス制御ではありません。

一覧・詳細の「表示を確認」でデータなし・読み込み中・エラーを再現できます。これらは表示だけのシミュレーションで、保持中の問い合わせ資料や編集中の入力は削除しません。「条件に一致しない」と「初期資料なし」は別の案内です。

### ナレッジと承認の確認手順

1. [ナレッジ一覧](http://127.0.0.1:4173/knowledge) は両役割とも承認済みの最新版だけを検索します。件名・適用対象・本文・文書番号の部分一致（空白区切りはAND）と担当部署で絞り込み、詳細から戻ってもURLの条件を保持します。
2. 担当者で解決済みの問い合わせを開き、「ナレッジの下書きを作成」へ進みます。未解決の問い合わせからは作成できません。元の番号・問い合わせ内容・解決内容の写しを確認し、社員向けの件名・適用対象・部署・本文を手動で入力します。
3. 「編集」「プレビュー」を切り替え、「下書きを保存」します。保存は公開ではありません。一般検索には出ず、Dashboardの確認待ちとレビュー一覧に反映されます。「次の保存・承認・差し戻しを失敗させる」で値を保持した再試行を確認できます。
4. 未保存の変更がある間は承認・差し戻しを利用できません。保存後、「承認して公開」で対象の文書・版・保存時刻と公開範囲を確認します。「この版を承認して公開」で社員全員の検索に反映され、確認待ちから外れます。担当者用の根拠・操作履歴は一般文書に表示しません。本文に含める情報は承認前に確認します。
5. 承認文書の「改訂版の下書きを作成」で新しい版を編集します。新しい版が承認されるまで、以前の承認版を公開し続けます。承認済み本文の直接編集はできません。
6. 「理由を入力して差し戻す」には理由が必須です。差し戻した文書は理由・履歴とともに閲覧でき、一般検索には出ません。差し戻し後の再編集・再申請はこのモックの対象外で、運用は未決定です。同一文書に未承認版がある場合は、さらに改訂版を作成しません。
7. [デモアカウント選択](http://127.0.0.1:4173/login) とヘッダーの役割切替は同じ状態を使います。社員にはレビュー・他人の問い合わせ・担当者用根拠を表示しません。レビューURLへ直接移動しても本文とページタイトルは表示不可の案内になります。これはサーバー認証の検証ではありません。

未保存の編集は一覧・根拠問い合わせへの移動、ブラウザーの戻る、役割変更で破棄を確認します。編集取消や理由入力後のダイアログ終了も確認します。読み込み・データなし・エラーの表示切替は編集中の内容を削除しません。本文は改行を保持するプレーンテキストで、HTML・Markdownを実行しません。

合成資料・選択・集計・入力検証・状態更新は `frontend/src/lib/mockData.ts` にまとめ、`App` の問い合わせ配列・ナレッジ版の配列を Dashboard・一覧・詳細に渡しています。編集バッファは画面内で保持し、保存した版と区別します。画面にAPI応答を埋め込まず、実際の連携段階でこの資料アクセス部分を置き換えます。

Windows では PowerShell のスクリプト実行ポリシーに依存しない `npm.cmd` を使用しています。ほかの環境では `npm` に読み替えてください。

同じ `frontend/` で検証します。

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run preview
```

`typecheck` は型エラーがなければ終了コード 0 で完了します。`build` は型検査の後に `dist/` を生成し、`preview` は [http://127.0.0.1:4173/](http://127.0.0.1:4173/) でビルド結果を表示します。preview はローカル確認用です。

`test` は Node.js のテストランナーと型除去を使い、30件で役割ごとの表示対象・集計・検索・ページ・登録検証・状態遷移・解決必須・履歴と時刻・Radar の参照に加え、承認版だけの検索・保存と公開の区別・差し戻し理由・改訂中の公開維持・解決根拠の変更を検証します。実際のサーバー権限検査や AI 評価のテストではありません。

Chromeで問い合わせ→解決→手動下書き→保存→承認→検索、役割と非公開情報、入力の破棄確認、エラー再試行、キーボード操作と390/640/1440pxの配置を確認しました。実際のOS日本語IME変換、スクリーンリーダー、ブラウザー200%拡大、ほかのブラウザー、継続実行する自動UI/E2Eテストは未検証です。

依存関係は `frontend/package-lock.json` で固定しています。バックエンド・DB・Docker・Ollama の準備は、この画面の起動には不要です。

## ローカルDBの起動と確認

検証環境: Windows / PowerShell 7、Docker Desktop の Linux エンジン、Docker CLI 29.4.1 / Compose v5.1.3、linux/amd64。PostgreSQL 17 は互換性を考慮した採用系列であり、最新のメジャーバージョンという意味ではありません。

### リソースの識別

| 対象 | 名前・用途 |
| --- | --- |
| Compose プロジェクト | `solveloop`（`infrastructure/compose.yaml`） |
| サービス / コンテナ | `db` / `solveloop-db-1` |
| named volume | `solveloop_postgres_data` → `/var/lib/postgresql/data` |
| ネットワーク | `solveloop_default` |
| 配布イメージ | `pgvector/pgvector:0.8.7-pg17-bookworm` |
| 固定 digest | `sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d` |

イメージは pgvector プロジェクトが PostgreSQL 公式イメージを基に配布するもので、独自ビルド・改変はしていません。タグと digest の両方を `infrastructure/compose.yaml` に固定しています。更新時は実際の PostgreSQL パッチ・pgvector・永続化を再検証します。

コンテナ・volume・ネットワークには `com.docker.compose.project=solveloop` のラベルが付き、コンテナとvolumeには日本語の用途説明も付きます。他プロジェクトのリソースを操作しないよう、以下ではプロジェクト名と設定ファイルを毎回指定します。DB の5432番はコンテナ内部だけで使用し、ホストへ公開しません。ホストの `localhost:5432` からは接続せず、`compose exec` を使います。

### 初回の設定と起動

Docker Desktop の Linux エンジンを起動します。以下のDB操作はすべてリポジトリのルートから実行し、`--env-file infrastructure/.env` と `-f infrastructure/compose.yaml` で対象ファイルを明示します。`-p solveloop` は配置先のフォルダー名による別プロジェクト・別volumeの作成を防ぎます。既に `solveloop` のリソースがある場合は、その用途を確認してから起動してください。

```powershell
docker info --format '{{.ServerVersion}} {{.OSType}}'
docker ps -a --filter label=com.docker.compose.project=solveloop
docker volume ls --filter label=com.docker.compose.project=solveloop
docker network ls --filter label=com.docker.compose.project=solveloop
```

`infrastructure/.env.example` は公開するキーと例です。パスワードは空欄なので、そのままでは起動できません。次の処理は既存の `infrastructure/.env` を上書きせず、ローカル専用のランダムな値を作成します。PowerShell 7 で一度だけ実行してください。

```powershell
if (Test-Path -LiteralPath infrastructure/.env) { throw 'infrastructure/.envは既に存在します。既存の設定を確認してください。' }
$dbLocalPassword = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
(Get-Content -Raw infrastructure/.env.example).Replace('POSTGRES_PASSWORD=', "POSTGRES_PASSWORD=$dbLocalPassword") |
  Set-Content -NoNewline -Encoding utf8 infrastructure/.env
Remove-Variable dbLocalPassword
git check-ignore -v infrastructure/.env
```

`infrastructure/.env` は Git 除外対象です。内容や、秘密値を展開する `docker compose config` / `docker inspect` の全出力を公開しないでください。シェルに同名の環境変数があると `infrastructure/.env` より優先されます。`POSTGRES_USER` はこのローカルDBを初期化する管理用ユーザーで、アプリの認証や本番用の最小権限設定ではありません。

```powershell
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml config --quiet
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml pull db
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml up -d --wait --wait-timeout 90 db
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml ps
```

`config --quiet` の終了コード0と、`solveloop-db-1` の `healthy` を確認します。各コマンドが失敗した場合は、原因を確認してから次へ進んでください。`PORTS` の `5432/tcp` はイメージの内部ポート表示で、`127.0.0.1:...->` のようなホスト公開ではありません。healthcheck はTCPで接続受付を確認し、パスワード・拡張・業務スキーマの検証は行いません。

起動しない場合は Docker エンジンの状態、`infrastructure/.env` の必須値、対象を限定した `docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml logs --tail 50 db` を確認します。ログを共有する前に秘密情報がないか確認してください。既存volumeのデータがある場合、`infrastructure/.env` の変更だけでDB名・ユーザー・パスワードは変更されません。エラー解消のためのvolume削除や全体の `prune` は行わないでください。

### 拡張・再起動・永続化の検証

以下のSQLはインフラ検証用であり、業務テーブル・デモシード・マイグレーションではありません。手動で実行するため、通常のDB起動時には適用されません。`prepare` は `vector` 拡張と専用スキーマ `solveloop_infra_check` に1行を作成します。同名スキーマが既にあれば上書きせず停止します。

```powershell
Get-Content -Raw infrastructure/verify-db-prepare.sql |
  docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec -T db sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
Get-Content -Raw infrastructure/verify-db-check.sql |
  docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec -T db sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
```

両方の終了コードが0で、`17.11`、`0.8.7`、`solveloop-volume-probe`、`[1,2,3]`、距離 `5` が表示されることを確認します。`check` は保存行・拡張版・ベクトル演算が想定と違う場合に例外で失敗します。この3次元ベクトルは検証専用で、将来の埋め込みモデル・次元数を決めるものではありません。

```powershell
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml ps -q db
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml restart db
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml up -d --no-recreate --wait --wait-timeout 90 db
Get-Content -Raw infrastructure/verify-db-check.sql |
  docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec -T db sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'

docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml up -d --force-recreate --wait --wait-timeout 90 db
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml ps -q db
Get-Content -Raw infrastructure/verify-db-check.sql |
  docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec -T db sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
```

再起動後とコンテナ再作成後に同じ保存行・距離が表示されます。再作成ではコンテナIDが変わり、`solveloop_postgres_data` は保持されます。検証終了後は、次の処理で専用テーブル・スキーマだけを削除します。`vector` 拡張とvolumeは残ります。

```powershell
Get-Content -Raw infrastructure/verify-db-cleanup.sql |
  docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec -T db sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
```

### 通常の確認・停止

```powershell
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml ps
docker volume ls --filter label=com.docker.compose.project=solveloop
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec db sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

psql 内では `SELECT version();`、`SELECT extversion FROM pg_extension WHERE extname = 'vector';` で版を確認し、`\q` で終了します。イメージの初期設定ではUnixソケット・コンテナ内localhostは信頼接続です。パスワード認証の確認は、Dockerネットワークのサービス名 `db` に接続します。次のコマンドは値を表示せず、コンテナ内の環境変数を使います。`db` への正しいパスワードの成功と誤ったパスワードの拒否を確認しました。

```powershell
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -h db -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

停止するときは `docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml stop db`、再開は前述の `up -d --wait` を使用します。コンテナ・ネットワークも外す場合は `docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml down` でvolumeを保持できます。`down --volumes` や `volume rm` / `prune` はデータ削除になるため通常手順に含めません。再起動・再作成での保持はバックアップ・復元の検証を意味しません。

## バックエンドの起動と検証

### 実行環境と設定

ホストでは Python 3.13.2 / uv 0.10.4、コンテナでは Python 3.13.18 / uv 0.10.4 を検証しました。ホストのPythonは変更していません。`backend/.python-version` はホストで検証した版を示します。コンテナは別途 Dockerfile のパッチ版と digest を固定し、Python の自動ダウンロードを無効にしています。

`backend/pyproject.toml` は Python 3.13 系を指定し、直接依存は完全な版番号、間接依存と配布物のハッシュは `backend/uv.lock` で固定しています。SQLAlchemy 2.0.55 は保守系列の採用で、最新系列という意味ではありません。

既存の `infrastructure/.env` はそのまま使います。Compose は必要なDB変数だけをバックエンドへ渡し、実際の環境ファイルをイメージへコピーしません。

| 環境変数 | 用途 |
| --- | --- |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | 既存DBの接続先・資格情報。すべて必須、空欄不可 |
| `DB_HOST` / `DB_PORT` | バックエンドの接続先。既定値は `db` / `5432`、Composeでは内部ネットワークを使用 |
| `BACKEND_PORT` | Compose のホスト側APIポート。未指定時8000、公開先は常に `127.0.0.1` |

アプリは `.env` を自動探索しません。ホスト実行時は必要な値を環境変数で明示してください。現在DBポートはホストへ公開していないため、DBを使う通常の実行はComposeで行います。DB初期化用ユーザーをローカル開発の接続にも使用しています。本番用の最小権限設定やアプリ利用者の認証は未実装です。

SQLAlchemy は同期接続を使います。要求ごとにセッションを開き、終了時に未コミット分を rollback して接続を返却します。コミットは業務処理側で明示する方式です。接続とプール待機・SQL実行には各3秒の制限を設定していますが、DNSなどを含む要求全体の厳密な上限ではありません。

### マイグレーションとAPI起動

以下はリポジトリのルートで実行します。初回の `.env` 作成は前述のDB手順を使い、既存ファイルを上書きしないでください。既存の画面 preview 4173 はそのまま利用できます。

```powershell
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml config --quiet
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml up -d --wait --wait-timeout 90 db
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml build backend
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml run --rm --no-deps backend alembic upgrade head
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml up -d --no-deps --wait --wait-timeout 90 backend
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec backend alembic current
```

各命令が成功してから次へ進みます。マイグレーションはアプリ開始時に自動実行しません。DB起動のhealthcheckは接続受付だけ、APIのhealthcheckは現在のマイグレーションと拡張も確認します。初回にマイグレーションを省略するとAPI自体は起動しますが `ready` が503となり、Compose の `--wait` は失敗します。状態を確認して上の `alembic upgrade head` を実行してください。

初期 revision は `0001_vector` です。空DBでは `public.vector` 拡張を作成し、既存の拡張があれば保持します。`alembic_version` は適用済みrevisionを記録する管理用テーブルで、問い合わせ・知識・利用者の業務テーブルではありません。起動や状態確認からテーブルを自動作成しません。現在は手書きrevisionの基盤であり、業務モデルの自動差分生成はまだ構成していません。

初期revisionのdowngradeは拡張・業務データを削除しません。通常の運用手順としてdowngrade・`stamp`・volumeの削除を使って不一致を隠さず、適用履歴と接続先を確認してください。別のスキーマに既存vectorがある環境は自動移動せず、readyが失敗します。

### 状態確認

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health/live
Invoke-RestMethod http://127.0.0.1:8000/health/ready | ConvertTo-Json -Depth 5
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml ps
```

| URL | 正常時 | DB停止・未適用時 |
| --- | --- | --- |
| [/health/live](http://127.0.0.1:8000/health/live) | 200、`status=alive` | APIプロセスが動いていれば200 |
| [/health/ready](http://127.0.0.1:8000/health/ready) | 200、`status=ready`、`scope=backend_foundation` | 503、`status=not_ready`、秘密値のない案内とrequest_id |
| [/docs](http://127.0.0.1:8000/docs) | 状態確認APIのOpenAPI画面 | 業務APIは未実装 |

`ready` はDBへのSQL実行、適用revision集合とソースのhead集合の一致、publicのvector拡張を確認します。これは現在の基盤スキーマの確認であり、業務機能・認証・デモ資料の準備完了やスキーマ全体の改変検知を意味しません。Ollama・AIは起動も状態確認も要求しません。AIの状態表示は未実装です。

DB障害は要求を失敗させ、画面モックや固定応答で置き換えません。接続例外の本文・SQL・資格情報はAPI応答とアプリログに出力しません。DB復旧後は接続プールの再接続でreadyが200へ戻ります。元のDBを止めず、専用の検証プロジェクトで停止・復旧を確認しました。

### ローカル検査とCI

ホストでDBを使わない検査は、ルートから `backend/` に移動して実行します。

```powershell
Set-Location backend
uv sync --locked
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked pytest -q
```

既定では単体テスト5件を実行し、専用DBを要求する統合テスト1件はskipします。統合テストは `RUN_DB_TESTS=1` とDB名 `solveloop_test` の両方を要求し、空DBからのみ開始します。DB名だけで安全を保証するものではないので、必ず別のComposeプロジェクト・新しいvolumeを使ってください。SQLiteは使いません。

リポジトリのルートでは以下でCIと同じ検証用イメージを構築できます。

```powershell
docker build --target test -t solveloop-backend-test:local backend
docker run --rm solveloop-backend-test:local ruff check .
docker run --rm solveloop-backend-test:local ruff format --check .
docker run --rm solveloop-backend-test:local
```

[基本CI](.github/workflows/ci.yaml) は Ubuntu 24.04 のGitHub Actionsで、lockを変更しないイメージ構築・Ruff・単体テスト・空のPostgreSQLでのマイグレーション・実HTTP・DB停止/復旧を実行する定義です。`solveloop-ci` 専用の環境・DB・volumeを作り、終了時にその検証volumeだけを削除します。既存の `solveloop` DBには実行しません。フロントのCI・業務API・AI評価は対象外です。ローカルで相当の検証を実行しましたが、GitHub Actions上ではまだ実行していません。

Dockerfileは `backend/Dockerfile`、ビルドコンテキストは `backend/`、適用される除外定義は `backend/.dockerignore` です。ルートの `.docs`・AGENTS・`.git`・`infrastructure/.env`・frontendはコンテキスト外です。コンテキスト内も必要なソースとlock等の許可リストだけを渡します。実行用 `runtime` targetは非rootで動作し、開発用依存とtestsは含めません。`test` targetだけがそれらを追加します。

APIだけを停止する場合は `docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml stop backend` を使います。DBや画面previewの停止は別操作です。

## 実装予定

- 問い合わせの登録・担当者の割り当て・対応履歴の管理
- 承認済みナレッジと過去の解決事例を使った検索・回答案の作成
- 解決履歴に基づく文書の下書きと、担当者による確認・承認
- 繰り返し発生する問い合わせと文書の不足を可視化する Knowledge Gap Radar

問い合わせ → 解決 → 文書化 → 承認 → 次の問い合わせへの活用、という流れを実装します。

## 技術構成

| 領域 | 採用済み・採用予定 |
| --- | --- |
| フロントエンド（導入済み） | React 19.3.1 / TypeScript 7.0.2 / Vite 8.3.5 / React Router 7.18.5 |
| バックエンド（実行基盤） | Python 3.13 / FastAPI 0.162.0 / SQLAlchemy 2.0.55 / Alembic 1.20.1 |
| データベース（ローカル起動・保存を検証済み） | PostgreSQL 17.11 / pgvector 0.8.7、業務連携・意味検索は未実装 |
| ローカル推論 | Ollama |
| 実行環境・検証 | Docker Compose / pytest / Vitest / Playwright / GitHub Actions |

生成と埋め込みはローカルの Ollama で実行する方針です。使用モデルと動作環境は、実装時の検証後に記載します。

## リポジトリ構成

```text
frontend/          画面とフロントエンドのテスト
backend/           API・業務処理・AI連携
infrastructure/    Compose・環境変数の例・DB検証SQL（実際の.envはGit除外）
demo/              架空企業のデータと再現シナリオ
evaluations/       検索・分類・Radarの評価
```

残りの業務画面・デモ動画・評価結果は実装と検証に合わせて追加します。

## 参考・利用した OSS

バックエンドは [FastAPIのコンテナ実行](https://fastapi.tiangolo.com/deployment/docker/)、[Pydantic Settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)、[SQLAlchemyの同期Session](https://docs.sqlalchemy.org/en/20/orm/session_basics.html)・[psycopg dialect](https://docs.sqlalchemy.org/en/20/dialects/postgresql.html#module-sqlalchemy.dialects.postgresql.psycopg)、[Alembic](https://alembic.sqlalchemy.org/en/latest/tutorial.html)、[uvのDocker連携](https://docs.astral.sh/uv/guides/integration/docker/)、[Dockerのcontextと除外](https://docs.docker.com/build/concepts/context/#dockerignore-files)を設計参考にしました。Full Stack FastAPI Templateはサービス・health・実行分離の参考で、コードのコピー・改変・テンプレート生成はしていません。JWT・SQLModel・メール・workerは導入していません。

| パッケージ・イメージ | 固定版・利用範囲 | ライセンス |
| --- | --- | --- |
| [FastAPI](https://github.com/fastapi/fastapi) / [Pydantic](https://github.com/pydantic/pydantic) / [Pydantic Settings](https://github.com/pydantic/pydantic-settings) | 0.162.0 / 2.14.2 / 2.16.2、API・設定検証 | MIT |
| [SQLAlchemy](https://github.com/sqlalchemy/sqlalchemy) / [Alembic](https://github.com/sqlalchemy/alembic) | 2.0.55 / 1.20.1、同期DB・変更履歴 | MIT |
| [psycopg / psycopg-binary](https://github.com/psycopg/psycopg) | 3.3.6、PostgreSQLドライバーの公式binary配布物 | LGPL-3.0-only、同梱ライブラリは各配布物の表示を保持 |
| [Uvicorn](https://github.com/encode/uvicorn) | 0.54.0、ASGIサーバー | BSD-3-Clause |
| [Ruff](https://github.com/astral-sh/ruff) / [pytest](https://github.com/pytest-dev/pytest) / [httpx2](https://github.com/pydantic/httpx2) | 0.17.3 / 9.2.0 / 2.16.0、開発用検査 | MIT / MIT / BSD-3-Clause |
| [Python公式イメージ](https://hub.docker.com/_/python) | 3.13.18-slim-bookworm、digest `sha256:281d39ff02e3b389401586134ff9e6572954687822a58055ec07a60ded4e0b7f` | PythonはPSF、同梱OS等は各ライセンス |
| [uv](https://github.com/astral-sh/uv/tree/0.10.4) | 0.10.4、公式イメージから実行ファイルをコピー、digest `sha256:4cac394b6b72846f8a85a7a0e577c6d61d4e17fe2ccee65d9451a8b3c9efb4ac` | MITを選択、[原文表示](backend/THIRD_PARTY_NOTICES.txt)を同梱 |
| [actions/checkout](https://github.com/actions/checkout/tree/v7.0.1) | v7.0.1のcommitをCIに固定、ソース取得 | MIT |

依存パッケージ・配布バイナリは未改造です。インストール済みの `.dist-info/licenses` とベースイメージ内のライセンス原文を削除しません。uvの原文表示も実行イメージにコピーします。独自に作成したのは設定・セッション境界・状態確認・revision・テスト・Compose追加・CIです。本プロジェクト自体のライセンスは未決定です。

DB構成は [Docker Compose のサービス定義](https://docs.docker.com/reference/compose-file/services/)・[volume](https://docs.docker.com/engine/storage/volumes/)・[環境変数](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)、[PostgreSQL 公式イメージの保存先・初期設定](https://hub.docker.com/_/postgres)、[PostgreSQL 17 の pg_isready](https://www.postgresql.org/docs/17/app-pg-isready.html) を設計参考にしました。[Full Stack FastAPI Template の Compose](https://github.com/fastapi/full-stack-fastapi-template/blob/master/compose.yml) はDBの状態確認・保存・必須変数の分け方だけを参考にし、コードはコピーしていません。

[pgvector 0.8.7](https://github.com/pgvector/pgvector/tree/v0.8.7) の[配布イメージ](https://hub.docker.com/r/pgvector/pgvector)をそのまま利用しています。[Dockerfile](https://github.com/pgvector/pgvector/blob/v0.8.7/Dockerfile)と[ライセンス](https://github.com/pgvector/pgvector/blob/v0.8.7/LICENSE)を確認し、タグ・digest・実測版は上の表に記載しました。pgvector と [PostgreSQL](https://www.postgresql.org/about/licence/) は PostgreSQL License で、コンテナ内の原文表示・同梱コンポーネントのライセンスは保持されます。外部ソース・Dockerfile・検証SQLのコピーや改変、独自イメージの配布は行っていません。これらの利用条件は、本プロジェクト自体のライセンス選択とは別です。

[Vite 公式ガイド](https://vite.dev/guide/)、[React の構築手順](https://react.dev/learn/build-a-react-app-from-scratch)、[TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) を環境構成の参考にしました。生成テンプレートや他製品の画面・ソースはコピーしていません。

[Zammad の問い合わせ画面](https://user-docs.zammad.org/en/latest/basics/ticket-basics.html)・[知識ベース](https://user-docs.zammad.org/en/latest/extras/knowledge-base.html)、[BookStack の公式画面](https://www.bookstackapp.com/#screenshots)、[Carbon のデータテーブル](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines)、[Pajamas の表設計](https://design.gitlab.com/components/table/) を情報配置・表・文書閲覧・編集と根拠の分離の設計参考にしました。これらの製品のコード・画像・フォント・アイコンは利用していません。

| パッケージ | 利用範囲 | ライセンス |
| --- | --- | --- |
| [React / React DOM](https://github.com/facebook/react) 19.3.1 | 画面の構成・描画 | MIT |
| [React Router](https://github.com/remix-run/react-router) 7.18.5 | URL・メニュー・ブラウザーの戻る操作 | MIT |
| [Vite](https://github.com/vitejs/vite) 8.3.5 / [React plugin](https://github.com/vitejs/vite-plugin-react) 6.1.2 | 開発サーバー・ビルド・開発時の更新 | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) 7.0.2 | アプリと Vite 設定の型検査 | Apache-2.0 |
| [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | React / React DOM / Node.js の型定義 | MIT |

共通レイアウト・ダッシュボード・問い合わせ画面・合成資料と状態更新を作成し、依存パッケージ本体は改変していません。React Router は [公式のルーターAPI](https://reactrouter.com/api/data-routers/createBrowserRouter) と [移動の保護](https://reactrouter.com/api/hooks/useBlocker) を参考に利用し、`RouterProvider` で未保存入力を保護しています。Loader・サーバー機能は使用していません。型検査・資料のテスト・ビルド・ブラウザー表示を確認しました。React / React DOM / scheduler / React Router と追加された依存パッケージの著作権・ライセンスは [THIRD_PARTY_NOTICES.txt](frontend/public/THIRD_PARTY_NOTICES.txt) に保存し、ビルド時に `dist/` にもコピーします。各開発用依存のライセンスはインストールしたパッケージ内に保持されます。
