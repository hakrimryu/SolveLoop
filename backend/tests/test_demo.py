import hashlib
import json
import os
import shutil
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.orm import Session

from app.auth import password_hasher
from app.config import load_settings
from app.database import build_engine
from app.demo import (
    CONFIRMATION,
    INSTANCE,
    apply_dataset,
    business_hash,
    environment_guard,
    inspect_database,
    target_guard,
)
from app.demo_data import Dataset, DemoError
from app.models import Department, User
from app.seed import DEMO_PASSWORD, seed_auth


@pytest.fixture
def data_root():
    path = Path(__file__).resolve().parents[2] / "demo"
    if not path.exists():
        path = Path("/demo")
    assert (path / "manifest.json").is_file(), "公開demoディレクトリをマウントしてください。"
    return path


def rewrite(root, name, mutate):
    path = root / name
    value = json.loads(path.read_text(encoding="utf-8"))
    mutate(value)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"][name] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")


def test_public_dataset_is_fixed_and_scenarios_are_separate(data_root):
    data = Dataset(data_root)
    assert data.summary() == Dataset(data_root).summary()
    assert data.summary()["resolved"] == 67
    assert all(b"\r" not in (data_root / name).read_bytes() for name in data.manifest.files)
    assert len({t.created_days_ago for t in data.tickets}) > 30
    assert all("scenario" not in t.model_dump() for t in data.tickets)
    assert all(data.at(t.created_days_ago) < data.as_of for t in data.tickets)
    assert {u.id for u in data.company.users if u.login_id in {"employee", "operator"}} == {
        str(UUID(int=201)),
        str(UUID(int=202)),
    }


@pytest.mark.parametrize("kind", ["hash", "fk", "state", "uuid", "number", "date", "path", "extra"])
def test_invalid_input_is_rejected_before_database(data_root, tmp_path, kind):
    root = tmp_path / "demo"
    shutil.copytree(data_root, root)
    if kind == "hash":
        with (root / "knowledge/01.txt").open("a", encoding="utf-8") as stream:
            stream.write("改変")
    elif kind == "path":
        value = json.loads((root / "manifest.json").read_text())
        value["files"]["../outside.txt"] = "0" * 64
        (root / "manifest.json").write_text(json.dumps(value))
    else:

        def mutate(value):
            ticket = value["tickets"][0]
            if kind == "fk":
                ticket["assignee_id"] = str(UUID(int=999))
            elif kind == "state":
                ticket["resolution"] = None
            elif kind == "uuid":
                ticket["id"] = "invalid"
            elif kind == "number":
                ticket["number"] = "REQ-9999"
            elif kind == "date":
                ticket["created_days_ago"] = 0
            elif kind == "extra":
                ticket["scenario"] = "knowledge-gap"

        rewrite(root, "tickets/tickets.json", mutate)
    with pytest.raises(ValueError):
        Dataset(root)


def test_environment_requires_all_independent_guards(monkeypatch):
    from test_foundation import local_settings

    settings = local_settings(
        db_host="demo-db",
        db_port=5432,
        postgres_db="solveloop_demo",
        postgres_user="solveloop_demo",
    )
    monkeypatch.setenv("SOLVELOOP_DEMO", "1")
    monkeypatch.setenv("SOLVELOOP_DEMO_INSTANCE", INSTANCE)
    environment_guard(settings, CONFIRMATION)
    for changes in (
        {"db_host": "db"},
        {"postgres_db": "solveloop"},
        {"postgres_user": "other"},
        {"db_port": 5433},
    ):
        with pytest.raises(DemoError):
            environment_guard(settings.model_copy(update=changes), CONFIRMATION)
    with pytest.raises(DemoError):
        environment_guard(settings, "yes")
    monkeypatch.delenv("SOLVELOOP_DEMO")
    with pytest.raises(DemoError):
        environment_guard(settings, CONFIRMATION)


