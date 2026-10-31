# 架空企業の再現デモ

株式会社 柳の合成資料です。実在の社員・会社の記録ではありません。初期資料は4部署、15人、問い合わせ100件（解決67件）、承認済み文書15件です。既存の `employee`（佐藤 美咲）と `operator`（山田 花子）は15人に含まれます。管理権限は `operator` だけです。新規発行・初回パスワード変更・停止はシードに入れず、実際に操作します。

## 専用環境の準備

リポジトリのルートで実行します。Docker DesktopとローカルOllamaが必要です。モデルは `qwen3:8b` と `embeddinggemma-2:270m-q8_0-text`。既存のdigest・profile・入力上限・同時性制限を維持します。モデル取得・通常環境の説明はルートREADMEを参照してください。

通常の `infrastructure/compose.yaml` と併用・マージしないでください。専用Composeは実envを必要とせず、公開デモ専用のDB認証情報を使います。APIは127.0.0.1:8020、DBのホスト公開はありません。原本8000・5174・`solveloop_postgres_data` は変更しません。

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml build demo-api
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml up -d demo-db
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api alembic upgrade head
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo validate
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo inspect --confirm solveloop-demo/solveloop_demo
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo load --confirm solveloop-demo/solveloop_demo
```

各終了コードを確認し、失敗したら次に進まないでください。`inspect` の実接続先・cluster・database_oid・instanceと `identity_matches: true` を確認します。DB名だけでは許可しません。専用環境変数、確認引数、実接続IP・ポート・ロール、初回DB作成時の `demo_guard.identity` を照合します。標識がないDB、別クラスタへ移した標識、対応外スキーマを拒否します。原本へ標識を手作業で作らないでください。

初期文書の承認は**合成の過去記録**です。イベントの `synthetic_initial_seed` で識別します。今回の実AI生成・人の承認を行ったという記録ではありません。MFA再登録文書やシナリオ完了結果は含めません。

## 実際の検索準備と起動

業務資料の適用ではOllamaを呼びません。文書はキーワードで閲覧できますが、ベクトル準備・有効化までは意味検索に使えません。

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.ai backfill
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.ai activate
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml up -d demo-api
```

`backfill` は実際のローカルOllamaで現在公開版を文書ごとに準備します。失敗しても適用済み資料と準備済み文書は残り、同じコマンドで未完了分を再開できます。`activate` は全公開版の準備が揃うまで切り替えません。AI呼出中のDB接続・行ロックを保持しない既存処理を利用します。固定ベクトルや架空の準備済み状態は使いません。

別のPowerShellでNode 22と既存フロントを起動します。

```powershell
cd frontend
npm.cmd ci
$env:SOLVELOOP_API_TARGET='http://127.0.0.1:8020'
npm.cmd run dev -- --host 127.0.0.2 --port 5180
```

