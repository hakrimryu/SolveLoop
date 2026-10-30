import os
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

import pytest
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import delete, func, inspect, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from test_foundation import local_settings

from app.auth import (
    COOKIE_NAME,
    csrf_token,
    password_hasher,
    require_csrf,
    require_operator,
    token_hash,
)
from app.config import load_settings
from app.database import build_engine
from app.main import create_app
from app.models import AuditEvent, AuthSession, Base, Department, User
from app.seed import DEMO_PASSWORD, seed_auth

ORIGIN = "http://127.0.0.1:8000"


def test_password_and_token_hashes() -> None:
    encoded = password_hasher.hash(DEMO_PASSWORD)
    assert encoded.startswith("$argon2id$")
    assert password_hasher.verify(encoded, DEMO_PASSWORD)
    with pytest.raises(VerifyMismatchError):
        password_hasher.verify(encoded, "wrong")
    assert csrf_token("a" * 43) != token_hash("a" * 43)
    assert csrf_token("a" * 43) == csrf_token("a" * 43)


def test_invalid_json_settings_hide_values(monkeypatch):
    monkeypatch.setenv("AUTH_ALLOWED_ORIGINS", "private-invalid-json")
    with pytest.raises(RuntimeError) as error:
        load_settings()
    assert "private-invalid-json" not in str(error.value)


@pytest.mark.parametrize(
    "origins",
    [
        [],
        ["*"],
        ["null"],
        ["http://localhost/"],
        ["http://name:secret@localhost"],
        ["http://localhost:invalid"],
        ["http://localhost#"],
    ],
)
def test_invalid_origins(origins) -> None:
    with pytest.raises(ValidationError):
        local_settings(auth_allowed_origins=origins)


def test_origin_and_validation_reject_without_db_or_secret_leak() -> None:
    with TestClient(create_app(local_settings())) as client:
        for headers in ({}, {"Origin": "null"}, {"Origin": "https://evil.example"}):
            result = client.post(
                "/api/v1/auth/login",
                json={"login_id": "employee", "password": "secret"},
                headers=headers,
            )
            assert result.status_code == 403
            assert result.json()["code"] == "CSRF_FAILED"
        result = client.post(
            "/api/v1/auth/login",
            json={"login_id": "employee", "password": {"secret": "private"}},
            headers={"Origin": ORIGIN},
        )
        assert result.status_code == 422
        assert "private" not in result.text
        result = client.post(
            "/api/v1/auth/login",
            json={"login_id": "employee", "password": "private"},
            headers={"Origin": ORIGIN},
        )
        assert result.status_code == 503
        assert "private" not in result.text
        assert result.headers["cache-control"] == "no-store"


@pytest.fixture(scope="module")
def auth_engine():
    if os.getenv("RUN_DB_TESTS") != "1":
        pytest.skip("専用DBでのみ実行します。")
    settings = load_settings()
    assert settings.postgres_db == "solveloop_test", "専用の空DBを指定してください。"
    engine = build_engine(settings)
    # 基盤テストのpublicを変更せず、認証の各ケースを独立したスキーマで実行する。
    # [ko] 기반 테스트의 public을 변경하지 않고 인증 사례마다 독립 스키마에서 실행한다.
    # [en] Isolate authentication cases in separate schemas without changing foundation test tables.
    with engine.begin() as connection:
        connection.execute(text("CREATE SCHEMA solveloop_auth_test"))
    mapped = engine.execution_options(schema_translate_map={None: "solveloop_auth_test"})
    try:
        Base.metadata.create_all(mapped)
        yield mapped
    finally:
        with engine.begin() as connection:
            connection.execute(text("DROP SCHEMA solveloop_auth_test CASCADE"))
        engine.dispose()


@pytest.fixture
def api(auth_engine):
    with Session(auth_engine) as session, session.begin():
        session.execute(delete(AuditEvent))
        session.execute(delete(AuthSession))
        session.execute(delete(User))
        session.execute(delete(Department))
        seed_auth(session)
    app = create_app(load_settings())
    app.state.engine.dispose()
    app.state.engine = auth_engine

    @app.get("/test/operator")
    def operator_only(user: Annotated[User, Depends(require_operator)]):
        return {"role": user.role}

    @app.post("/test/write", dependencies=[Depends(require_csrf)])
    def protected_write():
        return {"status": "ok"}

    with TestClient(app) as client:
        yield client


def login(api, login_id="employee", **extra):
    return api.post(
        "/api/v1/auth/login",
        json={"login_id": login_id, "password": DEMO_PASSWORD, **extra},
        headers={"Origin": ORIGIN},
    )


