import pytest
from sqlalchemy import event, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from test_business import business_engine as business_engine
from test_business import clients as clients
from test_business import copy, draft, post, review, review_path

from app.models import KnowledgeChunk, KnowledgeVersion


def change(client, value, operation="stop-publication", **changes):
    return post(
        client,
        review_path(value) + "/" + operation,
        {
            "expected_version": value["row_version"],
            "expected_document_version": value["document_row_version"],
            **changes,
        },
    )


@pytest.mark.integration
def test_stop_resume_preserves_versions_and_vectors_but_filters_every_public_entry(
    clients, business_engine
):
    op, emp = clients["operator"], clients["employee"]
    approved = review(op, draft(op))
    path = "/api/v1/knowledge/" + approved["document_id"]
    with Session(business_engine) as session:
        ids = list(session.scalars(select(KnowledgeChunk.id)))
    stopped = change(op, approved)
    assert stopped.status_code == 200, stopped.text
    stopped = stopped.json()
    assert stopped["publication_suspended"] is True
    assert stopped["body"] == approved["body"]
    assert stopped["published_version_no"] == 1
    assert stopped["events"][-1]["event_type"] == "publication_stopped"
    assert stopped["search_preparation"]["status"] == "ready"
    assert emp.get(path).status_code == 404
    assert op.get(path).status_code == 200
    for client in (op, emp):
        assert client.get("/api/v1/knowledge?q=VPN").json()["items"] == []
        assert post(client, "/knowledge/search", {"query": "VPN"}).json()["items"] == []
    paused = op.get("/api/v1/knowledge/reviews?status=suspended").json()["items"]
    assert len(paused) == 1 and paused[0]["publication_suspended"] is True
    resumed = change(op, stopped, "resume-publication")
    assert resumed.status_code == 200, resumed.text
    resumed = resumed.json()
    assert resumed["publication_suspended"] is False
    assert resumed["events"][-1]["event_type"] == "publication_resumed"
    assert emp.get(path).status_code == 200
    assert len(emp.get("/api/v1/knowledge").json()["items"]) == 1
    assert post(emp, "/knowledge/search", {"query": "VPN"}).json()["items"]
    with Session(business_engine) as session:
        assert list(session.scalars(select(KnowledgeChunk.id))) == ids
        assert session.scalar(select(func.count()).select_from(KnowledgeVersion)) == 1


@pytest.mark.integration
def test_stopped_document_stays_stopped_when_revision_is_approved(clients):
    op = clients["operator"]
    stopped = change(op, review(op, draft(op))).json()
    new = copy(op, stopped)
    assert new["publication_suspended"] is True
    assert change(op, new, "resume-publication").status_code == 409
    published = review(op, new)
    assert published["publication_suspended"] is True
    assert clients["employee"].get(f"/api/v1/knowledge/{new['document_id']}").status_code == 404
    assert change(op, stopped, "resume-publication").status_code == 409
    resumed = change(op, published, "resume-publication").json()
    assert resumed["published_version_no"] == 2
    assert not resumed["publication_suspended"]


@pytest.mark.integration
def test_publication_requires_operator_csrf_current_versions_and_prepared_resume(
    clients, business_engine
):
    op = clients["operator"]
    draft_value = draft(op)
    assert change(op, draft_value).status_code == 409
    value = review(op, draft_value)
    assert change(clients["employee"], value).status_code == 403
    assert change(clients["limited"], value).status_code == 403
    assert change(op, value, expected_document_version=999).status_code == 409
    assert change(op, value, expected_version=True).status_code == 422
    path = "/api/v1" + review_path(value) + "/stop-publication"
    assert (
        op.post(
            path,
            json={
                "expected_version": value["row_version"],
                "expected_document_version": value["document_row_version"],
            },
            headers={"X-CSRF-Token": "wrong"},
        ).status_code
        == 403
    )
    stopped = change(op, value).json()
    assert change(op, stopped).status_code == 409
    with Session(business_engine) as session, session.begin():
        for chunk in session.scalars(select(KnowledgeChunk)):
            session.delete(chunk)
    assert change(op, stopped, "resume-publication").status_code == 409
    assert (
        op.get(f"/api/v1/knowledge/{value['document_id']}").json()["publication_suspended"] is True
    )


@pytest.mark.integration
def test_publication_failure_rolls_back_state_history_and_index_version(clients, business_engine):
    op = clients["operator"]
    value = review(op, draft(op))

    def fail(connection, cursor, statement, parameters, context, executemany):
        if "INSERT INTO" in statement and "knowledge_events" in statement:
            raise SQLAlchemyError("検証用の履歴保存障害")

    event.listen(business_engine, "before_cursor_execute", fail)
    try:
        assert change(op, value).status_code == 503
    finally:
        event.remove(business_engine, "before_cursor_execute", fail)
    result = op.get("/api/v1" + review_path(value)).json()
    assert not result["publication_suspended"]
    assert result["row_version"] == value["row_version"]
    assert result["events"] == value["events"]
    assert post(clients["employee"], "/knowledge/search", {"query": "VPN"}).json()["items"]


@pytest.mark.integration
def test_delete_requires_exact_document_number_on_server(clients):
    value = draft(clients["operator"])
    for number in ("", "KB-9999", value["number"] + " "):
        assert (
            change(
                clients["operator"], value, "delete-document", confirmation_number=number
            ).status_code
            == 422
        )
    assert change(clients["operator"], value, "delete-document").status_code == 422
    assert (
        change(
            clients["operator"], value, "delete-document", confirmation_number=value["number"]
        ).status_code
        == 200
    )
