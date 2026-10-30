import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, Event, current_thread
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import delete, event, select, text, update
from sqlalchemy.orm import Session
from starlette.requests import Request
from starlette.responses import Response
from test_account_auth import NEW_PASSWORD, headers
from test_auth import ORIGIN, login
from test_auth import api as api
from test_auth import auth_engine as auth_engine

from app import accounts, auth
from app.database import get_session
from app.errors import ApiError
from app.models import AuditEvent, AuthSession, Department, User
from app.seed import DEMO_PASSWORD

ACTOR, TARGET = UUID(int=201), UUID(int=202)
ROOT = "/api/v1/accounts"
ACCOUNT_KEYS = {
    "id",
    "display_name",
    "login_id",
    "department",
    "role",
    "active",
    "can_manage_accounts",
    "must_change_password",
    "row_version",
}


@pytest.fixture
def manager(api, auth_engine):
    with Session(auth_engine) as session, session.begin():
        session.execute(update(User).where(User.id == ACTOR).values(can_manage_accounts=True))
    result = login(api)
    assert result.status_code == 200
    return result


def creation(engine, **extra):
    with Session(engine) as session:
        department_id = session.scalar(select(Department.id).where(Department.active.is_(True)))
    return {
        "display_name": "  柳  太郎  ",
        "login_id": "new-account",
        "department_id": str(department_id),
        "role": "employee",
        **extra,
    }


def mutate(api, manager, action, target=TARGET, version=1, **extra):
    return api.post(
        f"{ROOT}/{target}/{action}",
        json={"expected_version": version, **extra},
        headers=headers(manager),
    )


def snapshot(engine):
    with engine.connect() as connection:
        return [
            connection.execute(select(model.__table__).order_by(model.id)).all()
            for model in (User, AuthSession, AuditEvent)
        ]


@pytest.mark.parametrize("value", [True, False, "1", 1.0, 0, -1, None])
def test_expected_version_requires_positive_strict_integer(value):
    with pytest.raises(ValidationError):
        accounts.VersionInput(expected_version=value)


def test_temporary_password_uses_explicit_entropy_and_rejects_previous(monkeypatch):
    previous, fresh = "a" * 43, "b" * 43
    generated, sizes = iter([previous, fresh]), []

    def generate(size):
        sizes.append(size)
        return next(generated)

    monkeypatch.setattr(accounts.secrets, "token_urlsafe", generate)
    assert accounts.temporary_password(auth.password_hasher.hash(previous)) == fresh
    assert sizes == [32, 32]


@pytest.mark.integration
@pytest.mark.parametrize("role", ["employee", "operator"])
@pytest.mark.parametrize("restricted", [False, True])
def test_all_management_routes_enforce_current_permissions(api, auth_engine, role, restricted):
    with Session(auth_engine) as session, session.begin():
        session.execute(
            update(User)
            .where(User.login_id == role)
            .values(must_change_password=restricted, can_manage_accounts=restricted)
        )
    result = login(api, role)
    payload = creation(auth_engine)
    calls = [
        ("GET", ROOT, None),
        ("POST", ROOT, payload),
        ("GET", f"{ROOT}/{TARGET}/events", None),
        *[
            ("POST", f"{ROOT}/{TARGET}/{action}", {"expected_version": 1})
            for action in ("deactivate", "reactivate", "temporary-password")
        ],
    ]
    before = snapshot(auth_engine)
    for method, path, body in calls:
        denied = api.request(method, path, json=body, headers=headers(result))
        assert denied.status_code == 403
        assert denied.json()["code"] == ("PASSWORD_CHANGE_REQUIRED" if restricted else "FORBIDDEN")
        assert set(denied.json()) == {"code", "message", "request_id"}
    assert snapshot(auth_engine) == before
    api.cookies.clear()
    for method, path, body in calls:
        assert api.request(method, path, json=body, headers=headers(result)).status_code == 401


