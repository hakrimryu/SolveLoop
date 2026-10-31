import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from threading import Barrier, Event
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from search_fixtures import FixtureEmbeddings, initialize_search
from sqlalchemy import event, select, text
from sqlalchemy.orm import Session
from test_auth import ORIGIN

from app.auth import password_hasher
from app.business import normalized
from app.config import load_settings
from app.database import build_engine
from app.knowledge import DraftEdit, DraftInput
from app.knowledge_search import embedding_client
from app.main import create_app
from app.models import Base, Department, User
from app.seed import DEMO_PASSWORD, seed_auth
from app.tickets import EditInput, TicketInput, TransitionInput


def test_business_input_boundaries():
    assert TicketInput(title=" 題\r\n名 ", body=" 本文 ", department_id=None).title == "題\n名"
    assert normalized("ＡＢＣ Straße %_") == "abc strasse %_"
    for version in (True, "1", 1.1, 0):
        with pytest.raises(ValidationError):
            EditInput(body="本文", expected_version=version)
    for data in (
        {"action": "resolve", "expected_version": 1},
        {"action": "start", "expected_version": 1, "resolution": None},
        {"action": "resolve", "expected_version": 1, "resolution": " "},
        {"action": "start", "expected_version": 1, "assignee_id": None},
    ):
        with pytest.raises(ValidationError):
            TransitionInput(**data)
    for data in (
        {"expected_version": 1},
        {"expected_version": 1, "title": None},
        {"expected_version": 1, "source_refs": None},
    ):
        with pytest.raises(ValidationError):
            DraftEdit(**data)
    with pytest.raises(ValidationError):
        DraftInput(
            title="題",
            body="文",
            audience="全員",
            department_id=None,
            source_refs=[{"ticket_id": UUID(int=1), "expected_ticket_version": 1}] * 2,
        )


@pytest.fixture(scope="module")
# 専用DBの一時スキーマを使い、業務検証と既存資料を分離する。
# [ko] 전용 DB의 임시 스키마를 사용해 업무 검증과 기존 자료를 분리한다.
# [en] Use a temporary schema in the dedicated test DB to isolate business verification.
def business_engine():
    if os.getenv("RUN_DB_TESTS") != "1":
        pytest.skip("専用DBでのみ実行します。")
    settings = load_settings()
    assert settings.postgres_db == "solveloop_test"
    engine = build_engine(settings)
    with engine.begin() as connection:
        had_vector = connection.scalar(
            text("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector')")
        )
        connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        connection.execute(text("CREATE SCHEMA solveloop_business_test"))
    mapped = engine.execution_options(schema_translate_map={None: "solveloop_business_test"})
    try:
        Base.metadata.create_all(mapped)
        yield mapped
    finally:
        with engine.begin() as connection:
            connection.execute(text("DROP SCHEMA solveloop_business_test CASCADE"))
            if not had_vector:
                connection.execute(text("DROP EXTENSION vector"))
        engine.dispose()


@pytest.fixture
def clients(business_engine):
    with business_engine.begin() as connection:
        names = ",".join(
            'solveloop_business_test."' + table + '"' for table in Base.metadata.tables
        )
        connection.execute(text(f"TRUNCATE {names} CASCADE"))
    with Session(business_engine) as session, session.begin():
        initialize_search(session)
        seed_auth(session)
        encoded = password_hasher.hash(DEMO_PASSWORD)
        for ident, role, limited, manager in (
            (301, "employee", False, True),
            (302, "operator", False, False),
            (303, "operator", True, True),
        ):
            session.add(
                User(
                    id=UUID(int=ident),
                    display_name=f"試験{ident}",
                    login_id=f"business-{ident}",
                    password_hash=encoded,
                    department_id=UUID(int=101),
                    role=role,
                    active=True,
                    must_change_password=limited,
                    can_manage_accounts=manager,
                )
            )
    app = create_app(load_settings())
    app.state.engine.dispose()
    app.state.engine = business_engine
    app.dependency_overrides[embedding_client] = FixtureEmbeddings
    with ExitStack() as stack:
        result = {}
        for name, login_id in (
            ("employee", "employee"),
            ("operator", "operator"),
            ("other", "business-301"),
            ("second", "business-302"),
            ("limited", "business-303"),
        ):
            client = stack.enter_context(TestClient(app))
            response = client.post(
                "/api/v1/auth/login",
                json={"login_id": login_id, "password": DEMO_PASSWORD},
                headers={"Origin": ORIGIN},
            )
            assert response.status_code == 200
            client.headers.update({"Origin": ORIGIN, "X-CSRF-Token": response.json()["csrf_token"]})
            result[name] = client
        yield result


