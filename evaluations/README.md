# ローカルAI評価

## 社員向けAI案内の追加評価

[社員向け案内の測定・内容照合・制約](reports/employee-guidance-v1/report.md)は、公開合成文書3件で8質問と同時2要求を確認した小規模回帰です。S21の保留評価とは別に扱い、利用者の解決や時間削減効果を主張しません。同時要求の成功とAI_UNAVAILABLEの両方を保存しています。

この追加実行器だけは、指定したローカルの原本APIへ合成社員で接続し、合成公開文書KB-0003/0004/0005を使用します。問い合わせ・公開文書は作成/更新しませんが、ログインセッションと30日間のAI質問履歴は保存されます。既存結果を上書きせず、新しい出力先を指定します。実行にはPython標準ライブラリだけを使用します。

```powershell
python -X utf8 evaluations/employee_guidance.py --output .local/employee-guidance-new-run
```

以下のS21専用DB・リセット手順と混同しないでください。

全て架空企業の合成資料。S21の評価入力・正解・実行器・集計と、派生した測定報告を保存する。目標値と測定値は[評価規約](protocol.md)・結果報告で区別する。保留結果を見たprompt・threshold調整は行っていない。

事前の0.80目標はRadarの反復検出precision/recallに適用し、知識不足判定は別の参考指標として扱う。追加文書承認後の正解ラベルは対象条件の一致を仮定した未確認ラベルであり、正式な正解率や改善達成の根拠にしない。下書き10種の利用者レビューは完了0/10・確認待ち10/10。構造検査・分析者の所見・隔離DBでの文書承認を利用者の品質承認へ読み替えない。

コミット準備時にこの説明とMarkdown報告の表記のみを訂正した。評価規約・入力・正解・実行器・集計器・結果JSON・測定原本は基準線のまま保存し、再実行はしていない。

必要条件は既存のDocker環境と、製品が指定するdigestのローカルOllamaモデル。追加のモデル・外部API・パッケージは使わない。原本`solveloop`とS20`solveloop-demo`には接続しない。評価専用DBはポートを公開せず、別volume・role・cluster標識を検査する。

リポジトリルートからPowerShellまたは同等のシェルで実行する。

```powershell
New-Item -ItemType Directory -Force .local/s21
docker compose -p solveloop-evaluation -f infrastructure/compose.evaluation.yaml build eval
docker compose -p solveloop-evaluation -f infrastructure/compose.evaluation.yaml up -d --wait eval-db
docker compose -p solveloop-evaluation -f infrastructure/compose.evaluation.yaml run --rm eval alembic upgrade head
docker compose -p solveloop-evaluation -f infrastructure/compose.evaluation.yaml run --rm -e EVALUATION_HEAD=044cc692df9527a0fb99c1368b5c2fd1a04dc5c3 eval python /evaluation/run.py run --output /results/baseline-v1
python evaluations/score.py .local/s21/baseline-v1 --output .local/s21/derived
python evaluations/review.py .local/s21/baseline-v1 --output .local/s21/derived
```

今回の測定では、基準線完了後の最初のunloadで非resident確認が早すぎて実行器が停止した。基準線を再実行せず、入力・製品hashと時間測定未開始を確認する`finish`で続行した。修正後の新規`run`には不在確認の待機が含まれる。今回の続行コマンドは次の通り。

```powershell
docker compose -p solveloop-evaluation -f infrastructure/compose.evaluation.yaml run --rm eval python /evaluation/run.py finish --output /results/baseline-v1
```

`EVALUATION_HEAD`は今回測定した製品ソースのコミット。別の製品版を評価する場合は実際の版に置き換える。実際のPythonファイルhashも記録し、この文字列だけで版の一致を判断しない。既存結果の上書きと既存DBへの追加実行は拒否する。再実行は別の結果ディレクトリを指定し、他の評価接続を閉じて次の明示リセットを行う。

```powershell
docker compose -p solveloop-evaluation -f infrastructure/compose.evaluation.yaml run --rm eval python /evaluation/run.py reset --confirm solveloop-evaluation/solveloop_evaluation
```

モデル非resident開始の測定では両モデルをunloadする。実行中に同じOllamaを他の処理で使用しない。これはモデル・DB内容の変更ではないが、同時利用すると応答時間を比較できない。TestClientの認証済みAPI経路から実DB/実Ollamaを呼び、ブラウザとTCP APIサーバーの時間は含めない。

S20診断は本評価と分離し、評価DBの明示reset後に実行する。S20の入力をコピーして使用し、保留正解や成功率には含めない。

```powershell
docker compose -p solveloop-evaluation -f infrastructure/compose.evaluation.yaml run --rm --volume ${PWD}/demo:/demo:ro eval python /evaluation/diagnose_s20.py
python evaluations/summarize_s20.py .local/s21/s20-diagnostic-v1 --output .local/s21/s20-derived
```

今回のS20診断ではresetの初期検索状態復元を修正した後、`--output /results/s20-diagnostic-v2`へ実行した。最初の準備失敗は品質試行前で、失敗記録もローカルに保存した。

S21の公開境界だけを確認する場合は、基準線の評価DBをresetする前に次を実行する。S22の全体検証・利用者手動確認の代わりにはしない。

```powershell
docker compose -p solveloop-evaluation -f infrastructure/compose.evaluation.yaml run --rm eval python /evaluation/check_boundaries.py
```

採点器だけの確認（GPU・DB不要）:

```powershell
python -m pytest -q -p no:cacheprovider evaluations/test_evaluation.py
```

`reports/`は秘密を含まない派生結果。全モデル入出力・API応答原本・dump・cookie・個人環境は`.local/s21/`に保存しGit対象外。派生結果はモデルの出力再生や製品の分岐には使わない。生成された下書きの利用者レビューは別工程であり、実行器の文書承認を品質承認として記録しない。

実行条件はOllama公式の[generate API](https://docs.ollama.com/api/generate)の`keep_alive`と時間/token項目、[running models API](https://docs.ollama.com/api/ps)のresident確認を参考にした。rolling文書を2026-10-31確認。新しいコード・モデルのコピーはない。

S21後続の比較・不採用候補・原文保全の回帰結果は[別報告](reports/quality-v2/report.md)。初回基準線は保存し、Radarの改善達成やユーザーレビュー完了とは扱わない。