@pytest.mark.integration
def test_create_projection_validation_and_case_sensitive_uniqueness(
    api, auth_engine, manager, caplog
):
    payload = creation(auth_engine)
    before = snapshot(auth_engine)
    invalid = [payload | {key: None} for key in payload]
    invalid += [
        {key: value for key, value in payload.items() if key != missing} for missing in payload
    ]
    invalid += [
        payload | {"display_name": value}
        for value in ("", " " * 3, "名" * 101, "名\n", "名\x00", "\ud800")
    ]
    invalid += [payload | {"login_id": value} for value in (" space", "日本語", "a" * 101, "abc\n")]
    invalid += [payload | {"role": "admin"}, payload | {"department_id": str(uuid4())}]
    invalid += [
        payload | {key: "forged-secret"}
        for key in (
            "active",
            "actor",
            "hash",
            "can_manage_accounts",
            "must_change_password",
            "row_version",
            "password",
            "request_id",
            "target",
            "user_id",
        )
    ]
    for body in invalid:
        denied = api.post(
            ROOT,
            content=json.dumps(body),
            headers={**headers(manager), "Content-Type": "application/json"},
        )
        assert denied.status_code == 422
        assert "forged-secret" not in denied.text + caplog.text
    assert snapshot(auth_engine) == before
    with Session(auth_engine) as session, session.begin():
        session.execute(
            update(Department)
            .where(Department.id == UUID(payload["department_id"]))
            .values(active=False)
        )
    assert api.post(ROOT, json=payload, headers=headers(manager)).status_code == 422
    with Session(auth_engine) as session, session.begin():
        session.execute(
            update(Department)
            .where(Department.id == UUID(payload["department_id"]))
            .values(active=True)
        )
    made = api.post(ROOT, json=payload, headers=headers(manager))
    assert made.status_code == 201 and "location" not in made.headers
    issued = made.json()
    assert set(issued) == {"account", "temporary_password"}
    item, password = issued["account"], issued["temporary_password"]
    assert set(item) == ACCOUNT_KEYS and len(password) == 43
    assert item["display_name"] == "柳  太郎" and item["active"]
    assert item["must_change_password"] and not item["can_manage_accounts"]
    assert item["row_version"] == 1
    with Session(auth_engine) as session:
        saved = session.get(User, UUID(item["id"]))
        assert saved.password_hash.startswith("$argon2id$")
        assert auth.password_matches(saved.password_hash, password)
        entry = session.scalar(select(AuditEvent).where(AuditEvent.target_user_id == saved.id))
        assert entry.actor_id == ACTOR and entry.action == "create" and entry.target_version == 1
        assert str(entry.request_id) == made.headers["X-Request-ID"]
    assert api.post(ROOT, json=payload, headers=headers(manager)).json()["code"] == "LOGIN_ID_TAKEN"
    assert (
        api.post(
            ROOT,
            json=payload | {"login_id": "NEW-ACCOUNT", "role": "operator"},
            headers=headers(manager),
        ).status_code
        == 201
    )
    listing = api.get(ROOT)
    items = listing.json()["items"]
    assert listing.json()["total"] == len(items) == 4
    with Session(auth_engine) as session:
        ordered = list(session.scalars(select(User.login_id).order_by(User.login_id, User.id)))
    assert [row["login_id"] for row in items] == ordered
    assert all(set(row) == ACCOUNT_KEYS for row in items)
    history = api.get(f"{ROOT}/{item['id']}/events")
    assert password not in listing.text + history.text + caplog.text
    with TestClient(api.app) as user:
        logged = user.post(
            "/api/v1/auth/login",
            json={"login_id": item["login_id"], "password": password},
            headers={"Origin": ORIGIN},
        )
        assert logged.status_code == 200
        assert user.get(ROOT).json()["code"] == "PASSWORD_CHANGE_REQUIRED"