def post(client, path, data, key=None):
    return client.post(
        "/api/v1" + path, json=data, headers={"Idempotency-Key": key or str(uuid4())}
    )


def create_ticket(client, **changes):
    response = post(
        client,
        "/tickets",
        {
            "title": "VPN １００％_ の確認",
            "body": "端末変更後の接続を確認したい",
            "department_id": None,
            **changes,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def action(client, ticket, operation, **changes):
    data = {"expected_version": ticket["version"], **changes}
    if operation in {"start", "resolve", "reopen"}:
        data["action"] = operation
        endpoint = "transition"
    else:
        endpoint = operation
    response = post(client, f"/tickets/{ticket['id']}/{endpoint}", data)
    assert response.status_code == 200, response.text
    return response.json()


def solved(clients):
    ticket = create_ticket(clients["employee"])
    ticket = action(
        clients["operator"],
        ticket,
        "assignment",
        department_id=str(UUID(int=101)),
        assignee_id=str(UUID(int=202)),
    )
    ticket = action(clients["operator"], ticket, "start")
    return action(
        clients["operator"], ticket, "resolve", resolution="端末登録を更新して接続を確認しました。"
    )


def draft(client, ticket=None, **changes):
    data = dict(
        title="VPN 端末変更の手順",
        audience="端末変更後の社員",
        body="登録を確認し、再登録後に接続します。",
        department_id=str(UUID(int=101)),
        source_refs=[dict(ticket_id=ticket["id"], expected_ticket_version=ticket["version"])]
        if ticket
        else [],
    )
    response = post(client, "/knowledge/drafts", {**data, **changes})
    assert response.status_code == 201, response.text
    return response.json()


def review_path(version):
    return f"/knowledge/{version['document_id']}/versions/{version['version_no']}"


def review(client, version, operation="approve", **changes):
    if operation == "approve":
        prepare(client, version)
    response = post(
        client,
        review_path(version) + "/" + operation,
        dict(
            expected_version=version["row_version"],
            expected_document_version=version["document_row_version"],
            **changes,
        ),
    )
    assert response.status_code == 200, response.text
    return response.json()


def prepare(client, version):
    response = post(
        client,
        review_path(version) + "/prepare-search",
        dict(
            expected_version=version["row_version"],
            expected_document_version=version["document_row_version"],
        ),
    )
    assert response.status_code == 200, response.text
    return response.json()


def copy(client, version):
    response = post(
        client,
        f"/knowledge/{version['document_id']}/drafts",
        dict(
            base_version_no=version["latest_version_no"],
            expected_document_version=version["document_row_version"],
        ),
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.integration
def test_ticket_lifecycle_permissions_and_projection(clients):
    emp, op, other = clients["employee"], clients["operator"], clients["other"]
    ticket = create_ticket(emp)
    UUID(ticket["id"])
    assert ticket["number"].startswith("REQ-") and ticket["department"] is None
    assert other.get("/api/v1/tickets/" + ticket["id"]).status_code == 404
    assert (
        other.patch(
            "/api/v1/tickets/" + ticket["id"], json={"body": "他人", "expected_version": 1}
        ).status_code
        == 404
    )
    assert (
        post(
            emp, f"/tickets/{ticket['id']}/transition", {"action": "start", "expected_version": 1}
        ).status_code
        == 403
    )
    assert (
        post(
            op,
            f"/tickets/{ticket['id']}/assignment",
            {"department_id": None, "assignee_id": str(UUID(int=202)), "expected_version": 1},
        ).status_code
        == 422
    )
    changed = emp.patch(
        "/api/v1/tickets/" + ticket["id"], json={"body": "変更後の本文", "expected_version": 1}
    ).json()
    assert changed["events"][-1]["payload"] == {"fields": ["body"]}
    assert "before" in op.get("/api/v1/tickets/" + ticket["id"]).json()["events"][-1]["payload"]
    assert (
        emp.patch(
            "/api/v1/tickets/" + ticket["id"], json={"body": "再上書き", "expected_version": 1}
        ).status_code
        == 409
    )
    same = emp.patch(
        "/api/v1/tickets/" + ticket["id"], json={"body": "変更後の本文", "expected_version": 2}
    ).json()
    assert same["version"] == 2 and len(same["events"]) == 2
    ticket = action(
        op, changed, "assignment", department_id=str(UUID(int=101)), assignee_id=str(UUID(int=202))
    )
    assert (
        post(
            op,
            f"/tickets/{ticket['id']}/transition",
            {"action": "resolve", "resolution": "直接解決", "expected_version": ticket["version"]},
        ).status_code
        == 409
    )
    ticket = action(op, ticket, "start")
    ticket = action(op, ticket, "resolve", resolution="接続を確認しました。")
    assert (
        emp.patch(
            "/api/v1/tickets/" + ticket["id"],
            json={"body": "解決後", "expected_version": ticket["version"]},
        ).status_code
        == 409
    )
    ticket = action(op, ticket, "reopen")
    assert ticket["resolution"] is None
    employee_event = emp.get("/api/v1/tickets/" + ticket["id"]).json()["events"][-1]
    assert employee_event["payload"]["previous_resolution"] == "接続を確認しました。"
    assert emp.get("/api/v1/tickets?assignee=me").status_code == 422
    assert other.get("/api/v1/tickets").json()["visible_total"] == 0
    assert "requester" not in emp.get("/api/v1/tickets").json()["items"][0]


@pytest.mark.integration
def test_ticket_search_pages_allowlists_and_idempotency(clients):
    client = clients["employee"]
    data = dict(title="ＡＢＣ Straße １００％_", body="複数\r\n行", department_id=None)
    key = str(uuid4())
    one = post(client, "/tickets", data, key)
    two = post(client, "/tickets", data, key)
    assert one.status_code == two.status_code == 201 and one.json() == two.json()
    assert one.headers["location"].endswith(one.json()["id"])
    assert post(client, "/tickets", {**data, "title": "別内容"}, key).status_code == 409
    assert client.post("/api/v1/tickets", json=data).status_code == 422
    for q in ("abc strasse", "100%_", "複数\n行"):
        response = client.get(
            "/api/v1/tickets", params={"q": q, "page": 999, "page_size": 1}
        ).json()
        assert response["filtered_count"] == 1 and response["page"] == 1
    assert client.get("/api/v1/tickets?q=100xx").json()["filtered_count"] == 0
    assert client.get("/api/v1/tickets?new=1").status_code == 422
    for query in ("page=0", "page_size=101", "sort=title", "department_id=bad", "status=bad"):
        assert client.get("/api/v1/tickets?" + query).status_code == 422
    assert post(client, "/tickets", {**data, "requester_id": str(UUID(int=301))}).status_code == 422
    assert (
        client.patch(
            "/api/v1/tickets/" + one.json()["id"],
            json={"expected_version": 1, "body": "文", "status": "resolved"},
        ).status_code
        == 422
    )


@pytest.mark.integration
def test_knowledge_publication_rejection_next_version_and_sources(clients):
    op, emp = clients["operator"], clients["employee"]
    ticket = solved(clients)
    version = draft(op, ticket)
    assert emp.get("/api/v1/knowledge/" + version["document_id"]).status_code == 404
    assert emp.get("/api/v1" + review_path(version)).status_code == 403
    assert emp.get("/api/v1/knowledge/reviews").status_code == 403
    version = review(op, version)
    public = emp.get("/api/v1/knowledge/" + version["document_id"]).json()
    assert set(public) == {
        "publication_suspended",
        "document_id",
        "number",
        "version_no",
        "title",
        "audience",
        "department",
        "updated_at",
        "approved_at",
        "body",
    }
    assert emp.get("/api/v1/knowledge?q=VPN+登録").json()["filtered_count"] == 1
    assert emp.get("/api/v1/knowledge?q=VPN+存在しない単語").json()["filtered_count"] == 0
    revision = copy(op, version)
    edited = op.patch(
        "/api/v1" + review_path(revision), json={"expected_version": 1, "body": "改訂中の文"}
    )
    assert edited.status_code == 200
    revision = edited.json()
    assert emp.get("/api/v1/knowledge/" + version["document_id"]).json() == public
    revision = review(op, revision, "reject", reason="注意事項を追加してください。")
    preserved = op.get("/api/v1" + review_path(revision)).json()
    assert (
        op.patch(
            "/api/v1" + review_path(revision),
            json={"expected_version": revision["row_version"], "body": "上書き"},
        ).status_code
        == 409
    )
    next_version = copy(op, revision)
    assert next_version["version_no"] == 3 and next_version["base_version_no"] == 2
    assert op.get("/api/v1" + review_path(revision)).json()["events"] == preserved["events"]
    assert (
        post(
            op,
            f"/knowledge/{version['document_id']}/drafts",
            {
                "base_version_no": 2,
                "expected_document_version": next_version["document_row_version"],
            },
        ).json()["code"]
        == "DRAFT_EXISTS"
    )
    ticket = action(op, ticket, "reopen")
    blocked = post(
        op,
        review_path(next_version) + "/approve",
        {"expected_version": 1, "expected_document_version": next_version["document_row_version"]},
    )
    assert blocked.status_code == 409 and blocked.json()["code"] == "SOURCE_CHANGED"
    ticket = action(op, ticket, "resolve", resolution="再確認した新しい手順。")
    current = op.get("/api/v1" + review_path(next_version)).json()
    assert current["source_issues"][0]["code"] == "SOURCE_CHANGED"
    saved = op.patch(
        "/api/v1" + review_path(current),
        json={
            "expected_version": 1,
            "body": "再確認した手順で登録する。",
            "source_refs": [
                {"ticket_id": ticket["id"], "expected_ticket_version": ticket["version"]}
            ],
        },
    ).json()
    assert saved["source_issues"] == [] and saved["events"][-1]["event_type"] == "sources_refreshed"
    published = review(op, saved)
    assert emp.get("/api/v1/knowledge/" + published["document_id"]).json()["version_no"] == 3
    assert emp.get("/api/v1/knowledge").json()["visible_total"] == 1
    assert op.get("/api/v1" + review_path(version)).json()["body"] == version["body"]


@pytest.mark.integration
def test_draft_department_source_validation_and_conflicts(clients):
    op = clients["operator"]
    version = draft(op, department_id=None)
    assert (
        post(
            op,
            review_path(version) + "/approve",
            {"expected_version": 1, "expected_document_version": 1},
        ).status_code
        == 422
    )
    saved = op.patch(
        "/api/v1" + review_path(version),
        json={"expected_version": 1, "department_id": str(UUID(int=101))},
    ).json()
    assert saved["document_row_version"] == 1 and saved["row_version"] == 2
    assert (
        post(
            op,
            review_path(saved) + "/approve",
            {"expected_version": 1, "expected_document_version": 1},
        ).status_code
        == 409
    )
    assert (
        post(
            op,
            review_path(saved) + "/approve",
            {"expected_version": 2, "expected_document_version": 99},
        ).status_code
        == 409
    )
    assert (
        op.patch(
            "/api/v1" + review_path(saved), json={"expected_version": 2, "status": "approved"}
        ).status_code
        == 422
    )
    ticket = create_ticket(clients["employee"])
    failed = post(
        op,
        "/knowledge/drafts",
        dict(
            title="題",
            audience="全員",
            body="文",
            department_id=None,
            source_refs=[dict(ticket_id=ticket["id"], expected_ticket_version=1)],
        ),
    )
    assert failed.status_code == 409 and failed.json()["code"] == "SOURCE_NOT_RESOLVED"
    assert clients["employee"].get("/api/v1/knowledge/reviews").status_code == 403
    assert (
        post(
            clients["other"],
            "/knowledge/drafts",
            dict(title="題", audience="全員", body="文", department_id=None, source_refs=[]),
        ).status_code
        == 403
    )


@pytest.mark.integration
def test_business_auth_restrictions_inactive_history_and_dashboard(clients, business_engine):
    ticket = solved(clients)
    version = review(clients["operator"], draft(clients["operator"], ticket))
    for path in (
        "/tickets",
        "/tickets/" + ticket["id"],
        "/knowledge",
        "/knowledge/reviews",
        "/dashboard",
    ):
        assert clients["limited"].get("/api/v1" + path).json()["code"] == "PASSWORD_CHANGE_REQUIRED"
    dash = clients["operator"].get("/api/v1/dashboard").json()
    assert (
        dash["total"] == 1 and dash["counts"]["resolved"] == 1 and dash["review_pending_count"] == 0
    )
    assert clients["other"].get("/api/v1/dashboard").json()["total"] == 0
    assert "reviews" not in clients["employee"].get("/api/v1/dashboard").json()
    for target in (201, 202):
        response = post(
            clients["other"], f"/accounts/{UUID(int=target)}/deactivate", {"expected_version": 1}
        )
        assert response.status_code == 200
    assert clients["employee"].get("/api/v1/tickets").status_code == 401
    assert clients["operator"].get("/api/v1/knowledge").status_code == 401
    public = clients["other"].get("/api/v1/knowledge/" + version["document_id"])
    assert public.status_code == 200
    historical = clients["second"].get("/api/v1/tickets/" + ticket["id"]).json()
    assert historical["requester"]["id"] == str(UUID(int=201)) and historical["events"][-1][
        "actor"
    ]["id"] == str(UUID(int=202))
    rejected = post(
        clients["second"],
        f"/tickets/{ticket['id']}/transition",
        {"action": "reopen", "expected_version": ticket["version"]},
    )
    assert rejected.status_code == 422
    reopened = action(clients["second"], ticket, "reopen", assignee_id=str(UUID(int=302)))
    assert reopened["assignee"]["id"] == str(UUID(int=302))


def state(engine):
    with engine.connect() as connection:
        return {
            table: connection.execute(
                text(
                    "SELECT row_to_json(t)::text FROM "
                    f'solveloop_business_test."{table}" t ORDER BY id'
                )
            )
            .scalars()
            .all()
            for table in (
                "tickets",
                "ticket_events",
                "knowledge_documents",
                "knowledge_versions",
                "knowledge_sources",
                "knowledge_events",
                "idempotency_records",
            )
        }


@pytest.mark.integration
@pytest.mark.parametrize(
    "operation",
    ["create_ticket", "edit_ticket", "create_draft", "approve", "reject", "edit_draft", "copy"],
)
def test_event_failure_rolls_back_every_business_change(clients, business_engine, operation):
    op = clients["operator"]
    ticket = solved(clients)
    version = draft(op, ticket)
    if operation == "copy":
        version = review(op, version)
    if operation == "approve":
        prepare(op, version)
    before = state(business_engine)
    table = "ticket_events" if operation in {"create_ticket", "edit_ticket"} else "knowledge_events"

    def fail(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith("INSERT INTO") and table in statement:
            connection.exec_driver_sql("SELECT 1/0")

    event.listen(business_engine, "before_cursor_execute", fail)
    try:
        if operation == "create_ticket":
            result = post(op, "/tickets", dict(title="題", body="文", department_id=None))
        elif operation == "edit_ticket":
            ticket = {**ticket}
            result = post(
                op,
                f"/tickets/{ticket['id']}/transition",
                dict(action="reopen", expected_version=ticket["version"]),
            )
        elif operation == "create_draft":
            result = post(
                op,
                "/knowledge/drafts",
                dict(title="題", audience="全員", body="文", department_id=None, source_refs=[]),
            )
        elif operation == "edit_draft":
            result = op.patch(
                "/api/v1" + review_path(version), json=dict(expected_version=1, body="変更")
            )
        elif operation == "copy":
            result = post(
                op,
                f"/knowledge/{version['document_id']}/drafts",
                dict(base_version_no=1, expected_document_version=version["document_row_version"]),
            )
        else:
            result = post(
                op,
                review_path(version) + "/" + operation,
                dict(
                    expected_version=1,
                    expected_document_version=1,
                    **({"reason": "再確認"} if operation == "reject" else {}),
                ),
            )
        assert result.status_code == 503, result.text
    finally:
        event.remove(business_engine, "before_cursor_execute", fail)
    assert state(business_engine) == before


@pytest.mark.integration
def test_concurrent_versions_approval_copy_and_idempotency(clients):
    op, second = clients["operator"], clients["second"]
    ticket = solved(clients)
    barrier = Barrier(2)

    def change(client):
        barrier.wait(timeout=5)
        return post(
            client,
            f"/tickets/{ticket['id']}/transition",
            dict(action="reopen", expected_version=ticket["version"]),
        )

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(change, [op, second]))
    assert sorted(r.status_code for r in results) == [200, 409]
    version = draft(op)

    prepare(op, version)

    def approve(client):
        barrier.wait(timeout=5)
        return post(
            client,
            review_path(version) + "/approve",
            dict(expected_version=1, expected_document_version=1),
        )

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(approve, [op, second]))
    assert sorted(r.status_code for r in results) == [200, 409]
    published = next(r.json() for r in results if r.status_code == 200)

    def new_draft(client):
        barrier.wait(timeout=5)
        return post(
            client,
            f"/knowledge/{version['document_id']}/drafts",
            dict(base_version_no=1, expected_document_version=published["document_row_version"]),
        )

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(new_draft, [op, second]))
    assert sorted(r.status_code for r in results) == [201, 409]
    key = str(uuid4())

    def duplicate(_):
        barrier.wait(timeout=5)
        return post(op, "/tickets", dict(title="重複防止", body="内容", department_id=None), key)

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(duplicate, range(2)))
    assert all(r.status_code == 201 for r in results) and results[0].json() == results[1].json()


