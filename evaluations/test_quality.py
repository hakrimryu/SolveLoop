import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent
repo = ROOT.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(repo / "backend" if (repo / "backend").exists() else Path("/app")))

from quality import dataset, score  # noqa: E402


def test_prospective_split_is_frozen_and_regression_is_separate():
    data = dataset()
    manifest = json.loads((ROOT / "quality-v2-manifest.json").read_text(encoding="utf-8"))
    assert (
        hashlib.sha256((ROOT / "datasets/quality-v2.json").read_bytes()).hexdigest()
        == manifest["files"]["datasets/quality-v2.json"]
    )
    hold = [t for t in data["radar"] if t["split"] == "holdout"]
    cal = [t for t in data["radar"] if t["split"] == "calibration"]
    assert len(hold) == 40 and len(cal) == 10
    assert len({t["group"] for t in hold if t["group"]}) == 6
    assert {t["group"] for t in hold if t["group"]}.isdisjoint({t["group"] for t in cal})
    assert len([d for d in data["drafts"] if d["split"] == "holdout"]) == 10
    assert all(d["split"] == "regression" for d in data["regression_drafts"])
    old = read_json(ROOT / "datasets/questions.json") + read_json(ROOT / "datasets/radar.json")
    assert not {t["body"] for t in old} & {t["body"] for t in hold}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_missing_attempts_keep_all_draft_and_radar_denominators(tmp_path):
    source = tmp_path / "input"
    source.mkdir()
    for file in ["records.jsonl", "ollama.jsonl"]:
        (source / file).write_text("", encoding="utf-8")
    (source / "metadata.json").write_text("{}", encoding="utf-8")
    out = tmp_path / "output"
    out.mkdir()
    data = dataset()
    score(SimpleNamespace(input=source, output=out, split="holdout", label="quality"), data)
    result = read_json(out / "summary.json")
    assert result["drafts"]["planned"] == 30 and result["drafts"]["success"] == 0
    assert result["drafts"]["failure_or_missing"] == 30
    assert (
        result["drafts"]["caution_atoms"]["n"]
        == sum(len(d["required_cautions"]) for d in data["drafts"] if d["split"] == "holdout") * 3
    )
    assert result["drafts"]["body_source_retention"]["correct"] == 0
    assert all(r["gold_ticket_coverage"]["n"] == 30 for r in result["radar"])
    assert all(r["gold_ticket_coverage"]["counts"] == {"undetected": 30} for r in result["radar"])
    packet = read_json(out / "draft-review.json")
    assert all(d["human_review"]["status"] == "pending" for d in packet)
