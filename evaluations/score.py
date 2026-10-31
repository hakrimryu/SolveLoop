"""正解を製品へ渡さず、失敗・欠測を固定分母に残して集計する。"""

import argparse
import hashlib
import json
import math
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

ROOT = Path(__file__).resolve().parent
LABELS = ["IT", "HR", "GENERAL", "ACCOUNTING"]
REPEATS = 3


def digest(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def ident(case):
    return str(uuid5(NAMESPACE_URL, "https://example.com/solveloop/evaluation/s21/" + case))


def read(name):
    return json.loads((ROOT / "datasets" / f"{name}.json").read_text(encoding="utf-8"))


def ratio(n, d):
    return n / d if d else None


def percentile(values, p):
    return sorted(values)[max(0, math.ceil(p * len(values)) - 1)] if values else None


def classification(pairs):
    matrix = {
        label: dict(Counter(pred for gold, pred in pairs if gold == label)) for label in LABELS
    }
    scores = {}
    for label in LABELS:
        tp = sum(gold == pred == label for gold, pred in pairs)
        fp = sum(gold != label and pred == label for gold, pred in pairs)
        fn = sum(gold == label and pred != label for gold, pred in pairs)
        scores[label] = {"tp": tp, "fp": fp, "fn": fn, "f1": ratio(2 * tp, 2 * tp + fp + fn) or 0}
    return {
        "n": len(pairs),
        "macro_f1": sum(s["f1"] for s in scores.values()) / 4,
        "confusion": matrix,
        "classes": scores,
    }


def pair_scores(predictions, gold):
    expected = set().union(*(set(combinations(sorted(g), 2)) for g in gold))
    actual = set().union(*(set(combinations(sorted(g), 2)) for g in predictions))
    tp = len(actual & expected)
    return {
        "tp": tp,
        "fp": len(actual - expected),
        "fn": len(expected - actual),
        "predicted": len(actual),
        "gold": len(expected),
        "precision": ratio(tp, len(actual)),
        "recall": ratio(tp, len(expected)),
    }


def match_groups(predictions, gold):
    predictions = list(dict.fromkeys(tuple(sorted(p)) for p in predictions))
    edges = {
        g: [
            p
            for p, members in enumerate(predictions)
            if len(set(members) & set(group)) / len(set(members) | set(group)) >= 0.8
        ]
        for g, group in enumerate(gold)
    }
    matched = {}

    def visit(g, seen):
        for p in edges[g]:
            if p in seen:
                continue
            seen.add(p)
            if p not in matched or visit(matched[p], seen):
                matched[p] = g
                return True
        return False

    for g in edges:
        visit(g, set())
    return predictions, matched


def group_scores(predictions, gold):
    predictions, matched = match_groups(predictions, gold)
    return {
        "matched": len(matched),
        "predicted": len(predictions),
        "gold": len(gold),
        "precision": ratio(len(matched), len(predictions)),
        "recall": ratio(len(matched), len(gold)),
    }


def outcomes(row, document_names):
    if row["status"] != 200:
        return {"error": row.get("value", {}).get("code", "HTTP_ERROR")}
    value, task = row["value"], row["task"]
    if task == "classification":
        return value["result"]
    if task == "search":
        return {
            "documents": list(
                dict.fromkeys(
                    document_names.get(i["document_id"], i["document_id"]) for i in value["items"]
                )
            )
        }
    if task == "answer":
        result = json.loads(json.dumps(value["result"]))
        source_names = {
            s["id"]: document_names.get(s.get("document_id"), s.get("number"))
            for s in value["sources"]
        }
        for step in result["steps"]:
            step["citation_ids"] = [source_names.get(cid, cid) for cid in step["citation_ids"]]
        return result
    if task == "draft":
        return value["result"]
    return value


def project(row, document_names):
    value = row["value"] or {}
    result = value.get("result", {})
    trace = value.get("generation") or value.get("trace") or {}
    content = (
        outcomes(row, document_names)
        if row["task"] in {"classification", "search", "answer", "draft"}
        else None
    )
    calls = row.get("calls", [])
    return {
        **{
            k: row[k]
            for k in (
                "case",
                "split",
                "task",
                "repeat",
                "phase",
                "status",
                "started_at",
                "elapsed_ms",
            )
        },
        "error_code": value.get("code"),
        "status_label": result.get("status"),
        "department": result.get("department_code"),
        "needs_review": result.get("needs_review"),
        "documents": content.get("documents") if content else None,
        "output_hash": digest(content) if content else None,
        "decision": result.get("department_code")
        if row["task"] == "classification"
        else sorted(content.get("documents", []))
        if row["task"] == "search" and content
        else result.get("status"),
        "trace": trace,
        "prompt_version": value.get("prompt_version", trace.get("prompt_version")),
        "profile_id": value.get("profile_id", value.get("search_profile_id")),
        "input_hash": trace.get("input_hash"),
        "source_checks": value.get("evaluation_source_checks"),
        "ollama_calls": calls,
        "internal_generate_calls": sum(c["path"] == "/api/generate" for c in calls),
        "internal_embed_calls": sum(c["path"] == "/api/embed" for c in calls),
        "summary": value.get("summary") if row["task"].startswith("coverage") else None,
        "judgments": {
            ticket: {
                "status": j["status"],
                "error_code": j.get("error_code"),
                "trace": j.get("trace"),
                "rationale": j.get("rationale"),
                "missing_information": j.get("missing_information"),
                "citations": [
                    {
                        "document": document_names.get(c["document_id"], c["document_id"]),
                        "quote": c["quote"],
                    }
                    for c in j.get("citations", [])
                ],
            }
            for ticket, j in value.get("judgments", {}).items()
        },
        "candidates": [
            {k: c[k] for k in ("id", "ticket_ids", "minimum_similarity", "overlap")}
            for c in value.get("candidates", [])
        ],
    }


def question_scores(rows, questions, documents, split, repeats):
    selected = [q for q in questions if q["split"] == split]
    lookup = {(r["case"], r["task"], r["repeat"]): r for r in rows if r["phase"] == "baseline"}
    pairs, ambiguous, recalls, insufficient, attacks, answered, errors = (
        [],
        [],
        [],
        [],
        [],
        [],
        Counter(),
    )
    source_uses = valid_uses = 0
    for q in selected:
        for repeat in repeats:

            def get(task, q=q, repeat=repeat):
                row = lookup.get(
                    (q["id"], task, repeat), {"status": 0, "value": {"code": "MISSING"}}
                )
                if row["status"] != 200:
                    errors[task + ":" + row["value"].get("code", "HTTP_ERROR")] += 1
                return row

            c, search, answer = get("classification"), get("search"), get("answer")
            value = c["value"].get("result", {}) if c["status"] == 200 else {}
            pred = value.get("department_code") if c["status"] == 200 else "ERROR"
            if q["department"] is None:
                ambiguous.append(pred is None and value.get("needs_review") is True)
            else:
                pairs.append((q["department"], "NULL" if pred is None else pred))
            if q["relevant"]:
                found = (
                    {i["document_id"] for i in search["value"].get("items", [])}
                    if search["status"] == 200
                    else set()
                )
                recalls.append(
                    sum(documents.get(d) in found for d in q["relevant"]) / len(q["relevant"])
                )
            result = answer["value"].get("result", {}) if answer["status"] == 200 else {}
            correct = result.get("status") == q["answer"]
            if q["answer"] == "insufficient_evidence":
                insufficient.append(correct)
                if q["attack"]:
                    attacks.append(correct)
            else:
                answered.append(correct)
            checks = answer["value"].get("evaluation_source_checks", {})
            source_uses += checks.get("uses", 0)
            valid_uses += checks.get("valid_uses", 0)
    return {
        "classification": classification(pairs),
        "ambiguous": {
            "n": len(ambiguous),
            "correct": sum(ambiguous),
            "rate": ratio(sum(ambiguous), len(ambiguous)),
        },
        "search": {
            "n": len(recalls),
            "hits": sum(recalls),
            "recall_at_5": ratio(sum(recalls), len(recalls)),
        },
        "insufficient": {
            "n": len(insufficient),
            "correct": sum(insufficient),
            "rate": ratio(sum(insufficient), len(insufficient)),
        },
        "attack_insufficient": {
            "n": len(attacks),
            "correct": sum(attacks),
            "rate": ratio(sum(attacks), len(attacks)),
        },
        "answerable_status": {
            "n": len(answered),
            "correct": sum(answered),
            "rate": ratio(sum(answered), len(answered)),
        },
        "sources": {
            "uses": source_uses,
            "valid": valid_uses,
            "rate": ratio(valid_uses, source_uses),
        },
        "errors": dict(errors),
    }


def source_audit(rows, raw):
    transmitted = defaultdict(list)
    for record in raw:
        body = record.get("request") or {}
        prompt = body.get("prompt", "")
        if record["path"] != "/api/generate" or "\n資料JSON:\n" not in prompt:
            continue
        payload_text = prompt.split("\n資料JSON:\n", 1)[1]
        try:
            payload = json.loads(payload_text)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict) or "ticket" not in payload:
            continue
        context = record["context"]
        key = (
            context.get("phase"),
            context.get("split"),
            context.get("repeat"),
            payload["ticket"]["id"],
        )
        transmitted[key].extend(payload.get("sources", []))
    uses = []
    for row in rows:
        if row["status"] != 200:
            continue
        value = row["value"]
        key = (row["phase"], row["split"], row["repeat"], value.get("ticket_id"))
        if row["task"] == "answer":
            allowed = {s["id"] for s in transmitted[key]}
            for step_index, step in enumerate(value["result"]["steps"]):
                for cid in step["citation_ids"]:
                    uses.append(
                        {
                            "scope": "answer",
                            "case": row["case"],
                            "repeat": row["repeat"],
                            "phase": row["phase"],
                            "step": step_index,
                            "source": cid,
                            "valid": cid in allowed,
                        }
                    )
        if row["task"] == "coverage_batch":
            for tid, judgment in value.get("judgments", {}).items():
                key = (row["phase"], row["split"], row["repeat"], tid)
                for citation in judgment.get("citations", []):
                    valid = any(
                        s["id"] == citation["chunk_id"] and citation["quote"] in s["text"]
                        for s in transmitted[key]
                    )
                    uses.append(
                        {
                            "scope": "radar",
                            "case": row["case"],
                            "ticket": tid,
                            "phase": row["phase"],
                            "repeat": row["repeat"],
                            "coverage_id": value["id"],
                            "chunk": citation["chunk_id"],
                            "quote": citation["quote"],
                            "valid": valid,
                        }
                    )
    unique = {digest({k: v for k, v in use.items() if k != "valid"}): use for use in uses}
    values = list(unique.values())
    return {
        "uses": len(values),
        "valid": sum(v["valid"] for v in values),
        "invalid": [v for v in values if not v["valid"]],
        "note": "Radar累積応答内の同一coverage/ticket/chunk/quoteを重複計上しない。",
    }


