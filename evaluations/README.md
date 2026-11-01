[日本語](README.md) · [한국어](README.ko.md) · [English](README.en.md)

# 評価要約

[プロジェクト紹介](../README.md)

実API・PostgreSQL・ローカルOllamaを接続し、業務フローとAIの動作を確認しました。以下の数値は各報告の固定合成入力・測定時点に基づきます。実企業での問い合わせ削減や時間削減効果を測定したものではありません。

## 確認したこと

社員の質問→未解決の引き継ぎ→担当者の応対・解決→下書き・人の承認→再検索を確認しました。権限、古い版の更新拒否、重複登録防止、公開文書だけを検索する境界も検査しています。固定応答の検査と実モデルの評価は区別しました。

## 主な結果

| 評価 | 入力と結果 | 読み取れる範囲 |
| --- | --- | --- |
| 検索基準線 | 正解文書がある20問×3回、Recall@5 **60/60** | 文書の検索結果であり、回答内容の正しさとは別 |
| Radar | 反復群 **4/4** を毎回検出（3回）、知識不足判定precision **5/8** | 反復検出と文書で対応できるかの判断は別の問題 |
| 社員向けAI案内 | 合成公開文書3件・質問8件、単一要求 **1.152〜2.838秒** | API処理時間であり、社員の解決時間ではない |

検索・Radar基準線は2026-10-31、社員向け案内は2026-11-01の測定です。同じ入力の反復を独立標本として合算しません。

## 残る課題

- 後続の同時社員質問2件では、1件が `AI_UNAVAILABLE` で失敗しました。同時処理の安定性は追加検証が必要です。
- 適用条件の解釈と下書きの注意事項抽出には誤りが残ります。構造・引用検査の成功だけでは内容の十分さを保証できず、実利用者による下書き品質レビューも未完了です。

## 評価データと再実行

- [固定入力](datasets/)・[基準線の集計](reports/baseline-v1/summary.json)・[社員向け案内の実測](reports/employee-guidance-v1/records.jsonl)・[同時要求](reports/employee-guidance-v1/concurrency.json)
- [不採用候補の比較](reports/quality-v2/comparison.json)・[候補patch](quality-v2-candidate.patch)・[固定hash](quality-v2-manifest.json)
- 評価時の固定規約原文: [v1](frozen/protocol-v1.txt)・[v2](frozen/protocol-v2.txt)。内部識別子を含む原資料です。

実モデルの再実行は[infrastructure/compose.evaluation.yaml](../infrastructure/compose.evaluation.yaml)の専用DBに限定します。[実行器](run.py)・[比較実行器](quality.py)・[集計器](score.py)に引数があります。新しい評価では合成資料の準備とDBへの書き込みが発生するため、既存結果はバックアップし、通常利用中のDBでは実行しません。引数だけ確認する例:

```powershell
docker compose -p solveloop-evaluation -f infrastructure/compose.evaluation.yaml run --build --rm --no-deps eval python /evaluation/run.py --help
```

固定入力・分母の検査は[test_evaluation.py](test_evaluation.py)・[test_quality.py](test_quality.py)にあります。過去の比較対象は `ad49f2437977f4726a6bea40f4639cbbd820afc9` と保存patchで復元します。現在コードの再実行を過去と同じ測定とは扱いません。
