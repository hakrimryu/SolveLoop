import json
import os
from http.cookiejar import CookieJar
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener
from uuid import UUID

import pytest

BASE_URL = os.getenv("AUTH_TEST_BASE_URL", "")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not BASE_URL, reason="専用の起動済みAPIを指定してください。"),
]


def http_client():
    cookies = CookieJar()
    client = build_opener(HTTPCookieProcessor(cookies))

    def call(path, data=None, csrf=None):
        headers = {"Origin": "http://127.0.0.1:8000"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if csrf:
            headers["X-CSRF-Token"] = csrf
        request = Request(
            BASE_URL + "/api/v1" + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers=headers,
        )
        try:
            result = client.open(request, timeout=10)
        except HTTPError as error:
            result = error
        with result:
            body = result.read()
            assert result.headers["Cache-Control"] == "no-store"
            UUID(result.headers["X-Request-ID"])
            value = json.loads(body) if body else None
            if result.status >= 400:
                assert value["request_id"] == result.headers["X-Request-ID"]
            return result.status, value

    return call


@pytest.mark.parametrize("role", ["employee", "operator"])
def test_running_auth_api(role):
    call = http_client()

    assert call("/auth/me")[0] == 401
    status, login = call("/auth/login", {"login_id": role, "password": "SolveLoop-Demo-2026!"})
    assert status == 200
    assert login["user"]["role"] == role
    assert call("/auth/me")[1] == login["user"]
    assert call("/auth/csrf")[1]["csrf_token"] == login["csrf_token"]
    refs = call("/reference-data")[1]
    assert len(refs["departments"]) == 4
    assert ("operators" in refs) == (role == "operator")
    assert call("/auth/logout", {})[0] == 403
    assert call("/auth/logout", {}, login["csrf_token"])[0] == 204
    assert call("/auth/me")[0] == 401


@pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="本人変更は専用DBでのみ実行します。")
def test_running_password_lifecycle():
    from sqlalchemy import delete
    from sqlalchemy.orm import Session

    from app.auth import password_hasher
    from app.config import load_settings
    from app.database import build_engine
    from app.models import AuditEvent, AuthSession, User

    settings = load_settings()
    assert settings.postgres_db == "solveloop_test"
    engine = build_engine(settings)
    user_id = UUID(int=4004)
    temporary = "U04-Temporary-HTTP-2026!"
    changed = "U04-Personal-HTTP-2026!"
    with Session(engine) as session, session.begin():
        assert session.get(User, user_id) is None
        session.add(
            User(
                id=user_id,
                display_name="HTTP検証専用",
                login_id="u04_http_check",
                password_hash=password_hasher.hash(temporary),
                role="employee",
                active=True,
                must_change_password=True,
            )
        )
    try:
        first, second = http_client(), http_client()
        payload = {"login_id": "u04_http_check", "password": temporary}
        status, logged_in = first("/auth/login", payload)
        assert status == 200 and logged_in["user"]["must_change_password"]
        assert second("/auth/login", payload)[0] == 200
        assert first("/reference-data")[1]["code"] == "PASSWORD_CHANGE_REQUIRED"
        status, _ = first(
            "/auth/password/change",
            {"current_password": temporary, "new_password": changed},
            logged_in["csrf_token"],
        )
        assert status == 204
        assert first("/auth/me")[0] == second("/auth/me")[0] == 401
        assert first("/auth/login", payload)[0] == 401
        status, logged_in = first(
            "/auth/login", {"login_id": "u04_http_check", "password": changed}
        )
        assert status == 200 and not logged_in["user"]["must_change_password"]
        assert first("/reference-data")[0] == 200
        assert first("/auth/logout", {}, logged_in["csrf_token"])[0] == 204
    finally:
        with Session(engine) as session, session.begin():
            session.execute(delete(AuditEvent).where(AuditEvent.target_user_id == user_id))
            session.execute(delete(AuthSession).where(AuthSession.user_id == user_id))
            session.execute(delete(User).where(User.id == user_id))
        engine.dispose()