@pytest.mark.integration
@pytest.mark.parametrize("restricted", [False, True])
def test_deactivate_reactivate_preserves_hash_flags_and_old_sessions(
    api, auth_engine, manager, restricted
):
    with Session(auth_engine) as session, session.begin():
        session.execute(
            update(User)
            .where(User.id == TARGET)
            .values(must_change_password=restricted, department_id=None)
        )
    with TestClient(api.app) as other:
        assert login(other, "operator").status_code == 200
        assert (
            mutate(api, manager, "deactivate", target=ACTOR).json()["code"]
            == "SELF_DEACTIVATION_FORBIDDEN"
        )
        with Session(auth_engine) as session:
            encoded = session.get(User, TARGET).password_hash
        result = mutate(api, manager, "deactivate")
        assert result.status_code == 200 and result.json()["row_version"] == 2
        assert not result.json()["active"] and result.json()["department"] is None
        assert other.get("/api/v1/auth/me").status_code == 401
        assert login(other, "operator").status_code == 401
        assert mutate(api, manager, "deactivate").json()["code"] == "VERSION_CONFLICT"
        assert mutate(api, manager, "deactivate", version=2).json()["code"] == "INVALID_STATE"
        assert (
            mutate(api, manager, "temporary-password", version=2).json()["code"]
            == "ACCOUNT_INACTIVE"
        )
        assert (
            api.post(
                ROOT, json=creation(auth_engine, login_id="operator"), headers=headers(manager)
            ).json()["code"]
            == "LOGIN_ID_TAKEN"
        )
        assert api.get(f"{ROOT}/{TARGET}/events").status_code == 200
        result = mutate(api, manager, "reactivate", version=2)
        assert result.status_code == 200 and result.json()["active"]
        assert result.json()["must_change_password"] is restricted
        assert other.get("/api/v1/auth/me").status_code == 401
        assert login(other, "operator").status_code == 200
        assert mutate(api, manager, "reactivate", version=3).json()["code"] == "INVALID_STATE"
        with Session(auth_engine) as session:
            assert session.get(User, TARGET).password_hash == encoded
            entries = session.scalars(select(AuditEvent).order_by(AuditEvent.target_version)).all()
            assert [(x.action, x.target_version) for x in entries] == [
                ("deactivate", 2),
                ("reactivate", 3),
            ]


@pytest.mark.integration
@pytest.mark.parametrize("self_target", [False, True])
def test_reissue_revokes_all_target_sessions_and_self_cookie(
    api, auth_engine, manager, self_target, caplog
):
    target, login_id = (ACTOR, "employee") if self_target else (TARGET, "operator")
    with TestClient(api.app) as first, TestClient(api.app) as second:
        assert login(first, login_id).status_code == login(second, login_id).status_code == 200
        before = snapshot(auth_engine)
        result = mutate(api, manager, "temporary-password", target=target)
        assert result.status_code == 200
        assert (api.cookies.get(auth.COOKIE_NAME) is None) is self_target
        issued = result.json()
        password = issued["temporary_password"]
        assert len(password) == 43 and issued["account"]["must_change_password"]
        for client in (first, second):
            assert client.get("/api/v1/auth/me").status_code == 401
            assert login(client, login_id).status_code == 401
        logged = first.post(
            "/api/v1/auth/login",
            json={"login_id": login_id, "password": password},
            headers={"Origin": ORIGIN},
        )
        assert logged.status_code == 200
        assert first.get(ROOT).json()["code"] == "PASSWORD_CHANGE_REQUIRED"
        with Session(auth_engine) as session:
            saved = session.get(User, target)
            assert auth.password_matches(saved.password_hash, password)
            entry = session.scalar(select(AuditEvent))
            assert entry.action == "reissue" and entry.target_user_id == target
            assert (
                entry.actor_id == ACTOR and str(entry.request_id) == result.headers["X-Request-ID"]
            )
        if not self_target:
            assert api.get("/api/v1/auth/me").status_code == 200
            denied = mutate(api, manager, "temporary-password")
            assert denied.json()["code"] == "VERSION_CONFLICT" and password not in denied.text
            assert password not in api.get(ROOT).text + api.get(f"{ROOT}/{target}/events").text
        assert snapshot(auth_engine) != before
        assert password not in caplog.text


