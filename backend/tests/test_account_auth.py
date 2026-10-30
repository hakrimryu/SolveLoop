import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event, current_thread
from typing import Annotated
from uuid import UUID

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, func, inspect, select, text, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from test_auth import ORIGIN, login
from test_auth import api as api
from test_auth import auth_engine as auth_engine
from test_foundation import local_settings

from app import accounts, auth
from app.accounts import bootstrap_manager
from app.auth import COOKIE_NAME, PUBLIC_DEMO_PASSWORDS, require_account_manager
from app.main import create_app
from app.models import AuditEvent, AuthSession, User
from app.seed import DEMO_PASSWORD, seed_auth

NEW_PASSWORD = "本人専用の長いパスワード・検証用2026"


def headers(result):
    return {"Origin": ORIGIN, "X-CSRF-Token": result.json()["csrf_token"]}


def change(client, result, current=DEMO_PASSWORD, new=NEW_PASSWORD, **extra):
    return client.post(
        "/api/v1/auth/password/change",
        json={"current_password": current, "new_password": new, **extra},
        headers=headers(result),
    )


def state(engine):
    with Session(engine) as session:
        user = session.get(User, UUID(int=201))
        return (
            user.password_hash,
            user.active,
            user.can_manage_accounts,
            user.must_change_password,
            user.row_version,
            session.scalar(select(func.count()).select_from(AuthSession)),
            session.scalar(select(func.count()).select_from(AuditEvent)),
        )


@pytest.mark.parametrize(
    "value", ["x" * 14, "x" * 257, " " * 15, "a" * 14 + "\n", *PUBLIC_DEMO_PASSWORDS]
)
def test_new_password_policy(value):
    with pytest.raises(auth.ApiError) as error:
        auth.validate_new_password(auth.dummy_password_hash, value)
    assert error.value.code == "PASSWORD_POLICY_VIOLATION"
    assert value not in error.value.message


@pytest.mark.parametrize(
    "value", ["あ" * 15, "😀" * 15, "x" * 256, "  長いパスフレーズをそのまま使う  "]
)
def test_password_preserves_unicode_and_spaces(value):
    auth.validate_new_password(auth.dummy_password_hash, value)
    hashed = auth.password_hasher.hash(value)
    assert auth.password_matches(hashed, value)
    assert not auth.password_matches(hashed, value + "x")
    with pytest.raises(auth.ApiError):
        auth.validate_new_password(hashed, value)


def test_request_id_errors_and_unexpected_exceptions_are_sanitized(caplog):
    app = create_app(local_settings())

    @app.get("/api/test/failure")
    def failure():
        raise RuntimeError("private-password-never-log")

    with TestClient(app) as client:
        for path, status in [("/api/test/failure", 500), ("/api/missing", 404)]:
            result = client.get(path, headers={"X-Request-ID": "untrusted-client-value"})
            assert result.status_code == status
            assert result.json()["request_id"] == result.headers["X-Request-ID"]
            UUID(result.headers["X-Request-ID"])
            assert "private-password-never-log" not in result.text + caplog.text
        assert client.put("/api/v1/auth/me").json()["code"] == "METHOD_NOT_ALLOWED"
        result = client.post(
            "/api/v1/auth/login",
            content=b'{"login_id":"employee","password":"\\ud800"}',
            headers={"Origin": ORIGIN, "Content-Type": "application/json"},
        )
        assert result.status_code == 422


@pytest.mark.integration
@pytest.mark.parametrize("role", ["employee", "operator"])
@pytest.mark.parametrize("manager", [False, True])
def test_restricted_auth_and_management_are_independent(api, auth_engine, role, manager):
    with Session(auth_engine) as session, session.begin():
        session.execute(
            update(User)
            .where(User.login_id == role)
            .values(must_change_password=True, can_manage_accounts=manager)
        )

    @api.app.get("/test/manager")
    def manager_only(user: Annotated[User, Depends(require_account_manager)]):
        return {"id": str(user.id)}

    result = login(api, role)
    assert result.json()["user"]["must_change_password"] is True
    assert api.get("/api/v1/auth/me").status_code == 200
    assert api.get("/api/v1/auth/csrf").status_code == 200
    for path in ("/api/v1/reference-data", "/test/operator", "/test/manager"):
        denied = api.get(path)
        assert denied.status_code == 403
        assert denied.json()["code"] == "PASSWORD_CHANGE_REQUIRED"
    assert change(api, result).status_code == 204
    result = api.post(
        "/api/v1/auth/login",
        json={"login_id": role, "password": NEW_PASSWORD},
        headers={"Origin": ORIGIN},
    )
    assert result.status_code == 200
    assert api.get("/test/manager").status_code == (200 if manager else 403)
    assert api.get("/test/operator").status_code == (200 if role == "operator" else 403)
    assert ("operators" in api.get("/api/v1/reference-data").json()) == (role == "operator")
    assert api.post("/api/v1/auth/logout", headers=headers(result)).status_code == 204


