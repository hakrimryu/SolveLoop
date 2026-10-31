import json
import os
from pathlib import Path
from time import monotonic
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_http_business import Client

from app.config import load_settings
from app.database import build_engine
from app.demo import CONFIRMATION, environment_guard, target_guard
from app.demo_data import Dataset
from app.models import KnowledgeDocument

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("RUN_DEMO_LIVE_TESTS") != "1"
        or os.getenv("RUN_OLLAMA_TESTS") != "1"
        or not os.getenv("AUTH_TEST_BASE_URL"),
        reason="初期準備済みの専用デモDB/API・実Ollamaを明示した場合だけ実行します。",
    ),
]


def test_live_final_dataset_cycle():
    settings = load_settings()
    environment_guard(settings, CONFIRMATION)
    data = Dataset(Path("/demo"))
    engine = build_engine(settings)
    with Session(engine) as session:
        target_guard(session)
        assert len(list(session.scalars(select(KnowledgeDocument)))) == 15
    op, emp = Client(), Client()
    op.timeout = emp.timeout = 300
    op.login("operator")
    emp.login("employee")
    unresolved = next(s for s in data.scenarios if s.name == "insufficient-evidence").ticket_ids[0]
    current = op.ok(f"/tickets/{unresolved}")
    assert (
        400
        <= op.call(
            "/knowledge/generations",
            {
                "source_refs": [
                    {
                        "ticket_id": unresolved,
                        "expected_ticket_version": current["version"],
                    }
                ]
            },
        )[0]
        < 500
    )
    timings = {}
    started = monotonic()
    run = op.ok(
        "/radar/runs",
        {
            "request_key": str(uuid4()),
            "as_of": data.manifest.as_of,
            "days": 30,
            "threshold": 0.92,
        },
    )
    timings["detect_seconds"] = monotonic() - started
    gap = next(s for s in data.scenarios if s.name == "knowledge-gap")
    # シナリオは観察対象の選択だけに使用し、製品側の検出結果を作り替えない。
    candidates = [
        c for c in run["candidates"] if set(gap.source_ticket_ids) <= set(c["ticket_ids"])
    ]
    assert candidates, run
    candidate = max(candidates, key=lambda c: len(set(c["ticket_ids"]) & set(gap.ticket_ids)))

    def analyze(group):
        value = op.ok(
            f"/radar/runs/{run['id']}/candidates/{group['id']}/coverage",
            {"request_key": str(uuid4())},
        )
        while value["unanalyzed_ids"]:
            value = op.ok(
                f"/radar/coverage/{value['id']}/batches",
                {
                    "request_key": str(uuid4()),
                    "ticket_ids": value["unanalyzed_ids"][:3],
                },
            )
        assert value["summary"]["unanalyzed"] == 0
        return value

    started = monotonic()
    before = analyze(candidate)
    timings["before_seconds"] = monotonic() - started
    expense_ids = set(next(s for s in data.scenarios if s.name == "covered-repeat").ticket_ids)
    expense = max(run["candidates"], key=lambda c: len(expense_ids & set(c["ticket_ids"])))
    started = monotonic()
    expense_coverage = analyze(expense)
    timings["expense_seconds"] = monotonic() - started
    refs = [
        {"ticket_id": i, "expected_ticket_version": op.ok(f"/tickets/{i}")["version"]}
        for i in gap.source_ticket_ids
    ]
    started = monotonic()
    proposal = op.ok("/knowledge/generations", {"source_refs": refs})
    timings["generation_seconds"] = monotonic() - started
    assert proposal["trace"]["mode"] == "live"
    version = op.ok(
        "/knowledge/drafts",
        {
            "title": "携帯交換後のVPN MFA認証の再登録",
            "audience": "携帯電話を交換してVPNのMFA認証ができない社員",
            "body": "架空企業・デモデータ\n症状\n"
            "携帯交換後、旧端末の認証アプリが使えずVPNのMFAが失敗する。"
            "\n\n手順\n1. IT担当者が本人確認を行う。\n2. 旧端末の認証登録を失効する。"
            "\n3. 新端末用の認証登録を再発行する。\n4. 新端末の認証アプリを登録する。"
            "\n5. 認証コードでVPNに接続できることを本人と確認する。"
            "\n\n注意\n本人確認が完了するまでは登録を再発行しない。"
            "\n問い合わせ先\nIT担当へ社内問い合わせで相談する。",
            "department_id": str(UUID(int=101)),
            "source_refs": refs,
            "generation_id": proposal["generation_id"],
        },
        status=201,
        key=str(uuid4()),
    )
    assert version["status"] == "draft" and version["number"] == "KB-0016"
    path = f"/knowledge/{version['document_id']}/versions/1"
    expected = {
        "expected_version": version["row_version"],
        "expected_document_version": version["document_row_version"],
    }
    assert emp.call(f"/knowledge/{version['document_id']}")[0] == 404
    started = monotonic()
    prepared = op.ok(path + "/prepare-search", expected)
    timings["prepare_seconds"] = monotonic() - started
    assert prepared["status"] == "draft"
    assert emp.call(f"/knowledge/{version['document_id']}")[0] == 404
    approved = op.ok(path + "/approve", expected)
    assert approved["status"] == "approved"
    started = monotonic()
    after = analyze(candidate)
    timings["after_seconds"] = monotonic() - started
    history = op.ok(f"/radar/runs/{run['id']}")
    assert history["current"] and history["input_snapshot_hash"] == run["input_snapshot_hash"]
    assert history["coverages"][0]["summary"] == before["summary"]
    assert not history["coverages"][0]["current"]
    result = emp.ok(
        "/knowledge/search",
        {
            "query": "携帯を買い替えて社外アクセスの二段階認証を通せない",
            "top_k": 5,
        },
    )
    assert any(item["document_id"] == version["document_id"] for item in result["items"]), result
    assert emp.ok(f"/knowledge/{version['document_id']}")["title"] == version["title"]
    assert emp.call("/radar/runs")[0] == 403
    print(
        json.dumps(
            {
                "scope": "synthetic_live_smoke_not_formal_evaluation",
                "manifest_hash": data.manifest_hash,
                "run_id": run["id"],
                "input_count": run["input_count"],
                "candidates": run["candidates"],
                "selected_candidate_id": candidate["id"],
                "before": before["summary"],
                "expense": expense_coverage["summary"],
                "after": after["summary"],
                "generation_trace": proposal["trace"],
                "document_id": version["document_id"],
                "timings": timings,
            },
            ensure_ascii=False,
        )
    )
    engine.dispose()


