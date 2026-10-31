# 後続比較の再現

リポジトリルートのPowerShell、Docker、既存Ollama/固定モデルを使う。条件は[初回基準線](../baseline-v1/report.md)。resetは評価専用DBだけを対象とする。既存評価結果が必要なら先にdumpを保存する。

不採用版は現在の製品と異なるため保存patchから復元する。

```powershell
git worktree add --detach .local/s21-quality/baseline-source ad49f2437977f4726a6bea40f4639cbbd820afc9
docker build --target test -t solveloop-evaluation:baseline-ad49f24 .local/s21-quality/baseline-source/backend
git worktree add --detach .local/s21-quality/candidate-source ad49f2437977f4726a6bea40f4639cbbd820afc9
git -C .local/s21-quality/candidate-source apply "$PWD/evaluations/quality-v2-candidate.patch"
docker build --target test -t solveloop-evaluation:quality .local/s21-quality/candidate-source/backend
$compose = @('-p','solveloop-evaluation','-f','infrastructure/compose.evaluation.yaml','-f','infrastructure/compose.evaluation-quality.yaml')
$env:SOLVELOOP_QUALITY_IMAGE = 'solveloop-evaluation:baseline-ad49f24'
docker compose @compose up -d --wait eval-db
docker compose @compose run --rm eval alembic upgrade head
docker compose @compose run --rm eval python /evaluation/run.py reset --confirm solveloop-evaluation/solveloop_evaluation
docker compose @compose run --rm eval python /evaluation/quality.py prepare --split holdout --output /results/reproduce-instance
docker compose @compose run --rm -e EVALUATION_HEAD=ad49f2437977f4726a6bea40f4639cbbd820afc9 eval python /evaluation/quality.py run --split holdout --label baseline --output /results/reproduce-baseline
$env:SOLVELOOP_QUALITY_IMAGE = 'solveloop-evaluation:quality'
docker compose @compose run --rm -e EVALUATION_HEAD=ad49f2437977f4726a6bea40f4639cbbd820afc9 eval python /evaluation/quality.py run --split holdout --label quality --output /results/reproduce-candidate
$env:PYTHONPATH = 'backend'
backend/.venv/Scripts/python.exe evaluations/quality.py score --split holdout --label baseline --input .local/s21-quality/reproduce-baseline --output .local/s21-quality/reproduce-baseline-derived
backend/.venv/Scripts/python.exe evaluations/quality.py score --split holdout --label quality --input .local/s21-quality/reproduce-candidate --output .local/s21-quality/reproduce-candidate-derived
backend/.venv/Scripts/python.exe evaluations/quality_compare.py --baseline .local/s21-quality/reproduce-baseline-derived --quality .local/s21-quality/reproduce-candidate-derived --output .local/s21-quality/reproduce-comparison.json
backend/.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider evaluations/test_evaluation.py evaluations/test_quality.py
```

途中でreset・再準備しない。今回の原本ディレクトリはholdout-baseline / holdout-quality。校正はsplit=calibrationで別reset・出力先calibration-quality / calibration-quality-v2 / calibration-finalを使った。patchは最終候補だけを復元する。モデル出力は非決定的で同じ値を保証しない。

採用する原文保全だけの検査は現在のbackendで別imageを使う。既に使用済みの資料による回帰である。固定出力先にrecordsがあると上書きを拒否するため新しい結果マウントを使う。

```powershell
docker build --target test -t solveloop-evaluation:retention backend
$env:SOLVELOOP_QUALITY_IMAGE = 'solveloop-evaluation:retention'
docker compose @compose run --rm --volume "$PWD/.local/s21-quality/reproduce-retention:/results" eval python /evaluation/check_retention.py
docker compose @compose stop eval-db
Remove-Item Env:SOLVELOOP_QUALITY_IMAGE
```

最終backend回帰は別の一時PostgreSQL（DB/user=solveloop_test、data=tmpfs）を作り、retention imageからRUN_DB_TESTS=1で`pytest -q -p no:cacheprovider`を実行した。原本・デモ・評価DBをテストDBとして使用しない。339 passed / 13 skipped、ログはGit対象外に保存した。