@pytest.mark.integration
@pytest.mark.skipif(os.getenv("RUN_DEMO_DB_TESTS") != "1", reason="空のデモ専用DBのみ使用します。")
def test_atomic_load_idempotency_conflicts_reset_and_preservation(data_root, tmp_path):
    settings = load_settings()
    environment_guard(settings, CONFIRMATION)
    data = Dataset(data_root)
    engine = build_engine(settings)
    with Session(engine) as session, pytest.raises(DemoError), session.begin():
        session.execute(text("ALTER TABLE demo_guard.identity RENAME TO hidden_identity"))
        target_guard(session)
    with Session(engine) as session, pytest.raises(DemoError), session.begin():
        session.execute(text("UPDATE demo_guard.identity SET database_oid = 0"))
        target_guard(session)
    with Session(engine) as session, session.begin():
        target_guard(session)
        assert inspect_database(session)["seed_version"] is None
        seed_auth(session)
        original = [
            (u.id, u.password_hash, u.can_manage_accounts) for u in session.scalars(select(User))
        ]
    with Session(engine) as session, pytest.raises(DemoError), session.begin():
        apply_dataset(session, data)
    with Session(engine) as session, session.begin():
        assert [
            (u.id, u.password_hash, u.can_manage_accounts) for u in session.scalars(select(User))
        ] == original
        session.execute(User.__table__.delete())
        session.execute(Department.__table__.delete())

    def fail_midway(conn, cursor, statement, parameters, context, many):
        if (
            statement.startswith("INSERT INTO demo_guard.seed_receipt")
            or "INSERT INTO demo_guard.seed_receipt" in statement
        ):
            raise RuntimeError("検証用の適用失敗")

    event.listen(engine, "before_cursor_execute", fail_midway)
    try:
        with Session(engine) as session, pytest.raises(RuntimeError), session.begin():
            apply_dataset(session, data)
    finally:
        event.remove(engine, "before_cursor_execute", fail_midway)
    with Session(engine) as session, session.begin():
        status = inspect_database(session)
        assert status["counts"]["users"] == status["counts"]["tickets"] == 0
        assert session.scalar(text("SELECT last_value FROM ticket_number_seq")) == 1
        assert apply_dataset(session, data) == "loaded"
        initial_hash = business_hash(session)
    with Session(engine) as session, session.begin():
        hashes = list(session.scalars(select(User.password_hash).order_by(User.id)))
        assert all(password_hasher.verify(value, DEMO_PASSWORD) for value in hashes)
        assert apply_dataset(session, data) == "already_loaded_preserved"
        assert business_hash(session) == initial_hash
        assert hashes == list(session.scalars(select(User.password_hash).order_by(User.id)))
        assert session.scalar(text("SELECT nextval('ticket_number_seq')")) == 101
        assert session.scalar(text("SELECT nextval('knowledge_number_seq')")) == 16
        manager = session.get(User, UUID(int=202))
        manager.active = False
        assert (
            session.scalar(
                text("""
            SELECT count(*) FROM tickets t WHERE
              (SELECT count(*) FROM ticket_events e WHERE e.ticket_id = t.id) <> t.version
              OR t.updated_at <>
                 (SELECT max(occurred_at) FROM ticket_events e WHERE e.ticket_id=t.id)
              OR t.created_at <>
                 (SELECT min(occurred_at) FROM ticket_events e WHERE e.ticket_id=t.id)
              OR t.updated_at < t.created_at
              OR (t.status='resolved' AND t.resolved_at <> t.updated_at)
        """)
            )
            == 0
        )
    changed = tmp_path / "changed"
    shutil.copytree(data_root, changed)
    manifest_path = changed / "manifest.json"
    value = json.loads(manifest_path.read_text(encoding="utf-8"))
    value["seed_version"] = "yanagi-v2"
    manifest_path.write_text(json.dumps(value), encoding="utf-8")
    with Session(engine) as session, pytest.raises(DemoError), session.begin():
        apply_dataset(session, Dataset(changed))
    with Session(engine) as session, session.begin():
        assert not session.get(User, UUID(int=202)).active
        assert apply_dataset(session, data) == "already_loaded_preserved"
        assert not session.get(User, UUID(int=202)).active
        changed_hash = business_hash(session)
    other_engine = build_engine(settings)
    try:
        with other_engine.connect() as other:
            other.execute(text("SELECT 1"))
            with Session(engine) as session, pytest.raises(DemoError), session.begin():
                apply_dataset(session, data, reset=True)
    finally:
        other_engine.dispose()
    event.listen(engine, "before_cursor_execute", fail_midway)
    try:
        with Session(engine) as session, pytest.raises(RuntimeError), session.begin():
            apply_dataset(session, data, reset=True)
    finally:
        event.remove(engine, "before_cursor_execute", fail_midway)
    with Session(engine) as session, session.begin():
        assert business_hash(session) == changed_hash
        assert session.scalar(text("SELECT last_value FROM ticket_number_seq")) == 101
        assert apply_dataset(session, data, reset=True) == "reset_restored"
        status = inspect_database(session)
        assert status["business_hash"] == initial_hash
        assert status["initial_business_matches"]
        assert status["counts"]["tickets"] == 100
        assert status["counts"]["knowledge_versions"] == 15
        assert status["counts"]["knowledge_preparations"] == 0
        assert status["counts"]["radar_runs"] == status["counts"]["sessions"] == 0
        assert session.scalar(text("SELECT nextval('ticket_number_seq')")) == 101
    engine.dispose()