@pytest.mark.integration
def test_password_change_revokes_all_sessions_and_records_request_id(api, auth_engine):
    first = login(api)
    first_token = api.cookies.get(COOKIE_NAME)
    api.cookies.clear()
    second = login(api)
    second_token = api.cookies.get(COOKIE_NAME)
    api.cookies.clear()
    operator = login(api, "operator")
    operator_token = api.cookies.get(COOKIE_NAME)
    api.cookies.clear()
    api.cookies.set(COOKIE_NAME, first_token, domain="testserver.local", path="/")
    result = change(api, first)
    assert result.status_code == 204 and result.content == b""
    assert api.cookies.get(COOKIE_NAME) is None
    with Session(auth_engine) as session:
        saved = session.get(User, UUID(int=201))
        assert saved.row_version == 2 and not saved.must_change_password
        assert auth.password_matches(saved.password_hash, NEW_PASSWORD)
        audit = session.scalar(select(AuditEvent))
        assert audit.actor_id == audit.target_user_id == saved.id
        assert audit.action == "password_change" and audit.target_version == 2
        assert str(audit.request_id) == result.headers["X-Request-ID"]
        assert set(AuditEvent.__table__.columns.keys()) == {
            "id",
            "actor_id",
            "target_user_id",
            "action",
            "occurred_at",
            "request_id",
            "target_version",
        }
    for token in (first_token, second_token):
        api.cookies.set(COOKIE_NAME, token)
        assert api.get("/api/v1/auth/me").status_code == 401
    api.cookies.set(COOKIE_NAME, operator_token)
    assert api.get("/api/v1/auth/me").status_code == 200
    assert change(api, operator, new=DEMO_PASSWORD).status_code == 422
    assert login(api).status_code == 401
    assert second.status_code == 200


@pytest.mark.integration
def test_invalid_changes_leave_credentials_sessions_and_events_unchanged(api, auth_engine):
    result = login(api)
    before = state(auth_engine)
    invalid = [
        {"current": "wrong"},
        {"new": DEMO_PASSWORD},
        {"new": "x" * 14},
        {"new": "x" * 257},
        {"new": " " * 15},
        {"new": "x" * 15 + "\x00"},
        *[
            {key: "forged"}
            for key in (
                "actor",
                "active",
                "can_manage_accounts",
                "must_change_password",
                "password_hash",
                "confirmation",
                "user_id",
            )
        ],
    ]
    for values in invalid:
        denied = change(api, result, **values)
        assert denied.status_code == 422
        assert state(auth_engine) == before
    for supplied in (
        {},
        {"Origin": ORIGIN},
        {"Origin": "https://evil.example", "X-CSRF-Token": result.json()["csrf_token"]},
    ):
        denied = api.post(
            "/api/v1/auth/password/change",
            json={"current_password": DEMO_PASSWORD, "new_password": NEW_PASSWORD},
            headers=supplied,
        )
        assert denied.status_code == 403
        assert state(auth_engine) == before
    assert api.get("/api/v1/auth/me").status_code == 200


@pytest.mark.integration
def test_bootstrap_and_seed_preserve_existing_credentials_and_permissions(api, auth_engine):
    login(api)
    token = api.cookies.get(COOKIE_NAME)
    before = state(auth_engine)
    with Session(auth_engine) as session, session.begin():
        assert bootstrap_manager(session, "employee")
        assert not bootstrap_manager(session, "employee")
        seed_auth(session)
    after = state(auth_engine)
    assert after == (before[0], before[1], True, before[3], 2, 0, 1)
    api.cookies.set(COOKIE_NAME, token)
    assert api.get("/api/v1/auth/me").status_code == 401
    with Session(auth_engine) as session:
        audit = session.scalar(select(AuditEvent))
        assert audit.action == "management_granted" and audit.actor_id is None
        assert audit.target_user_id == UUID(int=201)
        assert session.get(User, UUID(int=201)).role == "employee"
    for login_id in ("missing", "EMPLOYEE"):
        with pytest.raises(ValueError), Session(auth_engine) as session, session.begin():
            bootstrap_manager(session, login_id)
    with Session(auth_engine) as session, session.begin():
        session.execute(
            update(User)
            .where(User.login_id == "employee")
            .values(active=False, must_change_password=True)
        )
        seed_auth(session)
    with pytest.raises(ValueError), Session(auth_engine) as session, session.begin():
        bootstrap_manager(session, "employee")
    assert state(auth_engine)[1:4] == (False, True, True)


