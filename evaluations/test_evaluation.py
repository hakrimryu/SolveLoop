import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from score import (  # noqa: E402
    classification,
    group_scores,
    pair_scores,
    percentile,
    question_scores,
    radar_scores,
    read,
    source_audit,
)


def test_fixed_denominators_include_missing_and_errors():
    q = [
        dict(
            id="H",
            split="holdout",
            department="IT",
            relevant=["doc"],
            answer="insufficient_evidence",
            attack=True,
        )
    ]
    score = question_scores([], q, {"doc": "uuid"}, "holdout", range(1, 4))
    assert score["classification"]["n"] == 3
    assert score["classification"]["macro_f1"] == 0
    assert score["search"] == {"n": 3, "hits": 0, "recall_at_5": 0}
    assert score["insufficient"] == {"n": 3, "correct": 0, "rate": 0}
    assert score["sources"]["rate"] is None
    assert sum(score["errors"].values()) == 9
    assert classification([("IT", "ERROR"), ("HR", "HR")])["classes"]["IT"]["fn"] == 1


def test_overlap_is_counted_once_and_false_cross_pairs_remain():
    gold = [{"a", "b", "c"}, {"d", "e", "f"}]
    scored = pair_scores([{"a", "b", "c"}, {"a", "b", "c"}, {"c", "d"}], gold)
    assert scored["tp"] == 3 and scored["fp"] == 1 and scored["fn"] == 3
    assert scored["precision"] == 0.75 and scored["recall"] == 0.5
    assert pair_scores([], gold)["recall"] == 0
    assert pair_scores([], gold)["precision"] is None
    assert group_scores([{"a", "b", "c"}, {"a", "b", "c"}], gold)["matched"] == 1
    assert group_scores([{"a", "b", "c", "x"}], gold)["matched"] == 0
    assert percentile([1, 2, 30], 0.95) == 30


def test_dataset_split_and_provenance():
    questions, radar, drafts = read("questions"), read("radar"), read("drafts")
    assert len(questions) == 40 and len([q for q in questions if q["split"] == "holdout"]) == 32
    assert len(drafts) == 10 and len(radar) == 40
    all_ids = [q["id"] for q in questions + radar] + [s["id"] for d in drafts for s in d["sources"]]
    assert len(set(all_ids)) == len(all_ids)
    assert len({q["body"] for q in questions}) == 40
    for split in ["calibration", "holdout"]:
        subset = [q for q in questions if q["split"] == split]
        assert {q["department"] for q in subset if q["department"]} == {
            "IT",
            "HR",
            "GENERAL",
            "ACCOUNTING",
        }
    assert {d for q in questions if q["split"] == "calibration" for d in q["relevant"]}.isdisjoint(
        {d for q in questions if q["split"] == "holdout" for d in q["relevant"]}
    )
    repo = Path(__file__).resolve().parents[1]
    if (repo / "demo").exists():
        seed = json.loads((repo / "demo/tickets/tickets.json").read_text(encoding="utf-8"))
        old = {t["body"] for t in seed["tickets"]}
        assert not old & {t["body"] for t in questions + radar}
    for d in drafts:
        text = "\n".join(s["resolution"] for s in d["sources"])
        assert all(step in text for step in d["required_steps"] + d["required_cautions"])


def test_missing_radar_is_not_removed_from_gold_denominator():
    scored = radar_scores([], read("radar"), "holdout", 1, "baseline")
    assert scored["gold_ticket_coverage"]["n"] == 20
    assert scored["gold_ticket_coverage"]["counts"] == {"undetected": 20}
    assert scored["problem_groups"]["gold"] == 4
    assert scored["problem_groups"]["recall"] == 0
    assert scored["gap"]["gold"] == 2 and scored["gap"]["recall"] == 0


def test_runtime_has_no_gold_reader():
    repo = Path(__file__).resolve().parents[1]
    backend = repo / "backend" / "app"
    if not backend.exists():
        backend = Path("/app/app")
    for path in backend.rglob("*.py"):
        code = path.read_text(encoding="utf-8")
        assert "evaluations/datasets" not in code
        assert "qr-after" not in code and "RQR" not in code


def test_environment_guard_rejects_original_and_demo_before_connecting(monkeypatch):
    repo = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repo / "backend" if (repo / "backend").exists() else Path("/app")))
    from run import guard, reset

    monkeypatch.setenv("SOLVELOOP_EVALUATION", "s21-v1")
    monkeypatch.setenv("POSTGRES_PASSWORD", "synthetic-test")
    for host, name in [("db", "solveloop"), ("demo-db", "solveloop_demo")]:
        monkeypatch.setenv("DB_HOST", host)
        monkeypatch.setenv("POSTGRES_DB", name)
        monkeypatch.setenv("POSTGRES_USER", name)
        with pytest.raises(ValueError, match="評価専用環境"):
            guard(None)
    with pytest.raises(ValueError, match="明示確認"):
        reset(None, None)


def test_source_audit_rejects_forged_ids_and_nonliteral_quotes():
    context = {"phase": "baseline", "split": "holdout", "repeat": 1}
    payload = {"ticket": {"id": "tid"}, "sources": [{"id": "cid", "text": "操作の原文。"}]}
    raw = [
        {
            "path": "/api/generate",
            "context": context,
            "request": {"prompt": "\n資料JSON:\n" + json.dumps(payload)},
        }
    ]
    answer = {
        **context,
        "status": 200,
        "task": "answer",
        "case": "Q",
        "value": {"ticket_id": "tid", "result": {"steps": [{"citation_ids": ["cid", "forged"]}]}},
    }
    coverage = {
        **context,
        "status": 200,
        "task": "coverage_batch",
        "case": "C",
        "value": {
            "id": "coverage",
            "judgments": {
                "tid": {
                    "citations": [
                        {"chunk_id": "cid", "quote": "原文"},
                        {"chunk_id": "cid", "quote": "作り話"},
                    ]
                }
            },
        },
    }
    scored = source_audit([answer, coverage, coverage], raw)
    assert scored["uses"] == 4 and scored["valid"] == 2
    assert len(scored["invalid"]) == 2