@pytest.mark.skipif(
    not os.getenv("DEMO_OUTAGE_BASE_URL"), reason="AI接続を閉じた専用APIが必要です。"
)
def test_manual_work_and_published_reading_during_ai_outage(monkeypatch):
    settings = load_settings()
    environment_guard(settings, CONFIRMATION)
    engine = build_engine(settings)
    with Session(engine) as session:
        target_guard(session)
    monkeypatch.setenv("AUTH_TEST_BASE_URL", os.environ["DEMO_OUTAGE_BASE_URL"])
    op, emp = Client(), Client()
    op.login("operator")
    emp.login("employee")
    ticket = emp.ok(
        "/tickets",
        {
            "title": "合成：AI停止中の手動受付",
            "body": "会議室の備品補充について総務に相談します。",
            "department_id": None,
        },
        status=201,
        key=str(uuid4()),
    )
    draft = op.ok(
        "/knowledge/drafts",
        {
            "title": "合成：手動文書の保存確認",
            "audience": "デモ担当者",
            "body": "架空企業・デモデータ\nAI停止中も手動保存を利用できます。",
            "department_id": str(UUID(int=103)),
            "source_refs": [],
        },
        status=201,
        key=str(uuid4()),
    )
    path = f"/knowledge/{draft['document_id']}/versions/1"
    expected = {
        "expected_version": draft["row_version"],
        "expected_document_version": draft["document_row_version"],
    }
    status, error = op.call(path + "/prepare-search", expected)
    assert status == 503 and error["code"] == "AI_UNAVAILABLE", error
    assert op.ok(path)["status"] == "draft"
    assert emp.ok(f"/tickets/{ticket['id']}")["body"] == ticket["body"]
    data = Dataset(Path("/demo"))
    assert emp.ok(f"/knowledge/{data.documents[0].id}")["title"] == data.documents[0].title
    assert emp.ok("/knowledge?q=VPN")["filtered_count"] >= 1
    assert emp.call(f"/knowledge/{draft['document_id']}")[0] == 404
    engine.dispose()
