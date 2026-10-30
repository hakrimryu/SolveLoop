# SolveLoop

社内の問い合わせと解決履歴を、再利用できるナレッジへつなぐ業務支援システム。

架空企業「株式会社 柳」を題材にした個人ポートフォリオです。社員・問い合わせ・社内文書には合成データを使用します。

## 開発状況

ログイン・ログアウト・本人のパスワード変更とアカウント管理画面は、ローカルAPIに接続しています。サーバーの管理権限と初回変更の必要状態を使い、アカウント一覧・追加・無効化・再有効化・仮パスワード再発行・変更履歴を操作できます。

問い合わせ・ナレッジ・Dashboard・Radarは合成データの画面モックです。業務の登録・対応・解決・手動の下書き保存・承認・検索を確認できますが、業務DB保存・所有者や担当者のサーバー検査・AI推論・Radar分析は未実装です。業務資料は認証世代ごとに初期化します。実際のUUIDを合成利用者IDへ置き換えず、新しい社員の自己問い合わせは0件から始まります。

バックエンドはPostgreSQL 17.11 / pgvector 0.8.7を使用し、部門・利用者・セッション・監査記録と適用履歴を保存します。管理権限は業務の役割と独立しています。管理権限編集・アカウント削除・既存プロフィール編集は提供しません。

## フロントエンドの起動

検証環境: Windows / PowerShell、Node.js 22.19.0、npm 10.9.3。Node.js は 22 系を使用し、検証したバージョンを `frontend/.node-version` に記録しています。このファイルだけで Node.js がインストール・切り替えされるわけではありません。

先に後述のDB/API起動・マイグレーション・必要な最小シードを実行してください。フロントエンドだけではログインできません。リポジトリのルートから実行します。

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev
```

[http://127.0.0.1:5173/](http://127.0.0.1:5173/) を開くとログイン画面が表示されます。終了は `Ctrl+C` です。ポートが使用中の場合はエラーで終了します。

Viteは `/api` を `http://127.0.0.1:8000` へ転送します。ブラウザーからは同一Originの相対URLだけを使い、CORSは追加しません。既存の5174を使う場合は `npm.cmd run dev -- --port 5174` で起動します。APIの `AUTH_ALLOWED_ORIGINS` には実際に開くOriginを完全一致で含めてください。公開 `.env.example` は127.0.0.1の5173/5174と既存8000を指定します。以前の `.env` を維持する場合は、起動するPowerShellで次を指定してからComposeのbackendを再作成できます。

```powershell
$env:AUTH_ALLOWED_ORIGINS='["http://127.0.0.1:8000","http://localhost:8000","http://127.0.0.1:5173","http://127.0.0.1:5174"]'
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml up -d --no-deps backend
```

独立した検証APIへ向ける場合だけ `SOLVELOOP_API_TARGET` でViteの転送先を変更します。検証OriginもAPI側で明示してください。同じhostの別portはcookieを共有するため、原本と検証は別hostとcookie jarを使用します。

### 認証・アカウント管理の確認手順

1. 後述の最小シードを用意した環境では `employee` / `operator` と公開デモパスワードでログインできます。役割選択や画面専用の固定managerはありません。再読み込み後もサーバーの有効なセッションを確認します。
2. 管理権限は自動付与しません。必要な場合だけ対象を明示し、後述のローカルbootstrapコマンドを実行して再ログインします。通常のoperatorには管理権限がありません。
3. 「アカウント管理」で氏名・ID・既存部門・役割を指定して追加します。IDは半角英数字・`.`・`_`・`-`の1〜100文字で、大文字・小文字を区別します。氏名は前後空白を除いて1〜100文字、改行・制御文字は使えません。
4. 成功直後だけ表示される仮パスワードで対象にログインします。初回・再発行のログインでは本人変更だけを利用できます。現在/仮値、新しい値、確認を入力してください。確認欄は画面だけで検査し、APIへ送りません。
5. 新しい値は15〜256 Unicode文字で、現在と同じ値・公開デモ用の値・空白だけ・制御文字を拒否します。空白やUnicodeは正規化しません。変更で全接続が終了し、新しい値で再ログインします。
6. 管理一覧で対象を選ぶと実際の変更履歴と20件ずつのページを確認できます。無効化は全接続と再ログインを停止します。再有効化しても古い接続は復活せず、新しいログインが必要です。自分の無効化はできません。
7. 仮値の再発行は旧パスワードと全接続を無効にします。自分への再発行成功では管理資料を終了し、ログイン画面上の専用一回表示だけに値を保ちます。閉じる・移動・別ログイン・認証無効化で原文を消去します。自動コピー・原文再照会はありません。

