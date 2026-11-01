[日本語](setup.md) · [한국어](setup.ko.md) · [English](setup.en.md)

# 実行方法

[プロジェクト紹介](../README.md)

Windows / PowerShellで、合成資料を用意した**専用デモ**を起動する手順です。初期資料は社員15人・問い合わせ100件・承認文書15件です。専用DBとポートを使い、一般環境の設定は変更しません。

## 準備

- Docker DesktopのLinuxエンジン
- Node.js 22系の22.19.0以降 · npm 10系
- Windowsホストで起動したOllama

生成にはQwen3 8B、埋め込みにはEmbeddingGemma2を使います。未取得ならホストで次を実行してください。ダウンロードにはネットワークが必要ですが、推論はローカルで処理します。

```powershell
ollama pull qwen3:8b
ollama pull embeddinggemma-2:270m-q8_0-text
```

検索profileはモデルのdigestも検査します。不一致が出た場合は、下の詳細資料にある固定モデル規格を確認してください。

## デモを起動する

**リポジトリのルート**で一行ずつ実行し、成功を確認して次へ進みます。既存の環境があれば同じデモか確認してください。通常の `compose.yaml` とはマージしません。

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml build demo-api
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml up -d --wait demo-db
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api alembic upgrade head
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo validate
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo inspect --confirm solveloop-demo/solveloop_demo
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo load --confirm solveloop-demo/solveloop_demo
```

`inspect` の `identity_matches: true` を確認します。DB名だけでなく、実際の専用DBの標識も検査します。同じ資料の再適用で既存の変更を上書きしません。初期文書の承認は合成の過去記録で、今回人が承認した記録ではありません。

次に実Ollamaで埋め込みを準備し、APIを起動します。

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.ai backfill
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.ai activate
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml up -d --wait demo-api
```

`backfill` が失敗しても完了分は残ります。原因を確認し、同じコマンドで再開できます。全公開文書を準備して `activate` が成功すると、意味検索を使えます。

## 画面を開く

別のPowerShellをリポジトリのルートで開き、実行します。

```powershell
cd frontend
npm.cmd ci
$env:SOLVELOOP_API_TARGET='http://127.0.0.1:8020'
npm.cmd run dev -- --host 127.0.0.2 --port 5180 --strictPort
```

[デモ画面](http://127.0.0.2:5180)を開きます。一般環境とcookieを分けるため `127.0.0.2` を使います。

| アカウント | 用途 | パスワード |
| --- | --- | --- |
| `employee` | 社員の質問・問い合わせ・文書検索 | `SolveLoop-Demo-2026!` |
| `operator` | 問い合わせ対応・文書レビュー・アカウント管理 | `SolveLoop-Demo-2026!` |

公開のローカルデモ専用パスワードです。社員で質問・解決確認・未解決の引き継ぎを行い、担当者で応対・解決・下書き・承認・再検索の流れを確認できます。AI生成と文書公開は別の操作で、公開前に人が確認します。

## 停止と問題の確認

フロントは `Ctrl+C` で終了します。DBとAPIは次で停止し、保存資料は保持します。

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml stop
```

- 検索準備が失敗したら、ホストのOllamaと両モデルを確認してください。APIコンテナは `host.docker.internal:11434` に接続します。
- `8020`・`5180` が使用中なら、同じデモの再利用か確認します。他のサービスを無断で終了しないでください。
- 再開時はAPI起動とフロント起動を繰り返します。リセットは任意で、通常起動には不要です。

## 設定・ライセンス

固定モデルのdigest・検索規格は[検索設定](../backend/app/ai/knowledge.py)と[生成設定](../backend/app/ai/tickets.py)にあります。デモは[固定の合成入力](../demo/manifest.json)を使います。動画で使った[IT企業の文書50件](../demo/it-company/knowledge.json)は別資料で、この初期デモには入りません。

OSS表示は[フロントエンド](../frontend/public/THIRD_PARTY_NOTICES.txt)・[バックエンド](../backend/THIRD_PARTY_NOTICES.txt)に保持しています。モデルは[Qwen3](https://ollama.com/library/qwen3:8b)・[EmbeddingGemma2](https://ollama.com/library/embeddinggemma-2:270m-q8_0-text)の配布条件に従います。モデルの重みは同梱しません。プロジェクト自体のライセンスは未決定です。
