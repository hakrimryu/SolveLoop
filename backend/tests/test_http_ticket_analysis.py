import os
from time import perf_counter
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from test_http_business import Client

from app.config import load_settings
from app.database import build_engine
from app.knowledge_search import activate
from app.models import KnowledgeDocument, Ticket

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("RUN_OLLAMA_TESTS") != "1"
        or os.getenv("RUN_DB_TESTS") != "1"
        or not os.getenv("AUTH_TEST_BASE_URL"),
        reason="実Ollamaと専用DB/APIを明示した場合だけ実行します。",
    ),
]


def test_local_ollama_classification_rag_and_insufficient_evidence():
    settings = load_settings()
    assert settings.postgres_db == "solveloop_test"
    engine = build_engine(settings)
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(Ticket)) == 0, (
            "空の専用DBが必要です。"
        )
        assert session.scalar(select(func.count()).select_from(KnowledgeDocument)) == 0
    activate(engine)
    engine.dispose()
    op, emp = Client(), Client()
    op.timeout = emp.timeout = 180
    op.login("operator")
    emp.login("employee")
    ticket = emp.ok(
        "/tickets",
        {
            "title": "合成検証：携帯を替えてから社外ネットワークに入れない",
            "body": "会社のVPNにログインすると追加認証が求められます。携帯電話を交換し、"
            "以前の端末の認証アプリは使えません。どの部署で何を確認すべきですか。",
            "department_id": None,
        },
        status=201,
        key=str(uuid4()),
    )
    path = f"/tickets/{ticket['id']}/analysis"
    before = op.ok(f"/tickets/{ticket['id']}")
    started = perf_counter()
    classification = op.ok(path, {"task": "classification", "expected_version": 1})
    assert classification["result"]["department_code"] == "IT"
    assert classification["generation"]["model"] == "qwen3:8b"
    no_sources = op.ok(path, {"task": "answer", "expected_version": 1})
    assert no_sources["result"]["status"] == "insufficient_evidence"
    assert no_sources["generation"] is None
    version = op.ok(
        "/knowledge/drafts",
        {
            "title": "合成検証：携帯交換後のVPN追加認証",
            "audience": "会社のVPNを使う社員",
            "body": "手順\n旧端末の認証アプリが使えない場合はIT担当者に連絡してください。"
            "IT担当者が本人確認を行い、旧端末の登録を失効して新端末の認証登録を再発行します。"
            "新端末で認証コードを確認してVPNへ接続してください。\n\n注意\n"
            "本人確認が終わるまでは認証登録を再発行しません。",
            "department_id": str(UUID(int=101)),
            "source_refs": [],
        },
        status=201,
        key=str(uuid4()),
    )
    review = f"/knowledge/{version['document_id']}/versions/1"
    expected = {"expected_version": 1, "expected_document_version": 1}
    op.ok(review + "/prepare-search", expected)
    published = op.ok(review + "/approve", expected)
    answer = op.ok(path, {"task": "answer", "expected_version": 1})
    assert answer["result"]["status"] == "answered", answer
    assert answer["sources"] and answer["sources"][0]["version_id"] == version["version_id"]
    used = {ref for step in answer["result"]["steps"] for ref in step["citation_ids"]}
    assert used == {source["id"] for source in answer["sources"]}
    assert emp.ok(f"/knowledge/{version['document_id']}")["body"] == version["body"]
    other = emp.ok(
        "/tickets",
        {
            "title": "合成検証：契約外の人工衛星の修理費用",
            "body": "当社が運用していない人工衛星の故障原因と部品交換の"
            "正確な価格を教えてください。",
            "department_id": None,
        },
        status=201,
        key=str(uuid4()),
    )
    insufficient = op.ok(
        f"/tickets/{other['id']}/analysis", {"task": "answer", "expected_version": 1}
    )
    assert insufficient["result"]["status"] == "insufficient_evidence", insufficient
    assert insufficient["result"]["steps"] == [] and insufficient["sources"] == []
    # 公開文書を停止し、担当者だけの解決事例を根拠に再検証する。
    op.ok(
        review + "/stop-publication",
        {
            "expected_version": published["row_version"],
            "expected_document_version": published["document_row_version"],
        },
    )
    case = emp.ok(
        "/tickets",
        {
            "title": "合成検証：端末交換後のVPN認証の解決例",
            "body": ticket["body"],
            "department_id": str(UUID(int=101)),
        },
        status=201,
        key=str(uuid4()),
    )
    case = op.ok(
        f"/tickets/{case['id']}/assignment",
        {
            "expected_version": case["version"],
            "department_id": str(UUID(int=101)),
            "assignee_id": str(UUID(int=202)),
        },
    )
    case = op.ok(
        f"/tickets/{case['id']}/transition",
        {"action": "start", "expected_version": case["version"]},
    )
    case = op.ok(
        f"/tickets/{case['id']}/transition",
        {
            "action": "resolve",
            "expected_version": case["version"],
            "resolution": "IT担当者が本人確認し、旧端末の登録を失効して新端末の認証登録を"
            "再発行しました。新端末の認証コードでVPN接続を確認しました。",
        },
    )
    case_answer = op.ok(path, {"task": "answer", "expected_version": 1})
    assert case_answer["result"]["status"] == "answered", case_answer
    assert {s["ticket_id"] for s in case_answer["sources"]} == {case["id"]}
    assert all(s["kind"] == "ticket" for s in case_answer["sources"])
    assert emp.call(path, {"task": "answer", "expected_version": 1})[0] == 403
    assert op.ok(f"/tickets/{ticket['id']}") == before
    print(
        {
            "scope": "synthetic_local_smoke_not_quality_evaluation",
            "ticket_id": ticket["id"],
            "document_id": version["document_id"],
            "case_id": case["id"],
            "classification": classification["result"],
            "answer": answer["result"],
            "case_answer": case_answer["result"],
            "insufficient": insufficient["result"],
            "generations": [
                r["generation"] for r in (classification, answer, insufficient, case_answer)
            ],
            "elapsed_seconds": round(perf_counter() - started, 2),
        }
    )
    # 検証資料は専用DBに残す。原本や既存資料を自動削除しない。
    op.call("/auth/logout", {})
    emp.call("/auth/logout", {})
