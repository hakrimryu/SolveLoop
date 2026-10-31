import json
import os
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
        reason="実Ollamaと空の専用DB/APIを明示した場合だけ実行します。",
    ),
]


def test_live_resolutions_to_edited_draft_publication_and_search():
    settings = load_settings()
    assert settings.postgres_db == "solveloop_test"
    engine = build_engine(settings)
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(Ticket)) == 0
        assert session.scalar(select(func.count()).select_from(KnowledgeDocument)) == 0
    activate(engine)
    engine.dispose()
    op, emp = Client(), Client()
    op.timeout = emp.timeout = 260
    op.login("operator")
    emp.login("employee")
    tickets = []
    for index in range(5):
        ticket = emp.ok(
            "/tickets",
            {
                "title": f"合成S17-{index + 1}：携帯交換後のVPN追加認証",
                "body": "携帯電話を交換し、旧端末の認証アプリが使えずVPNの追加認証ができません。",
                "department_id": None,
            },
            status=201,
            key=str(uuid4()),
        )
        path = f"/tickets/{ticket['id']}"
        ticket = op.ok(
            path + "/assignment",
            {
                "expected_version": ticket["version"],
                "department_id": str(UUID(int=101)),
                "assignee_id": str(UUID(int=202)),
            },
        )
        ticket = op.ok(
            path + "/transition", {"expected_version": ticket["version"], "action": "start"}
        )
        ticket = op.ok(
            path + "/transition",
            {
                "expected_version": ticket["version"],
                "action": "resolve",
                "resolution": "IT担当者が本人確認を行い、旧端末の認証登録を失効した。"
                "新端末用の認証登録を再発行し、新端末の認証コードでVPN接続できることを確認した。"
                "本人確認が完了するまでは登録を再発行しない。",
            },
        )
        tickets.append(ticket)
    refs = [
        {"ticket_id": ticket["id"], "expected_ticket_version": ticket["version"]}
        for ticket in tickets
    ]
    first = op.ok("/knowledge/generations", {"source_refs": refs[:1]})
    multiple = op.ok("/knowledge/generations", {"source_refs": refs})
    for value, count in ((first, 1), (multiple, 5)):
        assert value["trace"]["mode"] == "live" and value["trace"]["model"] == "qwen3:8b"
        assert (
            len(value["sources"]) == count
            and len(set(value["result"]["source_ticket_ids"])) == count
        )
        assert (
            value["result"]["symptoms"]
            and value["result"]["steps"]
            and "解決手順" in value["draft"]["body"]
        )
    assert emp.call("/knowledge/generations", {"source_refs": refs[:1]})[0] == 403
    assert all(op.ok(f"/tickets/{ticket['id']}") == ticket for ticket in tickets)
    body = {
        **multiple["draft"],
        "title": "合成S17：携帯交換後の認証登録を担当者が確認する手順",
        "department_id": str(UUID(int=101)),
        "source_refs": refs,
        "generation_id": multiple["generation_id"],
    }
    key = str(uuid4())
    version = op.ok("/knowledge/drafts", body, status=201, key=key)
    assert op.ok("/knowledge/drafts", body, status=201, key=key) == version
    assert op.call("/knowledge/drafts", body, key=str(uuid4()))[0] == 409
    assert version["status"] == "draft" and version["published_version_no"] is None
    assert not emp.ok("/knowledge?q=合成S17")["items"]
    path = f"/knowledge/{version['document_id']}/versions/1"
    expected = {
        "expected_version": version["row_version"],
        "expected_document_version": version["document_row_version"],
    }
    prepared = op.ok(path + "/prepare-search", expected)
    assert prepared["status"] == "draft" and prepared["search_preparation"]["status"] == "ready"
    approved = op.ok(path + "/approve", expected)
    assert approved["status"] == "approved"
    results = emp.ok(
        "/knowledge/search",
        {"query": "スマホを買い替えて会社のネットワークで二段階認証が通らなくなった", "top_k": 5},
    )
    assert any(item["document_id"] == version["document_id"] for item in results["items"])
    print(
        json.dumps(
            {
                "scope": "synthetic_live_smoke_not_quality_evaluation",
                "ticket_ids": [t["id"] for t in tickets],
                "document_id": version["document_id"],
                "single": first["trace"],
                "five": multiple["trace"],
            }
        )
    )
