# SolveLoop

社内の問い合わせと解決履歴を、再利用できるナレッジへつなぐ業務支援システム。

架空企業「株式会社 柳」を題材にした個人ポートフォリオです。社員・問い合わせ・社内文書には合成データを使用します。

## 開発状況

フロントエンドの最小開発環境を用意しました。日本語の動作確認画面を起動できます。業務画面・データ保存・認証・AI・Radar は未実装です。

## フロントエンドの起動

検証環境: Windows / PowerShell、Node.js 22.19.0、npm 10.9.3。Node.js は 22 系を使用し、検証したバージョンを `frontend/.node-version` に記録しています。このファイルだけで Node.js がインストール・切り替えされるわけではありません。

リポジトリのルートから実行します。

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev
```

[http://127.0.0.1:5173/](http://127.0.0.1:5173/) に「SolveLoop」「開発環境の動作確認」が表示されます。終了は `Ctrl+C` です。ポートが使用中の場合はエラーで終了します。

Windows では PowerShell のスクリプト実行ポリシーに依存しない `npm.cmd` を使用しています。ほかの環境では `npm` に読み替えてください。

同じ `frontend/` で検証します。

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run preview
```

`typecheck` は型エラーがなければ終了コード 0 で完了します。`build` は型検査の後に `dist/` を生成し、`preview` は [http://127.0.0.1:4173/](http://127.0.0.1:4173/) でビルド結果を表示します。preview はローカル確認用です。

依存関係は `frontend/package-lock.json` で固定しています。バックエンド・DB・Docker・Ollama の準備は、この画面の起動には不要です。

## 実装予定

- 問い合わせの登録・担当者の割り当て・対応履歴の管理
- 承認済みナレッジと過去の解決事例を使った検索・回答案の作成
- 解決履歴に基づく文書の下書きと、担当者による確認・承認
- 繰り返し発生する問い合わせと文書の不足を可視化する Knowledge Gap Radar

問い合わせ → 解決 → 文書化 → 承認 → 次の問い合わせへの活用、という流れを実装します。

## 技術構成

| 領域 | 採用済み・採用予定 |
| --- | --- |
| フロントエンド（導入済み） | React 19.3.1 / TypeScript 7.0.2 / Vite 8.3.5 |
| バックエンド | Python / FastAPI / SQLAlchemy / Alembic |
| データベース・検索 | PostgreSQL / pgvector |
| ローカル推論 | Ollama |
| 実行環境・検証 | Docker Compose / pytest / Vitest / Playwright / GitHub Actions |

生成と埋め込みはローカルの Ollama で実行する方針です。使用モデルと動作環境は、実装時の検証後に記載します。

## リポジトリ構成

```text
frontend/          画面とフロントエンドのテスト
backend/           API・業務処理・AI連携
infrastructure/    コンテナと実行環境の設定
demo/              架空企業のデータと再現シナリオ
evaluations/       検索・分類・Radarの評価
```

業務画面・デモ動画・評価結果は実装と検証に合わせて追加します。

## 参考・利用した OSS

[Vite 公式ガイド](https://vite.dev/guide/)、[React の構築手順](https://react.dev/learn/build-a-react-app-from-scratch)、[TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) を環境構成の参考にしました。生成テンプレートや他製品の画面・ソースはコピーしていません。

| パッケージ | 利用範囲 | ライセンス |
| --- | --- | --- |
| [React / React DOM](https://github.com/facebook/react) 19.3.1 | 画面の構成・描画 | MIT |
| [Vite](https://github.com/vitejs/vite) 8.3.5 / [React plugin](https://github.com/vitejs/vite-plugin-react) 6.1.2 | 開発サーバー・ビルド・開発時の更新 | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) 7.0.2 | アプリと Vite 設定の型検査 | Apache-2.0 |
| [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | React / React DOM / Node.js の型定義 | MIT |

アプリ固有の起動処理・確認画面・設定を作成し、依存パッケージ本体は改変していません。型検査・ビルド・ブラウザー表示を確認しました。ブラウザーに配布する React / React DOM / scheduler の著作権・ライセンスは [THIRD_PARTY_NOTICES.txt](frontend/public/THIRD_PARTY_NOTICES.txt) に保存し、ビルド時に `dist/` にもコピーします。各開発用依存のライセンスはインストールしたパッケージ内に保持されます。
