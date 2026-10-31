# SolveLoop

社内の問い合わせと解決履歴を、再利用できるナレッジへつなぐ業務支援システム。

架空企業「株式会社 柳」を題材にした個人ポートフォリオです。社員・問い合わせ・社内文書には合成データを使用します。

## 開発状況

ログイン・ログアウト・本人のパスワード変更とアカウント管理画面は、ローカルAPIに接続しています。サーバーの管理権限と初回変更の必要状態を使い、アカウント一覧・追加・無効化・再有効化・仮パスワード再発行・変更履歴を操作できます。

問い合わせ・ナレッジ・Dashboardは実APIとPostgreSQLに接続しています。社員の問い合わせ登録から、担当者の割り当て・解決、手動ナレッジ作成・承認、社員の検索・閲覧まで保存できます。サーバーで役割・所有者・現在のセッションを検査し、古い版による更新は409で拒否します。業務変更と履歴は同じトランザクションで保存します。

ローカルOllamaへの接続・生成のCLI検証と、承認ナレッジのchunk分割・768次元ベクトル保存・意味検索を実装しています。検索準備と人の承認を分け、現在の公開版と検索対象を同時に切り替えます。問い合わせの担当部署提案と根拠付き回答案もローカルAIで生成します。解決記録を抜粋・構成するAI下書き案も生成し、人が編集して保存できます。Knowledge Gap Radarで繰り返し問い合わせを検出し、現在の公開文書の対応範囲を別操作で判定できます。最小シードは部門と認証用の合成アカウントだけを用意し、業務資料は0件から始まります。実際のUUID・サーバー時刻を使い、再読み込みしてもDBの資料を保持します。

バックエンドはPostgreSQL 17.11 / pgvector 0.8.7を使用し、部門・利用者・セッション・アカウント監査、問い合わせ・変更履歴、ナレッジ文書・版・根拠・レビュー履歴、登録キーと適用履歴を保存します。管理権限は業務の役割と独立しています。管理権限編集・アカウント削除・既存プロフィール編集は提供しません。

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

共通fetchはcookie・CSRF・no-store・エラー処理をまとめます。起動・再表示・画面移動・書込み直前にmeを確認し、同じ利用者の新ログイン、UUID/権限/制限変更、logout、401で認証世代を更新します。進行中のfetchを中断し、以前の世代の遅延応答も捨てます。管理資料・原文・編集・選択・復帰情報・業務表示・タイトルを前の利用者から引き継ぎません。別タブには秘密のない無効化通知だけを送り、受信側もサーバーを再確認します。通常のタブ移動・復帰では画面を入れ替えず、最後に確認できた表示を維持して裏で資格を再確認します。

タブ移動・フォーカス復帰では入力・選択範囲・スクロール・開いた業務ダイアログをそのまま維持します。同じ利用者・権限・制限状態・CSRFなら認証世代や画面を更新せず、進行中の業務要求も中断しません。書き込み直前には引き続きサーバーで資格を確認します。別ログイン・認証変更通知・401では前の利用者の入力や表示を破棄します。認証確認の通信失敗では画面を隠して再確認を案内します。仮パスワードの一回表示は非表示時に除去し、復元しません。ブラウザーの再読み込み・終了を越える入力保存ではありません。

401・権限喪失の資料除去は未保存確認で取り消せません。通信障害は認証切れと断定せず表示を止めて再確認を案内します。POSTは自動再送せず、409は一覧・履歴を再取得して人が再操作します。503・応答喪失は反映済みの可能性があるため、追加を繰り返す前にIDと履歴を確認します。原文を失った場合は対象を確認して明示的に再発行してください。

### 問い合わせの確認手順

1. 社員でログインし、「問い合わせを登録」で件名・内容・担当部署を入力します。部署は未定にできます。登録後はサーバーの番号・UUID・時刻を使う詳細へ進みます。
2. 担当者でログインし、キーワード・状態・担当部署・担当者で絞り込みます。条件・ページはURLに残り、詳細から戻ると条件・選択リンクのフォーカス・スクロール位置を復元します。既定は20件/ページです。
3. 詳細で担当部署と担当者を確定し、「割り当てを反映」→「対応を開始」→解決内容を入力→「解決内容を記録して解決」と進みます。部署・担当者が未定のまま対応を開始できず、空白だけの解決内容も受け付けません。別部門の担当者への割り当ては可能です。
4. 社員は自分の未解決問い合わせの本文だけを編集できます。他人の問い合わせはAPIでも404、担当者専用操作は403になります。社員の履歴には登録・本文変更の事実・担当変更・状態・解決結果だけを返し、過去本文やナレッジの内部根拠は返しません。
5. 解決後の修正は担当者が「対応を再開」してから行います。前回の解決内容・時刻は履歴に残ります。無効化された担当者がいる場合は、再開時に有効な担当者を選びます。
6. Dashboardは権限内の問い合わせ件数・最近の5件を集計します。担当者には未割り当て・自分の未解決分・下書き件数と上位5件も表示します。試験用の固定件数やAI判定は混ぜません。

### ナレッジと承認の確認手順

1. 解決済み問い合わせの「ナレッジの下書きを作成」、またはレビュー一覧の「手動で下書きを作成」から入力します。件名・適用対象・本文は必須で、下書きの部署は未定にできます。問い合わせの根拠がない手動文書も作成できます。
2. 問い合わせ由来の場合は、元の番号・版・本文・解決内容の写しを確認します。「解決済み問い合わせを検索」から追加する根拠も明示的に選べます。根拠は最大20件です。HTML・Markdownは実行せず、改行を保持したプレーンテキストで表示します。
3. 「編集」「プレビュー」を切り替え、「下書きを保存」します。保存は公開ではありません。未保存の入力がある間は承認・差し戻しを利用できません。
4. 後述の意味検索の初期化を済ませ、有効な担当部署を確定します。「保存した版の検索準備」でローカル埋め込みを用意し、内容を確認してから別途「承認して公開」を実行します。準備だけでは承認・公開しません。内部の根拠・作者・差し戻し理由・レビュー履歴は公開DTOに含めません。公開する本文の情報は人が確認します。
5. 公開文書の改訂では最新の版を確認し、「次の版の下書きを作成」で同じ文書の次の番号を作ります。文書ごとの下書きは一つです。新しい版が承認されるまで既存の承認版を公開し続けます。
6. 差し戻しには理由が必要です。差し戻した版と理由は変更せず保存し、その版から次の番号の下書きを作成できます。承認・差し戻し済みの版の編集や、同じ版を下書きへ戻す操作はありません。
7. 根拠の問い合わせが変わると、版・hashを比較して警告し、承認APIも409で拒否します。再解決だけでは警告を解除しません。「現在の原本と比較」→「原本を確認済み・この版を根拠に選ぶ」→本文を確認して保存→承認の順に操作します。既存の公開版を原本変更だけで自動修正・非公開にはしません。
8. 社員でログインしてナレッジを検索します。キーワードはNFKC+casefold後の部分一致で、空白区切りはANDです。「意味検索へ」で質問文による検索に切り替え、本文の該当行から全文を確認できます。いずれも公開ポインターが指す現在の承認版だけを返します。

