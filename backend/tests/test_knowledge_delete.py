from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import UUID

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from test_business import business_engine as business_engine
from test_business import clients as clients
from test_business import copy, draft, post, prepare, review, review_path, solved

from app.models import (
    IdempotencyRecord,
    KnowledgeChunk,
    KnowledgeDocument,
    KnowledgeEvent,
    KnowledgePreparation,
    KnowledgeSource,
    KnowledgeVersion,
    Ticket,
)


def remove(client, version, **changes):
    return post(
        client,
        review_path(version) + "/delete-document",
        {
            "expected_version": version["row_version"],
            "expected_document_version": version["document_row_version"],
            "confirmation_number": version["number"],
            **changes,
        },
    )


@pytest.mark.integration
def test_delete_all_versions_vectors_replay_but_preserve_sources_and_other_docs(
    clients, business_engine
):
    op, emp = clients["operator"], clients["employee"]
    ticket = solved(clients)
    version = draft(op, ticket)
    original_id = UUID(version["document_id"])
    with Session(business_engine) as session:
        replay_key = session.scalar(
            select(IdempotencyRecord.key).where(IdempotencyRecord.entity_id == original_id)
        )
    approved = review(op, version)
    latest = copy(op, approved)
    prepare(op, latest)
    other = draft(op)
    assert remove(op, approved).status_code == 409
    response = remove(op, latest)
    assert response.status_code == 200, response.text
    assert response.json()["document_id"] == str(original_id)
    assert op.get("/api/v1" + review_path(latest)).status_code == 404
    assert emp.get(f"/api/v1/knowledge/{original_id}").status_code == 404
    assert emp.get("/api/v1/knowledge?q=VPN").json()["visible_total"] == 0
    assert post(emp, "/knowledge/search", {"query": "VPN"}).json()["items"] == []
    assert op.get("/api/v1" + review_path(other)).status_code == 200
    with Session(business_engine) as session:
        assert session.get(KnowledgeDocument, original_id) is None
        assert session.scalar(select(func.count()).select_from(KnowledgeVersion)) == 1
        assert session.scalar(select(func.count()).select_from(KnowledgeEvent)) == 1
        for model in (KnowledgeSource, KnowledgePreparation, KnowledgeChunk):
            assert session.scalar(select(func.count()).select_from(model)) == 0
        assert session.get(Ticket, UUID(ticket["id"])) is not None
        records = session.scalars(
            select(IdempotencyRecord).where(IdempotencyRecord.entity_id == original_id)
        ).all()
        assert len(records) == 2
        assert all(row.response_status == 410 and row.response_body == {} for row in records)
    replay = post(
        op,
        "/knowledge/drafts",
        {
            "title": "古い登録の再送",
            "audience": "全員",
            "body": "本文",
            "department_id": str(UUID(int=101)),
            "source_refs": [],
        },
        replay_key,
    )
    assert replay.status_code == 410
    assert remove(op, latest).status_code == 404


@pytest.mark.integration
def test_delete_auth_csrf_validation_and_stale_version(clients):
    op = clients["operator"]
    version = draft(op)
    for role, expected in (("employee", 403), ("limited", 403)):
        assert remove(clients[role], version).status_code == expected
    assert remove(op, version, expected_version=999).status_code == 409
    assert remove(op, version, expected_document_version=999).status_code == 409
    assert remove(op, version, expected_version=True).status_code == 422
    assert remove(op, version, unknown=True).status_code == 422
    path = "/api/v1" + review_path(version) + "/delete-document"
    assert (
        op.post(
            path,
            json={
                "expected_version": 1,
                "expected_document_version": 1,
                "confirmation_number": version["number"],
            },
            headers={"X-CSRF-Token": "wrong"},
        ).status_code
        == 403
    )
    assert (
        op.post(
            path + "?all=true",
            json={
                "expected_version": 1,
                "expected_document_version": 1,
                "confirmation_number": version["number"],
            },
        ).status_code
        == 422
    )
    assert op.get("/api/v1" + review_path(version)).status_code == 200
    assert remove(op, version).status_code == 200


@pytest.mark.integration
def test_failed_delete_rolls_back_every_table(clients, business_engine):
    op = clients["operator"]
    version = review(op, draft(op, solved(clients)))

    def counts():
        with Session(business_engine) as session:
            return [
                session.scalar(select(func.count()).select_from(model))
                for model in (
                    KnowledgeDocument,
                    KnowledgeVersion,
                    KnowledgeSource,
                    KnowledgeEvent,
                    KnowledgePreparation,
                    KnowledgeChunk,
                )
            ]

    before = counts()

    def fail(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith("DELETE FROM") and "knowledge_documents" in statement:
            raise SQLAlchemyError("検証用の削除障害")

    event.listen(business_engine, "before_cursor_execute", fail)
    try:
        assert remove(op, version).status_code == 503
    finally:
        event.remove(business_engine, "before_cursor_execute", fail)
    assert counts() == before
    assert clients["employee"].get(f"/api/v1/knowledge/{version['document_id']}").status_code == 200
    with Session(business_engine) as session:
        assert all(row.response_status == 201 for row in session.scalars(select(IdempotencyRecord)))


@pytest.mark.integration
def test_delete_during_embedding_does_not_resurrect_document(clients):
    from search_fixtures import FixtureEmbeddings

    from app.knowledge_search import embedding_client

    started, resume = Event(), Event()

    class Waiting(FixtureEmbeddings):
        def embed(self, *args, **kwargs):
            started.set()
            assert resume.wait(10)
            return super().embed(*args, **kwargs)

    op = clients["operator"]
    version = draft(op)
    app = op.app
    app.dependency_overrides[embedding_client] = Waiting
    try:
        with ThreadPoolExecutor() as pool:
            future = pool.submit(
                post,
                clients["second"],
                review_path(version) + "/prepare-search",
                {
                    "expected_version": version["row_version"],
                    "expected_document_version": version["document_row_version"],
                },
            )
            try:
                assert started.wait(10)
                assert remove(op, version).status_code == 200
            finally:
                resume.set()
            assert future.result().status_code == 404
    finally:
        app.dependency_overrides[embedding_client] = FixtureEmbeddings