共通fetchはcookie・CSRF・no-store・エラー処理をまとめます。起動・再表示・画面移動・書込み直前にmeを確認し、同じ利用者の新ログイン、UUID/権限/制限変更、logout、401で認証世代を更新します。進行中のfetchを中断し、以前の世代の遅延応答も捨てます。管理資料・原文・編集・選択・復帰情報・業務snapshot・タイトルを前の利用者から引き継ぎません。別タブには秘密のない無効化通知だけを送り、受信側もサーバーを再確認します。非表示タブは内容を隠し、再確認前には再表示しません。

401・権限喪失の資料除去は未保存確認で取り消せません。通信障害は認証切れと断定せず表示を止めて再確認を案内します。POSTは自動再送せず、409は一覧・履歴を再取得して人が再操作します。503・応答喪失は反映済みの可能性があるため、追加を繰り返す前にIDと履歴を確認します。原文を失った場合は対象を確認して明示的に再発行してください。

業務画面だけには「表示を確認」の合成状態切替が残ります。初期業務資料は問い合わせ12件・承認済み文書3件・下書き2件・差し戻し1件・Radar候補1件です。基準日時は2026/10/30 09:00 JSTで、業務操作は1分ずつ進む合成時刻です。認証・管理履歴は実際のサーバー時刻です。

### 問い合わせの確認手順

1. 担当者の Dashboard で「未割り当て」を開きます。未解決・未割り当ての3件が表示されます。「自分の担当（未解決）」は2件です。
2. キーワード・状態・担当部署・担当者で絞り込みます。検索は「検索」または変換確定後の Enter で反映します。条件・ページはURLに残り、詳細の一覧復帰リンクやブラウザーの戻る操作で保持されます。既定は20件/ページ・更新順です。
3. 「問い合わせを登録」で件名・内容・担当部署を入力します。必須項目の検証後、新しい詳細へ進みます。「次の登録を失敗させる（デモ用）」で入力を保持した再試行も確認できます。
4. 詳細で担当者を選び「割り当てを反映」→「対応を開始」→解決内容を入力→「解決内容を記録して解決」と進みます。空白だけの解決内容は受け付けません。解決記録・変更者・合成時刻と、一覧・Dashboardの件数に反映されます。
5. 未保存の入力がある状態で閉じる・画面移動・ブラウザーの戻る・ログアウトを行うと、破棄の確認が出ます。ブラウザー自体の再読み込み・終了時の確認はブラウザーの仕様に依存します。自動保存・復元はありません。
6. 社員アカウントでログインすると自己の問い合わせだけが表示され、未解決分の本文を編集できます。担当者向けの割り当て・状態変更・下書き操作は表示しません。表示制御のモックであり、実際のアクセス制御ではありません。

一覧・詳細の「表示を確認」でデータなし・読み込み中・エラーを再現できます。これらは表示だけのシミュレーションで、保持中の問い合わせ資料や編集中の入力は削除しません。「条件に一致しない」と「初期資料なし」は別の案内です。

### ナレッジと承認の確認手順