@pytest.mark.integration
def test_input_errors_empty_history_and_stable_pagination(api, auth_engine, manager):
    before = snapshot(auth_engine)
    assert api.get(ROOT + "?q=x").status_code == 422
    assert api.request("GET", ROOT, content=b"{}").status_code == 422
    assert api.request("GET", f"{ROOT}/{TARGET}/events", content=b"{}").status_code == 422
    for suffix in ("?q=x", "?page=0", "?page_size=101", "?page=x", "?page_size=0"):
        assert api.get(f"{ROOT}/{TARGET}/events{suffix}").status_code == 422
    for action in ("deactivate", "reactivate", "temporary-password"):
        assert mutate(api, manager, action, target=uuid4()).status_code == 404
        assert mutate(api, manager, action, target="bad").status_code == 422
        for version in (True, "1", 1.0, None, 0):
            assert mutate(api, manager, action, version=version).status_code == 422
        assert mutate(api, manager, action, active=False).status_code == 422
        assert (
            api.post(
                f"{ROOT}/{TARGET}/{action}",
                json={"expected_version": 1},
                headers={"Origin": ORIGIN},
            ).json()["code"]
            == "CSRF_FAILED"
        )
        assert (
            api.post(
                f"{ROOT}/{TARGET}/{action}", content="{}", headers=headers(manager)
            ).status_code
            == 422
        )
    assert api.get(f"{ROOT}/{uuid4()}/events").status_code == 404
    empty = api.get(f"{ROOT}/{TARGET}/events?page=999").json()
    assert empty == {"items": [], "page": 1, "page_size": 20, "page_count": 1, "total": 0}
    assert snapshot(auth_engine) == before
    now = datetime.now(UTC)
    with Session(auth_engine) as session, session.begin():
        for index in range(1, 6):
            session.add(
                AuditEvent(
                    id=UUID(int=1000 + index),
                    actor_id=None if index == 1 else ACTOR,
                    target_user_id=TARGET,
                    action="management_granted" if index == 1 else "reissue",
                    occurred_at=now,
                    request_id=uuid4(),
                    target_version=index,
                )
            )
    statements = []

    def capture(connection, cursor, statement, parameters, context, executemany):
        if "audit_events" in statement:
            statements.append(statement)

    event.listen(auth_engine, "before_cursor_execute", capture)
    try:
        page = api.get(f"{ROOT}/{TARGET}/events?page=99&page_size=2").json()
    finally:
        event.remove(auth_engine, "before_cursor_execute", capture)
    assert len(statements) == 1
    assert (page["page"], page["page_count"], page["total"]) == (3, 3, 5)
    assert [row["id"] for row in page["items"]] == [str(UUID(int=1001))]
    assert page["items"][0]["actor"] is None
    first = api.get(f"{ROOT}/{TARGET}/events?page_size=2").json()
    assert [row["id"] for row in first["items"]] == [str(UUID(int=1005)), str(UUID(int=1004))]
    assert set(first["items"][0]) == {
        "id",
        "actor",
        "target_user_id",
        "action",
        "occurred_at",
        "request_id",
    }
    assert set(first["items"][0]["actor"]) == {"id", "display_name"}

    def commit_during_read(connection, cursor, statement, parameters, context, executemany):
        if "ranked_events AS" in statement:
            with Session(auth_engine) as concurrent, concurrent.begin():
                concurrent.add(
                    AuditEvent(
                        actor_id=ACTOR,
                        target_user_id=TARGET,
                        action="reissue",
                        occurred_at=now,
                        request_id=uuid4(),
                        target_version=6,
                    )
                )

    event.listen(auth_engine, "after_cursor_execute", commit_during_read)
    try:
        consistent = api.get(f"{ROOT}/{TARGET}/events?page_size=100").json()
    finally:
        event.remove(auth_engine, "after_cursor_execute", commit_during_read)
    assert consistent["total"] == len(consistent["items"]) == 5
    assert api.get(f"{ROOT}/{TARGET}/events").json()["total"] == 6


