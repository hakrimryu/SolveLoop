"""S21のAI根拠公開境界を専用合成DB/APIで確認する。"""

import json
from pathlib import Path
from uuid import UUID

from run import Evaluation, ident


def main():
    e = Evaluation(Path("/results/boundaries"))
    e.login()
    _, version = e.call(
        "/knowledge/drafts",
        {
            "title": "評価専用・公開前の境界検査",
            "audience": "評価担当者",
            "body": "架空企業・合成資料。公開前の文書本文は社員へ提供しない。",
            "department_id": str(UUID(int=101)),
            "source_refs": [],
        },
        expected=201,
    )
    _, ticket = e.call(
        "/tickets",
        {
            "title": "評価専用・非所有問い合わせ",
            "body": "担当者本人が登録した非公開の合成問い合わせ。",
            "department_id": None,
        },
        expected=201,
    )
    cases = [
        ("unpublished_direct", f"/knowledge/{version['document_id']}", None, 404),
        ("nonowned_direct", f"/tickets/{ticket['id']}", None, 404),
        (
            "employee_ai",
            f"/tickets/{ident('H01')}/analysis",
            {"task": "answer", "expected_version": 1},
            403,
        ),
        ("employee_radar", "/radar/runs", None, 403),
    ]
    results = []
    for case, path, body, expected in cases:
        status, value = e.call(path, body, employee=True)
        results.append(
            {
                "case": case,
                "status": status,
                "expected": expected,
                "pass": status == expected,
                "error_code": value.get("code"),
            }
        )
    status, value = e.call(
        "/knowledge/search", {"query": "評価専用・公開前の境界検査", "top_k": 20}, employee=True
    )
    exposed = status == 200 and any(
        x["document_id"] == version["document_id"] for x in value["items"]
    )
    results.append(
        {
            "case": "unpublished_semantic_search",
            "status": status,
            "pass": status == 200 and not exposed,
            "exposed": exposed,
        }
    )
    e.call("/auth/logout", {}, employee=True, expected=204)
    e.call("/auth/logout", {}, expected=204)
    e.employee.close()
    e.client.close()
    e.app.state.engine.dispose()
    e.engine.dispose()
    Path("/results/boundaries.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    assert all(r["pass"] for r in results), results
    print("S21 AI公開境界: 5/5、漏出0。S22全体検証ではありません。")


if __name__ == "__main__":
    main()