@pytest.mark.integration
def test_waiting_business_write_rechecks_revoked_session(clients, business_engine):
    op = clients["operator"]
    ticket = create_ticket(clients["employee"])
    waiting = Event()

    def observed(connection, cursor, statement, parameters, context, executemany):
        if "users" in statement and "FOR UPDATE" in statement:
            waiting.set()

    with business_engine.connect() as blocker:
        tx = blocker.begin()
        blocker.execute(
            text("SELECT id FROM solveloop_business_test.users WHERE id=:id FOR UPDATE"),
            {"id": UUID(int=202)},
        )
        event.listen(business_engine, "before_cursor_execute", observed)
        try:
            with ThreadPoolExecutor(1) as pool:
                future = pool.submit(
                    op.patch,
                    "/api/v1/tickets/" + ticket["id"],
                    json={"expected_version": 1, "body": "失効後の変更"},
                )
                assert waiting.wait(5)
                blocker.execute(
                    text("DELETE FROM solveloop_business_test.sessions WHERE user_id=:id"),
                    {"id": UUID(int=202)},
                )
                tx.commit()
                result = future.result(timeout=8)
                assert result.status_code == 401
        finally:
            event.remove(business_engine, "before_cursor_execute", observed)
            if tx.is_active:
                tx.rollback()
    assert clients["employee"].get("/api/v1/tickets/" + ticket["id"]).json()["version"] == 1


