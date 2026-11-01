from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_business import business_engine as business_engine
from test_business import clients as clients
from test_business import create_ticket, post

from app.guidance_history import purge_expired
from app.models import GuidanceSession

pytestmark = pytest.mark.integration


def test_guidance_feedback_ownership_handoff_and_retention(clients):
    emp, op, other = clients["employee"], clients["operator"], clients["other"]
    answer = post(emp, "/knowledge/guidance", {"query": "端末の登録を確認したい"}).json()
    ident = answer["guidance_id"]
    path = f"/knowledge/guidance/{ident}"
    assert other.get("/api/v1" + path).status_code == 404
    assert op.get("/api/v1" + path).status_code == 200
    data = {"outcome": "unresolved", "reason": "手順が見つかりません", "expected_version": 1}
    result = post(emp, path + "/feedback", data)
    assert result.status_code == 200, result.text
    assert post(emp, path + "/feedback", data).json()["version"] == 2
    assert post(op, path + "/feedback", data).status_code == 404
    assert post(emp, path + "/feedback", {**data, "outcome": "solved"}).status_code == 409
    assert (
        post(
            other,
            "/tickets",
            {"title": "別社員", "body": "文", "department_id": None, "guidance_id": ident},
        ).status_code
        == 404
    )
    ticket = create_ticket(emp, guidance_id=ident, handoff_reason="解決できない")
    assert ticket["guidance_context"]["response"]["query"] == answer["query"]
    assert ticket["guidance_context"]["outcome"] == "unresolved"
    with Session(op.app.state.engine) as session, session.begin():
        session.get(GuidanceSession, UUID(ident)).expires_at = datetime.now(UTC) - timedelta(
            seconds=1
        )
    assert emp.get("/api/v1" + path).status_code == 404
    assert emp.get("/api/v1/knowledge/guidance/history").json()["items"] == []
    with Session(op.app.state.engine) as session, session.begin():
        assert purge_expired(session) == 1
    assert (
        emp.get(f"/api/v1/tickets/{ticket['id']}").json()["guidance_context"]["query"]
        == answer["query"]
    )


def test_messages_idempotency_conflicts_visibility_and_read_state(clients):
    emp, op, other = clients["employee"], clients["operator"], clients["other"]
    ticket = create_ticket(emp)
    path = f"/tickets/{ticket['id']}"
    data = {"body": "端末番号を教えてください。", "expected_version": ticket["version"]}
    first = post(op, path + "/messages", data, "first-reply")
    assert first.status_code == 201, first.text
    value = first.json()
    assert value["status"] == "open" and value["next_action"] == "requester"
    assert len(value["messages"]) == 1
    assert post(op, path + "/messages", data, "first-reply").json() == value
    assert post(op, path + "/messages", data).status_code == 409
    assert (
        post(other, path + "/messages", {**data, "expected_version": value["version"]}).status_code
        == 404
    )
    assert other.get("/api/v1" + path).status_code == 404
    assert emp.get("/api/v1" + path).json()["unread_count"] == 1
    assert post(emp, path + "/read", {"message_version": value["version"]}).status_code == 200
    assert emp.get("/api/v1" + path).json()["unread_count"] == 0
    reply = post(
        emp,
        path + "/messages",
        {"body": "合成端末 PC-01 です。", "expected_version": value["version"]},
    ).json()
    assert reply["next_action"] == "operator" and len(reply["messages"]) == 2
    assert op.get("/api/v1/tickets?queue=needs_reply").json()["filtered_count"] == 1
    assert op.get("/api/v1/tickets?queue=waiting_requester").json()["filtered_count"] == 0
    assert post(emp, path + "/read", {"message_version": reply["version"] + 1}).status_code == 422


def test_guidance_busy_is_error_not_knowledge_gap(clients, monkeypatch):
    from app.employee_guidance import GUIDANCE_LOCK

    monkeypatch.setattr("app.employee_guidance.GUIDANCE_WAIT_SECONDS", 0)

    emp = clients["employee"]
    assert GUIDANCE_LOCK.acquire(blocking=False)
    try:
        response = post(emp, "/knowledge/guidance", {"query": "合成の混雑確認"})
    finally:
        GUIDANCE_LOCK.release()
    assert response.status_code == 503
    rows = emp.get("/api/v1/knowledge/guidance/history").json()["items"]
    assert rows[0]["state"] == "error" and rows[0]["error_code"] == "AI_BUSY"
    assert rows[0]["outcome"] is None
    with Session(emp.app.state.engine) as session:
        assert session.scalar(select(GuidanceSession)).response is None