@pytest.mark.integration
def test_bootstrap_cli_requires_exact_target(api, auth_engine, monkeypatch, capsys):
    monkeypatch.setattr(accounts, "build_engine", lambda _: auth_engine)
    monkeypatch.setattr(sys, "argv", ["accounts", "bootstrap-manager", "--login-id", "employee"])
    accounts.main()
    assert "全セッションを終了" in capsys.readouterr().out
    accounts.main()
    assert "変更はありません" in capsys.readouterr().out
    for args in (
        ["accounts", "bootstrap-manager"],
        ["accounts", "bootstrap-manager", "--login-id", "missing"],
        ["accounts", "bootstrap-manager", "--login-id", " bad"],
    ):
        monkeypatch.setattr(sys, "argv", args)
        with pytest.raises(SystemExit) as error:
            accounts.main()
        assert error.value.code != 0


@pytest.mark.integration
def test_account_constraints_and_audit_foreign_keys(api, auth_engine):
    values = {
        "actor_id": UUID(int=201),
        "target_user_id": UUID(int=201),
        "action": "password_change",
        "target_version": 2,
        "occurred_at": datetime.now(UTC),
        "request_id": UUID(int=701),
    }
    for invalid in [
        {"actor_id": None},
        {"actor_id": UUID(int=202)},
        {"target_version": 0},
        {"target_user_id": UUID(int=99999)},
        {"action": "admin"},
        {"action": "management_granted"},
    ]:
        with pytest.raises(IntegrityError), Session(auth_engine) as session, session.begin():
            session.add(AuditEvent(**(values | invalid)))
            session.flush()
    with pytest.raises(IntegrityError), Session(auth_engine) as session, session.begin():
        session.execute(update(User).where(User.id == UUID(int=201)).values(row_version=0))
    with Session(auth_engine) as session, session.begin():
        session.add(AuditEvent(**values))
    with pytest.raises(IntegrityError), Session(auth_engine) as session, session.begin():
        session.add(AuditEvent(**values))
        session.flush()
    with pytest.raises(IntegrityError), Session(auth_engine) as session, session.begin():
        session.execute(delete(User).where(User.id == UUID(int=201)))
    indexes = inspect(auth_engine).get_indexes("audit_events", schema="solveloop_auth_test")
    assert {"ix_audit_actor_id", "ix_audit_target_time"} <= {item["name"] for item in indexes}


@pytest.mark.integration
@pytest.mark.parametrize("operation", ["password", "bootstrap"])
def test_audit_failure_rolls_back_everything(api, auth_engine, operation, caplog):
    result = login(api)
    before = state(auth_engine)

    def reject_audit(connection, cursor, statement, parameters, context, executemany):
        if "INSERT INTO" in statement and "audit_events" in statement:
            connection.exec_driver_sql("SELECT 1/0")

    event.listen(auth_engine, "before_cursor_execute", reject_audit)
    try:
        if operation == "password":
            failed = change(api, result)
            assert failed.status_code == 503
            assert failed.json()["request_id"] == failed.headers["X-Request-ID"]
            assert "set-cookie" not in failed.headers
            assert NEW_PASSWORD not in failed.text + caplog.text
        else:
            with pytest.raises(SQLAlchemyError), Session(auth_engine) as session, session.begin():
                bootstrap_manager(session, "employee")
    finally:
        event.remove(auth_engine, "before_cursor_execute", reject_audit)
    assert state(auth_engine) == before
    assert api.get("/api/v1/auth/me").status_code == 200


@pytest.mark.integration
def test_expired_cleanup_is_limited_to_locked_owners(api, auth_engine):
    with Session(auth_engine) as session, session.begin():
        session.add(
            AuthSession(
                user_id=UUID(int=202),
                token_hash="e" * 64,
                csrf_token_hash="c" * 64,
                expires_at=datetime.now(UTC) - timedelta(hours=1),
            )
        )
    assert login(api).status_code == 200
    with Session(auth_engine) as session:
        assert (
            session.scalar(select(AuthSession).where(AuthSession.token_hash == "e" * 64))
            is not None
        )


@pytest.mark.integration
def test_committed_change_with_lost_response_requires_relogin(api, auth_engine, monkeypatch):
    result = login(api)

    def lose_response(request, response):
        raise RuntimeError("応答喪失の検証")

    monkeypatch.setattr(auth, "clear_session_cookie", lose_response)
    assert change(api, result).status_code == 500
    assert state(auth_engine)[3:] == (False, 2, 0, 1)
    assert api.get("/api/v1/auth/me").status_code == 401
    assert login(api).status_code == 401
    assert (
        api.post(
            "/api/v1/auth/login",
            json={"login_id": "employee", "password": NEW_PASSWORD},
            headers={"Origin": ORIGIN},
        ).status_code
        == 200
    )