@pytest.mark.integration
@pytest.mark.parametrize("first", ["approve", "reopen"])
def test_source_reopen_and_approval_serialize_with_real_ticket_lock(
    clients, business_engine, monkeypatch, first
):
    from test_accounts import wait_for_pg_lock

    from app import knowledge, tickets

    ticket = solved(clients)
    version = draft(clients["operator"], ticket)
    prepare(clients["operator"], version)
    with Session(business_engine) as session, session.begin():
        session.get(User, UUID(int=303)).must_change_password = False
    locked, waiting, release = Event(), Event(), Event()
    pids = {}
    real_sources = knowledge.lock_tickets
    real_ticket = tickets.visible_ticket

    def source_lock(session, ids):
        if first == "reopen":
            pids["second"] = session.scalar(text("SELECT pg_backend_pid()"))
            waiting.set()
        result = real_sources(session, ids)
        if first == "approve":
            locked.set()
            assert release.wait(8)
        return result

    def ticket_lock(session, actor, ticket_id, lock=False):
        if lock and first == "approve":
            pids["second"] = session.scalar(text("SELECT pg_backend_pid()"))
            waiting.set()
        result = real_ticket(session, actor, ticket_id, lock)
        if lock and first == "reopen":
            locked.set()
            assert release.wait(8)
        return result

    monkeypatch.setattr(knowledge, "lock_tickets", source_lock)
    monkeypatch.setattr(tickets, "visible_ticket", ticket_lock)

    def approve():
        return post(
            clients["limited"],
            review_path(version) + "/approve",
            {"expected_version": 1, "expected_document_version": 1},
        )

    def reopen():
        return post(
            clients["second"],
            f"/tickets/{ticket['id']}/transition",
            {"action": "reopen", "expected_version": ticket["version"]},
        )

    actions = {"approve": approve, "reopen": reopen}
    with ThreadPoolExecutor(2) as pool:
        one = pool.submit(actions[first])
        assert locked.wait(5)
        two = pool.submit(actions["reopen" if first == "approve" else "approve"])
        try:
            assert waiting.wait(5)
            wait_for_pg_lock(business_engine, pids["second"])
        finally:
            release.set()
        results = [one.result(timeout=8), two.result(timeout=8)]
    assert results[0].status_code == 200
    assert results[1].status_code == (200 if first == "approve" else 409)
    public = clients["employee"].get("/api/v1/knowledge/" + version["document_id"])
    assert public.status_code == (200 if first == "approve" else 404)


