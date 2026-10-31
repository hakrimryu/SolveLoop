import json
from uuid import UUID

import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session
from test_business import business_engine as business_engine
from test_business import clients as clients
from test_business import draft, post, review, solved
from test_ticket_analysis import FixtureAI

from app.ai.ollama import OllamaError
from app.ai.tickets import propose
from app.employee_guidance import GuidanceInput
from app.knowledge_search import embedding_client
from app.models import KnowledgeDocument


@pytest.mark.parametrize("query", ["", " ", "x" * 501, 123, "a\x00b"])
def test_guidance_rejects_invalid_question(query):
    with pytest.raises(ValidationError):
        GuidanceInput(query=query)


def test_guidance_has_separate_prompt_and_limits_steps():
    class TooLong(FixtureAI):
        def structured(self, *args):
            result = super().structured(*args)
            value = json.loads(result["response"])
            value["steps"] *= 4
            return {**result, "response": json.dumps(value)}

    with pytest.raises(OllamaError) as error:
        propose(TooLong(), "guidance", {"question": "質問"}, [], [{"id": "source"}])
    assert error.value.code == "AI_INVALID_OUTPUT"


@pytest.mark.integration
def test_employee_guidance_only_public_documents_and_no_case_lookup(clients):
    fake = FixtureAI()
    fake.calls = []
    clients["operator"].app.dependency_overrides[embedding_client] = lambda: fake
    op, emp = clients["operator"], clients["employee"]
    case = solved(clients)
    draft(op, body="未承認秘密")
    published = review(op, draft(op, body="公開手順を確認します。"))
    result = post(emp, "/knowledge/guidance", {"query": "端末の登録"})
    assert result.status_code == 200, result.text
    value = result.json()
    assert value["prompt_version"] == "employee-guidance-v1"
    assert [s["version_id"] for s in value["sources"]] == [published["version_id"]]
    assert all(s["kind"] == "knowledge" for s in value["sources"])
    assert "未承認秘密" not in result.text and case["id"] not in fake.calls[-1]
    assert case["resolution"] not in fake.calls[-1]
    assert post(clients["limited"], "/knowledge/guidance", {"query": "質問"}).status_code == 403
    assert post(emp, "/knowledge/guidance", {"query": "質問", "sources": []}).status_code == 422
    assert (
        emp.post(
            "/api/v1/knowledge/guidance", json={"query": "質問"}, headers={"X-CSRF-Token": "wrong"}
        ).status_code
        == 403
    )
    assert (
        post(
            emp,
            f"/tickets/{case['id']}/analysis",
            {"task": "answer", "expected_version": case["version"]},
        ).status_code
        == 403
    )


@pytest.mark.integration
def test_no_documents_is_normal_insufficient_and_generation_errors_are_errors(clients):
    fake = FixtureAI()
    fake.calls = []
    op, emp = clients["operator"], clients["employee"]
    op.app.dependency_overrides[embedding_client] = lambda: fake
    value = post(emp, "/knowledge/guidance", {"query": "質問"}).json()
    assert value["result"]["status"] == "insufficient_evidence"
    assert value["generation"] is None and not fake.calls
    review(op, draft(op))
    for code in ("AI_UNAVAILABLE", "AI_INVALID_OUTPUT"):

        def fail(*args, error=code):
            raise OllamaError(error, "試験用の障害")

        fake.structured = fail
        response = post(emp, "/knowledge/guidance", {"query": "質問"})
        assert response.status_code == 503 and response.json()["code"] == code


@pytest.mark.integration
def test_publication_change_during_guidance_discards_result(clients):
    fake = FixtureAI()
    op, emp = clients["operator"], clients["employee"]
    op.app.dependency_overrides[embedding_client] = lambda: fake
    published = review(op, draft(op))

    def stop():
        with Session(op.app.state.engine) as session, session.begin():
            session.get(
                KnowledgeDocument, UUID(published["document_id"])
            ).publication_suspended = True

    fake.hook = stop
    response = post(emp, "/knowledge/guidance", {"query": "質問"})
    assert response.status_code == 409 and response.json()["code"] == "AI_CONTEXT_CHANGED"