@pytest.mark.integration
@pytest.mark.parametrize("role", ["employee", "operator"])
def test_login_me_reference_data_and_logout(api, auth_engine, role):
    assert api.get("/api/v1/auth/me").status_code == 401
    assert api.get("/api/v1/reference-data").status_code == 401
    result = login(api, role)
    assert result.status_code == 200
    body = result.json()
    assert body["user"]["role"] == role
    assert set(body["user"]) == {
        "id",
        "display_name",
        "role",
        "department",
        "can_manage_accounts",
        "must_change_password",
    }
    assert body["user"]["can_manage_accounts"] is False
    assert body["user"]["must_change_password"] is False
    assert datetime.fromisoformat(body["expires_at"].replace("Z", "+00:00")) > datetime.now(
        UTC
    ) + timedelta(hours=7)
    cookie = result.headers["set-cookie"]
    for attribute in ("HttpOnly", "SameSite=lax", "Path=/", "Max-Age=28800"):
        assert attribute in cookie
    assert "Domain=" not in cookie
    assert "Secure" not in cookie
    token = api.cookies.get(COOKIE_NAME)
    assert len(token) == 43
    assert token not in result.text
    for field in ("password_hash", "token_hash", "csrf_token_hash", "login_id"):
        assert field not in result.text
    with Session(auth_engine) as session:
        stored = session.scalar(select(AuthSession))
        assert stored.token_hash == token_hash(token)
        assert stored.csrf_token_hash == token_hash(body["csrf_token"])
    assert api.get("/api/v1/auth/me").json() == body["user"]
    assert api.get("/api/v1/auth/csrf").json()["csrf_token"] == body["csrf_token"]
    ref = api.get("/api/v1/reference-data")
    assert ref.headers["cache-control"] == "no-store"
    assert len(ref.json()["departments"]) == 4
    assert ("operators" in ref.json()) == (role == "operator")
    if role == "operator":
        assert set(ref.json()["operators"][0]) == {"id", "display_name"}
    assert api.get("/test/operator").status_code == (200 if role == "operator" else 403)
    headers = {"Origin": ORIGIN, "X-CSRF-Token": body["csrf_token"]}
    assert api.post("/test/write", headers=headers).status_code == 200
    assert api.post("/api/v1/auth/logout", headers=headers).status_code == 204
    assert api.cookies.get(COOKIE_NAME) is None
    api.cookies.set(COOKIE_NAME, token)
    assert api.get("/api/v1/auth/me").status_code == 401
    assert api.post("/test/write", headers=headers).status_code == 401


@pytest.mark.integration
def test_secure_cookie_is_emitted(api):
    api.app.state.settings.auth_cookie_secure = True
    response = login(api)
    assert response.status_code == 200
    assert "; Secure" in response.headers["set-cookie"]


@pytest.mark.integration
def test_reference_filters_inactive_and_session_reads_current_role(api, auth_engine):
    login(api, "operator")
    with Session(auth_engine) as session, session.begin():
        session.execute(update(Department).where(Department.code == "HR").values(active=False))
        session.execute(
            update(User)
            .where(User.login_id == "operator")
            .values(role="employee", department_id=None)
        )
    result = api.get("/api/v1/reference-data").json()
    assert len(result["departments"]) == 3
    assert "operators" not in result
    assert api.get("/api/v1/auth/me").json()["department"] is None
    assert api.get("/test/operator").status_code == 403
    api.cookies.clear()
    api.cookies.set(COOKIE_NAME, "x" * 43)
    assert api.get("/api/v1/auth/me").status_code == 401


@pytest.mark.integration
def test_sessions_survive_application_restart(api, auth_engine):
    login(api)
    token = api.cookies.get(COOKIE_NAME)
    restarted = create_app(load_settings())
    restarted.state.engine.dispose()
    restarted.state.engine = auth_engine
    with TestClient(restarted) as client:
        client.cookies.set(COOKIE_NAME, token)
        assert client.get("/api/v1/auth/me").json()["role"] == "employee"


