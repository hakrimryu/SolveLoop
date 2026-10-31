"""採用する原文保全だけの変更を実API/実Ollamaで確認する。性能評価とは分ける。"""

import json
import re
from pathlib import Path
from unittest.mock import patch

from quality import dataset, product_hashes, state, write
from run import Evaluation, ident

from app.ai.drafts import PROMPT_VERSION, RENDERING_VERSION
from app.ai.ollama import OllamaClient


def main():
    output = Path("/results/retention-live")
    output.mkdir(parents=True, exist_ok=True)
    e = Evaluation(output)
    if e.records.exists():
        raise ValueError("確認結果は上書きできません。")
    data = dataset()
    selected = [d for d in data["drafts"] if d["split"] == "holdout"] + data["regression_drafts"]
    before = state(e)
    e.login()
    results = []

    def observe(client, *args, **kwargs):
        return e.observe(client, *args, **kwargs)

    with patch.object(OllamaClient, "_request", observe):
        for draft in selected:
            row = e.record(
                draft["id"],
                "regression",
                "draft",
                1,
                lambda draft=draft: e.call(
                    "/knowledge/generations",
                    {
                        "source_refs": [
                            {"ticket_id": str(ident(s["id"])), "expected_ticket_version": 4}
                            for s in draft["sources"]
                        ]
                    },
                ),
                "retention_live",
            )
            value = row["value"] if row["status"] == 200 else {}
            units = set(
                u.strip()
                for s in draft["sources"]
                for u in re.split(r"(?<=[。！？])|\n", s["resolution"])
                if u.strip()
            )
            body = value.get("draft", {}).get("body", "")
            retained = sum(u.rstrip("。！？") in body for u in units)
            results.append(
                {
                    "case": draft["id"],
                    "status": row["status"],
                    "error_code": value.get("code"),
                    "source_units": len(units),
                    "retained": retained,
                    "trace": value.get("trace"),
                    "result": value.get("result"),
                    "draft": value.get("draft"),
                }
            )
    after = state(e)
    summary = {
        "purpose": "live_regression_of_deterministic_retention_not_new_holdout",
        "prompt_version": PROMPT_VERSION,
        "rendering_version": RENDERING_VERSION,
        "product_files": product_hashes(),
        "input_unchanged": before == after,
        "planned": len(selected),
        "success": sum(r["status"] == 200 for r in results),
        "failures": sum(r["status"] != 200 for r in results),
        "incomplete_successes": sum(
            r["status"] == 200 and r["source_units"] != r["retained"] for r in results
        ),
        "results": results,
        "human_review": "pending",
    }
    write(output / "summary.json", summary)
    assert summary["input_unchanged"] and summary["incomplete_successes"] == 0
    assert all(
        r["trace"].get("rendering_version") == RENDERING_VERSION
        for r in results
        if r["status"] == 200
    )
    e.client.close()
    e.employee.close()
    e.app.state.engine.dispose()
    e.engine.dispose()
    print(
        json.dumps(
            {
                k: summary[k]
                for k in [
                    "planned",
                    "success",
                    "failures",
                    "incomplete_successes",
                    "input_unchanged",
                ]
            }
        )
    )


if __name__ == "__main__":
    main()
