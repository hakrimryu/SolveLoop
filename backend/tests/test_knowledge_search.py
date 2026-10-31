from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Event
from uuid import UUID

import pytest
from pydantic import ValidationError
from search_fixtures import FixtureEmbeddings
from sqlalchemy import delete, event, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from test_business import action, copy, draft, post, prepare, review, review_path, solved
from test_business import business_engine as business_engine
from test_business import clients as clients

from app.ai.knowledge import PROFILE_ID, SPECIFICATION, chunks, embed, fingerprint
from app.ai.ollama import OllamaError
from app.errors import ApiError
from app.knowledge_search import SearchInput, activate, backfill, embedding_client
from app.models import (
    AuthSession,
    EmbeddingProfile,
    KnowledgeChunk,
    KnowledgeDocument,
    KnowledgePreparation,
    KnowledgeSearchState,
    Ticket,
)


def expected(version):
    return dict(
        expected_version=version["row_version"],
        expected_document_version=version["document_row_version"],
    )


def search(client, **changes):
    return post(client, "/knowledge/search", {"query": "端末を替えたら認証できない", **changes})


def test_chunk_source_positions_context_and_no_truncation():
    body = (
        "概要\n新端末の登録。\n\n手順\n"
        + ("設定を開き、登録を確認します。\n" * 300)
        + "\n\n例外\n紛失した端末は担当者へ連絡。😀"
    )
    result = chunks("VPN登録", "会社支給端末の利用者", body)
    covered = set()
    assert len(result) > 2
    for chunk in result:
        assert chunk.text == body[chunk.start : chunk.end]
        assert chunk.line_start == body.count("\n", 0, chunk.start) + 1
        assert chunk.content_hash == fingerprint(chunk.input)
        assert chunk.input.startswith("title: VPN登録 | text: 適用対象: 会社支給端末の利用者\n")
        assert (
            len(chunk.text.encode())
            <= SPECIFICATION["chunk_bytes"] + 2 * SPECIFICATION["neighbor_bytes"]
        )
        covered.update(range(chunk.start, chunk.end))
    assert covered == set(range(len(body)))
    assert "手順" in result[2].context
    assert "紛失した端末" in result[-1].text
    assert chunks("題", "全員", "手順\n設定する。\n\n例外\n紛失時は連絡。")[0].text.endswith(
        "紛失時は連絡。"
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"query": " "},
        {"query": "あ" * 501},
        {"top_k": True},
        {"top_k": 0},
        {"top_k": 21},
        {"profile_id": PROFILE_ID},
    ],
)
def test_search_strict_input(changes):
    with pytest.raises(ValidationError):
        SearchInput(**{"query": "質問", **changes})


@pytest.mark.parametrize(
    "change,code",
    [
        ("digest", "AI_PROFILE_MISMATCH"),
        ("dimensions", "AI_DIMENSION_MISMATCH"),
        ("zero", "AI_INVALID_RESPONSE"),
        ("nan", "AI_INVALID_RESPONSE"),
        ("tokens", "AI_INPUT_REJECTED"),
    ],
)
def test_embedding_profile_vector_and_token_validation(change, code):
    class Invalid(FixtureEmbeddings):
        def embed(self, value, **options):
            assert options == {"context_tokens": 8192, "expected_digest": SPECIFICATION["digest"]}
            result = super().embed(value, **options)
            if change == "digest":
                result["local_model"]["digest"] = "a" * 64
            elif change == "dimensions":
                result["embeddings"] = [[1.0]]
            elif change == "zero":
                result["embeddings"] = [[0.0] * 768]
            elif change == "nan":
                result["embeddings"][0][0] = float("nan")
            else:
                result["prompt_eval_count"] = 8193
            return result

    with pytest.raises(OllamaError) as error:
        embed(Invalid(), "入力")
    assert error.value.code == code


