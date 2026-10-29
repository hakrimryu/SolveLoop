# SolveLoop

社内の問い合わせと解決履歴を、再利用できるナレッジへつなぐ業務支援システム。

架空企業「株式会社 柳」を題材にした個人ポートフォリオです。社員・問い合わせ・社内文書には合成データを使用します。

## 開発状況

共通レイアウトとダッシュボードの画面モックを用意しました。担当者・社員の表示切替、問い合わせの件数と担当分の一覧、確認待ちの下書き、Radar の根拠パネルを合成データで確認できます。

データ保存・認証・権限検査・AI 推論・Radar の分析処理は未実装です。問い合わせ・ナレッジ・レビュー・ログインの移動先には準備中の案内だけを表示します。

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

合成資料は問い合わせ12件・下書き2件・Radar候補1件です。表示の基準日時は `2026/10/30 09:00 JST` に固定しています。件数は合成資料から計算し、Radar の文書対応状況は作成済みのサンプルを表示します。

Windows では PowerShell のスクリプト実行ポリシーに依存しない `npm.cmd` を使用しています。ほかの環境では `npm` に読み替えてください。

同じ `frontend/` で検証します。

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run preview
```

`typecheck` は型エラーがなければ終了コード 0 で完了します。`build` は型検査の後に `dist/` を生成し、`preview` は [http://127.0.0.1:4173/](http://127.0.0.1:4173/) でビルド結果を表示します。preview はローカル確認用です。

`test` は Node.js のテストランナーと型除去を使い、役割ごとの表示対象・集計・空データ・Radar の参照・日本時間の表示を検証します。実際のサーバー権限検査や AI 評価のテストではありません。

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
| フロントエンド（導入済み） | React 19.3.1 / TypeScript 7.0.2 / Vite 8.3.5 / React Router 7.18.5 |
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

残りの業務画面・デモ動画・評価結果は実装と検証に合わせて追加します。

## 参考・利用した OSS

[Vite 公式ガイド](https://vite.dev/guide/)、[React の構築手順](https://react.dev/learn/build-a-react-app-from-scratch)、[TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) を環境構成の参考にしました。生成テンプレートや他製品の画面・ソースはコピーしていません。

[Zammad の問い合わせ画面](https://user-docs.zammad.org/en/latest/basics/ticket-basics.html)、[BookStack の公式画面](https://www.bookstackapp.com/#screenshots)、[Carbon のデータテーブル](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines)、[Pajamas の表設計](https://design.gitlab.com/components/table/) を情報配置・表・文書閲覧の設計参考にしました。これらの製品のコード・画像・フォント・アイコンは利用していません。

| パッケージ | 利用範囲 | ライセンス |
| --- | --- | --- |
| [React / React DOM](https://github.com/facebook/react) 19.3.1 | 画面の構成・描画 | MIT |
| [React Router](https://github.com/remix-run/react-router) 7.18.5 | URL・メニュー・ブラウザーの戻る操作 | MIT |
| [Vite](https://github.com/vitejs/vite) 8.3.5 / [React plugin](https://github.com/vitejs/vite-plugin-react) 6.1.2 | 開発サーバー・ビルド・開発時の更新 | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) 7.0.2 | アプリと Vite 設定の型検査 | Apache-2.0 |
| [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | React / React DOM / Node.js の型定義 | MIT |

共通レイアウト・ダッシュボード・合成資料と集計・表示確認用の操作を作成し、依存パッケージ本体は改変していません。React Router は [公式の Declarative Mode](https://reactrouter.com/7.18.5/start/declarative/installation) を参考に利用しています。型検査・資料のテスト・ビルド・ブラウザー表示を確認しました。React / React DOM / scheduler / React Router と追加された依存パッケージの著作権・ライセンスは [THIRD_PARTY_NOTICES.txt](frontend/public/THIRD_PARTY_NOTICES.txt) に保存し、ビルド時に `dist/` にもコピーします。各開発用依存のライセンスはインストールしたパッケージ内に保持されます。