1. [ナレッジ一覧](http://127.0.0.1:4173/knowledge) は両役割とも承認済みの最新版だけを検索します。件名・適用対象・本文・文書番号の部分一致（空白区切りはAND）と担当部署で絞り込み、詳細から戻ってもURLの条件を保持します。
2. 担当者で解決済みの問い合わせを開き、「ナレッジの下書きを作成」へ進みます。未解決の問い合わせからは作成できません。元の番号・問い合わせ内容・解決内容の写しを確認し、社員向けの件名・適用対象・部署・本文を手動で入力します。
3. 「編集」「プレビュー」を切り替え、「下書きを保存」します。保存は公開ではありません。一般検索には出ず、Dashboardの確認待ちとレビュー一覧に反映されます。「次の保存・承認・差し戻しを失敗させる」で値を保持した再試行を確認できます。
4. 未保存の変更がある間は承認・差し戻しを利用できません。保存後、「承認して公開」で対象の文書・版・保存時刻と公開範囲を確認します。「この版を承認して公開」で社員全員の検索に反映され、確認待ちから外れます。担当者用の根拠・操作履歴は一般文書に表示しません。本文に含める情報は承認前に確認します。
5. 承認文書の「改訂版の下書きを作成」で新しい版を編集します。新しい版が承認されるまで、以前の承認版を公開し続けます。承認済み本文の直接編集はできません。
6. 「理由を入力して差し戻す」には理由が必須です。差し戻した文書は理由・履歴とともに閲覧でき、一般検索には出ません。差し戻し後の再編集・再申請はこのモックの対象外で、運用は未決定です。同一文書に未承認版がある場合は、さらに改訂版を作成しません。
7. [ログイン](http://127.0.0.1:5173/login) から実際の担当者・社員アカウントで確認します。社員にはレビュー・他人の問い合わせ・担当者用根拠を表示しません。レビューへのアクセスも表示不可の案内になります。これはサーバー認証の検証ではありません。

未保存の編集は一覧・根拠問い合わせへの移動、ブラウザーの戻るで破棄を確認します。認証終了では入力を除去します。編集取消や理由入力後のダイアログ終了も確認します。読み込み・データなし・エラーの表示切替は編集中の内容を削除しません。本文は改行を保持するプレーンテキストで、HTML・Markdownを実行しません。

合成資料・選択・集計・入力検証・状態更新は `frontend/src/lib/mockData.ts` にまとめ、`App` の問い合わせ配列・ナレッジ版の配列を Dashboard・一覧・詳細に渡しています。認証・アカウント管理は `frontend/src/lib/api.ts` の実API境界を使用します。編集バッファは画面内で保持し、保存した版と区別します。画面にAPI応答を埋め込まず、実際の連携段階でこの資料アクセス部分を置き換えます。

Windows では PowerShell のスクリプト実行ポリシーに依存しない `npm.cmd` を使用しています。ほかの環境では `npm` に読み替えてください。

同じ `frontend/` で検証します。

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run preview
```

`typecheck` は型エラーがなければ終了コード 0 で完了します。`build` は型検査の後に `dist/` を生成し、`preview` は [http://127.0.0.1:4173/](http://127.0.0.1:4173/) でビルド結果を表示します。preview はローカル確認用です。

previewの4173はAPIの既定の許可Originに含めていません。previewでログイン・更新を確認する場合は、先にリポジトリのルートから次を実行し、既存の許可Originに実際のpreview Originを追加してbackendを再作成します。異なるOriginを使用中の場合は、その値も維持してください。実際の `.env` は書き換えません。

```powershell
$env:AUTH_ALLOWED_ORIGINS='["http://127.0.0.1:8000","http://localhost:8000","http://127.0.0.1:5173","http://127.0.0.1:5174","http://127.0.0.1:4173"]'
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml up -d --no-deps --wait --wait-timeout 90 backend
```

この環境変数は同じPowerShellでの後続のCompose実行にも使われます。別のPowerShellからbackendを再作成する場合は、必要なOriginを再指定してください。設定せずにpreviewからログイン・更新すると、Origin検査で403になります。

既存のpreviewと`dist/`を保全して検証する場合は、`npm.cmd run build -- --outDir ../.local/u06-dist`を使います。開発サーバーを別ポートで確認する場合は、空きポートを確認して`npm.cmd run dev -- --host 127.0.0.1 --port 5174 --strictPort`を実行します。既に動作しているサーバーは重複起動・終了しません。

`test` はNode.jsのテストランナーと型除去を使います。認証・fetchの単体境界、世代更新、遅延応答と最終反映直前の旧世代結果の破棄、通知・非表示状態、Unicode入力、業務snapshot分離と既存の業務合成資料を47件で検証します。実サーバーの権限・DB・HTTP検証は後述のpytestと分けます。

専用PostgreSQL/APIと分離したブラウザーで、実際の追加→仮ログイン→本人変更→再ログイン、他管理者による無効化・再有効化、自己再発行、同じroleのUUID切替、複数タブのlogin/logout、権限・制限変更、409競合、履歴のページを確認しました。実DB停止の503と復旧、テスト専用プロキシの404・空一覧・遅延応答は別の検証です。問い合わせ・知識の実API E2Eはまだありません。

Chromeの390/640/1440pxでフォーム・表・日本語表示、キーボード順序・エラー要約のフォーカス・Escapeを確認しました。非表示タブの除去・復帰待ちはイベント単体検証と一般Chromeでの利用者による実タブ切替で確認しました。後者は秘密値を含まない状態記録で、入力消去→確認中→再表示の順序を照合しています。実OS日本語IME、スクリーンリーダー、200%拡大、他OS、継続実行する自動UI/E2Eは未検証です。依存関係は `frontend/package-lock.json` で固定しています。ログインにはDB/APIが必要で、Ollamaは不要です。

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
| `AUTH_ALLOWED_ORIGINS` | JSON配列。既定は `http://127.0.0.1:8000`、`http://localhost:8000`、`http://127.0.0.1:5173`、`http://127.0.0.1:5174`。previewの4173は使用時だけ明示追加。パス・末尾スラッシュ・ワイルドカード不可 |
| `AUTH_COOKIE_SECURE` | ローカルHTTPでは既定 `false`。HTTPSでは `true` を明示 |

アプリは `.env` を自動探索しません。ホスト実行時は必要な値を環境変数で明示してください。現在DBポートはホストへ公開していないため、DBを使う通常の実行はComposeで行います。DB初期化用ユーザーをローカル開発の接続にも使用しています。アプリのemployee/operator認証とは別で、本番用DBの最小権限設定は未実装です。APIポートを変える場合は許可Originも合わせて指定してください。フロントはViteの `/api` プロキシを使い、CORSは構成していません。

SQLAlchemy は同期接続を使います。要求ごとにセッションを開き、終了時に未コミット分を rollback して接続を返却します。コミットは業務処理側で明示する方式です。接続とプール待機・SQL実行には各3秒の制限を設定していますが、DNSなどを含む要求全体の厳密な上限ではありません。

### マイグレーションとAPI起動

以下はリポジトリのルートで実行します。初回の `.env` 作成は前述のDB手順を使い、既存ファイルを上書きしないでください。preview 4173で認証を確認する場合は、前述のpreview用Originを指定してからbackendを起動してください。

```powershell
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml config --quiet
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml up -d --wait --wait-timeout 90 db
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml build backend
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml run --rm --no-deps backend alembic upgrade head
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml up -d --no-deps --wait --wait-timeout 90 backend
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec backend alembic current
```

各命令が成功してから次へ進みます。マイグレーションはアプリ開始時に自動実行しません。DB起動のhealthcheckは接続受付だけ、APIのhealthcheckは現在のマイグレーションと拡張も確認します。初回にマイグレーションを省略するとAPI自体は起動しますが `ready` が503となり、Compose の `--wait` は失敗します。状態を確認して上の `alembic upgrade head` を実行してください。

初期revision `0001_vector` は空DBに `public.vector` を作成し、既存の拡張を保持します。`0002_auth` は部門・利用者・セッション、現在のhead `0003_account_auth` は管理権限・変更必要状態・行バージョンと `audit_events` を追加します。既存の利用者ID・パスワード・有効状態・セッションをマイグレーションで変更しません。既存利用者の新しい値は権限なし・変更要求なし・バージョン1です。`alembic_version` は適用履歴です。起動や状態確認からテーブル・シードを自動作成しません。`alembic check` でモデルと実DBの差分を確認できます。

初期revisionのdowngradeは拡張を削除せず、認証revisionのdowngradeはデータ削除を避けるため拒否します。通常の運用手順としてdowngrade・`stamp`・volumeの削除を使って不一致を隠さず、適用履歴と接続先を確認してください。別のスキーマに既存vectorがある環境は自動移動せず、readyが失敗します。

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
| [/docs](http://127.0.0.1:8000/docs) | 状態確認・認証・参照資料APIのOpenAPI画面 | 問い合わせ・知識APIは未実装 |

`ready` はDBへのSQL実行、適用revision集合とソースのhead集合の一致、publicのvector拡張を確認します。これは現在の基盤スキーマの確認であり、業務機能・認証・デモ資料の準備完了やスキーマ全体の改変検知を意味しません。Ollama・AIは起動も状態確認も要求しません。AIの状態表示は未実装です。

DB障害は要求を失敗させ、画面モックや固定応答で置き換えません。接続例外の本文・SQL・資格情報はAPI応答とアプリログに出力しません。DB復旧後は接続プールの再接続でreadyが200へ戻ります。元のDBを止めず、専用の検証プロジェクトで停止・復旧を確認しました。

### 最小デモシードと認証API

マイグレーション後に、起動とは別の管理コマンドで合成資料を追加します。最小シードは [app/seed.py](backend/app/seed.py) に公開しています。

```powershell
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec backend python -m app.seed
```

部門はIT・人事・総務・経理、アカウントは次の2件です。全件を一つのトランザクションで追加し、再実行しても既存の名前・役割・有効状態・パスワードを変更しません。削除・初期化・公開登録APIはありません。

| login_id | 名前 | role | パスワード |
| --- | --- | --- | --- |
| `employee` | 佐藤 美咲 | employee（社員） | `SolveLoop-Demo-2026!` |
| `operator` | 山田 花子 | operator（担当者） | `SolveLoop-Demo-2026!` |

公開のローカルデモ専用パスワードです。実際のサービスでは使わないでください。DBにはArgon2idハッシュだけを保存します。

| API | 動作 |
| --- | --- |
| `POST /api/v1/auth/login` | JSONの `{login_id,password}` と許可Originを検査。`{user,csrf_token,expires_at}` とセッションcookieを返す |
| `GET /api/v1/auth/me` | `{id,display_name,role,department,can_manage_accounts,must_change_password}`。未認証・期限切れ・無効アカウントは401 |
| `GET /api/v1/auth/csrf` | ログイン済みセッションの `{csrf_token}` を再取得 |
| `POST /api/v1/auth/logout` | セッション・許可Origin・`X-CSRF-Token` を検査してDBの現在セッションを削除。204とcookie削除 |
| `POST /api/v1/auth/password/change` | JSON `{current_password,new_password}` とOrigin・CSRFを検査。本人のhash更新・変更要求解除・全セッション削除・監査記録を一括確定し、204とcookie削除 |
| `GET /api/v1/reference-data` | 有効なdepartments。担当者のみ有効なoperatorsの `{id,display_name}` を追加。変更要求中は403 |

セッションcookie `solveloop_session` はhost-only・Path=/・HttpOnly・SameSite=Lax、固定8時間で延長しません。Secureは設定で切り替えます。DBにはセッション原文とCSRF原文を保存せず、SHA-256ハッシュのみを保存します。CSRF値はセッション原文を鍵とするHMACで再取得可能にし、別セッションでは無効です。認証・参照資料APIはエラーも含め `Cache-Control: no-store` です。

ログイン成功時に現在のcookieに対応する旧セッションを破棄し、新規発行します。他のブラウザーのセッションは維持します。ログイン失敗で現在のセッションは変更しません。ログアウトは現在のセッションだけを破棄し、無効・期限切れのセッションは401です。期限切れ行はログイン成功時に整理します。ログイン前はCSRF値がないため、許可OriginとJSON形式を必須にしてログインCSRFを防ぎます。認証後の書込みにはOriginとCSRFの両方を要求します。

ルートのPowerShellで、cookieをメモリ内に保持して確認できます。

```powershell
$authOrigin = @{ Origin = 'http://127.0.0.1:8000' }
$authBody = @{ login_id = 'employee'; password = 'SolveLoop-Demo-2026!' } | ConvertTo-Json
$authLogin = Invoke-RestMethod http://127.0.0.1:8000/api/v1/auth/login -Method Post -ContentType 'application/json' -Headers $authOrigin -Body $authBody -SessionVariable authSession
Invoke-RestMethod http://127.0.0.1:8000/api/v1/auth/me -WebSession $authSession
Invoke-RestMethod http://127.0.0.1:8000/api/v1/reference-data -WebSession $authSession | ConvertTo-Json -Depth 5
$authWrite = @{ Origin = 'http://127.0.0.1:8000'; 'X-CSRF-Token' = $authLogin.csrf_token }
Invoke-WebRequest http://127.0.0.1:8000/api/v1/auth/logout -Method Post -Headers $authWrite -WebSession $authSession | Select-Object StatusCode
```

社員の自分情報・部門4件・ログアウト204が期待結果です。最後にもう一度meを呼ぶと401です。`login_id` を `operator` に変えてログインすると、参照資料にoperatorsが追加されます。Origin省略・不許可、ログアウトのCSRF省略・不一致は403、誤った資格情報は401、未知の入力フィールド・長さ違反は422です。エラーは日本語の `{code,message,request_id}` で、入力値を返しません。

フロントのログイン・本人変更・アカウント管理はこのAPIに接続しています。`require_full_auth`・`require_operator`・`require_account_manager` は制限状態・業務の役割・管理権限を分けて検査します。検証専用経路は通常APIに追加しません。問い合わせの所有者検査は問い合わせAPIとともに実装します。現在はlocalhost限定のデモで、SSO・メール復旧・総当たり対策・本番配備は対象外です。

### 本人変更と初期管理権限

本人変更には現在または仮パスワードが必要です。新しい値は15〜256 Unicode文字で、現在の値・公開デモ用の値・制御文字・空白のみの値を拒否します。空白やUnicodeを正規化・切り詰めせず、英大文字・数字・記号の混在は要求しません。画面の確認欄はAPIへ送信しません。成功後は他のブラウザーも含めた全セッションが終了し、新しい値で再ログインします。応答を失った場合も自動で変更を再送せず、再ログインで確認します。

`must_change_password=true` のセッションはme・CSRF再取得・本人変更・logoutだけを利用できます。参照資料・アカウント管理APIと今後の業務APIは `403 PASSWORD_CHANGE_REQUIRED` です。既存の公開シードを一括で仮パスワード扱いにはしません。

最初の管理権限は指定した有効な既存IDに、ローカルコマンドで付与します。次は `employee` を指定する例であり、マイグレーションや通常のシードから自動実行しません。

```powershell
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec backend python -m app.accounts bootstrap-manager --login-id employee
```

権限付与・対象の全セッション削除・`management_granted` 監査記録を一括確定します。既に付与済みなら変更しません。社員に管理権限を付けても担当者の業務権限は増えません。HTTPや画面での管理権限編集、アカウント削除はありません。既存の名前・所属・役割・hash・有効状態は保持し、シード再実行で権限や変更必要状態を上書きしません。

ログイン・本人変更・logout・初期権限付与は利用者行を同じUUID順でロックします。待機後に資格情報と実際のセッションを読み直し、古い資格による遅延セッションの生成を防ぎます。変更と監査の保存に失敗すれば一括rollbackします。APIの成功・エラーは `no-store` とサーバー生成の `X-Request-ID` を返し、エラー・監査の番号に同じ値を使います。パスワード・hash・セッション・CSRFをログや監査に記録しません。

### アカウント管理API

全経路で現在の管理権限を検査します。社員・担当者という業務上の役割だけでは利用できず、管理権限のない利用者は403、未認証・破棄済みセッションは401です。書込みにはJSON・許可Origin・`X-CSRF-Token` が必要です。管理権限を入力・編集するAPIはありません。

| API | 入力と結果 |
| --- | --- |
| `GET /api/v1/accounts` | query・本文なし。`{items,total}`。無効なアカウントも含め、DBの `login_id ASC,id ASC` 順 |
| `POST /api/v1/accounts` | `{display_name,login_id,department_id,role}` のみ。201 `{account,temporary_password}` |
| `POST /api/v1/accounts/{account_id}/deactivate` | `{expected_version}`。200 Account。自己の無効化は409 |
| `POST /api/v1/accounts/{account_id}/reactivate` | `{expected_version}`。200 Account。既存のhash・変更必要状態を保持し、古いセッションは復活しない |
| `POST /api/v1/accounts/{account_id}/temporary-password` | `{expected_version}`。200 `{account,temporary_password}`。無効な対象は409、自己への成功は現在のcookieも削除 |
| `GET /api/v1/accounts/{account_id}/events` | `page`（既定1）・`page_size`（既定20、1〜100）のみ。`{items,page,page_size,page_count,total}`。新しい時刻・UUID順、超過ページは最終ページに補正、0件は1ページ |

Accountは `id,display_name,login_id,department,role,active,can_manage_accounts,must_change_password,row_version` だけです。departmentは `{id,code,name}` またはnull。変更履歴は `id,actor,target_user_id,action,occurred_at,request_id` だけで、actorは `{id,display_name}`、ローカル権限付与ではnullです。履歴の件数とページ資料は同じSQLで取得します。無効な対象の履歴も管理者だけが参照できます。

名前は外側の空白を除去して1〜100文字とし、改行・制御文字を拒否します。IDはASCII英数字と `._-` の1〜100文字で、大文字・小文字を区別し、空白や文字幅を変換しません。無効なIDも再利用できません。所属は有効な既存部署のUUIDが必須、roleは `employee|operator` だけです。新規アカウントは有効・管理権限なし・本人変更必須・版1で始まります。未定義フィールド、無効なUUID・部署、未知のqueryは422です。

仮パスワードは `secrets.token_urlsafe(32)` の43文字で生成し、Argon2idのhashだけをDBへ保存します。再発行時には以前のパスワードと異なることを確認します。原文は成功直後の応答1回だけで、一覧・履歴・ログ・再照会用テーブルに保存しません。これは原文の返却回数であり、ログインを1回に制限するtokenではありません。初回・再発行ログイン後は本人変更が必要です。

変更要求には取得した `row_version` を `expected_version` として送ります。正の整数だけを受け取り、文字列・小数・boolは拒否します。actorと対象のUUIDを最初から一緒に昇順ロックし、待機後にセッション・CSRF・変更必要状態・管理権限を再検査します。状態/hash/版・全セッション破棄・監査を同じトランザクションで確定します。再有効化ではセッションを作りません。

重複IDは `409 LOGIN_ID_TAKEN`、古い版は `409 VERSION_CONFLICT`、自己無効化は `409 SELF_DEACTIVATION_FORBIDDEN`、既に同じ状態は `409 INVALID_STATE`、無効な対象への再発行は `409 ACCOUNT_INACTIVE`、対象不在は404です。DB・ロック待機の失敗は503です。エラーは入力値を含まない日本語の `{code,message,request_id}` で、全応答がno-storeです。

POSTの応答喪失・503時は自動再送しません。一覧と対象の履歴を確認し、追加・状態変更が反映済みなら繰り返しません。仮値を失った場合は対象と最新の版を人が確認した上で明示的に再発行します。原文応答の再生はありません。commit前の監査失敗は全てrollbackしますが、応答喪失や接続切断を常に未反映とは判断しません。

OpenAPIは [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs) で確認できます。上の手順で明示的に準備した管理者がログインした後、同じメモリ内cookieを使って参照します。

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/v1/accounts -WebSession $authSession | ConvertTo-Json -Depth 5
```

通常のシードだけでは管理権限がないため403になります。固定の `manager` アカウントを自動作成する機能はありません。実際の管理操作を試す際は対象を明示し、返却された原文を端末ログ・ファイル・画面記録に残さないでください。

### ローカル検査とCI

ホストでDBを使わない検査は、ルートから `backend/` に移動して実行します。

```powershell
Set-Location backend
uv sync --locked
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked pytest -q
```

DBを使わない単体検査と、DB・実HTTPの統合検査を分けています。DBテストは `RUN_DB_TESTS=1` とDB名 `solveloop_test` の両方を要求し、基盤テストは空DBからのみ開始します。旧revisionの資料保持・本人変更・制限/権限・管理APIの入力/一回返却・全セッション破棄・監査失敗rollback・応答喪失・同時重複・実際の行ロック競合を検証します。認証と管理の各ケースは同DBの専用スキーマに分離し、終了時にそのスキーマを削除します。実HTTPの本人変更と管理生涯周期も専用DBの一時アカウントだけを使います。必ず別のComposeプロジェクト・新しいvolumeを使ってください。SQLiteは使いません。

リポジトリのルートでは以下でCIと同じ検証用イメージを構築できます。

```powershell
docker build --target test -t solveloop-backend-test:local backend
docker run --rm solveloop-backend-test:local ruff check .
docker run --rm solveloop-backend-test:local ruff format --check .
docker run --rm solveloop-backend-test:local
```

[基本CI](.github/workflows/ci.yaml) は Ubuntu 24.04 のGitHub Actionsで、lockを変更しないイメージ構築・Ruff・単体テスト・空のPostgreSQLでのマイグレーション・認証/権限・シード再適用・実HTTPの両役割ログイン/ログアウトとアカウント管理生涯周期・DB停止/復旧を実行する定義です。`solveloop-ci` 専用の環境・DB・volumeを作り、終了時にその検証volumeだけを削除します。既存の `solveloop` DBには実行しません。フロントのCI・問い合わせ/知識API・AI評価は対象外です。ローカルで相当の検証を実行しましたが、GitHub Actions上ではまだ実行していません。

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

認証は [argon2-cffiのAPI](https://argon2-cffi.readthedocs.io/en/stable/howto.html)、[OWASPのセッション管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)・[CSRF対策](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)、[FastAPIの例外処理](https://fastapi.tiangolo.com/tutorial/handling-errors/)を設計参考にしました。外部の認証アプリ・サンプルコードをコピーせず、パッケージの公開APIを利用しています。認証パッケージは未改造で、インストールされた原文ライセンスを保持します。

バックエンドは [FastAPIのコンテナ実行](https://fastapi.tiangolo.com/deployment/docker/)、[Pydantic Settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)、[SQLAlchemyの同期Session](https://docs.sqlalchemy.org/en/20/orm/session_basics.html)・[psycopg dialect](https://docs.sqlalchemy.org/en/20/dialects/postgresql.html#module-sqlalchemy.dialects.postgresql.psycopg)、[Alembic](https://alembic.sqlalchemy.org/en/latest/tutorial.html)、[uvのDocker連携](https://docs.astral.sh/uv/guides/integration/docker/)、[Dockerのcontextと除外](https://docs.docker.com/build/concepts/context/#dockerignore-files)を設計参考にしました。Full Stack FastAPI Templateはサービス・health・実行分離の参考で、コードのコピー・改変・テンプレート生成はしていません。JWT・SQLModel・メール・workerは導入していません。

| パッケージ・イメージ | 固定版・利用範囲 | ライセンス |
| --- | --- | --- |
| [FastAPI](https://github.com/fastapi/fastapi) / [Pydantic](https://github.com/pydantic/pydantic) / [Pydantic Settings](https://github.com/pydantic/pydantic-settings) | 0.162.0 / 2.14.2 / 2.16.2、API・設定検証 | MIT |
| [SQLAlchemy](https://github.com/sqlalchemy/sqlalchemy) / [Alembic](https://github.com/sqlalchemy/alembic) | 2.0.55 / 1.20.1、同期DB・変更履歴 | MIT |
| [argon2-cffi](https://github.com/hynek/argon2-cffi) / [bindings](https://github.com/hynek/argon2-cffi-bindings) | 25.1.0 / 26.1.0、Argon2idパスワードハッシュ | MIT、配布物の原文表示を保持 |
| [cffi](https://cffi.readthedocs.io/) / [pycparser](https://github.com/eliben/pycparser) | 2.1.1 / 3.12、Argon2 bindingsの間接依存 | MIT-0 / BSD-3-Clause |
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