@pytest.mark.integration
def test_preparation_is_private_and_publication_switches_current_chunks(clients):
    op, emp = clients["operator"], clients["employee"]
    version = draft(op)
    assert (
        post(op, review_path(version) + "/approve", expected(version)).json()["code"]
        == "EMBEDDING_NOT_READY"
    )
    prepared = prepare(op, version)
    assert prepared["row_version"] == version["row_version"]
    assert prepared["events"] == version["events"]
    assert prepared["search_preparation"]["status"] == "ready"
    assert search(emp).json()["items"] == []
    published = review(op, prepared)
    first = search(emp).json()["items"]
    assert len(first) == 1 and first[0]["version_id"] == version["version_id"]
    assert first[0]["cosine_distance"] == pytest.approx(0)
    assert "sources" not in first[0] and "events" not in first[0]
    assert search(emp, department_id=str(UUID(int=102))).json()["items"] == []
    revision = copy(op, published)
    prepare(op, revision)
    assert search(emp).json()["items"] == first
    rejected = review(op, revision, "reject", reason="手順を見直す")
    assert search(emp).json()["items"] == first
    next_version = copy(op, rejected)
    changed = op.patch(
        "/api/v1" + review_path(next_version),
        json={"expected_version": 1, "body": "新端末の認証情報を再登録してください。"},
    ).json()
    review(op, changed)
    latest = search(emp).json()["items"]
    assert len(latest) == 1 and latest[0]["version_no"] == 3
    assert latest[0]["chunk_id"] != first[0]["chunk_id"]
    assert latest[0]["text"] == changed["body"]
    for who, status in [("employee", 403), ("limited", 403)]:
        assert (
            post(
                clients[who], review_path(changed) + "/prepare-search", expected(changed)
            ).status_code
            == status
        )
    assert search(clients["limited"]).status_code == 403
    assert (
        post(
            emp, "/knowledge/search", {"query": "質問", "version_id": revision["version_id"]}
        ).status_code
        == 422
    )
    assert (
        emp.post(
            "/api/v1/knowledge/search", json={"query": "質問"}, headers={"X-CSRF-Token": "wrong"}
        ).status_code
        == 403
    )


@pytest.mark.integration
@pytest.mark.parametrize("change", ["body", "source", "source_hash", "profile", "session"])
def test_preparation_rechecks_changes_and_releases_db_during_inference(
    clients, business_engine, change
):
    op = clients["operator"]
    ticket = solved(clients)
    version = draft(op, ticket)
    before = Event()

    class Racing(FixtureEmbeddings):
        def embed(self, value, **options):
            assert business_engine.pool.checkedout() == 0
            if not before.is_set():
                before.set()
                if change == "body":
                    assert (
                        clients["second"]
                        .patch(
                            "/api/v1" + review_path(version),
                            json={"expected_version": 1, "body": "競合した本文"},
                        )
                        .status_code
                        == 200
                    )
                elif change == "source":
                    action(clients["second"], ticket, "reopen")
                else:
                    with Session(business_engine) as session, session.begin():
                        if change == "source_hash":
                            session.get(
                                Ticket, UUID(ticket["id"])
                            ).resolution = "版番号が同じでも変わった根拠"
                        elif change == "profile":
                            session.get(KnowledgeSearchState, 1).revision += 1
                        else:
                            session.execute(
                                delete(AuthSession).where(AuthSession.user_id == UUID(int=202))
                            )
            return super().embed(value, **options)

    op.app.dependency_overrides[embedding_client] = Racing
    result = post(op, review_path(version) + "/prepare-search", expected(version))
    assert result.status_code == (401 if change == "session" else 409), result.text
    with Session(business_engine) as session:
        assert session.scalar(select(func_count(KnowledgePreparation))) == 0
        assert (
            session.get(KnowledgeDocument, UUID(version["document_id"])).published_version_id
            is None
        )


def func_count(model):
    from sqlalchemy import func

    return select(func.count()).select_from(model).scalar_subquery()