### 保存・競合・結果不明

未保存の一般移動は破棄確認で保護します。401・権限変更・別ログインでは以前の編集・選択・表示を除去し、古い非同期応答を捨てます。業務の保存失敗では同じセッション内の入力を保持し、古い版による409では最新保存内容を別に取得して比較できます。人が確認する前に版番号を書き換えて再送しません。認証自体を再確認できない場合は表示を止めます。

新規問い合わせ・新規文書・次の下書きのPOSTには `Idempotency-Key` が必須です。同じ利用者・メソッド・パス・キー・正規化入力の結果を24時間再生でき、別内容での再利用は409です。現在の認証・権限を再生前にも検査します。保存された応答は登録時点の値なので、その後は詳細GETで現在の状態を確認します。自動再送は行いません。503や応答喪失は反映済みの可能性があるため、一覧・詳細・履歴を確認してから明示的に操作してください。

担当者は、ナレッジの読む画面の右側にある赤い「文書の管理」から公開停止・再公開・完全削除を実行できます。「版の詳細・改訂」は本文の改訂用です。下書き・差し戻しの版詳細にも同じ管理欄があります。社員には管理操作を表示しません。

「公開を停止…」は確認後に社員の閲覧・キーワード検索・意味検索から除外し、承認本文・全版・根拠・レビュー履歴・検索ベクトルを保管します。担当者はURLまたはレビュー一覧の「公開停止」フィルターから再確認できます。「再公開…」は現在の承認版だけを確認後に戻します。停止中に改訂版を承認しても自動再公開しません。再公開には有効な規格の検索準備が必要ですが、Ollamaは呼び出しません。

「文書を削除…」は公開版・下書き・差し戻しの全版、レビュー履歴、根拠の写し、検索準備とベクトルを一括で完全に削除します。確認画面で文書番号・件名・公開状態・対象範囲を確認し、文書番号を正確に入力すると最終ボタンが有効になります。番号はサーバーでも照合します。元の問い合わせ・利用者・他の文書は保持します。画面からの復元はできず、バックアップ内の資料消去も行いません。

`POST /api/v1/knowledge/{document_id}/versions/{version_no}/stop-publication`・`resume-publication` は `expected_version` と `expected_document_version`、`delete-document` はさらに `confirmation_number` を必須にします。通常認証済みの担当者・Origin・CSRF・JSONを要求し、文書と版をロックして更新または削除・履歴・検索対象を同じDBトランザクションで確定します。409では最新内容を明示確認し、通信障害・503の結果不明時は自動再送しません。削除済みの登録結果は本文を除去した410の記録に置き換え、同じキーから本文の再表示や文書の再作成を行いません。公開状態と履歴の追加migrationは `0006_publication_control` です。更新時はバックアップ後に `alembic upgrade head` を実行してください。

入力と表示用DTOは `frontend/src/lib/business.ts`、共通の認証・CSRF・世代境界は `frontend/src/lib/api.ts`、画面の取得・キャンセルは `frontend/src/lib/useBusiness.ts` にあります。問い合わせやナレッジのメモリ内モック保存・表示切替・失敗シミュレーターはありません。実API失敗を合成成功で代替しません。

小規模デモでは、一つのSQLで権限内の対象を取得し、検索の正規化・絞り込み・ページをサーバーのメモリ内で計算します。同じ要求内の件数と行を揃えるための構成で、大量データ向けの索引検索・SQLページングや負荷性能は未検証です。
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

`test` はNode.jsのテストランナーと型除去を使います。認証・fetch、業務PATCHと登録キー、世代更新・遅延応答破棄・通知・非表示、画面離脱によるキャンセル、Unicode入力と業務表示を検証します。実サーバーの権限・DB・HTTP検証は後述のpytestと分けます。

画面内の入力保護は、開発サーバーの `/tests/business-ui.html` をブラウザーで開いて検証できます。実際のReactコンポーネントに隔離したAPI応答を渡し、本文・担当・解決入力の保持、保存後の再取得失敗、登録結果不明時の同じキー・内容による明示再試行、送信中・結果不明中の根拠変更防止を確認します。`/tests/session-ui.html` は実際の認証クライアントと画面を使い、同一資格の復帰・通信障害後の回復・別利用者/セッションへの入力除去・問い合わせdialog・仮パスワードの破棄を固定応答で検証します。結果はページに表示され、再読み込みで再実行します。追加依存は不要です。この検証は `npm test` とは別で、実DB・HTTPの検証ではありません。検証ページは通常の本番ビルドに含めません。

