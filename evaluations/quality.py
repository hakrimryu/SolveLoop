"""固定した別資料で旧版と品質修正版の実処理を比較する。"""

import argparse
import hashlib
import json
import os
import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from run import ROOT, Evaluation, add_tickets, ident
from score import project, radar_scores, source_audit
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.config import AISettings
from app.ai.drafts import PROMPT_VERSION as DRAFT_PROMPT
from app.ai.knowledge import fingerprint
from app.ai.ollama import OllamaClient
from app.ai.radar import PROMPT_VERSION as RADAR_PROMPT
from app.knowledge_search import activate, backfill
from app.models import Ticket, User
from app.radar import corpus, snapshot
from app.seed import seed_auth


def write(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


def dataset():
    manifest = json.loads((ROOT / "quality-v2-manifest.json").read_text(encoding="utf-8"))
    for name, expected in manifest["files"].items():
        if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
            raise ValueError("凍結した品質評価資料のhashが一致しません。")
    return json.loads((ROOT / "datasets/quality-v2.json").read_text(encoding="utf-8"))


def product_hashes():
    return {
        str(p.relative_to("/app")): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(Path("/app/app").rglob("*.py"))
    }


def state(e):
    with Session(e.engine) as s:
        return {
            "corpus_hash": corpus(s)[0],
            "ticket_hash": fingerprint(
                [snapshot(t) for t in s.scalars(select(Ticket).order_by(Ticket.id))]
            ),
        }


def prepare(args, data):
    e = Evaluation(args.output)
    with Session(e.engine) as s:
        if s.scalar(select(Ticket.id).limit(1)) or s.scalar(select(User.id).limit(1)):
            raise ValueError("評価DBだけを明示resetしてから準備してください。")
    with Session(e.engine) as s, s.begin():
        seed_auth(s)
    radar = [t for t in data["radar"] if t["split"] == args.split]
    drafts = [d for d in data["drafts"] if d["split"] == args.split]
    if args.split == "holdout":
        drafts += data.get("regression_drafts", [])
    add_tickets(e.engine, radar)
    add_tickets(e.engine, [s for d in drafts for s in d["sources"]], draft=True)
    backfill(e.engine, OllamaClient(AISettings()))
    activate(e.engine)
    e.login()
    for doc in data["documents"]:
        if doc["split"] == args.split:
            e.publish(doc)
    write(
        args.output / "instance.json", {**state(e), "documents": e.documents, "split": args.split}
    )
    e.client.close()
    e.employee.close()
    e.app.state.engine.dispose()
    e.engine.dispose()


def run(args, data):
    if (args.output / "records.jsonl").exists():
        raise ValueError("試行結果は上書きできません。")
    e = Evaluation(args.output)
    manifest = json.loads((ROOT / "quality-v2-manifest.json").read_text(encoding="utf-8"))
    hashes = product_hashes()
    if (
        args.split == "holdout"
        and args.label == "quality"
        and hashes != manifest.get("quality_product_files")
    ):
        raise ValueError("保留実行は校正後に凍結した製品コードだけを使います。")
    start = state(e)
    metadata = {
        **start,
        "label": args.label,
        "split": args.split,
        "started_at": datetime.now(UTC).isoformat(),
        "product_parent_head": os.getenv("EVALUATION_HEAD"),
        "product_files": hashes,
        "dataset_hash": hashlib.sha256(
            (ROOT / "datasets/quality-v2.json").read_bytes()
        ).hexdigest(),
        "draft_prompt": DRAFT_PROMPT,
        "radar_prompt": RADAR_PROMPT,
        "repeats": 3,
        "threshold": 0.92,
        "transport": "ASGI + real PostgreSQL + real Ollama HTTP",
        "models": OllamaClient(AISettings())._request("/api/tags"),
        "human_review": "pending",
    }
    write(args.output / "metadata.json", metadata)
    e.login()
    drafts = [d for d in data["drafts"] if d["split"] == args.split]
    if args.split == "holdout":
        drafts += data.get("regression_drafts", [])

    def observe(client, *pos, **kw):
        return e.observe(client, *pos, **kw)

    with patch.object(OllamaClient, "_request", observe):
        for repeat in range(1, 4):
            row = e.detect(args.split, repeat, "baseline")
            if row["status"] == 200:
                for group in row["value"]["candidates"]:
                    e.coverage(args.split, repeat, "baseline", row["value"], group)
            for draft in drafts:
                e.record(
                    draft["id"],
                    args.split,
                    "draft",
                    repeat,
                    lambda draft=draft: e.call(
                        "/knowledge/generations",
                        {
                            "source_refs": [
                                {"ticket_id": str(ident(s["id"])), "expected_ticket_version": 4}
                                for s in draft["sources"]
                            ]
                        },
                    ),
                    "regression" if draft.get("split") == "regression" else "baseline",
                )
    if state(e) != start:
        raise ValueError("比較中に問い合わせまたは公開文書が変わりました。")
    e.client.close()
    e.employee.close()
    e.app.state.engine.dispose()
    e.engine.dispose()


def contains(fragment, texts):
    core = fragment.rstrip("。！？").strip()
    return bool(core) and any(core in text for text in texts)


def score(args, data):
    rows = [
        json.loads(x)
        for x in (args.input / "records.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    raw = [
        json.loads(x)
        for x in (args.input / "ollama.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    lookup = {(r["case"], r["repeat"]): r for r in rows if r["task"] == "draft"}
    caution_n = caution_ok = step_n = step_ok = unit_n = unit_ok = success = 0
    review = []
    selected = [d for d in data["drafts"] if d["split"] == args.split]
    if args.split == "holdout":
        selected += data.get("regression_drafts", [])
    for spec in selected:
        attempts = []
        for repeat in range(1, 4):
            row = lookup.get((spec["id"], repeat), {"status": 0, "value": {"code": "MISSING"}})
            value = row["value"] if row["status"] == 200 else {}
            result = value.get("result", {})
            body = value.get("draft", {}).get("body", "")
            units = set(
                u.strip()
                for s in spec["sources"]
                for u in re.split(r"(?<=[。！？])|\n", s["resolution"])
                if u.strip()
            )
            if spec.get("split") != "regression":
                success += row["status"] == 200
                caution_n += len(spec["required_cautions"])
                caution_ok += sum(
                    contains(c, result.get("cautions", [])) for c in spec["required_cautions"]
                )
                step_n += len(spec["required_step_groups"])
                step_ok += sum(
                    any(contains(c, result.get("steps", [])) for c in g)
                    for g in spec["required_step_groups"]
                )
                unit_n += len(units)
                unit_ok += sum(contains(u, [body]) for u in units)
            attempts.append(
                {
                    "repeat": repeat,
                    "status": row["status"],
                    "error_code": value.get("code"),
                    "result": result or None,
                    "draft": value.get("draft"),
                    "trace": value.get("trace"),
                    "source_units": len(units),
                    "retained_units": sum(contains(u, [body]) for u in units),
                }
            )
        review.append(
            {
                "id": spec["id"],
                "scope": spec["split"],
                "sources": spec["sources"],
                "attempts": attempts,
                "human_review": {
                    "status": "pending",
                    "reviewer": None,
                    "procedure": None,
                    "conditions": None,
                    "revision_required": None,
                },
            }
        )
    summary = {
        "label": args.label,
        "split": args.split,
        "radar": [
            radar_scores(rows, data["radar"], args.split, i, "baseline") for i in range(1, 4)
        ],
        "drafts": {
            "planned": len([d for d in selected if d.get("split") != "regression"]) * 3,
            "success": success,
            "failure_or_missing": len([d for d in selected if d.get("split") != "regression"]) * 3
            - success,
            "caution_atoms": {"correct": caution_ok, "n": caution_n},
            "step_atoms": {"correct": step_ok, "n": step_n},
            "body_source_retention": {"correct": unit_ok, "n": unit_n},
            "human_review": "pending",
        },
        "errors": dict(
            Counter(r["value"].get("code", "HTTP_ERROR") for r in rows if r["status"] != 200)
        ),
        "source_audit": source_audit(rows, raw),
        "operational_failures": [
            {k: r.get(k) for k in ["context", "path", "elapsed_ms", "error_code"]}
            for r in raw
            if r.get("error_code")
        ],
    }
    write(args.output / "summary.json", summary)
    write(args.output / "draft-review.json", review)
    write(args.output / "attempts.json", [project(r, {}) for r in rows])
    write(
        args.output / "metadata.json",
        json.loads((args.input / "metadata.json").read_text(encoding="utf-8")),
    )
    print(json.dumps(summary["drafts"], ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "run", "score"])
    parser.add_argument("--split", choices=["calibration", "holdout"], required=True)
    parser.add_argument("--label", choices=["baseline", "quality"], default="quality")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--input", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    data = dataset()
    {"prepare": prepare, "run": run, "score": score}[args.command](args, data)


if __name__ == "__main__":
    main()
