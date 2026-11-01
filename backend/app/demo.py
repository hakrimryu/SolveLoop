import argparse
import hashlib
import json
import os
import socket
import sys
from datetime import timedelta
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import func, select, text, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth import password_hasher
from app.config import load_settings
from app.database import build_engine
from app.demo_data import Dataset, DemoError, require
from app.models import (
    AuditEvent,
    Base,
    Department,
    KnowledgeDocument,
    KnowledgeEvent,
    KnowledgeSearchState,
    KnowledgeVersion,
    Ticket,
    TicketEvent,
    User,
)
from app.seed import DEMO_PASSWORD

INSTANCE = "ef53d43d-57f8-43b7-8230-31983ef3f020"
CONFIRMATION = "solveloop-demo/solveloop_demo"
LOCK_ID = 7320001
BUSINESS_TABLES = (
    "departments",
    "users",
    "audit_events",
    "tickets",
    "ticket_events",
    "knowledge_documents",
    "knowledge_versions",
    "knowledge_events",
)
DELETE_ORDER = (
    "guidance_sessions",
    "ticket_reads",
    "ticket_messages",
    "radar_reviews",
    "radar_coverages",
    "radar_runs",
    "ticket_embeddings",
    "knowledge_generations",
    "knowledge_sources",
    "knowledge_events",
    "knowledge_preparations",
    "knowledge_chunks",
    "knowledge_versions",
    "knowledge_documents",
    "ticket_events",
    "tickets",
    "idempotency_records",
    "sessions",
    "audit_events",
    "users",
    "departments",
    "knowledge_search_state",
    "embedding_profiles",
)


def stable_id(value):
    return uuid5(NAMESPACE_URL, f"https://example.com/solveloop/demo/events/{value}")


def environment_guard(settings, confirmation):
    require(
        os.getenv("SOLVELOOP_DEMO") == "1"
        and os.getenv("SOLVELOOP_DEMO_INSTANCE") == INSTANCE
        and confirmation == CONFIRMATION
        and settings.db_host == "demo-db"
        and settings.db_port == 5432
        and settings.postgres_db == "solveloop_demo"
        and settings.postgres_user == "solveloop_demo",
        "専用Compose・環境・確認引数が一致しないため拒否しました。原本には使用できません。",
    )


def target_guard(session):
    require(
        session.scalar(text("SELECT to_regclass('demo_guard.identity')")) is not None,
        "デモ専用の初期化標識がないDBを拒否しました。",
    )
    row = (
        session.execute(
            text("""
        SELECT current_database() AS database, current_user AS role,
               host(inet_server_addr()) AS address, inet_server_port() AS port,
               c.system_identifier::text AS cluster,
               d.oid::bigint AS database_oid,
               i.instance_id::text AS instance_id,
               i.system_identifier = c.system_identifier::text
                   AND i.database_oid = d.oid AS identity_matches
        FROM pg_control_system() c, pg_database d, demo_guard.identity i
        WHERE d.datname = current_database() AND i.singleton
    """)
        )
        .mappings()
        .one()
    )
    addresses = {item[4][0] for item in socket.getaddrinfo("demo-db", 5432)}
    require(
        row["database"] == row["role"] == "solveloop_demo"
        and row["port"] == 5432
        and row["address"] in addresses
        and row["instance_id"] == INSTANCE
        and row["identity_matches"],
        "実接続先とデモ標識が一致しないため拒否しました。復元先には標識を転用できません。",
    )
    return dict(row)


def schema_guard(session):
    tables = set(
        session.scalars(text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))
    )
    require(
        tables == set(Base.metadata.tables) | {"alembic_version"}
        and session.scalar(text("SELECT version_num FROM alembic_version")) == "0010_self_service",
        "スキーマが対応範囲外です。デモ環境のmigrationと実装を確認してください。",
    )