@pytest.mark.integration
def test_save_and_approve_cannot_both_accept_the_same_draft_version(clients):
    version = draft(clients["operator"])
    prepare(clients["operator"], version)
    barrier = Barrier(2)

    def save():
        barrier.wait(5)
        return clients["second"].patch(
            "/api/v1" + review_path(version),
            json={"expected_version": 1, "body": "同時に編集した内容"},
        )

    def approve():
        barrier.wait(5)
        return post(
            clients["operator"],
            review_path(version) + "/approve",
            {"expected_version": 1, "expected_document_version": 1},
        )

    with ThreadPoolExecutor(2) as pool:
        one, two = pool.submit(save), pool.submit(approve)
        results = [one.result(timeout=8), two.result(timeout=8)]
    assert sorted(result.status_code for result in results) == [200, 409]


@pytest.mark.integration
def test_draft_creation_replays_only_for_current_authorized_actor(clients, business_engine):
    client = clients["operator"]
    data = dict(title="重複防止", audience="全員", body="本文", department_id=None, source_refs=[])
    key = str(uuid4())
    one, two = (
        post(client, "/knowledge/drafts", data, key),
        post(client, "/knowledge/drafts", data, key),
    )
    assert one.status_code == two.status_code == 201 and one.json() == two.json()
    version = review(client, one.json(), "reject", reason="再確認")
    copied = dict(base_version_no=1, expected_document_version=version["document_row_version"])
    path = f"/knowledge/{version['document_id']}/drafts"
    copy_key = str(uuid4())
    one, two = post(client, path, copied, copy_key), post(client, path, copied, copy_key)
    assert one.status_code == two.status_code == 201 and one.json() == two.json()
    with Session(business_engine) as session, session.begin():
        session.get(User, UUID(int=202)).must_change_password = True
    assert post(client, path, copied, copy_key).json()["code"] == "PASSWORD_CHANGE_REQUIRED"