@pytest.mark.integration
@pytest.mark.parametrize("kind", ["timeout", "digest", "dimension", "database"])
def test_failure_never_saves_partial_preparation_or_publication(clients, business_engine, kind):
    op = clients["operator"]
    version = draft(op, body="手順\n" + "設定を確認します。\n" * 700)

    class Failing(FixtureEmbeddings):
        calls = 0

        def embed(self, value, **options):
            self.calls += 1
            result = super().embed(value, **options)
            if self.calls > 1:
                if kind == "timeout":
                    raise OllamaError("AI_TIMEOUT", "ローカルAIの時間切れです。")
                if kind == "digest":
                    result["local_model"]["digest"] = "f" * 64
                if kind == "dimension":
                    result["embeddings"] = [[1.0]]
            return result

    failing = Failing()
    op.app.dependency_overrides[embedding_client] = lambda: failing

    def fail(connection, cursor, statement, parameters, context, executemany):
        if "INSERT INTO" in statement and "knowledge_chunks" in statement:
            connection.exec_driver_sql("SELECT 1/0")

    if kind == "database":
        event.listen(business_engine, "before_cursor_execute", fail)
    try:
        result = post(op, review_path(version) + "/prepare-search", expected(version))
        assert result.status_code == (504 if kind == "timeout" else 503), result.text
    finally:
        if kind == "database":
            event.remove(business_engine, "before_cursor_execute", fail)
    with Session(business_engine) as session:
        assert session.scalar(select(func_count(KnowledgePreparation))) == 0
        assert session.scalar(select(func_count(KnowledgeChunk))) == 0
        assert (
            session.get(KnowledgeDocument, UUID(version["document_id"])).published_version_id
            is None
        )
    assert op.get("/api/v1/knowledge").status_code == 200
    assert (
        op.patch(
            "/api/v1" + review_path(version),
            json={"expected_version": 1, "body": "手動編集は継続可能"},
        ).status_code
        == 200
    )


@pytest.mark.integration
def test_backfill_requires_all_public_versions_and_profile_switch_invalidates_drafts(
    clients, business_engine
):
    op = clients["operator"]
    for title in ["文書一", "文書二"]:
        review(op, draft(op, title=title))
    pending = draft(op)
    prepare(op, pending)
    alternate = {**SPECIFICATION, "chunk_rule": "future-rule"}
    alternate_id = fingerprint(alternate)
    with Session(business_engine) as session, session.begin():
        session.execute(
            delete(KnowledgePreparation).where(
                KnowledgePreparation.indexed_row_version.is_not(None)
            )
        )
        session.add(
            EmbeddingProfile(
                id=alternate_id,
                specification=alternate,
                created_at=datetime.now(UTC),
            )
        )
        session.get(KnowledgeSearchState, 1).active_profile_id = alternate_id
        session.get(KnowledgeSearchState, 1).revision += 1

    class FailSecond(FixtureEmbeddings):
        calls = 0

        def embed(self, value, **options):
            self.calls += 1
            if self.calls == 2:
                raise OllamaError("AI_UNAVAILABLE", "接続できません。")
            return super().embed(value, **options)

    with pytest.raises(OllamaError):
        backfill(business_engine, FailSecond())
    with pytest.raises(ApiError) as error:
        activate(business_engine)
    assert error.value.code == "EMBEDDING_NOT_READY"
    with Session(business_engine) as session:
        assert session.get(KnowledgeSearchState, 1).active_profile_id == alternate_id
        assert session.scalar(select(func_count(KnowledgePreparation))) == 2
    assert backfill(business_engine, FixtureEmbeddings()) == 2
    assert activate(business_engine) == 2
    assert (
        post(op, review_path(pending) + "/approve", expected(pending)).json()["code"]
        == "EMBEDDING_NOT_READY"
    )
    assert len(search(clients["employee"]).json()["items"]) == 2
    review(op, pending)