def test_expiry_is_thirty_days_and_no_feedback_on_error(clients, monkeypatch):
    from app.employee_guidance import GUIDANCE_LOCK

    monkeypatch.setattr("app.employee_guidance.GUIDANCE_WAIT_SECONDS", 0)

    emp = clients["employee"]
    GUIDANCE_LOCK.acquire()
    try:
        response = post(emp, "/knowledge/guidance", {"query": "合成の保存期間確認"})
    finally:
        GUIDANCE_LOCK.release()
    ident = response.json()["request_id"]
    row = emp.get(f"/api/v1/knowledge/guidance/{ident}").json()
    delta = datetime.fromisoformat(row["expires_at"]) - datetime.fromisoformat(row["created_at"])
    assert delta == timedelta(days=30)
    assert (
        post(
            emp,
            f"/knowledge/guidance/{ident}/feedback",
            {"outcome": "solved", "expected_version": 1},
        ).status_code
        == 409
    )


def test_metrics_require_operator_and_do_not_count_unknown_as_solved(clients):
    emp, op = clients["employee"], clients["operator"]
    result = post(emp, "/knowledge/guidance", {"query": "合成の指標確認"})
    assert result.status_code == 200
    assert emp.get("/api/v1/knowledge/guidance/metrics").status_code == 403
    metrics = op.get("/api/v1/knowledge/guidance/metrics").json()
    assert metrics["total"] == 1 and metrics["outcomes"]["solved"] == 0
    assert metrics["unconfirmed"] == 1
    assert metrics["states"]["insufficient_evidence"] == 1
    assert metrics["median_processing_ms"] >= 0


def test_read_marker_does_not_consume_a_later_message(clients):
    emp, op = clients["employee"], clients["operator"]
    ticket = create_ticket(emp)
    path = f"/tickets/{ticket['id']}"
    first = post(
        op, path + "/messages", {"body": "確認一", "expected_version": ticket["version"]}
    ).json()
    second = post(
        op, path + "/messages", {"body": "確認二", "expected_version": first["version"]}
    ).json()
    assert post(emp, path + "/read", {"message_version": first["version"]}).status_code == 200
    assert emp.get("/api/v1" + path).json()["unread_count"] == 1
    assert post(emp, path + "/read", {"message_version": 1}).status_code == 200
    assert emp.get("/api/v1" + path).json()["unread_count"] == 1
    assert post(emp, path + "/read", {"message_version": second["version"]}).status_code == 200
    assert emp.get("/api/v1" + path).json()["unread_count"] == 0


def test_two_employee_questions_wait_for_the_first_generation(clients):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from time import monotonic, sleep

    from sqlalchemy import func
    from test_business import draft, review
    from test_ticket_analysis import FixtureAI

    from app.knowledge_search import embedding_client

    emp, op = clients["employee"], clients["operator"]
    fake = FixtureAI()
    fake.calls = []
    entered, release = Event(), Event()
    original = fake.structured

    def wait(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)

    fake.structured = wait
    op.app.dependency_overrides[embedding_client] = lambda: fake
    review(op, draft(op))
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(post, emp, "/knowledge/guidance", {"query": "合成の待機確認一"})
        assert entered.wait(5)
        second = pool.submit(post, emp, "/knowledge/guidance", {"query": "合成の待機確認二"})
        try:
            deadline = monotonic() + 4
            while monotonic() < deadline:
                with Session(op.app.state.engine) as session:
                    if session.scalar(select(func.count()).select_from(GuidanceSession)) == 2:
                        break
                sleep(0.01)
            else:
                pytest.fail("二つ目の質問が記録されませんでした。")
        finally:
            release.set()
        assert first.result().status_code == 200
        assert second.result().status_code == 200


def test_stopped_document_is_not_reexposed_through_history_ticket_or_replay(clients):
    from test_business import draft, review
    from test_ticket_analysis import FixtureAI

    from app.knowledge_search import embedding_client
    from app.models import KnowledgeDocument

    emp, op = clients["employee"], clients["operator"]
    op.app.dependency_overrides[embedding_client] = FixtureAI
    doc = review(op, draft(op, body="公開停止の再表示境界確認用の固有原文"))
    value = post(emp, "/knowledge/guidance", {"query": "手順を教えて"}).json()
    history_path = f"/api/v1/knowledge/guidance/{value['guidance_id']}"
    assert emp.get(history_path).json()["response"]
    payload = {
        "title": "停止境界の合成確認",
        "body": "確認",
        "department_id": None,
        "guidance_id": value["guidance_id"],
    }
    ticket = post(emp, "/tickets", payload, "stopped-document-replay").json()
    assert ticket["guidance_context"]["response"]
    with Session(op.app.state.engine) as session, session.begin():
        session.get(KnowledgeDocument, UUID(doc["document_id"])).publication_suspended = True
    hidden = emp.get(history_path).json()
    assert hidden["response"] is None and hidden["response_restricted"]
    assert op.get(history_path).json()["response"]
    detail = emp.get(f"/api/v1/tickets/{ticket['id']}")
    assert detail.json()["guidance_context"]["response"] is None
    replay = post(emp, "/tickets", payload, "stopped-document-replay")
    assert replay.status_code == 201
    assert replay.json()["guidance_context"]["response"] is None
    assert "固有原文" not in detail.text + replay.text