@pytest.mark.integration
@pytest.mark.parametrize("action", ["create", "deactivate", "reactivate", "temporary-password"])
def test_management_audit_failure_rolls_back_state_sessions_and_event(
    api, auth_engine, manager, action, caplog
):
    if action == "reactivate":
        assert mutate(api, manager, "deactivate").status_code == 200
    else:
        with TestClient(api.app) as other:
            assert login(other, "operator").status_code == 200
    before = snapshot(auth_engine)

    def fail_audit(connection, cursor, statement, parameters, context, executemany):
        if "INSERT INTO" in statement and "audit_events" in statement:
            connection.exec_driver_sql("SELECT 1/0")

    event.listen(auth_engine, "before_cursor_execute", fail_audit)
    try:
        result = (
            api.post(ROOT, json=creation(auth_engine), headers=headers(manager))
            if action == "create"
            else mutate(api, manager, action, version=2 if action == "reactivate" else 1)
        )
        assert result.status_code == 503 and "set-cookie" not in result.headers
        assert "temporary_password" not in result.text
        assert result.json()["request_id"] == result.headers["X-Request-ID"]
        assert "division" not in result.text + caplog.text
    finally:
        event.remove(auth_engine, "before_cursor_execute", fail_audit)
    assert snapshot(auth_engine) == before


@pytest.mark.integration
@pytest.mark.parametrize("action", ["create", "temporary-password"])
def test_lost_issued_response_is_not_replayed(api, auth_engine, manager, monkeypatch, action):
    real_commit = Session.commit

    def lost_response(session):
        real_commit(session)
        raise RuntimeError("確定後の応答喪失")

    with monkeypatch.context() as patch:
        patch.setattr(Session, "commit", lost_response)
        failed = (
            api.post(ROOT, json=creation(auth_engine), headers=headers(manager))
            if action == "create"
            else mutate(api, manager, action)
        )
        assert failed.status_code == 500 and "temporary_password" not in failed.text
    listing = api.get(ROOT)
    target = next(
        row
        for row in listing.json()["items"]
        if row["login_id"] == ("new-account" if action == "create" else "operator")
    )
    assert target["row_version"] == (1 if action == "create" else 2)
    history = api.get(f"{ROOT}/{target['id']}/events")
    assert history.json()["total"] == 1 and "temporary_password" not in history.text + listing.text
    repeated = (
        api.post(ROOT, json=creation(auth_engine), headers=headers(manager))
        if action == "create"
        else mutate(api, manager, action)
    )
    assert repeated.status_code == 409
    assert api.get(f"{ROOT}/{target['id']}/events").json()["total"] == 1
    assert (
        mutate(
            api, manager, "temporary-password", target=target["id"], version=target["row_version"]
        ).status_code
        == 200
    )


@pytest.mark.integration
def test_management_lock_timeout_rolls_back(api, auth_engine, manager):
    before = snapshot(auth_engine)

    def short_session():
        with Session(auth_engine) as session:
            session.execute(text("SET LOCAL lock_timeout = '100ms'"))
            yield session

    api.app.dependency_overrides[get_session] = short_session
    try:
        with Session(auth_engine) as blocking:
            auth.lock_users(blocking, {TARGET})
            assert mutate(api, manager, "temporary-password").status_code == 503
    finally:
        api.app.dependency_overrides.clear()
    assert snapshot(auth_engine) == before


def direct_request(app, token, csrf):
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": ROOT,
            "headers": [
                (b"origin", ORIGIN.encode()),
                (b"content-type", b"application/json"),
                (b"cookie", f"{auth.COOKIE_NAME}={token}".encode()),
                (b"x-csrf-token", csrf.encode()),
            ],
            "app": app,
        }
    )
    request.state.request_id = uuid4()
    return request


def wait_for_pg_lock(engine, pid):
    with engine.connect() as connection:
        for _ in range(1000):
            if connection.scalar(
                text("SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=:pid"),
                {"pid": pid},
            ):
                return
    pytest.fail("後続処理が実際のPGロック待機に入りませんでした。")


