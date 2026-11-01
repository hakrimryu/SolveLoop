[日本語](README.md) · [한국어](README.ko.md) · [English](README.en.md)

# Evaluation summary

[Project overview](../README.en.md)

The workflow and AI behavior were checked with the real API, PostgreSQL and local Ollama. These figures refer to each report's fixed synthetic inputs and measurement date. They do not measure ticket reduction or time savings in a real company.

## What was checked

The workflow covers employee questions, unresolved handoff, operator support/resolution, drafts, human approval and retrieval. Checks also cover permissions, stale-update rejection, duplicate creation and public-only search. Fixed-response tests are separate from live-model evaluation.

## Main results

| Evaluation | Inputs and observations | Interpretation |
| --- | --- | --- |
| Retrieval baseline | 20 questions with relevant documents ×3 runs; Recall@5 **60/60** | Retrieval quality, separate from answer correctness |
| Radar | **4/4** recurring groups detected in each of 3 runs; gap precision **5/8** | Recurrence detection and document coverage are different judgments |
| Employee guidance | 3 synthetic public documents, 8 questions; single-request processing **1.152–2.838 seconds** | API processing time, not employee resolution time |

Retrieval/Radar baseline measurements are from 2026-10-31; employee guidance is from 2026-11-01. Repeated runs of the same inputs are not independent samples.

## Outstanding work

- Of 2 concurrent employee requests in the later measurement, 1 failed with `AI_UNAVAILABLE`. Concurrent-use stability needs further verification.
- Applicability interpretation and draft caution extraction still have errors. Valid structure/citations do not establish sufficient content. Draft-quality review by actual users is incomplete.

## Evaluation data and reruns

- [Fixed inputs](datasets/), [baseline aggregates](reports/baseline-v1/summary.json), [employee-guidance measurements](reports/employee-guidance-v1/records.jsonl), and [concurrent requests](reports/employee-guidance-v1/concurrency.json)
- [Rejected candidate comparison](reports/quality-v2/comparison.json), [candidate patch](quality-v2-candidate.patch), and [fixed hashes](quality-v2-manifest.json)
- Frozen original protocols: [v1](frozen/protocol-v1.txt) and [v2](frozen/protocol-v2.txt). These source artifacts retain internal identifiers.

Live-model reruns must use the dedicated DB in [infrastructure/compose.evaluation.yaml](../infrastructure/compose.evaluation.yaml). Arguments are defined in the [runner](run.py), [comparison runner](quality.py), and [scorer](score.py). New evaluations prepare synthetic data and write to the DB; back up existing results and never target a DB in ordinary use. To inspect arguments only:

```powershell
docker compose -p solveloop-evaluation -f infrastructure/compose.evaluation.yaml run --build --rm --no-deps eval python /evaluation/run.py --help
```

Fixed-input and denominator checks are in [test_evaluation.py](test_evaluation.py) and [test_quality.py](test_quality.py). Historical comparison code is restored from `ad49f2437977f4726a6bea40f4639cbbd820afc9` and the saved patch. Rerunning current code is a separate measurement.
