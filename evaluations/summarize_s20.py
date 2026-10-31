"""S20診断の生ログから、秘密を含まない比較値を抽出する。"""

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from score import digest, project, source_audit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    raw_summary = json.loads((args.input / "summary.json").read_text(encoding="utf-8"))
    rows = [
        json.loads(line)
        for line in (args.input / "records.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    raw = [
        json.loads(line)
        for line in (args.input / "ollama.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    results = []
    for r in raw_summary["results"]:
        results.append(
            {
                **{k: r[k] for k in ["phase", "repeat", "summary", "elapsed_ms"]},
                "unknown_errors": dict(
                    Counter(
                        j.get("error_code", "MODEL_UNKNOWN")
                        for j in r["judgments"].values()
                        if j["status"] == "unknown"
                    )
                ),
                "judgments": {
                    tid: {
                        k: j.get(k)
                        for k in [
                            "status",
                            "rationale",
                            "missing_information",
                            "error_code",
                            "trace",
                        ]
                    }
                    for tid, j in r["judgments"].items()
                },
            }
        )
    variants = defaultdict(set)
    for record in raw:
        if record["path"] != "/api/generate" or record["context"].get("phase") not in {
            "s20_before",
            "s20_after",
        }:
            continue
        body = record.get("request") or {}
        prompt = body.get("prompt", "").split("\n前回の形式・出典・引用を修正してください。")[0]
        try:
            payload = json.loads(prompt.split("\n資料JSON:\n", 1)[1])
        except (IndexError, json.JSONDecodeError):
            continue
        variants[(record["context"]["phase"], payload["ticket"]["id"])].add(
            digest({"prompt": prompt, "schema": body.get("format"), "options": body.get("options")})
        )
    drafts = [r for r in rows if r["task"] == "draft"]
    summary = {
        **{k: raw_summary[k] for k in ["scope", "manifest_hash", "search_profile"]},
        "parameters": raw_summary["run"]["parameters"],
        "candidate": {
            k: raw_summary["candidate"][k]
            for k in ["id", "ticket_ids", "minimum_similarity", "overlap"]
        },
        "results": results,
        "transmitted_source_audit": source_audit(rows, raw),
        "input_variants": [
            {"phase": p, "ticket": tid, "hashes": sorted(hashes), "n": len(hashes)}
            for (p, tid), hashes in variants.items()
        ],
        "drafts": {
            "attempts": [
                {
                    "repeat": r["repeat"],
                    "status": r["status"],
                    "result_hash": digest(r["value"].get("result")),
                    "trace": r["value"].get("trace"),
                }
                for r in drafts
            ],
            "first_result_for_comparison": next(
                (r["value"]["result"] for r in drafts if r["status"] == 200), None
            ),
            "human_review": "pending",
        },
        "setup_failure": "最初の診断準備は評価resetのsingleton復元漏れで停止。品質試行前。"
        "修正後に新規出力先で実行。",
        "product_head": "044cc692df9527a0fb99c1368b5c2fd1a04dc5c3",
    }
    for name, value in [("summary", summary), ("attempts", [project(r, {}) for r in rows])]:
        (args.output / f"{name}.json").write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
    print([(r["phase"], r["repeat"], r["summary"]) for r in results])


if __name__ == "__main__":
    main()