@pytest.mark.integration
@pytest.mark.parametrize(
    "first,second",
    [
        ("login", "deactivate"),
        ("deactivate", "login"),
        ("login", "reissue"),
        ("reissue", "login"),
        ("password", "reissue"),
        ("reissue", "password"),
        ("deactivate", "reissue"),
        ("reissue", "deactivate"),
        ("reissue", "reissue"),
        ("mutual-a", "mutual-b"),
        ("mutual-b", "mutual-a"),
    ],
)
def test_management_serializes_with_login_change_and_mutual_managers(
    api, auth_engine, manager, monkeypatch, first, second
):
    with Session(auth_engine) as session, session.begin():
        session.execute(update(User).where(User.id == TARGET).values(can_manage_accounts=True))
    actor_request = direct_request(
        api.app, api.cookies.get(auth.COOKIE_NAME), manager.json()["csrf_token"]
    )
    with TestClient(api.app) as other:
        logged = login(other, "operator")
        target_request = direct_request(
            api.app, other.cookies.get(auth.COOKIE_NAME), logged.json()["csrf_token"]
        )
    locked, waiting, release = Event(), Event(), Event()
    real_lock, pids, sets = auth.lock_users, {}, []

    def ordered_lock(session, ids):
        name = current_thread().name
        sets.append((name, ids))
        if name == "second-op":
            pids["second"] = session.scalar(text("SELECT pg_backend_pid()"))
            waiting.set()
        users = real_lock(session, ids)
        if name == "first-op":
            locked.set()
            assert release.wait(8)
        return users

    monkeypatch.setattr(auth, "lock_users", ordered_lock)
    monkeypatch.setattr(accounts, "lock_users", ordered_lock)

    def call(name, operation):
        current_thread().name = name
        with Session(auth_engine) as session:
            try:
                if operation == "login":
                    auth.login(
                        auth.LoginInput(login_id="operator", password=DEMO_PASSWORD),
                        Request(
                            {**target_request.scope, "headers": [(b"origin", ORIGIN.encode())]}
                        ),
                        Response(),
                        session,
                        None,
                        None,
                    )
                    return 200, None
                if operation == "password":
                    cached = auth.get_auth(session, target_request.cookies[auth.COOKIE_NAME])
                    current = auth.get_write_auth(target_request, session, cached, None)
                    auth.change_password(
                        auth.PasswordChangeInput(
                            current_password=DEMO_PASSWORD, new_password=NEW_PASSWORD
                        ),
                        target_request,
                        Response(),
                        current,
                        session,
                        None,
                    )
                    return 204, None
                request = target_request if operation == "mutual-b" else actor_request
                cached = auth.get_auth(session, request.cookies[auth.COOKIE_NAME])
                result = accounts.change_account(
                    "reissue" if operation.startswith("mutual") else operation,
                    ACTOR if operation == "mutual-b" else TARGET,
                    accounts.VersionInput(expected_version=1),
                    request,
                    Response(),
                    cached,
                    session,
                )
                return 200, result
            except ApiError as error:
                return error.status, error.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(call, "first-op", first)
        assert locked.wait(5)
        two = pool.submit(call, "second-op", second)
        try:
            assert waiting.wait(5)
            wait_for_pg_lock(auth_engine, pids["second"])
        finally:
            release.set()
        first_result, second_result = one.result(timeout=10), two.result(timeout=10)
    assert first_result[0] == (204 if first == "password" else 200)
    expected = (
        200
        if first == "login"
        else 401
        if second in ("login", "password") or second.startswith("mutual")
        else 409
    )
    assert second_result[0] == expected
    for name, ids in sets:
        operation = first if name == "first-op" else second
        assert ids == ({TARGET} if operation in ("login", "password") else {ACTOR, TARGET})
    with Session(auth_engine) as session:
        revoked = ACTOR if first == "mutual-b" else TARGET
        assert not session.scalars(select(AuthSession).where(AuthSession.user_id == revoked)).all()
        entries = session.scalars(select(AuditEvent)).all()
        assert len(entries) == 1