分離したPostgreSQL/APIとChromeで、社員の登録→担当者の割り当て・解決→手動下書き→承認→社員検索・閲覧を確認しました。改訂中の旧公開版維持、差し戻し後の次版、根拠変更の承認停止と明示的再確認、実409の入力保護、390/640/1440pxも確認しています。ローディング・取得503・保存503・遅延中の二重送信防止は試験専用プロキシを使ったUI検証で、実DBの障害・権限・競合テストとは区別します。ブラウザー検証は今回の操作確認であり、保存されたPlaywright自動E2Eやアクセシビリティ監査の完了を意味しません。

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
| [/docs](http://127.0.0.1:8000/docs) | 状態確認・認証・参照資料APIのOpenAPI画面 | 認証・アカウント・問い合わせ・ナレッジ・集計API |

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

DBを使わない単体検査と、DB・実HTTPの統合検査を分けています。DBテストは `RUN_DB_TESTS=1` とDB名 `solveloop_test` の両方を要求し、基盤テストは空DBからのみ開始します。旧revisionの資料保持・本人変更・制限/権限・管理APIの入力/一回返却・全セッション破棄・監査失敗rollback・応答喪失・同時重複・実際の行ロック競合を検証します。認証・管理・業務の各ケースは同DBの専用スキーマに分離し、終了時にそのスキーマを削除します。実HTTPの本人変更と管理生涯周期も専用DBの一時アカウントだけを使います。必ず別のComposeプロジェクト・新しいvolumeを使ってください。SQLiteは使いません。

リポジトリのルートでは以下でCIと同じ検証用イメージを構築できます。

```powershell
docker build --target test -t solveloop-backend-test:local backend
docker run --rm solveloop-backend-test:local ruff check .
docker run --rm solveloop-backend-test:local ruff format --check .
docker run --rm solveloop-backend-test:local
```

[基本CI](.github/workflows/ci.yaml) は Ubuntu 24.04 のGitHub Actionsで、lockを変更しないイメージ構築・Ruff・単体テスト・空のPostgreSQLでのマイグレーション・認証/権限・シード再適用・実HTTPの両役割ログイン/ログアウトとアカウント管理生涯周期・DB停止/復旧を実行する定義です。`solveloop-ci` 専用の環境・DB・volumeを作り、終了時にその検証volumeだけを削除します。既存の `solveloop` DBには実行しません。問い合わせ・ナレッジの権限、版競合、根拠・公開ポインター、履歴原子性と実HTTPの手動業務フローも対象です。フロントCI・実AI評価は対象外です。ローカルで相当の検証を実行しましたが、GitHub Actions上ではまだ実行していません。

Dockerfileは `backend/Dockerfile`、ビルドコンテキストは `backend/`、適用される除外定義は `backend/.dockerignore` です。ルートの `.docs`・AGENTS・`.git`・`infrastructure/.env`・frontendはコンテキスト外です。コンテキスト内も必要なソースとlock等の許可リストだけを渡します。実行用 `runtime` targetは非rootで動作し、開発用依存とtestsは含めません。`test` targetだけがそれらを追加します。

APIだけを停止する場合は `docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml stop backend` を使います。DBや画面previewの停止は別操作です。

## ローカルOllamaの接続検証

WindowsホストでOllamaを起動し、DB/APIは上記のComposeで実行します。検証したOllamaは **0.40.13** です。既存のOllamaが動作していれば再利用してください。ホストの `127.0.0.1:11434` から、バックエンドコンテナの `host.docker.internal:11434` へ接続できることをDocker Desktopで確認しています。Ollamaの公開バインド・ポート転送・CORSの追加は不要でした。別環境で失敗しても、先に到達範囲を調べ、無条件に `0.0.0.0` へ変更しないでください。

モデルはローカル実行用です。初回ダウンロードにはネットワークが必要ですが、推論に外部AI APIは使いません。モデルの利用条件を確認してから、Windowsホストで準備します。既にある同じモデルは再ダウンロード不要です。

```powershell
ollama --version
ollama list
ollama pull qwen3:8b
ollama pull embeddinggemma-2:270m-q8_0-text
```

生成は既存の [Qwen3 8B](https://ollama.com/library/qwen3:8b)、埋め込みは [EmbeddingGemma 2のテキスト専用Q8版](https://ollama.com/library/embeddinggemma-2:270m-q8_0-text) を接続検証に使用します。両モデルのライセンスはApache 2.0です（[Qwenの表示](https://ollama.com/library/qwen3:8b)、[Googleのモデルカード](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2)）。1世代目のEmbeddingGemmaとはモデル・利用条件が異なり、互換ベクトルとして混ぜられません。重みはGitやアプリのイメージに含めません。配布元の条件・表示は保持し、本プロジェクト自体のライセンスとは分けて扱います。

`infrastructure/.env.example` に接続設定の例を用意しています。既存 `.env` に追記しなくてもComposeの既定値で動作します。既存DBの設定やOriginを保持してバックエンドだけを更新します。

```powershell
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml build backend
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml up -d --no-deps --wait backend
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec backend python -m app.ai check
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec backend python -m app.ai generate
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml exec backend python -m app.ai embed
```

`check` は接続と両モデルのローカル重み・能力を検査します。`generate` は架空のVPN問い合わせの言い換え、`embed` は架空の端末変更文の数値化を行います。`smoke` で両方を順に実行できます。CLIの入力は `backend/app/ai/__main__.py` にあり、DB・アカウント・業務資料は読み書きしません。生成結果、モデル名・digest、Ollama版、HTTP呼出しの経過ms、Ollamaの処理/ロード時間ns、GPU割当てを含む実行状態をJSONで表示します。埋め込みの全ベクトルはPythonの `OllamaClient.embed()` から取得でき、CLIには次元とL2ノルムだけを表示します。

ホスト側でも同じコードを実行できます。DB環境変数は不要です。

```powershell
Set-Location backend
uv sync --locked
$env:OLLAMA_BASE_URL='http://127.0.0.1:11434'
$env:PYTHONIOENCODING='utf-8'
uv run --locked python -m app.ai smoke
Remove-Item Env:OLLAMA_BASE_URL
```

設定は `OLLAMA_BASE_URL`、`OLLAMA_CHAT_MODEL`、`OLLAMA_EMBED_MODEL`、`OLLAMA_GENERATE_TIMEOUT_SECONDS`、`OLLAMA_EMBED_TIMEOUT_SECONDS` です。既定はホスト用ループバック、`qwen3:8b`、`embeddinggemma-2:270m-q8_0-text`、生成120秒・埋め込み120秒です。Composeは接続先だけを `host.docker.internal` に変えます。メタデータ取得は5秒、各推論は指定したsocketの通信待機時間で制限します。CLI全体の厳密な総実行時間上限ではありません。最初の埋め込みは30秒設定でtimeoutしたため、初期ロードも考慮して120秒にしました。

推論は同一Pythonプロセス内で1件に制限し、実測時のOllamaも `OLLAMA_NUM_PARALLEL=1` でした。接続検証CLIはコンテキスト2048、検索用埋め込みは8192を指定します。生成は2000文字・出力128トークン・thinking無効、埋め込みの低水準呼出しは32768 UTF-8 bytesまでです。byte数をトークン数へ換算しません。埋め込みは `truncate:false` とし、超過を黙って切り捨てません。検索用の入力形式・分割規則は下記の固定profileに含めます。

外部URL・cloudモデル・remote指定・ローカルGGUFでないモデルを拒否し、HTTPプロキシとredirectを使いません。自動ダウンロード・再試行・別モデルや外部供給者へのfallbackはありません。接続不能は `AI_UNAVAILABLE`、モデル不足は `AI_MODEL_NOT_FOUND`、timeoutは `AI_TIMEOUT`、混雑は `AI_BUSY`、入力拒否は `AI_INPUT_REJECTED`、不正JSON・空/未完了生成・非有限/空ベクトル・モデル名不一致は `AI_INVALID_RESPONSE` です。エラーに入力やOllamaの内部エラー本文を載せず、CLIは終了コード1、設定不正は2を返します。設定はAI利用時だけ読み、通常のAPI起動・`/health/ready` はOllamaに依存しません。

### 小さい接続試験の実測

2026-10-31、Windows 11 Pro build26200、RTX 5070 Ti / VRAM16303MiB、NVIDIA driver616.92、Ollama0.40.13。モデルをアンロードして再ロードしたホストの1回の測定です。OS・ファイル・CUDAのキャッシュは残っており、初回インストール直後の時間や品質評価ではありません。

| 処理 | モデル・量子化 | HTTP経過 / Ollamaロード時間 | 結果 |
| --- | --- | --- | --- |
| 生成 | qwen3:8b / Q4_K_M | 2598.14ms / 2359.75ms | `VPNへの接続ができない状況です。`、入力46/出力11トークン |
| 埋め込み | embeddinggemma-2:270m-q8_0-text / Q8_0 | 1237.94ms / 1068.68ms | 768次元、L2ノルム約0.99999986、入力15トークン |

生成digest: `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41`。埋め込みdigest: `c21dd30c1e38444d3b4faa091407b6fa97221447b4965d74931d43d7f09bbbfd`。タグは更新され得るため、再実行の出力でdigestも確認してください。

`ollama ps` は両方を `100% GPU` と表示し、`/api/ps` の割当ては生成5282505686bytes・埋め込み380496772bytesでした。NVIDIAの250ms間隔・17標本ではGPU全体の使用メモリ2574〜8455MiB、使用率1〜32%を観測しました。他のデスクトップアプリも含む値で、瞬間的な最大値を保証しません。既にロード済みの同じモデルをバックエンドコンテナから呼んだ別の1回は、生成102.74ms・埋め込み19.58msでした。これらは小さい入力の接続測定であり、日本語検索精度・スループット・OOM耐性を保証しません。モデルの最終的な品質判断は後続の専用評価で行います。

通常の `pytest` とCIは実GPU・Ollama・モデルダウンロード不要です。`backend/tests/test_ai.py` は一時ループバックHTTPサーバーで成功・接続拒否・実socket timeout・モデル不足・remote/redirect拒否・不正応答・再試行なしを検証します。実Ollama検証は上のCLIを明示的に別実行します。

Ollama障害時の手動業務は、専用の検証DB/APIだけで `OLLAMA_BASE_URL=http://127.0.0.1:1` を指定して検証しました。AI CLIは実際に接続拒否となり、同じAPIのready・認証/アカウント管理・問い合わせ登録/解決・手動ナレッジ承認/検索の実HTTPテストは成功しています。共有のホストOllama自体は停止していません。

## ナレッジの意味検索と安全な公開

### 初期化・既存承認版の準備

新しいマイグレーションは4表を追加し、既存の本文・アカウント・履歴を変更しません。検索は初期状態では無効です。既存環境ではDBをバックアップし、後述の専用DBでの検証を済ませてから適用してください。アプリ起動時の自動migration・自動モデル取得はありません。

```powershell
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml run --rm --no-deps backend alembic upgrade head
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml run --rm --no-deps backend python -m app.ai backfill
docker compose -p solveloop --env-file infrastructure/.env -f infrastructure/compose.yaml run --rm --no-deps backend python -m app.ai activate
```

`backfill` は現在の承認版を全件確認し、未準備分だけを処理します。公開済みの業務状態や承認履歴は変えません。途中失敗で準備できた文書は非公開の検索準備として残り、再実行できます。`activate` はすべての現在公開版のhash・保存版・chunk数を短いDBトランザクションで再検査し、揃った場合だけprofileを一括有効化します。一部だけの完了を検索全体の準備完了として扱いません。公開文書0件の環境も明示的に有効化してください。

新規・改訂版は画面の「保存した版の検索準備」→内容確認→「承認して公開」の順です。本文・適用対象・部署・根拠・文書/保存版・有効profile世代が変われば準備し直します。AI停止中も手動保存・差し戻し・既存公開版・キーワード検索は利用可能です。準備済みの版はAI呼出しなしで承認できます。未準備版の新規公開は拒否します。

### 固定した埋め込み規格

実行資産は `backend/app/ai/knowledge.py` にあり、非公開文書は読みません。

| 項目 | 値 |
| --- | --- |
| モデル / digest | `embeddinggemma-2:270m-q8_0-text` / `c21dd30c1e38444d3b4faa091407b6fa97221447b4965d74931d43d7f09bbbfd` |
| 次元・正規化 | 768 / サーバー側L2、DBでもノルムを検査 |
| 質問 | `task: search result \| query: {query}` |
| 文書 | `title: {title} \| text: 適用対象: {audience}` + 節の文脈 + 本文 |
| chunk規則 | `paragraph-sentence-neighbor-v1`、本文2400 UTF-8 bytes目標、短い隣接単位600 bytesまでを前後に含む |
| コンテキスト | 8192 tokens、`truncate=false`、実処理 `prompt_eval_count` をchunkごとに保存・検査 |

公式の [検索用prefix](https://ai.google.dev/gemma/docs/embeddinggemma/inference-embeddinggemma-with-sentence-transformers)、[2世代の8K上限](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2)、[Ollamaの超過時拒否](https://docs.ollama.com/api/embed)を設計参考にしました。Ollama配布metadataの262144を入力上限の根拠にはしません。8192を指定した小さい実入力の動作を確認したもので、8192ちょうどの境界や最大長の性能を実証したものではありません。

節・空行を優先し、長い単位は文/行の境界、境界がなければUTF-8サイズ内のUnicode文字で分割します。文字の切り捨てはありません。タイトル・適用対象・先行する節名を各入力に付け、短い隣接単位を重ねます。すべての長い手順と例外を一つのchunkへ収める保証はなく、結果から全文の条件も確認してください。byteの目標はトークン数の推定ではなく、実際のトークン化と超過拒否はOllamaが行います。

profile IDはモデル・digest・次元・正規化・両テンプレート・context・分割規則/サイズを正規JSON化したSHA-256です。文書入力と保存した根拠集合のhash、元の保存版/文書版、有効profile世代を準備結果に保存します。chunkは版→準備結果→連番でつなぎ、原文のUnicode code point `[body_start,body_end)`・行・入力hash・実トークン数を保持します。規格が異なるベクトルは比較しません。モデルのdigestは推論前後に検査し、profileと異なれば失敗します。モデル変更は設定値だけの差替えではなく、対応profileの実装・全件準備・検証・有効化が必要です。

### API・原子性・失敗

| API | 入力 / 結果 |
| --- | --- |
| `GET /api/v1/knowledge` | 従来のキーワード検索。Ollama呼出しなし |
| `POST /api/v1/knowledge/search` | `{query,top_k?,department_id?}`、query 1〜500文字、top_k 1〜20/既定5。現在の公開版のchunk順位を返す |
| `POST /api/v1/knowledge/{id}/versions/{no}/prepare-search` | 担当者専用。`expected_version,expected_document_version`。保存済み本文だけを準備し、レビュー詳細の `search_preparation` を返す |
| 既存の `…/approve` | 同じ2版番号を使用。準備・根拠・権限を再検査して公開 |

意味検索/準備のPOSTもセッション・完全認証・Origin・CSRFを要求します。DB接続/行ロックを持たずに埋め込みを計算し、終了後に現在の認証を再検査します。承認は利用者→検索状態の共有ロック→根拠→文書→版の順で検査し、承認状態・公開ポインター・検索対象保存版・履歴を同時commitします。chunkの保存や履歴のDBエラーは全体rollbackし、既存公開版を維持します。外部推論そのものをDBでrollbackするという意味ではありません。

SQLで現在の公開ポインター・approved・有効profile・一致する保存版・部署を限定してから、pgvectorのcosine distanceでtop-kを正確検索します。HNSWや別の検索サーバーは使いません（[pgvector v0.8.7](https://github.com/pgvector/pgvector/blob/v0.8.7/README.md)）。結果は文書/公開版/chunk ID・該当本文/位置・hash・距離を返し、担当者用根拠・履歴は含めません。同じ文書の複数chunkが含まれます。距離が小さいほど意味が近いという比較値で、正答確率・解決可能性や検索品質の評価値ではありません。

未有効化は503 `SEARCH_NOT_READY`、規格の不一致は503 `SEARCH_PROFILE_UNSUPPORTED` / `AI_PROFILE_MISMATCH`、次元不一致は503 `AI_DIMENSION_MISMATCH`、未準備の承認は409 `EMBEDDING_NOT_READY`、準備中の変更は409 `EMBEDDING_STALE`、検索中のprofile変更は409 `SEARCH_PROFILE_CHANGED`です。AI障害は503、AI待ち時間超過は504で返し、結果0件やキーワード検索の成功に置き換えません。画面は入力を保持し、明示的な再検索とキーワード検索への移動を案内します。

### 検証と復旧

通常のCPU/CI検査は固定応答を使い、実Ollama・GPU・モデル取得を必要としません。既存の空の専用PostgreSQL検査に加え、`backend/tests/test_knowledge_search.py` が保存・距離・制約・非公開資料の除外・本文/根拠/profile/セッション変更・準備失敗・全件backfillと切替を確認します。`test_foundation.py` は旧版のアカウント・承認文書・履歴を保持する移行と、途中DDL失敗時のrollbackも検査します。`test_http_business.py` の検索準備はテスト専用固定ベクトルであり、実モデル試験とは区別します。

実モデルは **専用** Composeプロジェクト/DB `solveloop_test` で別実行します。次のPowerShell例は既存の `infrastructure/.env` と通常のイメージタグを変更しません。各命令の成功を確認してから次へ進み、既存の試験環境を再利用する場合は空DB専用の全テストを再実行しないでください。

```powershell
New-Item -ItemType Directory -Path .local -Force | Out-Null
if (Test-Path .local/search-check.env) { throw '既存の検証設定を確認してください。' }
$searchCheckPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
@('POSTGRES_DB=solveloop_test','POSTGRES_USER=solveloop_test',"POSTGRES_PASSWORD=$searchCheckPassword",'OLLAMA_BASE_URL=http://host.docker.internal:11434') | Set-Content .local/search-check.env -Encoding ascii
docker build --target test -t solveloop-backend-test:search-check backend
docker build --target runtime -t solveloop-backend:search-check backend
docker compose -p solveloop-search-check --env-file .local/search-check.env -f infrastructure/compose.yaml up -d --wait db
docker run --rm --network solveloop-search-check_default --env-file .local/search-check.env -e RUN_DB_TESTS=1 solveloop-backend-test:search-check
docker run --rm --network solveloop-search-check_default --env-file .local/search-check.env solveloop-backend:search-check alembic upgrade head
docker run --rm --network solveloop-search-check_default --env-file .local/search-check.env solveloop-backend:search-check python -m app.seed
docker run -d --name solveloop-search-check-api --network solveloop-search-check_default --network-alias backend --label local.solveloop.test=semantic-search --env-file .local/search-check.env solveloop-backend:search-check
```

試験APIが起動したら、次を実行します。ホストのOllamaと指定モデルを事前に用意してください。CPUテストとは別の明示的な実AI操作です。

```powershell
docker run --rm --network solveloop-search-check_default --env-file .local/search-check.env -e RUN_DB_TESTS=1 -e RUN_OLLAMA_TESTS=1 -e AUTH_TEST_BASE_URL=http://backend:8000 solveloop-backend-test:search-check pytest -q -rP -p no:cacheprovider tests/test_http_search.py
```

終了後、名前とラベルを確認した上で今回の試験資源だけを片付けます。

```powershell
docker inspect solveloop-search-check-api --format '{{index .Config.Labels "local.solveloop.test"}}'
docker rm -f solveloop-search-check-api
docker compose -p solveloop-search-check --env-file .local/search-check.env -f infrastructure/compose.yaml down --volumes
Remove-Item -LiteralPath .local/search-check.env
```

合成の日本語文書3件を実埋め込み→保存→異なる表現の質問→改訂中の旧版維持→承認後の最新chunkだけの検索まで検証し、作成した文書/準備/ログインを終了時に片付けます。これは小さい動作確認で、正式なRecall・正解率・処理量の評価ではありません。ブラウザーでは開発サーバーの `/tests/business-ui.html` が準備/承認分離・AIエラー/空結果・入力保護・遅延応答・Unicode位置を固定応答で検証します。

既存DBでは適用前に `pg_dump -Fc` で保存し、別の専用DBへ `pg_restore --no-owner --no-privileges --exit-on-error` して復元と移行を確認します。DDL途中の失敗はPostgreSQLのトランザクションで戻ります。アプリ再起動をmigration完了と混同せず、失敗後は適用revision・既存資料・readyを確認してください。追加後の破壊的downgradeは提供しません。障害時は書込みを止め、バックアップを新しいDBへ復元・確認し、確認済み接続先と対応するアプリ版へ切り替えます。原本volumeへの上書き復元・削除は自動実行しません。

## 問い合わせの分類・根拠付き回答案

担当者で問い合わせ詳細を開き、本文の下にある「担当部署を提案」または「根拠付き回答案を生成」を実行します。保存済みの件名・本文を使い、未保存の本文は送信しません。分類は部署・理由・追加確認の要否を表示します。担当部署の選択と割り当て、解決内容の記録、ナレッジ承認は人が別の操作で確定します。社員や初回パスワード変更中のアカウントにはAI操作を許可しません。

`POST /api/v1/tickets/{ticket_id}/analysis` は JSON `{ "task": "classification" | "answer", "expected_version": 1 }` を受け取ります。実際の問い合わせの保存版を指定してください。許可Origin・CSRF・現在の担当者資格を検査し、本文や根拠IDの直接指定を拒否します。提案は画面内だけに保持し、DBの業務資料・履歴を変更しません。

回答案の各手順には、検索に実際に含まれた根拠IDを付けます。サーバーが現在の公開版・version/chunk ID・本文位置、または解決問い合わせのID・保存版・解決記録の位置と内容hashを返し、原文リンクを作ります。モデルにURLの生成やツール実行を任せません。

- 公開文書：既存の768次元意味検索で最大2chunk。現在の公開ポインターが指す承認版のみで、下書き・差し戻し・過去版・公開停止・削除文書を除外します。
- 解決事例：担当者に許可された現在の解決記録から、NFKC正規化した文字2個の組み合わせによるDice係数で最大2件。問い合わせ自身と未解決事例を除外します。解決内容の該当chunkを提示し、事例の全文埋め込みは行いません。対応範囲は100件までで、超過は `AI_CORPUS_TOO_LARGE` とし、部分検索に見せません。
- 距離・文字一致は回答の正しさや確率ではありません。無関係な候補しかない場合、モデルも `insufficient_evidence` を返せます。根拠が0件なら文章生成せず、検索のみと表示します。適用条件や本人確認などを人が原文で確認してください。

生成には検証した `qwen3:8b` / digest `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41` を使用します。Ollama0.40.13で `format` のJSONスキーマ、`think=false`、`truncate=false`、`shift=false`、コンテキスト32768・出力上限1536を確認しました。prompt全体24576 UTF-8 bytesまでで、超過時は切り捨てず `AI_INVALID_INPUT` とします。検索のコンテキスト8192とCLI接続試験の2048は別です。モデル/digestを変える場合は規格と実検証を見直してください。

出力は厳密な型・部署enum・段階別の実在根拠IDと照合し、重複JSONキーも拒否します。不正な生成内容だけ最大1回再生成し、その後は `AI_INVALID_OUTPUT` とします。接続・モデル・HTTP障害を再生成や空の検索結果へ置き換えません。応答には実推論 `mode=live`、prompt版、モデル/digest、入力hash、生成時刻・要求番号を含みます。再生応答や永続的なAI実行履歴はありません。

| 状態 | 表示・API |
| --- | --- |
| 根拠不足 | 200 `result.status=insufficient_evidence`、手順なし・不足情報を表示 |
| 問い合わせ更新 | 409 `VERSION_CONFLICT`、古い提案を破棄 |
| 根拠の変更・停止・削除・公開切替 | 409 `AI_CONTEXT_CHANGED`、結果を返さず再実行を案内 |
| 検索準備・規格の不備 | 503 `SEARCH_NOT_READY` など。成功や0件に見せない |
| 不正なモデル出力・接続障害・混雑 | 503 `AI_INVALID_OUTPUT` / `AI_INVALID_RESPONSE` / `AI_UNAVAILABLE` / `AI_BUSY` など |
| 応答時間超過 | 504 `AI_TIMEOUT`。自動再送しない |

推論中はDB接続・行ロックを保持せず、返却前にセッション・権限・問い合わせ・選択した全根拠を再検査します。問い合わせ分析はプロセス内1件で待機キューはありません。既存のsocket待ち上限（生成/埋め込み各120秒、metadata5秒）は個々の通信に適用され、要求全体の厳密な総時間上限ではありません。AI失敗時も手動業務を続けられます。通常のタブ復帰の表示・入力・選択・スクロール・開いたダイアログを保持する認証処理は共通のままです。

### 分離した検証

`tests/test_ticket_analysis.py` は固定応答で権限・引用・型・最大1回の修正・根拠不足・障害・推論中の競合とDB接続解放を確認します。`/tests/business-ui.html` は実React部品の固定応答検査、`/tests/session-ui.html` は認証と入力・位置保持の検査です。固定応答の検査は実モデルの品質を測りません。

実Ollamaの検査は、上記「検証と復旧」の**新しい専用プロジェクト**を構築し、migration・最小合成シード・試験API起動後に実行します。DB名は `solveloop_test`、問い合わせ・文書は0件が前提です。既存DBや通常の `solveloop` プロジェクトを指定しないでください。

```powershell
docker run --rm --network solveloop-search-check_default --env-file .local/search-check.env -e RUN_DB_TESTS=1 -e RUN_OLLAMA_TESTS=1 -e AUTH_TEST_BASE_URL=http://backend:8000 solveloop-backend-test:search-check pytest -q -rP -p no:cacheprovider tests/test_http_ticket_analysis.py
```

この検査は合成問い合わせ・公開文書・解決事例を作り、分類・両方の根拠・無関係な質問の不足判断・業務状態の不変を実HTTPで確認します。作成した資料は試験DBに残し、自動削除・リセットはしません。再実行は別の空試験環境を使ってください。実行した少量の動作確認を、正解率や正式なRAG品質評価として扱いません。正式な品質評価は後続です。

## 解決記録からのAI下書き案

解決済み問い合わせの「ナレッジの下書きを作成」から、または下書き編集の根拠欄で解決記録を選び、「選択した根拠からAI案を生成」を実行します。既存の手動作成も引き続き使えます。生成・再生成は入力を上書きしません。生成案を原本と照合し、「生成案を確認して編集欄へ反映」の確認後に編集します。過去形の解決記録を業務向けの表現へ直すことや、適用条件・実施順の確認は人が行います。「下書きを保存」→検索準備→別の承認操作が必要です。

`POST /api/v1/knowledge/generations` は `{source_refs:[{ticket_id,expected_ticket_version}]}` だけを受け付けます。完全認証・担当者・Origin・CSRFを検査し、現在の解決状態・解決内容・解決日時と保存版を確認します。生成は1〜5件、手動の根拠契約は重複なし最大20件のままです。全文を使い、prompt全体24576 UTF-8 bytesを超えた入力は切り捨てません。追加文書・未解決事例・権限外資料は参照しません。

`backend/app/ai/drafts.py` の `knowledge-draft-v2` は、件名・適用対象・症状・解決手順・例外/注意・不足情報・出典問い合わせIDを構造化します。件名は原題、症状は問い合わせ本文、手順/注意は解決内容の連続した原文抜粋とサーバーで照合します。対象が明記されていなければ確認が必要と表示し、手順がない場合は不足情報を必須にします。重複JSONキー・余分な項目・型違い・重複抜粋・虚偽の出典を拒否します。構造と抜粋が正しくても、選択・順序・適用範囲の適切さは人の確認が必要です。資料中の命令を実行せず、HTML・Markdownも実行しません。

応答は `generation_id`、構造化した `result`、編集用 `draft`、サーバーが取得した実際の保存版の写し、`trace` を返します。生成だけでは知識の版を作りません。生成IDを既存の新規/PATCH下書きAPIへ渡すと、同じ利用者・同じセッション・1時間以内・同じ根拠ID/版/hashを再検査し、根拠の写し・人の編集後本文・生成追跡・一回限りの消費を原子的に保存します。生成中はDB接続・行ロックを保持せず、返却直前にも認証と根拠を再検査します。

成功した生成だけを追加migration `0007_knowledge_generations` の最小追跡に記録します。モデル/digest、prompt版、入力/生成内容hash、token数、試行数、時間、要求番号、根拠ID/版/hash、利用者/内部セッションID、保存先を保持します。生の生成本文・prompt・追加の根拠本文コピー・cookie・CSRF・パスワードは保存しません。人が保存した本文・根拠の写しは従来の知識テーブル、生成後の編集有無は従来のレビュー履歴に残します。文書削除後も本文を持たない消費済み印を残し、同じ生成IDの再保存を防ぎます。追跡レコードの自動削除・結果再生・汎用 `ai_runs` は提供しません。

生成失敗・受取中止・再生成時も編集中の入力を保持し、保存を自動再送しません。生成の受取中止はサーバーの推論停止を保証しません。根拠を変更した場合は入力を保持して原本を比較し、明示的な再選択・再生成・再確認を行います。サーバーが根拠を自動更新・除外することはありません。新規保存の応答不明時は一覧を確認し、同じ登録キーで明示的に再試行します。別キーでも同じ生成IDの重複保存は409です。認証変更・失効時は従来通り前の資料を除去します。

生成モデル/context/出力上限は問い合わせ提案と同じです。個々の通信は生成120秒・metadata5秒、S17には最大1回の構造修正を含む240秒の経過時間予算を設け、各通信のtimeoutを残時間以下に制限します。各通信前後・修正前・返却前に期限を検査し、超過を `AI_TIMEOUT` とします。これは同期HTTP要求を厳密に240秒で強制停止する保証ではありません。DNS・OS・socket読取・DB待機や、ブラウザー中止後のOllama処理の即時停止とは区別します。

固定応答の境界検査は `tests/test_knowledge_generation.py`、ブラウザーの入力保護は `/tests/business-ui.html` にあります。実Ollama検査は上記の**別の空試験環境**で `tests/test_http_knowledge_generation.py` を `RUN_DB_TESTS=1`・`RUN_OLLAMA_TESTS=1`・`AUTH_TEST_BASE_URL` 付きで実行します。合成解決問い合わせ1件/5件の生成、編集保存、重複防止、検索準備、別承認、異なる表現の意味検索を確認し、作成資料は試験DBに残します。正式な品質評価ではありません。

## 繰り返し検出と文書対応判定（Knowledge Gap Radar）

担当者のDashboardで、分析基準日時・直近日数・類似度の閾値を指定します。既定は30日、`created_at` が `[as_of-days, as_of]` の範囲にある全状態の問い合わせが対象です。本文は実行時の最新保存版を使います。過去時点の本文を復元する機能ではありません。対応範囲は100件までで、超過や本文不足を正常な0件として隠しません。

本文全体に `task: clustering | query: {body}` を付け、既存のローカルEmbeddingGemma 2を使います。モデル・digest・768次元・L2正規化・入力規則を別profileで追跡し、文書検索のベクトルとは混ぜません。保存版と本文hashが一致する埋め込みだけを再利用します。UUID順で正確なcosine類似度を計算し、各開始点から、全構成員との類似度が閾値以上の場合だけグループを広げます。同一グループ・真部分集合を除き、異なる問い合わせ5件以上を候補にします。重複する候補は表示します。最大cliqueの完全列挙ではなく、連鎖結合を避ける小規模向けの決定的な規則です。

初期閾値0.92は、日本語の合成本文9件の少量校正で選んだ暫定値です。同じ問題として指定した11組の最小類似度は約0.928、異なる問題の9組の最大は約0.901でした。この資料での選択理由であり、正式評価・一般的な精度・最適値ではありません。[公式のtask prefix](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2?hl=en)と[類似度・最小件数による分類の参考](https://www.sbert.net/examples/sentence_transformer/applications/clustering/README.html)を参照し、アルゴリズムは本リポジトリで実装しています。Sentence Transformersの依存関係やソースコードは導入していません。

候補を選び、別操作で文書対応の判定記録を開始します。検出だけで全問い合わせと全文章に生成AIを実行しません。1バッチ最大3件を明示操作で分析し、問い合わせごとに現在の公開版から意味検索の上位3箇所を取得します。対象・症状・手順・条件・例外をqwen3:8bで確認し、主題が似ているだけの資料を解決手順とみなしません。初期VPN手順が携帯交換後のMFA再登録まで解決できるとは断定しません。

| 表示 | 意味 |
| --- | --- |
| 対応可能 / covered | 現在の公開原文の引用で、解決に必要な手順を裏付ける参考判定 |
| 文書不足 / uncovered | 有効な検索と判定の範囲では、必要な手順・条件が不足 |
| 判断不能 / unknown | 不明確な判定、モデル・通信・形式・引用検証の失敗 |
| 未分析 / unanalyzed | まだ試みていない問い合わせ。unknownとは別集計 |

分母は固定した候補の全問い合わせです。分析済み数と各状態の件数・全体比率、分析済みだけの対応率を分けて表示します。未分析やunknownを対応可能・文書不足へ振り替えません。全件の判定が確定した場合だけ、対応率80%未満を不足候補とします。80%は暫定の運用基準で、精度ではありません。候補が重なる場合、候補別件数の単純合計は全体件数になりません。

モデルが返すchunk IDと引用は、検索で許可した出典・実際の保存原文・位置とサーバーで照合します。任意のURL・出典は採用しません。未承認・差し戻し・公開停止・削除・過去の公開版を現在の根拠に使いません。構造と引用の一致だけでは、引用の選択や適用判断の正しさまでは保証できないため、人が原文と理由を確認します。

検出と各バッチに240秒の経過時間予算を設け、通信ごとのmetadata5秒・生成120秒・埋め込み120秒も残時間以下に制限します。構造の修正は最大1回、入力全文と根拠を含むpromptは24576 UTF-8 bytesまでです。超過は切り捨てずエラーです。未実行分は未分析のまま残します。OS・DNS・socket読取・DB待機を含む厳密な強制終了時刻、画面で受信を止めた際のOllama即時停止は保証しません。

追加migration `0008_radar` は、問い合わせ埋め込み・検出run・候補別の判定記録の3表を追加します。候補と構成ID・版・hashはrun、問い合わせ別の理由・引用・出典とバッチ進行は判定記録に保存します。原prompt・生成の自由原文・追加の問い合わせ本文コピー・認証情報は保存しません。推論中はDB接続・行ロックを返し、結果保存前に現在の認証・権限・入力集合・版/hash・検索profile・公開状態を再確認します。今回バッチの保存失敗・根拠変更では新しい判定を一部だけ保存せず、過去の完了範囲は保ちます。

要求ごとにUUIDキーを保持し、応答不明時には同じ要求で保存済み結果を確認できます。別条件へのキー再利用と実行中の同じ判定への重複処理は拒否します。プロセス中断後は所有期間を過ぎた記録を中断として表示し、明示的な新要求で再実行します。自動再試行や持続workerはありません。unknownの再判定には新しい判定記録を使い、過去の確定結果を上書きしません。

有効な解決内容・解決日時を持つ現在の解決済み問い合わせだけを、人が1〜5件選んで既存の下書き画面へ移動できます。全候補を解決根拠に自動採用せず、途中で切り捨てません。移動先で選択した保存版を再検査し、AI生成 → 明示反映 → 人の編集 → 下書き保存 → 検索準備 → 別操作の承認を維持します。

承認後は、同じrun・候補・as_of・本文hash・profile・閾値・規則で新しい判定を開始し、公開文書を再検索します。承認だけで過去の点数や問い合わせの状態は変わりません。原本や入力集合が変わった場合は新しい検出が必要です。公開根拠が変わった過去記録は件数を履歴として表示し、以前の理由・引用を現在の資料として再表示しません。未分析・unknown・条件差異がある結果は単純な改善比較にしません。

固定応答の保存・競合・権限・失敗検査は `tests/test_radar.py`、画面の回帰は `/tests/business-ui.html` です。実モデルの少量校正は次のように独立実行できます。

```powershell
$env:RUN_OLLAMA_TESTS = '1'
cd backend
uv run python -X utf8 -m pytest -q -s tests/test_radar_calibration.py
```

実HTTPの循環確認は、上記の検索用試験環境とは**別の空の専用DB/API**で、最小合成アカウントと検索profileを準備し、`RUN_DB_TESTS=1`・`RUN_OLLAMA_TESTS=1`・`AUTH_TEST_BASE_URL` を明示して `tests/test_http_radar.py` を実行します。11件の合成問い合わせと少数の文書を作り、反復検出・不足/対応判定・S17生成と人の編集に相当する保存・検索準備・承認・同じ問い合わせ集合同士の再判定を検証します。試験資料を元のDBへ投入したり、自動リセットしたりしません。正式な品質評価、最終規模のシード拡張は後続です。

## 技術構成

| 領域 | 採用済み・採用予定 |
| --- | --- |
| フロントエンド（導入済み） | React 19.3.1 / TypeScript 7.0.2 / Vite 8.3.5 / React Router 7.18.5 |
| バックエンド（実行基盤） | Python 3.13 / FastAPI 0.162.0 / SQLAlchemy 2.0.55 / Alembic 1.20.1 |
| データベース（ローカル起動・保存を検証済み） | PostgreSQL 17.11 / pgvector 0.8.7、業務保存・768次元ベクトル・正確意味検索 |
| ローカル推論 | Ollama |
| 実行環境・検証 | Docker Compose / pytest / Node.js内蔵test / Chrome操作検証 / GitHub Actions（定義済み） |

生成・埋め込みのローカルOllama接続、意味検索、問い合わせ分類・回答案、解決記録からのAI下書き案を少量の合成資料で動作確認しています。Radarも少量の実モデル動作を確認しています。正式な品質評価は後続です。

## リポジトリ構成

```text
frontend/          画面とフロントエンドのテスト
backend/           API・業務処理・AI連携
infrastructure/    Compose・環境変数の例・DB検証SQL（実際の.envはGit除外）
demo/              架空企業のデータと再現シナリオ
evaluations/       検索・分類・Radarの評価
```

AI/Radar・デモ動画・評価結果は実装と検証に合わせて追加します。

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

共通レイアウト・ダッシュボード・問い合わせ・ナレッジ画面とAPI連携を作成し、依存パッケージ本体は改変していません。React Router は [公式のルーターAPI](https://reactrouter.com/api/data-routers/createBrowserRouter) と [移動の保護](https://reactrouter.com/api/hooks/useBlocker) を参考に利用し、`RouterProvider` で未保存入力を保護しています。Loader・サーバー機能は使用していません。型検査・境界テスト・ビルド・ブラウザー表示を確認しました。React / React DOM / scheduler / React Router と追加された依存パッケージの著作権・ライセンスは [THIRD_PARTY_NOTICES.txt](frontend/public/THIRD_PARTY_NOTICES.txt) に保存し、ビルド時に `dist/` にもコピーします。各開発用依存のライセンスはインストールしたパッケージ内に保持されます。
