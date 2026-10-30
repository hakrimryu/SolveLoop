import logging
import os
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.auth import password_hasher
from app.config import BACKEND_DIR, Settings, load_settings
from app.database import build_engine
from app.main import create_app


def local_settings(**changes: object) -> Settings:
    values = {
        "db_host": "127.0.0.1",
        "db_port": 1,
        "postgres_db": "solveloop_test",
        "postgres_user": "probe_user",
        "postgres_password": SecretStr("probe:p@ss/%word"),
    }
    values.update(changes)
    return Settings(**values)


def test_url_preserves_special_characters_and_masks_password() -> None:
    settings = local_settings()
    assert settings.database_url.password == "probe:p@ss/%word"
    assert "probe:p@ss/%word" not in repr(settings)
    assert "probe:p@ss/%word" not in str(settings.database_url)


@pytest.mark.parametrize("changes", [{"db_port": 0}, {"postgres_password": ""}])
def test_invalid_settings_hide_inputs(changes: dict[str, object]) -> None:
    with pytest.raises(ValidationError) as error:
        local_settings(**changes)
    assert "input_value" not in str(error.value)


def test_missing_settings_fail_without_values(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(RuntimeError, match="DB環境変数"):
        load_settings()


def test_live_survives_unreachable_db_and_ready_is_sanitized(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with TestClient(create_app(local_settings())) as client:
        assert client.get("/health/live").json() == {"status": "alive"}
        with caplog.at_level(logging.WARNING):
            response = client.get("/health/ready")
        assert response.status_code == 503
        body = response.json()
        assert body["checks"]["database"] == "unavailable"
        assert body["error"]["code"] == "SERVICE_UNAVAILABLE"
        UUID(body["error"]["request_id"])
        for sensitive in ("probe:p@ss", "probe_user", "Traceback", "SELECT"):
            assert sensitive not in response.text + caplog.text


@pytest.mark.integration
@pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="専用DBでのみ実行します。")
def test_postgresql_foundation_and_migrations() -> None:
    settings = load_settings()
    assert settings.postgres_db == "solveloop_test", "専用の空DBを指定してください。"
    engine = build_engine(settings)
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    try:
        with engine.connect() as connection:
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
                )
                == 0
            )
            assert not connection.scalar(
                text("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')")
            )

        app = create_app(settings)
        with TestClient(app) as client:
            before = client.get("/health/ready")
            assert before.status_code == 503
            assert before.json()["checks"] == {
                "database": "up",
                "schema": "outdated",
                "vector": "missing",
            }
            with engine.connect() as connection:
                assert (
                    connection.scalar(text("SELECT to_regclass('public.alembic_version')")) is None
                )

            # 履歴だけが一致していても、必要な拡張がなければ受付可能にしない。
            command.stamp(config, "head")
            assert client.get("/health/ready").json()["checks"]["vector"] == "missing"
            assert client.get("/health/ready").status_code == 503
            with engine.begin() as connection:
                connection.execute(text("DELETE FROM alembic_version"))

            command.upgrade(config, "0002_auth")
            # 旧revisionの列だけで作った資料が、追加migrationで変わらないことを確認する。
            with engine.begin() as connection:
                connection.execute(
                    text("INSERT INTO departments VALUES (:id, 'LEGACY', '既存部署', true)"),
                    {"id": UUID(int=900)},
                )
                for user_id, active in [(901, True), (902, False)]:
                    connection.execute(
                        text(
                            "INSERT INTO users "
                            "(id,department_id,display_name,login_id,password_hash,role,active) "
                            "VALUES (:id,:department,'既存利用者',:login,:hash,'employee',:active)"
                        ),
                        {
                            "id": UUID(int=user_id),
                            "department": UUID(int=900) if active else None,
                            "login": f"legacy{user_id}",
                            "hash": password_hasher.hash("old"),
                            "active": active,
                        },
                    )
                connection.execute(
                    text(
                        "INSERT INTO sessions VALUES "
                        "(:id,:token,:user_id,now()+interval '1 hour',:csrf)"
                    ),
                    {
                        "id": UUID(int=903),
                        "token": "a" * 64,
                        "user_id": UUID(int=901),
                        "csrf": "b" * 64,
                    },
                )
                before_users = connection.execute(
                    text(
                        "SELECT id,department_id,display_name,login_id,password_hash,role,active "
                        "FROM users ORDER BY id"
                    )
                ).all()
                before_sessions = connection.execute(
                    text("SELECT * FROM sessions ORDER BY id")
                ).all()
            command.upgrade(config, "head")
            with engine.connect() as connection:
                assert (
                    connection.execute(
                        text(
                            "SELECT id,department_id,display_name,login_id,password_hash,"
                            "role,active "
                            "FROM users ORDER BY id"
                        )
                    ).all()
                    == before_users
                )
                assert (
                    connection.execute(text("SELECT * FROM sessions ORDER BY id")).all()
                    == before_sessions
                )
                assert connection.execute(
                    text("SELECT can_manage_accounts,must_change_password,row_version FROM users")
                ).all() == [(False, False, 1), (False, False, 1)]
                assert connection.scalar(text("SELECT count(*) FROM audit_events")) == 0
            command.check(config)
            with engine.begin() as connection:
                connection.execute(text("DELETE FROM sessions WHERE id=:id"), {"id": UUID(int=903)})
                connection.execute(
                    text("DELETE FROM users WHERE id IN (:a,:b)"),
                    {"a": UUID(int=901), "b": UUID(int=902)},
                )
                connection.execute(
                    text("DELETE FROM departments WHERE id=:id"), {"id": UUID(int=900)}
                )
            command.upgrade(config, "head")
            response = client.get("/health/ready")
            assert response.status_code == 200
            assert response.json()["scope"] == "backend_foundation"

            with engine.connect() as connection:
                assert set(
                    connection.scalars(
                        text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
                    )
                ) == {"alembic_version", "departments", "users", "sessions", "audit_events"}
                assert (
                    connection.scalar(text("SELECT '[1,2,3]'::vector <-> '[4,6,3]'::vector")) == 5
                )
            with engine.begin() as connection:
                connection.execute(text("UPDATE alembic_version SET version_num = 'unknown_test'"))
            assert client.get("/health/ready").status_code == 503
            with engine.begin() as connection:
                connection.execute(
                    text("UPDATE alembic_version SET version_num = '0003_account_auth'")
                )
            assert client.get("/health/ready").status_code == 200
            assert app.state.engine.pool.checkedout() == 0

        # セッション終了時に未コミットの変更が残らないことを実DBで確認する。
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE session_probe (value integer)"))
        try:
            with Session(engine) as session:
                session.execute(text("INSERT INTO session_probe VALUES (1)"))
            with engine.connect() as connection:
                assert connection.scalar(text("SELECT count(*) FROM session_probe")) == 0
        finally:
            with engine.begin() as connection:
                connection.execute(text("DROP TABLE session_probe"))
    finally:
        engine.dispose()