@pytest.mark.integration
def test_login_failures_rotation_expiry_and_deactivation(api, auth_engine):
    first = login(api).json()
    old_token = api.cookies.get(COOKIE_NAME)
    results = []
    for login_id in ("employee", "missing"):
        response = api.post(
            "/api/v1/auth/login",
            json={"login_id": login_id, "password": "wrong"},
            headers={"Origin": ORIGIN},
        )
        assert response.status_code == 401
        results.append((response.json()["code"], response.json()["message"]))
    assert results[0] == results[1]
    assert api.get("/api/v1/auth/me").status_code == 200
    for key in ("role", "user_id", "active"):
        assert login(api, **{key: "operator"}).status_code == 422
    second = login(api, "operator").json()
    new_token = api.cookies.get(COOKIE_NAME)
    assert old_token != new_token
    assert second["csrf_token"] != first["csrf_token"]
    api.cookies.clear()
    api.cookies.set(COOKIE_NAME, old_token)
    assert api.get("/api/v1/auth/me").status_code == 401
    api.cookies.clear()
    api.cookies.set(COOKIE_NAME, new_token)
    with Session(auth_engine) as session, session.begin():
        session.execute(update(User).where(User.login_id == "operator").values(active=False))
    assert api.get("/api/v1/auth/me").status_code == 401
    assert login(api, "operator").status_code == 401
    login(api)
    with Session(auth_engine) as session, session.begin():
        session.execute(
            update(AuthSession).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
    assert api.get("/api/v1/auth/me").status_code == 401
    assert api.get("/api/v1/auth/csrf").status_code == 401
    assert (
        api.post(
            "/api/v1/auth/logout", headers={"Origin": ORIGIN, "X-CSRF-Token": first["csrf_token"]}
        ).status_code
        == 401
    )
    login(api)
    with Session(auth_engine) as session:
        assert session.scalar(select(func.count()).select_from(AuthSession)) == 1


@pytest.mark.integration
def test_csrf_origin_and_cross_session_rejection(api):
    first = login(api).json()["csrf_token"]
    second = login(api).json()["csrf_token"]
    for headers in (
        {},
        {"Origin": ORIGIN},
        {"Origin": ORIGIN, "X-CSRF-Token": "x" * 64},
        {"Origin": ORIGIN, "X-CSRF-Token": first},
        {"Origin": "https://evil.example", "X-CSRF-Token": second},
        {"Origin": ORIGIN + ".evil.example", "X-CSRF-Token": second},
    ):
        result = api.post("/api/v1/auth/logout", headers=headers)
        assert result.status_code == 403
        assert result.json()["code"] == "CSRF_FAILED"
        UUID(result.json()["request_id"])
    assert api.get("/api/v1/auth/me").status_code == 200


@pytest.mark.integration
def test_seed_is_additive_and_transactional(api, auth_engine):
    with Session(auth_engine) as session, session.begin():
        before = session.scalar(select(User).where(User.login_id == "employee"))
        original_hash = before.password_hash
        before.display_name = "変更済み"
        before.active = False
        seed_auth(session)
        seed_auth(session)
    with Session(auth_engine) as session:
        assert session.scalar(select(func.count()).select_from(User)) == 2
        assert session.scalar(select(func.count()).select_from(Department)) == 4
        saved = session.scalar(select(User).where(User.login_id == "employee"))
        assert saved.display_name == "変更済み" and not saved.active
        assert saved.password_hash == original_hash
    with Session(auth_engine) as session, session.begin():
        session.execute(delete(User))
        session.execute(delete(Department))
    with Session(auth_engine) as session:
        seed_auth(session)
        session.rollback()
    with Session(auth_engine) as session:
        assert session.scalar(select(func.count()).select_from(User)) == 0
        assert session.scalar(select(func.count()).select_from(Department)) == 0


@pytest.mark.integration
def test_db_constraints_and_model_schema(api, auth_engine):
    for statement in (
        update(User).where(User.login_id == "employee").values(role="admin"),
        update(User).where(User.login_id == "employee").values(department_id=UUID(int=99999)),
        update(User).where(User.login_id == "employee").values(login_id="operator"),
        delete(Department),
    ):
        with pytest.raises(IntegrityError), Session(auth_engine) as session, session.begin():
            session.execute(statement)
    assert set(inspect(auth_engine).get_table_names(schema="solveloop_auth_test")) == {
        "departments",
        "users",
        "sessions",
        "audit_events",
        "tickets",
        "ticket_events",
        "idempotency_records",
        "knowledge_documents",
        "knowledge_versions",
        "knowledge_sources",
        "knowledge_events",
    }


def test_secure_cookie_and_no_raw_password_validation() -> None:
    app = create_app(local_settings(auth_cookie_secure=True))
    assert app.state.settings.auth_cookie_secure
    with TestClient(app) as client:
        for password in ("", "x" * 257, {"password": "secret"}):
            result = client.post(
                "/api/v1/auth/login",
                json={"login_id": "employee", "password": password},
                headers={"Origin": ORIGIN},
            )
            assert result.status_code == 422
            assert "secret" not in result.text