[専用デモ画面](http://127.0.0.2:5180)で `operator` または `employee`、公開デモ専用パスワード `SolveLoop-Demo-2026!` を使用します。通常環境のCookieと分離するため127.0.0.2を使います。認証期限・生成・実行時刻は実時刻です。

## 入力の再現契約

| 項目 | 契約 |
| --- | --- |
| 形式 | UTF-8 JSONで会社・問い合わせ・文書メタデータ・シナリオを分離。本文 `.txt` はplain text。Markdown/HTMLとして実行しない |
| スキーマ | `backend/app/demo_data.py` のstrictモデル。未知フィールド、重複JSONキー、件数・UUID・FK・状態・本文上限・相対日付・必須節を検査 |
| manifest | schema_version=1、seed_version=yanagi-v1、random_seed=20261031、as_of、synthetic、19入力ファイルのSHA256。manifest自体のSHA256も適用履歴に保存 |
| 日付 | 固定as_of=`2026-09-30T18:00:00+09:00` からcreated_days_agoを引く。実行時の乱数・現在日付は使わない。random_seedは資料版の来歴情報 |
| 問い合わせ履歴 | 作成、10分後に割当、30分後に開始、90分後に解決。状態に必要なイベントだけ生成、versionはイベント数。未解決には解決内容・時刻なし |
| 文書履歴 | 作成は基準日88日前、合成承認は87日前。第1版・row_version=2、公開ポインターとイベントを整合させる。実ベクトルは別処理 |
| ID・番号 | UUIDは入力固定。最小2アカウント・4部署は既存シードと同じID。REQ-0001〜0100、KB-0001〜0015。次の新規番号はREQ-0101 / KB-0016 |
| 原子性 | 全業務資料とreceiptを一トランザクションで適用。シーケンスもrollback可能なALTER SEQUENCE RESTARTを使用。同時適用をadvisory lockで直列化 |
| 再適用 | 同じmanifestは `already_loaded_preserved`。業務変更・パスワード・権限・結果を上書きしない。別manifest/版は明示リセットまで拒否。初回に既存資料があれば取り込まず拒否 |
| 検査 | `initial_business_matches` は業務初期値との一致。パスワードのランダムsalt・セッション・実行結果は業務hashの対象外。認証可否は別検査 |
| シナリオ | `scenarios/scenarios.json` は再現・確認用。製品APIの探知・対応判定では読まない。期待結果で補正しない。S21の評価質問・正解集合ではない |

編集時は意図を確認してseed_versionと該当hashを更新します。不整合はDB操作前に拒否します。同一入力は同じ業務資料・関係を再現しますが、Argon2のsalt、認証期限、実AIの生成内容・判定・処理時間は固定しません。

## 明示的なリセット

**専用デモDBだけ**を初期入力へ戻します。デモAPIと検証処理を停止してください。他のDB接続が残っている場合も拒否します。AIの受信中止だけではサーバー処理の停止にはなりません。

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml stop demo-api
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo reset --confirm solveloop-demo/solveloop_demo
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo inspect --confirm solveloop-demo/solveloop_demo
```

`reset_restored`、`initial_business_matches: true`、15人・100件・初期15文書を確認します。その後backfill・activate・API起動を再実行し、画面で再ログインします。途中失敗はリセット前へ全体rollbackします。

対象は専用DBの全合成社員・権限・パスワード、問い合わせ・履歴、文書全版・根拠・レビュー、セッション・アカウント監査、登録キー、生成追跡、Radar実行・判定、派生ベクトル・profile・検索状態です。初期資料を再作成し検索状態を未準備へ戻します。

専用DBの識別標識・migration、原本の全資料・セッション・権限・パスワード、既存named volume、実env、frontend/dist、バックアップ、他プロジェクト資源は保持します。volume削除・prune・原本復元は行いません。

## 2〜3分の操作構成

AI待ち時間は操作時間と別に扱います。初期検索準備を先に済ませ、判定・生成の待ち時間を確認してから収録します。編集で待ちを省いた場合は表示し、2〜3分で全処理が必ず完了するとは主張しません。

| 操作の目安 | 操作と観察点 |
| --- | --- |
| 0:00〜0:20 | operatorログイン→Dashboardの100件/解決67件/下書き0件を確認。Radarの基準日時へ固定as_ofを入力。日数30・閾値0.92を維持して検出 |
| 0:20〜0:50 + AI待ち | 実際のMFA候補で構成問い合わせと重複を確認。文書対応判定を開始し、3件以下の明示バッチで最後まで分析。一般VPN文書と不足理由を読む |
| 0:50〜1:20 + AI待ち | 有効なREQ-0001〜0003を1〜3件選択。担当者は山田・鈴木・高橋。原文・版・解決を確認してS17実生成。明示反映後に対象・注意を見直し、編集して保存 |
| 1:20〜1:50 + AI待ち | 新文書KB-0016（初期15件とは別）の検索準備→完了確認→別の承認操作と確認dialog。生成だけでは保存・承認されないことを確認 |
| 1:50〜2:20 + AI待ち | Dashboardで保存済みの**同じrun**を選択。同じ候補・問い合わせ集合・条件で新しい文書対応判定を作り、最後まで明示分析。旧判定を履歴に残して前後を確認 |
| 2:20〜2:50 + AI待ち | 「携帯を買い替えて社外アクセスの二段階認証を通せない」など別表現で意味検索。現在公開原文へ移動し該当箇所を読む |

経費REQ-0009〜0014は初期KB-0013に手順がある反復です。VPN導入REQ-0015〜0019と曖昧なREQ-0026〜0027は認証登録と区別して読みます。勤怠CSVのREQ-0020〜0025は解決記録がなくS17の根拠に選べません。候補は実ベクトルに従います。MFA8件が必ず単独候補になる、重複が必ず出る、承認後に全件対応になる、とは保証しません。

以前の少量確認はHTTPで0/5→5/5、別ブラウザーで0/5→4/5でした。経費は4/5対応で、画面位置を求める1件を不足と判定しました。今回の最終資料の動作確認では、対象43件から6候補、MFAは曖昧な問い合わせを含む9件の重複候補になりました。最終LF入力のHTTPでは承認前0/9、承認後は対応3件・不足4件・判断不能2件（出力検証失敗）で、単純な改善比較は保留です。経費の一候補は6/6対応でした。別のブラウザー循環では文書のLF統一前に0/9→5/9を確認しました。S17では同じ手順の重複・注意漏れがあり、人の編集で原文と照合しました。JSON・出典・引用一致は内容判断の正確さを保証しません。モデル・閾値・promptを調整せず、これらを正式な品質指標や業務改善実績とは扱いません。

## 検査の区別

ホストでは `cd backend` 後に `uv run --locked pytest -q tests/test_demo.py` で入力・拒否契約を検査します。専用DB試験は**空の専用DB**に `RUN_DEMO_DB_TESTS=1` を明示した場合だけ動作します。コンテナでは公開 `demo/` を `/demo:ro` にマウントしてください。初期適用済みDBでは空DB条件で停止します。通常CIに実Ollamaは不要です。S21の保留評価セット・正式指標とは区別します。

初期15文書を準備した専用デモで、次の実HTTP確認を任意に実行できます。新しい文書を生成・編集保存・準備・承認し、判定履歴を残します。再実行の前には上記リセットと検索準備が必要です。対応件数や100%の成功をassertする品質試験ではありません。

```powershell
docker build --target test -t solveloop-demo:test backend
docker run --rm --network solveloop-demo_default -e DB_HOST=demo-db -e POSTGRES_DB=solveloop_demo -e POSTGRES_USER=solveloop_demo -e POSTGRES_PASSWORD=SolveLoop-Isolated-Demo-Only! -e SOLVELOOP_DEMO=1 -e SOLVELOOP_DEMO_INSTANCE=ef53d43d-57f8-43b7-8230-31983ef3f020 -e RUN_DEMO_LIVE_TESTS=1 -e RUN_OLLAMA_TESTS=1 -e AUTH_TEST_BASE_URL=http://demo-api:8000 --mount "type=bind,src=$((Get-Location).Path)/demo,dst=/demo,readonly" solveloop-demo:test pytest -q -rP -p no:cacheprovider tests/test_http_demo.py
```

通常は実循環1件を実行し、障害APIを指定していない1件をskipします。障害確認には同じ専用DBに接続し `OLLAMA_BASE_URL=http://127.0.0.1:9` とした別の専用APIを用意して、そのURLを `DEMO_OUTAGE_BASE_URL` に指定します。原本Ollamaは停止しません。準備の503と、手動問い合わせ・下書き保存・既存公開文書利用の維持を分けて検査します。