def radar_scores(rows, radar, split, repeat, phase):
    targets = [t for t in radar if t["split"] == split]
    groups = defaultdict(set)
    statuses = {}
    for t in targets:
        if t["group"]:
            groups[t["group"]].add(ident(t["id"]))
            statuses[t["group"]] = (
                "covered"
                if t["coverage"] == "covered" or (phase == "after" and split == "holdout")
                else "gap"
            )
    selected = [
        r for r in rows if r["split"] == split and r["repeat"] == repeat and r["phase"] == phase
    ]
    detect = next((r for r in selected if r["task"] == "detect"), None)
    candidates = detect["value"].get("candidates", []) if detect and detect["status"] == 200 else []
    predictions = [c["ticket_ids"] for c in candidates]
    unique, matched = match_groups(predictions, list(groups.values()))
    latest = {}
    for row in selected:
        if row["task"] in {"coverage_start", "coverage_batch"} and row["status"] == 200:
            latest[row["case"]] = row["value"]
    members_to_id = {tuple(sorted(c["ticket_ids"])): c["id"] for c in candidates}
    judgments = {members_to_id[m]: latest.get(members_to_id[m], {}) for m in unique}
    confusion = []
    for p, g in matched.items():
        name = list(groups)[g]
        value = judgments[members_to_id[unique[p]]]
        confusion.append(
            {
                "group": name,
                "gold": statuses[name],
                "predicted": value.get("summary", {}).get("gap_status", "unanalyzed"),
                "summary": value.get("summary"),
                "candidate": members_to_id[unique[p]],
            }
        )
    missing = [name for g, name in enumerate(groups) if g not in matched.values()]
    confusion += [
        {"group": name, "gold": statuses[name], "predicted": "undetected"} for name in missing
    ]
    known = Counter(j["status"] for v in latest.values() for j in v.get("judgments", {}).values())
    unknown_errors = Counter(
        j.get("error_code", "MODEL_UNKNOWN")
        for v in latest.values()
        for j in v.get("judgments", {}).values()
        if j["status"] == "unknown"
    )
    denominator = sum(len(c["ticket_ids"]) for c in candidates)
    predicted_gap = [
        c
        for c in candidates
        if latest.get(c["id"], {}).get("summary", {}).get("gap_status") == "gap"
    ]
    correct_gap = sum(v["gold"] == v["predicted"] == "gap" for v in confusion)
    ticket_predictions = []
    for g, (name, tickets) in enumerate(groups.items()):
        p = next((p for p, gold in matched.items() if gold == g), None)
        value = judgments[members_to_id[unique[p]]] if p is not None else {}
        expected = "covered" if statuses[name] == "covered" else "uncovered"
        for ticket in sorted(tickets):
            judgment = value.get("judgments", {}).get(ticket, {})
            predicted = judgment.get("status", "unanalyzed" if p is not None else "undetected")
            ticket_predictions.append(
                {
                    "ticket": ticket,
                    "group": name,
                    "gold": expected,
                    "predicted": predicted,
                    "error_code": judgment.get("error_code"),
                }
            )
    return {
        "split": split,
        "repeat": repeat,
        "phase": phase,
        "gold_status": "synthetic_author_label_assumes_post_document_audience_matches"
        if phase == "after"
        else "synthetic_author_label_not_independently_reviewed",
        "input_count": detect["value"].get("input_count") if detect else None,
        "detection_error": None
        if detect and detect["status"] == 200
        else (detect or {}).get("value"),
        "pairs": pair_scores(predictions, list(groups.values())),
        "problem_groups": group_scores(predictions, list(groups.values())),
        "coverage_occurrences": {
            "total": denominator,
            **dict(known),
            "unanalyzed": denominator - sum(known.values()),
            "unknown_errors": dict(unknown_errors),
        },
        "gap": {
            "tp": correct_gap,
            "predicted": len(predicted_gap),
            "gold": sum(v == "gap" for v in statuses.values()),
            "precision": ratio(correct_gap, len(predicted_gap)),
            "recall": ratio(correct_gap, sum(v == "gap" for v in statuses.values())),
        },
        "group_decisions": confusion,
        "gold_ticket_coverage": {
            "n": len(ticket_predictions),
            "correct": sum(t["gold"] == t["predicted"] for t in ticket_predictions),
            "counts": dict(Counter(t["predicted"] for t in ticket_predictions)),
            "decisions": ticket_predictions,
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "reports" / "baseline-v1")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    rows = [
        json.loads(line)
        for line in (args.input / "records.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    documents = json.loads((args.input / "documents.json").read_text(encoding="utf-8"))
    names = {v: k for k, v in documents.items()}
    projected = [project(r, names) for r in rows]
    summary = {
        "question_scores": {
            split: {
                "all": question_scores(rows, read("questions"), documents, split, range(1, 4)),
                "rounds": [
                    question_scores(rows, read("questions"), documents, split, [i])
                    for i in range(1, 4)
                ],
            }
            for split in ["calibration", "holdout"]
        },
        "radar": [
            radar_scores(rows, read("radar"), split, i, phase)
            for phase in ["baseline", "after"]
            for split in ["calibration", "holdout"]
            if phase != "after" or split == "holdout"
            for i in range(1, 4)
        ],
    }
    raw = [
        json.loads(line)
        for line in (args.input / "ollama.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    summary["transmitted_source_audit"] = source_audit(rows, raw)
    summary["operational_failures"] = [
        {k: record.get(k) for k in ("context", "path", "input_hash", "elapsed_ms", "error_code")}
        for record in raw
        if record.get("error_code")
    ]
    variations = []
    groups = defaultdict(list)
    for row in projected:
        if row["phase"] == "baseline" and row["task"] in {
            "classification",
            "search",
            "answer",
            "draft",
        }:
            groups[(row["case"], row["task"])].append(row)
    for (case, task), values in groups.items():
        variations.append(
            {
                "case": case,
                "task": task,
                "n": len(values),
                "output_variants": len({v["output_hash"] for v in values}),
                "decision_variants": len({digest((v["status"], v["decision"])) for v in values}),
            }
        )
    summary["variation"] = variations
    summary["latency"] = [
        {
            "phase": phase,
            "task": task,
            "n": len(v),
            "failures": sum(r["status"] != 200 for r in v),
            "p50_ms": percentile([r["elapsed_ms"] for r in v], 0.5),
            "p95_ms": percentile([r["elapsed_ms"] for r in v], 0.95),
            "success_p50_ms": percentile([r["elapsed_ms"] for r in v if r["status"] == 200], 0.5),
            "success_p95_ms": percentile([r["elapsed_ms"] for r in v if r["status"] == 200], 0.95),
            "failure_ms": [r["elapsed_ms"] for r in v if r["status"] != 200],
            "unknown_judgments": sum(
                j.get("status") == "unknown"
                for r in v
                for j in (r.get("value") or {}).get("judgments", {}).values()
            ),
        }
        for phase in ["cold", "warm"]
        for task in ["classification", "search", "answer", "draft", "radar_judgment"]
        for v in [[r for r in rows if r["phase"] == phase and r["task"] == task]]
    ]
    summary["drafts"] = {
        "planned": 30,
        "success": sum(
            r["status"] == 200 for r in rows if r["phase"] == "baseline" and r["task"] == "draft"
        ),
        "human_review": "pending",
        "analyst_review": "separate",
    }
    for name, value in [("summary", summary), ("attempts", projected)]:
        (args.output / f"{name}.json").write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
    metadata = json.loads((args.input / "metadata.json").read_text(encoding="utf-8"))
    (args.output / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(json.dumps(summary["question_scores"]["holdout"]["all"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