@pytest.mark.integration
def test_password_change_lock_timeout_keeps_old_credentials(api, auth_engine):
    from app.database import get_session

    result = login(api)
    before = state(auth_engine)

    def short_timeout_session():
        with Session(auth_engine) as session:
            session.execute(text("SET LOCAL lock_timeout = '100ms'"))
            yield session

    api.app.dependency_overrides[get_session] = short_timeout_session
    try:
        with Session(auth_engine) as blocking:
            auth.lock_users(blocking, {UUID(int=201)})
            denied = change(api, result)
            assert denied.status_code == 503
            assert "set-cookie" not in denied.headers
    finally:
        api.app.dependency_overrides.clear()
    assert state(auth_engine) == before


@pytest.mark.integration
def test_login_rehash_preserves_version_and_other_sessions(api, auth_engine):
    from argon2 import PasswordHasher

    first = login(api)
    old_token = api.cookies.get(COOKIE_NAME)
    with Session(auth_engine) as session, session.begin():
        user = session.get(User, UUID(int=201))
        user.password_hash = PasswordHasher(time_cost=1).hash(DEMO_PASSWORD)
    api.cookies.clear()
    assert login(api).status_code == 200
    assert state(auth_engine)[4:] == (1, 2, 0)
    api.cookies.set(COOKIE_NAME, old_token)
    assert api.get("/api/v1/auth/me").status_code == 200
    assert first.status_code == 200


@pytest.mark.integration
@pytest.mark.parametrize(
    "first,second", [("login", "password"), ("password", "login"), ("password", "password")]
)
def test_concurrent_login_and_password_change_cannot_revive_old_credentials(
    api, auth_engine, monkeypatch, first, second
):
    original = login(api)
    original_token = api.cookies.get(COOKIE_NAME)
    locked, waiting, release = Event(), Event(), Event()
    real_lock = auth.lock_users
    thread_ids = {}

    def ordered_lock(session, ids):
        name = current_thread().name
        if name == "second-operation":
            thread_ids["second"] = session.scalar(text("SELECT pg_backend_pid()"))
            waiting.set()
        users = real_lock(session, ids)
        if name == "first-operation":
            locked.set()
            assert release.wait(5)
        return users

    monkeypatch.setattr(auth, "lock_users", ordered_lock)

    def call(operation):
        # TestClientの同期ハンドラは別スレッドなので、直接関数を独立Sessionで呼び出す。
        from starlette.requests import Request
        from starlette.responses import Response

        request = Request(
            {
                "type": "http",
                "method": "POST",
                "path": "/api/v1/auth/password/change",
                "headers": [
                    (b"origin", ORIGIN.encode()),
                    (b"content-type", b"application/json"),
                    (b"x-csrf-token", original.json()["csrf_token"].encode()),
                ],
                "app": api.app,
            }
        )
        if operation == "password":
            request.scope["headers"].append((b"cookie", f"{COOKIE_NAME}={original_token}".encode()))
        request.state.request_id = UUID(int=700)
        with Session(auth_engine) as session:
            try:
                if operation == "login":
                    data = auth.LoginInput(login_id="employee", password=DEMO_PASSWORD)
                    auth.login(data, request, Response(), session, None, None)
                    return 200
                cached = auth.get_auth(session, original_token)
                current = auth.get_write_auth(request, session, cached, None)
                auth.change_password(
                    auth.PasswordChangeInput(
                        current_password=DEMO_PASSWORD, new_password=NEW_PASSWORD
                    ),
                    request,
                    Response(),
                    current,
                    session,
                    None,
                )
                return 204
            except auth.ApiError as error:
                return error.status

    def run_named(name, operation):
        current_thread().name = name
        return call(operation)

    with ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(run_named, "first-operation", first)
        assert locked.wait(5)
        two = pool.submit(run_named, "second-operation", second)
        try:
            assert waiting.wait(5)
            # 実際にPGの行ロックで待機したことを確認してから先行処理を進める。
            with auth_engine.connect() as connection:
                for _ in range(200):
                    if connection.scalar(
                        text(
                            "SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid=:pid"
                        ),
                        {"pid": thread_ids["second"]},
                    ):
                        break
                else:
                    pytest.fail("後続処理が行ロック待機に入りませんでした。")
        finally:
            release.set()
        assert one.result(timeout=8) == (200 if first == "login" else 204)
        assert two.result(timeout=8) == (204 if first == "login" else 401)
    assert state(auth_engine)[5:] == (0, 1)
    assert api.get("/api/v1/auth/me").status_code == 401