def business_hash(session):
    values = {}
    for name in BUSINESS_TABLES:
        # パスワードのsaltは入力再現性の対象外。実際の認証可否は別に検証する。
        column = "to_jsonb(t) - 'password_hash'" if name == "users" else "to_jsonb(t)"
        values[name] = session.scalar(
            text(
                f"SELECT coalesce(jsonb_agg(v ORDER BY v::text), '[]'::jsonb) "
                f"FROM (SELECT {column} AS v FROM public.{name} t) q"
            )
        )
    raw = json.dumps(values, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def receipt(session):
    return (
        session.execute(text("SELECT * FROM demo_guard.seed_receipt WHERE singleton"))
        .mappings()
        .one_or_none()
    )


def inspect_database(session):
    counts = {
        name: session.scalar(select(func.count()).select_from(table))
        for name, table in Base.metadata.tables.items()
    }
    saved = receipt(session)
    return {
        "counts": counts,
        "seed_version": saved["seed_version"] if saved else None,
        "manifest_hash": saved["manifest_hash"] if saved else None,
        "business_hash": business_hash(session),
        "initial_business_matches": bool(
            saved and saved["baseline_hash"] == business_hash(session)
        ),
    }


def insert_dataset(session, data):
    depts = {d.code: UUID(d.id) for d in data.company.departments}
    users = {UUID(u.id): u for u in data.company.users}
    for dept in data.company.departments:
        session.add(Department(id=UUID(dept.id), code=dept.code, name=dept.name, active=True))
    session.flush()
    for uid, user in users.items():
        session.add(
            User(
                id=uid,
                login_id=user.login_id,
                display_name=user.display_name,
                role=user.role,
                department_id=depts[user.department_code],
                password_hash=password_hasher.hash(DEMO_PASSWORD),
                active=True,
                can_manage_accounts=user.can_manage_accounts,
                must_change_password=False,
                row_version=2 if user.can_manage_accounts else 1,
            )
        )
    session.flush()
    manager = next(uid for uid, user in users.items() if user.can_manage_accounts)
    session.add(
        AuditEvent(
            id=stable_id("initial-management"),
            actor_id=None,
            target_user_id=manager,
            action="management_granted",
            occurred_at=data.at(89),
            request_id=stable_id("initial-management-request"),
            target_version=2,
        )
    )
    for value in data.tickets:
        created = data.at(value.created_days_ago)
        assigned = value.status != "open" or value.assignee_id is not None
        events = [("created", {}, UUID(value.requester_id), created)]
        if assigned:
            assignee = UUID(value.assignee_id)
            dept = next(d for d in data.company.departments if d.code == value.department_code)
            user = users[assignee]
            events.append(
                (
                    "assignment_changed",
                    {
                        "before": {
                            "department": {"id": dept.id, "code": dept.code, "name": dept.name},
                            "assignee": None,
                        },
                        "after": {
                            "department": {"id": dept.id, "code": dept.code, "name": dept.name},
                            "assignee": {"id": str(assignee), "display_name": user.display_name},
                        },
                    },
                    assignee,
                    created + timedelta(minutes=10),
                )
            )
        if value.status in {"in_progress", "resolved"}:
            events.append(
                (
                    "started",
                    {"from_status": "open", "to_status": "in_progress"},
                    assignee,
                    created + timedelta(minutes=30),
                )
            )
        resolved_at = created + timedelta(minutes=90) if value.status == "resolved" else None
        if resolved_at:
            events.append(
                (
                    "resolved",
                    {
                        "from_status": "in_progress",
                        "to_status": "resolved",
                        "resolution": value.resolution,
                        "resolved_at": resolved_at.isoformat(),
                    },
                    assignee,
                    resolved_at,
                )
            )
        session.add(
            Ticket(
                id=UUID(value.id),
                number=value.number,
                title=value.title,
                body=value.body,
                requester_id=UUID(value.requester_id),
                assignee_id=UUID(value.assignee_id) if value.assignee_id else None,
                department_id=depts.get(value.department_code),
                status=value.status,
                resolution=value.resolution,
                resolved_at=resolved_at,
                version=len(events),
                created_at=created,
                updated_at=events[-1][3],
            )
        )
        session.flush()
        for version, (kind, payload, actor, occurred) in enumerate(events, 1):
            session.add(
                TicketEvent(
                    id=stable_id(f"{value.id}/{version}"),
                    ticket_id=UUID(value.id),
                    ticket_version=version,
                    actor_id=actor,
                    event_type=kind,
                    payload=payload,
                    occurred_at=occurred,
                )
            )
    session.flush()
    for doc in data.documents:
        author = next(
            uid
            for uid, u in users.items()
            if u.role == "operator" and u.department_code == doc.department_code
        )
        created, approved = data.at(doc.created_days_ago), data.at(doc.approved_days_ago)
        session.add(
            KnowledgeDocument(
                id=UUID(doc.id),
                number=doc.number,
                published_version_id=None,
                publication_suspended=False,
                row_version=2,
                created_by=author,
                created_at=created,
            )
        )
        session.flush()
        session.add(
            KnowledgeVersion(
                id=UUID(doc.version_id),
                document_id=UUID(doc.id),
                version_no=1,
                base_version_id=None,
                status="approved",
                title=doc.title,
                audience=doc.audience,
                body=data.files[doc.body_file],
                department_id=depts[doc.department_code],
                created_by=author,
                created_at=created,
                updated_at=approved,
                reviewed_by=author,
                reviewed_at=approved,
                row_version=2,
            )
        )
        session.flush()
        session.execute(
            update(KnowledgeDocument)
            .where(KnowledgeDocument.id == UUID(doc.id))
            .values(published_version_id=UUID(doc.version_id))
        )
        for revision, kind, moment in [(1, "draft_created", created), (2, "approved", approved)]:
            session.add(
                KnowledgeEvent(
                    id=stable_id(f"{doc.version_id}/{revision}"),
                    knowledge_version_id=UUID(doc.version_id),
                    row_version=revision,
                    actor_id=author,
                    event_type=kind,
                    reason=None,
                    payload={
                        "synthetic_initial_seed": True,
                        "seed_version": data.manifest.seed_version,
                    },
                    occurred_at=moment,
                )
            )
    session.flush()
    # setvalはrollbackで戻らないため、デモ専用シーケンスをトランザクションDDLで進める。
    session.execute(text("ALTER SEQUENCE public.ticket_number_seq RESTART WITH 101"))
    session.execute(text("ALTER SEQUENCE public.knowledge_number_seq RESTART WITH 16"))


def apply_dataset(session, data, reset=False):
    session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": LOCK_ID})
    target_guard(session)
    schema_guard(session)
    old = receipt(session)
    if old and not reset:
        require(
            old["manifest_hash"] == data.manifest_hash
            and old["seed_version"] == data.manifest.seed_version,
            "別バージョン・変更済みmanifestを拒否しました。明示リセットが必要です。",
        )
        return "already_loaded_preserved"
    names = ", ".join(f"public.{name}" for name in DELETE_ORDER)
    session.execute(text(f"LOCK TABLE {names} IN ACCESS EXCLUSIVE MODE NOWAIT"))
    require(
        session.scalar(
            text(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                "AND pid <> pg_backend_pid() AND backend_type = 'client backend'"
            )
        )
        == 0,
        "他のDB接続があります。デモAPIと検証処理を停止してから再実行してください。",
    )
    if reset:
        require(old is not None, "適用履歴のないDBはリセットできません。")
    else:
        for name, table in Base.metadata.tables.items():
            if name != "knowledge_search_state":
                require(
                    session.scalar(select(func.count()).select_from(table)) == 0,
                    "既存資料との衝突を検出しました。上書き・取り込みは行いません。",
                )
        state = session.get(KnowledgeSearchState, 1)
        require(
            state and state.active_profile_id is None and state.revision == 1,
            "検索状態が初期状態ではありません。",
        )
    if reset:
        session.execute(update(KnowledgeDocument).values(published_version_id=None))
        for name in DELETE_ORDER:
            session.execute(Base.metadata.tables[name].delete())
        session.add(KnowledgeSearchState(id=1, active_profile_id=None, revision=1))
        session.execute(text("DELETE FROM demo_guard.seed_receipt"))
        session.flush()
    insert_dataset(session, data)
    baseline = business_hash(session)
    session.execute(
        text("""
        INSERT INTO demo_guard.seed_receipt
            (singleton, seed_version, manifest_hash, baseline_hash)
        VALUES (true, :version, :manifest, :baseline)
    """),
        dict(version=data.manifest.seed_version, manifest=data.manifest_hash, baseline=baseline),
    )
    return "reset_restored" if reset else "loaded"


def main():
    parser = argparse.ArgumentParser(description="架空企業の入力検査・専用デモDBへの適用。")
    parser.add_argument("command", choices=["validate", "inspect", "load", "reset"])
    parser.add_argument("--data", type=Path, default=Path("/demo"))
    parser.add_argument("--confirm")
    args = parser.parse_args()
    engine = None
    try:
        data = Dataset(args.data)
        report = data.summary()
        if args.command != "validate":
            settings = load_settings()
            environment_guard(settings, args.confirm)
            engine = build_engine(settings)
            with Session(engine) as session, session.begin():
                report["target"] = target_guard(session)
                schema_guard(session)
                if args.command in {"load", "reset"}:
                    report["result"] = apply_dataset(session, data, args.command == "reset")
                report["database"] = inspect_database(session)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (DemoError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    except SQLAlchemyError:
        print(
            "DB処理を中止しました。変更はrollbackしました。接続先・migrationを確認してください。",
            file=sys.stderr,
        )
        return 1
    finally:
        if engine:
            engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
