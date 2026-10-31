"""下書き10種の原文・生成抜粋・機械的検査をレビュー用に並べる。"""

import argparse
import json
from difflib import SequenceMatcher
from pathlib import Path

from score import digest, read


def checks(value, expected):
    if not value:
        return {"generated": False}
    result = value["result"]
    text = "\n".join(result["steps"])
    cautions = "\n".join(result["cautions"])
    source_text = {
        name: [s[field] for s in expected["sources"]]
        for name, field in [
            ("symptoms", "body"),
            ("steps", "resolution"),
            ("cautions", "resolution"),
        ]
    }
    missing_steps = [s for s in expected["required_steps"] if s not in text]
    missing_cautions = [s for s in expected["required_cautions"] if s not in cautions]
    similar = [
        [i + 1, j + 1]
        for i, left in enumerate(result["steps"])
        for j, right in enumerate(result["steps"])
        if i < j and SequenceMatcher(None, left, right).ratio() >= 0.65
    ]
    return {
        "generated": True,
        "all_excerpts_exist": all(
            any(t in source for source in source_text[field])
            for field in source_text
            for t in result[field]
        ),
        "required_steps_not_in_steps": missing_steps,
        "required_cautions_not_in_cautions": missing_cautions,
        "similar_step_pairs_to_check": similar,
        "audience_exact": result["audience"] == expected["audience"]
        if expected["audience"]
        else None,
        "warning": "文字列照合と類似度の検査であり、意味・順序・適用条件の正しさの承認ではない。",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    rows = [
        json.loads(x)
        for x in (args.input / "records.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    packet = []
    lines = [
        "# 下書き10種の利用者レビュー資料",
        "",
        "状態: **利用者レビュー未実施**。機械的検査・分析者の所見を人の確認完了に読み替えない。",
        "",
        "各種の初回成功を掲載する。初回失敗なら失敗を隠さず回番号を示す。全試行の成功/失敗は別のattempts.jsonに残る。",
        "",
        "確認項目: 根拠の意味、操作の順序と欠落、対象/前提/例外、不要な重複、"
        "必要な修正（不要・軽微・大幅・利用不可）。",
        "",
    ]
    for spec in read("drafts"):
        attempts = [
            r
            for r in rows
            if r["phase"] == "baseline" and r["task"] == "draft" and r["case"] == spec["id"]
        ]
        selected = next((r for r in attempts if r["status"] == 200), None)
        value = selected["value"] if selected else None
        item = {
            "id": spec["id"],
            "selected_repeat": selected["repeat"] if selected else None,
            "attempt_statuses": [r["status"] for r in attempts],
            "input_hash": digest(spec["sources"]),
            "sources": spec["sources"],
            "generated": value["result"] if value else None,
            "trace": value["trace"] if value else None,
            "automatic_checks": checks(value, spec),
            "human_review": {
                "status": "pending",
                "reviewer": None,
                "evidence_fidelity": None,
                "procedure": None,
                "conditions": None,
                "revision_required": None,
            },
        }
        packet.append(item)
        lines += [
            "## " + spec["id"],
            "",
            f"掲載回: {item['selected_repeat']} / 全試行HTTP状態: {item['attempt_statuses']}",
            "",
        ]
        for source in spec["sources"]:
            lines += [
                "### 根拠 " + source["id"],
                "",
                "**" + source["title"] + "**",
                "",
                source["body"],
                "",
                source["resolution"],
                "",
            ]
        lines += [
            "### 生成案",
            "",
            "```json",
            json.dumps(item["generated"], ensure_ascii=False, indent=2),
            "```",
            "",
            "### 自動検査（品質承認ではない）",
            "",
            "```json",
            json.dumps(item["automatic_checks"], ensure_ascii=False, indent=2),
            "```",
            "",
            "### 利用者記入欄",
            "",
            "- 根拠の意味: 未確認",
            "- 手順の順序・欠落: 未確認",
            "- 対象・条件・例外: 未確認",
            "- 修正必要度: 未確認",
            "- 確認者・日時: 未記入",
            "",
        ]
    (args.output / "draft-review.json").write_text(
        json.dumps(packet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    (args.output / "draft-review.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