@pytest.mark.integration
@pytest.mark.parametrize(
    "changed,code",
    [
        ("session", "AUTHENTICATION_REQUIRED"),
        ("expiry", "AUTHENTICATION_REQUIRED"),
        ("active", "AUTHENTICATION_REQUIRED"),
        ("csrf", "CSRF_FAILED"),
        ("permission", "FORBIDDEN"),
        ("restricted", "PASSWORD_CHANGE_REQUIRED"),
    ],
)
def test_waiting_management_rechecks_actor_session_csrf_and_permission(
    api, auth_engine, manager, monkeypatch, changed, code
):
    request = direct_request(
        api.app, api.cookies.get(auth.COOKIE_NAME), manager.json()["csrf_token"]
    )
    waiting, pid = Event(), {}
    real_lock = accounts.lock_users

    def discover_wait(session, ids):
        pid["value"] = session.scalar(text("SELECT pg_backend_pid()"))
        waiting.set()
        return real_lock(session, ids)

    monkeypatch.setattr(accounts, "lock_users", discover_wait)

    def call():
        with Session(auth_engine) as session:
            cached = auth.get_auth(session, request.cookies[auth.COOKIE_NAME])
            try:
                accounts.change_account(
                    "reissue",
                    TARGET,
                    accounts.VersionInput(expected_version=1),
                    request,
                    Response(),
                    cached,
                    session,
                )
            except ApiError as error:
                return error.code

    with ThreadPoolExecutor(max_workers=1) as pool, Session(auth_engine) as blocking:
        actor = auth.lock_users(blocking, {ACTOR})[ACTOR]
        result = pool.submit(call)
        try:
            assert waiting.wait(5)
            wait_for_pg_lock(auth_engine, pid["value"])
            if changed == "session":
                blocking.execute(delete(AuthSession).where(AuthSession.user_id == ACTOR))
            elif changed == "expiry":
                blocking.execute(
                    update(AuthSession)
                    .where(AuthSession.user_id == ACTOR)
                    .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
                )
            elif changed == "csrf":
                blocking.execute(
                    update(AuthSession)
                    .where(AuthSession.user_id == ACTOR)
                    .values(csrf_token_hash="0" * 64)
                )
            elif changed == "active":
                actor.active = False
            elif changed == "permission":
                actor.can_manage_accounts = False
            else:
                actor.must_change_password = True
        finally:
            blocking.commit()
        assert result.result(timeout=8) == code
    with Session(auth_engine) as session:
        assert session.get(User, TARGET).row_version == 1
        assert session.scalar(select(AuditEvent)) is None


@pytest.mark.integration
def test_concurrent_creates_use_database_unique_constraint(api, auth_engine, manager, monkeypatch):
    with Session(auth_engine) as session, session.begin():
        session.execute(update(User).where(User.id == TARGET).values(can_manage_accounts=True))
    first_request = direct_request(
        api.app, api.cookies.get(auth.COOKIE_NAME), manager.json()["csrf_token"]
    )
    with TestClient(api.app) as other:
        logged = login(other, "operator")
        second_request = direct_request(
            api.app, other.cookies.get(auth.COOKIE_NAME), logged.json()["csrf_token"]
        )
    barrier = Barrier(2)
    real_password = accounts.temporary_password

    def together(encoded=None):
        barrier.wait(timeout=8)
        return real_password(encoded)

    monkeypatch.setattr(accounts, "temporary_password", together)
    data = accounts.CreateAccountInput(**creation(auth_engine))

    def call(request):
        with Session(auth_engine) as session:
            cached = auth.get_auth(session, request.cookies[auth.COOKIE_NAME])
            try:
                accounts.create_account(data, request, cached, session)
                return 201
            except ApiError as error:
                assert error.code == "LOGIN_ID_TAKEN"
                return error.status

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(call, [first_request, second_request]))
    assert sorted(results) == [201, 409]
    with Session(auth_engine) as session:
        assert len(session.scalars(select(User).where(User.login_id == data.login_id)).all()) == 1
        assert len(session.scalars(select(AuditEvent)).all()) == 1


@pytest.mark.integration
def test_unrelated_integrity_error_is_not_login_id_conflict(api, auth_engine, manager, monkeypatch):
    real_record = accounts.record_event

    def invalid_event(session, request, actor, target, action):
        real_record(session, request, actor, target, action)
        session.add(
            AuditEvent(
                actor_id=actor.id,
                target_user_id=target.id,
                action="create",
                occurred_at=datetime.now(UTC),
                request_id=uuid4(),
                target_version=0,
            )
        )

    monkeypatch.setattr(accounts, "record_event", invalid_event)
    before = snapshot(auth_engine)
    result = api.post(ROOT, json=creation(auth_engine), headers=headers(manager))
    assert result.status_code == 503 and result.json()["code"] == "SERVICE_UNAVAILABLE"
    assert snapshot(auth_engine) == before
