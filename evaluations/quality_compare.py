"""同じDB入力で実行した二版の派生結果を比較する。"""

import argparse
import json
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def aggregate(directory, specs):
    summary = read(directory / "summary.json")
    review = read(directory / "draft-review.json")
    groups = summary["radar"]
    counts = {
        key: sum(g["coverage_occurrences"].get(key, 0) for g in groups)
        for key in ["total", "covered", "uncovered", "unknown", "unanalyzed"]
    }
    gap = {key: sum(g["gap"][key] for g in groups) for key in ["tp", "predicted", "gold"]}
    gap["precision"] = gap["tp"] / gap["predicted"] if gap["predicted"] else None
    gap["recall"] = gap["tp"] / gap["gold"] if gap["gold"] else None
    predicted_cautions = correct_cautions = successful_units = retained_successful_units = 0
    extra_cautions = []
    for case in review:
        if case["scope"] == "regression":
            continue
        gold = specs[case["id"]]["required_cautions"]
        for attempt in case["attempts"]:
            if attempt["status"] != 200:
                continue
            successful_units += attempt["source_units"]
            retained_successful_units += attempt["retained_units"]
            for caution in attempt["result"]["cautions"]:
                predicted_cautions += 1
                if any(g.rstrip("。！？").strip() in caution for g in gold):
                    correct_cautions += 1
                else:
                    extra_cautions.append(
                        {"case": case["id"], "repeat": attempt["repeat"], "text": caution}
                    )
    return {
        "radar_counts": counts,
        "gap": gap,
        "drafts": summary["drafts"],
        "caution_precision": {
            "correct": correct_cautions,
            "n": predicted_cautions,
            "precision": correct_cautions / predicted_cautions if predicted_cautions else None,
            "extra_cautions": extra_cautions,
        },
        "successful_body_retention": {"correct": retained_successful_units, "n": successful_units},
        "errors": summary["errors"],
        "source_audit": summary["source_audit"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("quality", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    before, after = read(args.baseline / "metadata.json"), read(args.quality / "metadata.json")
    for key in ["corpus_hash", "ticket_hash", "dataset_hash"]:
        if before[key] != after[key]:
            raise ValueError("比較入力が一致しません: " + key)
    data = read(Path(__file__).resolve().parent / "datasets/quality-v2.json")
    specs = {d["id"]: d for d in data["drafts"]}
    result = {
        "same_input": {key: before[key] for key in ["corpus_hash", "ticket_hash", "dataset_hash"]},
        "baseline": aggregate(args.baseline, specs),
        "quality": aggregate(args.quality, specs),
        "human_review": "pending",
        "note": "注意欄のprecisionは指定原文との一致。意味的正確性・人による品質承認ではない。"
        "失敗を除いた原文保全と全試行分母を別表示。",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(
        json.dumps(
            {
                label: {"gap": result[label]["gap"], "drafts": result[label]["drafts"]}
                for label in ["baseline", "quality"]
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