@pytest.mark.integration
def test_pgvector_distance_dimensions_norm_and_unique_constraints(clients, business_engine):
    prepare(clients["operator"], draft(clients["operator"]))
    with Session(business_engine) as session:
        chunk = session.scalar(select(KnowledgeChunk))
        assert len(chunk.embedding) == 768
        chunk_id = chunk.id
    for assignment in [
        "embedding='[1,0]'::vector",
        "embedding=array_fill(0::real, ARRAY[768])::vector",
        "body_end=body_start",
        "input_tokens=8193",
    ]:
        with pytest.raises(SQLAlchemyError), business_engine.begin() as connection:
            connection.execute(
                text(
                    f"UPDATE solveloop_business_test.knowledge_chunks SET {assignment} WHERE id=:id"
                ),
                {"id": chunk_id},
            )
    with pytest.raises(IntegrityError), Session(business_engine) as session, session.begin():
        old = session.get(KnowledgeChunk, chunk_id)
        session.add(
            KnowledgeChunk(
                **{
                    column.name: getattr(old, column.name)
                    for column in KnowledgeChunk.__table__.columns
                    if column.name != "id"
                }
            )
        )


@pytest.mark.integration
def test_ollama_outage_does_not_become_empty_or_block_prepared_approval(clients):
    op, emp = clients["operator"], clients["employee"]
    version = draft(op)
    prepare(op, version)

    class Offline(FixtureEmbeddings):
        def embed(self, value, **options):
            raise OllamaError("AI_UNAVAILABLE", "ローカルOllamaに接続できません。")

    op.app.dependency_overrides[embedding_client] = Offline
    result = post(op, review_path(version) + "/approve", expected(version))
    assert result.status_code == 200
    assert search(emp).json()["code"] == "AI_UNAVAILABLE"
    assert emp.get("/api/v1/knowledge").json()["visible_total"] == 1


@pytest.mark.integration
def test_inactive_search_requires_activation_but_manual_work_continues(clients, business_engine):
    with Session(business_engine) as session, session.begin():
        session.get(KnowledgeSearchState, 1).active_profile_id = None
    op = clients["operator"]
    version = draft(op)
    assert (
        post(op, review_path(version) + "/prepare-search", expected(version)).json()["code"]
        == "SEARCH_NOT_READY"
    )
    assert search(clients["employee"]).json()["code"] == "SEARCH_NOT_READY"
    assert clients["employee"].get("/api/v1/knowledge").status_code == 200
    assert review(op, version, "reject", reason="手動で差し戻し")["status"] == "rejected"


@pytest.mark.integration
def test_activation_waits_for_approval_and_search_rechecks_session_and_profile(
    clients, business_engine, monkeypatch
):
    from app import knowledge_search as ks

    op = clients["operator"]
    version = draft(op)
    prepare(op, version)
    locked, release = Event(), Event()
    real = ks.require_prepared

    def waiting(*args):
        result = real(*args)
        locked.set()
        assert release.wait(8)
        return result

    monkeypatch.setattr(ks, "require_prepared", waiting)
    with ThreadPoolExecutor(2) as pool:
        approving = pool.submit(post, op, review_path(version) + "/approve", expected(version))
        assert locked.wait(5)
        switching = pool.submit(activate, business_engine)
        release.set()
        assert approving.result(8).status_code == 200
        assert switching.result(8) == 1

    class ChangeProfile(FixtureEmbeddings):
        def embed(self, value, **options):
            assert business_engine.pool.checkedout() == 0
            with Session(business_engine) as session, session.begin():
                session.get(KnowledgeSearchState, 1).revision += 1
            return super().embed(value, **options)

    op.app.dependency_overrides[embedding_client] = ChangeProfile
    assert search(op).json()["code"] == "SEARCH_PROFILE_CHANGED"

    class Revoked(FixtureEmbeddings):
        def embed(self, value, **options):
            with Session(business_engine) as session, session.begin():
                session.execute(delete(AuthSession).where(AuthSession.user_id == UUID(int=202)))
            return super().embed(value, **options)

    op.app.dependency_overrides[embedding_client] = Revoked
    assert search(op).status_code == 401