@pytest.mark.integration
def test_preserved_inactive_department_noop_and_strict_empty_filters(clients, business_engine):
    op = clients["operator"]
    ticket = create_ticket(op, department_id=str(UUID(int=101)))
    version = draft(op)
    with Session(business_engine) as session, session.begin():
        session.get(Department, UUID(int=101)).active = False
    same = action(op, ticket, "assignment", department_id=str(UUID(int=101)), assignee_id=None)
    assert same["version"] == ticket["version"] and same["events"] == ticket["events"]
    response = op.patch(
        "/api/v1" + review_path(version),
        json={
            "expected_version": 1,
            "department_id": str(UUID(int=101)),
            "body": "既存部署を保持して本文を編集",
        },
    )
    assert response.status_code == 200
    assert (
        post(
            op,
            review_path(response.json()) + "/approve",
            {"expected_version": 2, "expected_document_version": 1},
        ).status_code
        == 422
    )
    for query in ("department_id=", "assignee="):
        assert op.get("/api/v1/tickets?" + query).status_code == 422


@pytest.mark.integration
def test_expired_idempotency_key_does_not_create_again(clients, business_engine):
    from datetime import UTC, datetime, timedelta

    from app.models import IdempotencyRecord

    data = dict(title="期限確認", body="本文", department_id=None)
    key = str(uuid4())
    assert post(clients["employee"], "/tickets", data, key).status_code == 201
    before = state(business_engine)
    with Session(business_engine) as session, session.begin():
        row = session.scalar(select(IdempotencyRecord).where(IdempotencyRecord.key == key))
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    response = post(clients["employee"], "/tickets", data, key)
    assert response.status_code == 409 and response.json()["code"] == "IDEMPOTENCY_KEY_EXPIRED"
    after = state(business_engine)
    assert (
        after["tickets"] == before["tickets"] and after["ticket_events"] == before["ticket_events"]
    )


