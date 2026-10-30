import os
from uuid import UUID, uuid4

import pytest
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session
from test_http_auth import http_client

from app.auth import password_hasher
from app.config import load_settings
from app.database import build_engine
from app.models import AuditEvent, AuthSession, Department, User

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.getenv("AUTH_TEST_BASE_URL") or os.getenv("RUN_DB_TESTS") != "1",
        reason="起動済みの専用APIと専用DBでのみ実行します。",
    ),
]


def test_running_account_management_lifecycle():
    settings = load_settings()
    assert settings.postgres_db == "solveloop_test"
    engine = build_engine(settings)
    actor_id, login_id = uuid4(), "u05-http-" + uuid4().hex
    initial, personal = "HTTP検証専用の管理者パスワード2026", "HTTP検証専用の本人変更パスワード2026"
    user_ids = {actor_id}
    with Session(engine) as session, session.begin():
        department = session.scalar(select(Department).where(Department.active.is_(True)))
        department_id = str(department.id)
        session.add(
            User(
                id=actor_id,
                login_id=login_id,
                display_name="HTTP管理検証専用",
                department_id=department.id,
                role="employee",
                active=True,
                can_manage_accounts=True,
                password_hash=password_hasher.hash(initial),
            )
        )
    try:
        manager, first, second = http_client(), http_client(), http_client()
        status, logged = manager("/auth/login", {"login_id": login_id, "password": initial})
        assert status == 200
        csrf = logged["csrf_token"]
        target_login = "u05-target-" + uuid4().hex
        status, issued = manager(
            "/accounts",
            {
                "display_name": "HTTP対象検証専用",
                "login_id": target_login,
                "department_id": department_id,
                "role": "employee",
            },
            csrf,
        )
        assert status == 201
        target = issued["account"]["id"]
        user_ids.add(UUID(target))
        password = issued["temporary_password"]
        assert len(password) == 43
        assert any(row["id"] == target for row in manager("/accounts")[1]["items"])
        status, limited = first("/auth/login", {"login_id": target_login, "password": password})
        assert status == 200 and limited["user"]["must_change_password"]
        assert first("/accounts")[1]["code"] == "PASSWORD_CHANGE_REQUIRED"
        assert second("/auth/login", {"login_id": target_login, "password": password})[0] == 200
        assert (
            first(
                "/auth/password/change",
                {"current_password": password, "new_password": personal},
                limited["csrf_token"],
            )[0]
            == 204
        )
        assert first("/auth/me")[0] == second("/auth/me")[0] == 401
        assert first("/auth/login", {"login_id": target_login, "password": password})[0] == 401
        assert first("/auth/login", {"login_id": target_login, "password": personal})[0] == 200
        assert first("/accounts")[1]["code"] == "FORBIDDEN"
        assert first("/reference-data")[0] == 200
        path = f"/accounts/{target}"
        assert manager(path + "/deactivate", {"expected_version": 2}, csrf)[0] == 200
        assert first("/auth/me")[0] == 401
        assert first("/auth/login", {"login_id": target_login, "password": personal})[0] == 401
        assert (
            manager(path + "/temporary-password", {"expected_version": 3}, csrf)[1]["code"]
            == "ACCOUNT_INACTIVE"
        )
        assert manager(path + "/reactivate", {"expected_version": 3}, csrf)[0] == 200
        assert first("/auth/me")[0] == 401
        assert first("/auth/login", {"login_id": target_login, "password": personal})[0] == 200
        status, reissued = manager(path + "/temporary-password", {"expected_version": 4}, csrf)
        assert status == 200
        assert first("/auth/me")[0] == 401
        assert first("/auth/login", {"login_id": target_login, "password": personal})[0] == 401
        assert (
            first(
                "/auth/login",
                {"login_id": target_login, "password": reissued["temporary_password"]},
            )[0]
            == 200
        )
        history = manager(path + "/events?page_size=2&page=999")[1]
        assert (history["total"], history["page"], history["page_count"]) == (5, 3, 3)
        assert history["items"][0]["action"] == "create"
        assert manager("/auth/logout", {}, csrf)[0] == 204
    finally:
        with Session(engine) as session, session.begin():
            session.execute(
                delete(AuditEvent).where(
                    or_(AuditEvent.actor_id.in_(user_ids), AuditEvent.target_user_id.in_(user_ids))
                )
            )
            session.execute(delete(AuthSession).where(AuthSession.user_id.in_(user_ids)))
            session.execute(delete(User).where(User.id.in_(user_ids)))
        engine.dispose()