@pytest.mark.integration
def test_source_hash_is_checked_even_when_ticket_version_is_unchanged(clients, business_engine):
    from app.models import Ticket

    ticket = solved(clients)
    version = draft(clients["operator"], ticket)
    with Session(business_engine) as session, session.begin():
        session.get(Ticket, UUID(ticket["id"])).resolution = "DB原本が変わった状態を検証"
    response = post(
        clients["operator"],
        review_path(version) + "/approve",
        {"expected_version": 1, "expected_document_version": 1},
    )
    assert response.status_code == 409 and response.json()["code"] == "SOURCE_CHANGED"
    assert clients["employee"].get("/api/v1/knowledge/" + version["document_id"]).status_code == 404


@pytest.mark.integration
def test_business_ticket_lock_timeout_is_503_without_partial_events(clients, business_engine):
    ticket = create_ticket(clients["employee"])
    before = state(business_engine)
    with business_engine.begin() as blocker:
        blocker.execute(
            text("SELECT id FROM solveloop_business_test.tickets WHERE id=:id FOR UPDATE"),
            {"id": UUID(ticket["id"])},
        )
        result = clients["operator"].patch(
            "/api/v1/tickets/" + ticket["id"], json={"expected_version": 1, "body": "待機中の変更"}
        )
        assert result.status_code == 503
    assert state(business_engine) == before
