"""隔離合成DBで製品のHTTP処理と実Ollamaを評価する。"""

import argparse
import hashlib
import json
import os
import socket
from datetime import UTC, datetime, timedelta
from pathlib import Path
from time import monotonic, perf_counter, sleep
from unittest.mock import patch
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.ai.config import AISettings
from app.ai.knowledge import PROFILE_ID, SPECIFICATION, fingerprint
from app.ai.ollama import OllamaClient
from app.ai.radar import GROUP_RULE, TICKET_PROFILE
from app.ai.tickets import CHAT_DIGEST
from app.config import load_settings
from app.database import build_engine
from app.main import create_app
from app.models import Base, Department, KnowledgeVersion, Ticket, TicketEvent, User
from app.seed import DEMO_PASSWORD, seed_auth

ROOT = Path(__file__).resolve().parent
AS_OF = {
    "calibration": "2026-08-31T18:00:00+09:00",
    "holdout": "2026-09-30T18:00:00+09:00",
}
REPEATS = 3


def read(name):
    return json.loads((ROOT / "datasets" / f"{name}.json").read_text(encoding="utf-8"))


def ident(case):
    return uuid5(NAMESPACE_URL, "https://example.com/solveloop/evaluation/s21/" + case)


def guard(engine):
    settings = load_settings()
    if not (
        os.getenv("SOLVELOOP_EVALUATION") == "s21-v1"
        and settings.db_host == "eval-db"
        and settings.db_port == 5432
        and settings.postgres_db == settings.postgres_user == "solveloop_evaluation"
    ):
        raise ValueError("評価専用環境以外では実行できません。")
    with engine.connect() as c:
        if not c.scalar(text("SELECT to_regclass('evaluation_guard.identity')")):
            raise ValueError("評価DBの初期化標識がありません。")
        row = c.execute(
            text("""
            SELECT current_database(), current_user, host(inet_server_addr()),
                   inet_server_port(), i.instance,
                   i.cluster = p.system_identifier::text AND i.database_oid = d.oid
            FROM evaluation_guard.identity i, pg_control_system() p, pg_database d
            WHERE d.datname = current_database()
        """)
        ).one()
        addresses = {x[4][0] for x in socket.getaddrinfo("eval-db", 5432)}
        if not (
            row[0] == row[1] == "solveloop_evaluation"
            and row[2] in addresses
            and row[3] == 5432
            and row[4] == "s21-v1"
            and row[5]
        ):
            raise ValueError("実接続先・cluster・DB識別が評価標識と一致しません。")


def reset(engine, confirmation):
    if confirmation != "solveloop-evaluation/solveloop_evaluation":
        raise ValueError("明示確認文字列が必要です。")
    guard(engine)
    from app.demo import DELETE_ORDER

    with engine.begin() as c:
        c.execute(text("SELECT pg_advisory_xact_lock(7321001)"))
        if c.scalar(
            text("""SELECT count(*) FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()""")
        ):
            raise ValueError("他の評価接続を終了してからリセットしてください。")
        for table in sorted(Base.metadata.tables):
            c.execute(text(f"LOCK TABLE {table} IN ACCESS EXCLUSIVE MODE NOWAIT"))
        c.execute(text("UPDATE knowledge_documents SET published_version_id=NULL"))
        c.execute(text("UPDATE knowledge_versions SET base_version_id=NULL"))
        for table in DELETE_ORDER:
            c.execute(text(f"DELETE FROM {table}"))
        c.execute(
            text(
                "INSERT INTO knowledge_search_state (id, active_profile_id, revision) "
                "VALUES (1, NULL, 1)"
            )
        )
        c.execute(text("ALTER SEQUENCE ticket_number_seq RESTART WITH 1"))
        c.execute(text("ALTER SEQUENCE knowledge_number_seq RESTART WITH 1"))


def add_tickets(engine, rows, draft=False):
    with Session(engine) as s, s.begin():
        depts = {d.code: d.id for d in s.scalars(select(Department))}
        for row in rows:
            case = row["id"]
            if s.get(Ticket, ident(case)):
                raise ValueError("既存評価を上書きせず、明示reset後に実行してください。")
            day = (
                datetime(2026, 6, 1, tzinfo=UTC)
                if draft
                else datetime.fromisoformat(AS_OF[row["split"]]) - timedelta(days=7)
                if "group" in row
                else datetime(2026, 5, 1, tzinfo=UTC)
            )
            resolution = row.get("resolution")
            version = 4 if resolution else 1
            s.add(
                Ticket(
                    id=ident(case),
                    number="EV-" + case,
                    requester_id=UUID(int=201),
                    assignee_id=UUID(int=202) if draft else None,
                    department_id=depts.get(row.get("department")),
                    title=row["title"],
                    body=row["body"],
                    status="resolved" if resolution else "open",
                    resolution=resolution,
                    resolved_at=day + timedelta(hours=1) if resolution else None,
                    created_at=day,
                    updated_at=day + timedelta(hours=1) if resolution else day,
                    version=version,
                )
            )
            s.flush()
            events = (
                ["created", "assignment_changed", "started", "resolved"] if draft else ["created"]
            )
            for v, event in enumerate(events, 1):
                s.add(
                    TicketEvent(
                        ticket_id=ident(case),
                        ticket_version=v,
                        actor_id=UUID(int=202) if draft else UUID(int=201),
                        event_type=event,
                        payload={"synthetic_evaluation": True},
                        occurred_at=day + timedelta(minutes=v),
                    )
                )


class Evaluation:
    def __init__(self, output):
        self.output = output
        self.records = output / "records.jsonl"
        self.raw = output / "ollama.jsonl"
        self.context = {}
        self.calls = []
        self.engine = build_engine(load_settings())
        guard(self.engine)
        self.app = create_app()
        self.client = TestClient(self.app)
        self.employee = TestClient(self.app)
        self.csrf = ""
        self.emp_csrf = ""
        self.documents = {}
        self.original_request = OllamaClient._request

    def observe(self, client, path, body=None, timeout=5, *, deadline=None):
        started = perf_counter()
        record = {
            "context": self.context,
            "path": path,
            "input_hash": fingerprint(body),
            "request": body,
        }
        try:
            value = self.original_request(client, path, body, timeout, deadline=deadline)
            record["response"] = value
            return value
        except Exception as error:
            record["error_code"] = getattr(error, "code", type(error).__name__)
            raise
        finally:
            record["elapsed_ms"] = round((perf_counter() - started) * 1000, 3)
            with self.raw.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
            if path in {"/api/generate", "/api/embed"}:
                response = record.get("response", {})
                self.calls.append(
                    {
                        "path": path,
                        "input_hash": record["input_hash"],
                        "output_hash": fingerprint(
                            response.get("response", response.get("embeddings"))
                        ),
                        "elapsed_ms": record["elapsed_ms"],
                        "error_code": record.get("error_code"),
                        **{
                            k: response.get(k)
                            for k in (
                                "load_duration",
                                "total_duration",
                                "prompt_eval_count",
                                "eval_count",
                                "done",
                                "done_reason",
                            )
                        },
                    }
                )

    def call(self, path, body=None, *, employee=False, method=None, expected=None):
        client = self.employee if employee else self.client
        csrf = self.emp_csrf if employee else self.csrf
        headers = {
            "Origin": "http://testserver",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": str(uuid4()),
        }
        response = client.request(
            method or ("POST" if body is not None else "GET"),
            "/api/v1" + path,
            json=body,
            headers=headers,
        )
        value = response.json() if response.content else None
        if expected is not None and response.status_code != expected:
            raise RuntimeError(f"{path}: {response.status_code} {value}")
        return response.status_code, value

    def login(self):
        for employee, login in [(False, "operator"), (True, "employee")]:
            _, value = self.call(
                "/auth/login",
                {"login_id": login, "password": DEMO_PASSWORD},
                employee=employee,
                expected=200,
            )
            if employee:
                self.emp_csrf = value["csrf_token"]
            else:
                self.csrf = value["csrf_token"]

    def record(self, case, split, task, repeat, action, phase="baseline"):
        self.context = {
            "case": case,
            "split": split,
            "task": task,
            "repeat": repeat,
            "phase": phase,
        }
        self.calls = []
        started = perf_counter()
        when = datetime.now(UTC).isoformat()
        try:
            status, value = action()
        except Exception as error:
            status, value = 0, {"code": getattr(error, "code", type(error).__name__)}
        row = {
            **self.context,
            "started_at": when,
            "status": status,
            "value": value,
            "elapsed_ms": round((perf_counter() - started) * 1000, 3),
            "calls": self.calls,
        }
        with self.records.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(
            json.dumps(
                {k: row[k] for k in ("case", "task", "repeat", "phase", "status", "elapsed_ms")}
            ),
            flush=True,
        )
        return row

    def publish(self, doc):
        self.context = {"phase": "synthetic_corpus", "case": doc["id"]}
        _, version = self.call(
            "/knowledge/drafts",
            {
                **{k: doc[k] for k in ("title", "audience", "body")},
                "department_id": str(
                    UUID(int=101 + ["IT", "HR", "GENERAL", "ACCOUNTING"].index(doc["department"]))
                ),
                "source_refs": [],
            },
            expected=201,
        )
        path = f"/knowledge/{version['document_id']}/versions/1"
        expected = {
            "expected_version": version["row_version"],
            "expected_document_version": version["document_row_version"],
        }
        self.call(path + "/prepare-search", expected, expected=200)
        self.call(path + "/approve", expected, expected=200)
        self.documents[doc["id"]] = version["document_id"]

    def valid_sources(self, result):
        checks = []
        with Session(self.engine) as s:
            for source in result.get("sources", []):
                if source["kind"] == "knowledge":
                    from app.models import KnowledgeDocument

                    version = s.get(KnowledgeVersion, UUID(source["version_id"]))
                    doc = s.get(KnowledgeDocument, UUID(source["document_id"]))
                    valid = (
                        version is not None
                        and doc is not None
                        and str(doc.published_version_id) == source["version_id"]
                        and not doc.publication_suspended
                        and version.status == "approved"
                        and version.body[source["body_start"] : source["body_end"]]
                        == source["text"]
                    )
                else:
                    ticket = s.get(Ticket, UUID(source["ticket_id"]))
                    valid = (
                        ticket is not None
                        and ticket.status == "resolved"
                        and ticket.version == source["ticket_version"]
                        and ticket.resolution[source["resolution_start"] : source["resolution_end"]]
                        == source["text"]
                    )
                checks.append({"id": source["id"], "valid": bool(valid)})
        used = [
            cid
            for step in result.get("result", {}).get("steps", [])
            for cid in step["citation_ids"]
        ]
        return {
            "sources": checks,
            "uses": len(used),
            "valid_uses": sum(any(c["id"] == cid and c["valid"] for c in checks) for cid in used),
        }

    def answer(self, question):
        status, value = self.call(
            f"/tickets/{ident(question['id'])}/analysis",
            {"expected_version": 1, "task": "answer"},
        )
        if status == 200:
            value["evaluation_source_checks"] = self.valid_sources(value)
        return status, value

    def question_runs(self):
        for repeat in range(1, REPEATS + 1):
            for q in read("questions"):
                case, split = q["id"], q["split"]
                self.record(
                    case,
                    split,
                    "classification",
                    repeat,
                    lambda q=q: self.call(
                        f"/tickets/{ident(q['id'])}/analysis",
                        {"expected_version": 1, "task": "classification"},
                    ),
                )
                self.record(
                    case,
                    split,
                    "search",
                    repeat,
                    lambda q=q: self.call(
                        "/knowledge/search",
                        {"query": q["title"] + "\n" + q["body"], "top_k": 5},
                        employee=True,
                    ),
                )
                self.record(case, split, "answer", repeat, lambda q=q: self.answer(q))

    def detect(self, split, repeat, phase):
        return self.record(
            "RADAR",
            split,
            "detect",
            repeat,
            lambda: self.call(
                "/radar/runs",
                {
                    "request_key": str(uuid4()),
                    "as_of": AS_OF[split],
                    "days": 30,
                    "threshold": 0.92,
                },
            ),
            phase,
        )

    def coverage(self, split, repeat, phase, run, group):
        case = group["id"]
        row = self.record(
            case,
            split,
            "coverage_start",
            repeat,
            lambda: self.call(
                f"/radar/runs/{run['id']}/candidates/{case}/coverage",
                {"request_key": str(uuid4())},
            ),
            phase,
        )
        if row["status"] != 200:
            return
        value = row["value"]
        while value["unanalyzed_ids"]:
            pending = value["unanalyzed_ids"][:3]
            row = self.record(
                case,
                split,
                "coverage_batch",
                repeat,
                lambda value=value, pending=pending: self.call(
                    f"/radar/coverage/{value['id']}/batches",
                    {"request_key": str(uuid4()), "ticket_ids": pending},
                ),
                phase,
            )
            if row["status"] != 200:
                break
            new = row["value"]
            if len(new["unanalyzed_ids"]) >= len(value["unanalyzed_ids"]):
                break
            value = new

    def radar_runs(self, phase="baseline"):
        for repeat in range(1, REPEATS + 1):
            for split in ["calibration", "holdout"]:
                if phase == "after" and split == "calibration":
                    continue
                row = self.detect(split, repeat, phase)
                if row["status"] == 200:
                    for group in row["value"]["candidates"]:
                        self.coverage(split, repeat, phase, row["value"], group)

    def draft_runs(self):
        for repeat in range(1, REPEATS + 1):
            for draft in read("drafts"):
                self.record(
                    draft["id"],
                    "holdout",
                    "draft",
                    repeat,
                    lambda draft=draft: self.call(
                        "/knowledge/generations",
                        {
                            "source_refs": [
                                {
                                    "ticket_id": str(ident(s["id"])),
                                    "expected_ticket_version": 4,
                                }
                                for s in draft["sources"]
                            ]
                        },
                    ),
                )

    def unload(self):
        observer = OllamaClient(AISettings())
        for model in [SPECIFICATION["model"], "qwen3:8b"]:
            observer._request("/api/generate", {"model": model, "keep_alive": 0})
        deadline = monotonic() + 10
        while True:
            resident = observer._request("/api/ps")["models"]
            if not any(x["name"] in {SPECIFICATION["model"], "qwen3:8b"} for x in resident):
                return
            if monotonic() >= deadline:
                raise RuntimeError("モデルの非resident状態を確認できません。")
            sleep(0.1)

    def latency_runs(self):
        q = read("questions")[0]
        draft = read("drafts")[0]
        detect = self.detect("calibration", 0, "latency_setup")
        group = (
            detect["value"]["candidates"][0]
            if detect["status"] == 200 and detect["value"]["candidates"]
            else None
        )

        def single_coverage():
            _, value = self.call(
                f"/radar/runs/{detect['value']['id']}/candidates/{group['id']}/coverage",
                {"request_key": str(uuid4())},
                expected=200,
            )
            return self.call(
                f"/radar/coverage/{value['id']}/batches",
                {"request_key": str(uuid4()), "ticket_ids": group["ticket_ids"][:1]},
            )

        actions = {
            "classification": lambda: self.call(
                f"/tickets/{ident(q['id'])}/analysis",
                {"expected_version": 1, "task": "classification"},
            ),
            "search": lambda: self.call(
                "/knowledge/search",
                {"query": q["title"] + "\n" + q["body"], "top_k": 5},
                employee=True,
            ),
            "answer": lambda: self.answer(q),
            "draft": lambda: self.call(
                "/knowledge/generations",
                {
                    "source_refs": [
                        {"ticket_id": str(ident(s["id"])), "expected_ticket_version": 4}
                        for s in draft["sources"]
                    ]
                },
            ),
        }
        if group:
            actions["radar_judgment"] = single_coverage
        for task, action in actions.items():
            for repeat in range(1, REPEATS + 1):
                self.context = {"phase": "unload", "task": task, "repeat": repeat}
                self.unload()
                self.record("LATENCY-" + task, "calibration", task, repeat, action, "cold")
                self.record("LATENCY-" + task, "calibration", task, repeat, action, "warm")

    def execute(self):
        if self.records.exists():
            raise ValueError("結果ファイルは上書きできません。別の出力先を指定してください。")
        with Session(self.engine) as s:
            if s.scalar(select(Ticket.id).limit(1)) or s.scalar(select(User.id).limit(1)):
                raise ValueError("空の評価DBが必要です。明示resetしてください。")
        files = {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((ROOT / "datasets").glob("*.json"))
        }
        product = {
            str(p.relative_to("/app")): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(Path("/app/app").rglob("*.py"))
        }
        observer = OllamaClient(AISettings())
        metadata = {
            "schema_version": 1,
            "started_at": datetime.now(UTC).isoformat(),
            "dataset_hashes": files,
            "protocol_hash": hashlib.sha256((ROOT / "protocol.md").read_bytes()).hexdigest(),
            "product_files": product,
            "product_head": os.getenv("EVALUATION_HEAD"),
            "models": observer._request("/api/tags"),
            "ollama": observer._request("/api/version"),
            "initial_residency": observer._request("/api/ps"),
            "chat_digest": CHAT_DIGEST,
            "search_profile": PROFILE_ID,
            "search_spec": SPECIFICATION,
            "ticket_profile": TICKET_PROFILE,
            "group_rule": GROUP_RULE,
            "threshold": 0.92,
            "repeats": REPEATS,
            "transport": "FastAPI TestClient ASGI + real PostgreSQL + real Ollama HTTP",
            "source_data": "synthetic_only",
            "tuning": False,
        }
        (self.output / "metadata.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        with Session(self.engine) as s, s.begin():
            seed_auth(s)
        add_tickets(self.engine, read("questions") + read("radar"))
        self.login()

        def observe(client, *args, **kwargs):
            return self.observe(client, *args, **kwargs)

        with patch.object(OllamaClient, "_request", observe):
            from app.knowledge_search import activate, backfill

            self.context = {"phase": "empty_corpus_activation"}
            backfill(self.engine, OllamaClient(AISettings()))
            activate(self.engine)
            for doc in read("documents"):
                self.publish(doc)
            (self.output / "documents.json").write_text(
                json.dumps(self.documents, indent=2) + "\n", encoding="utf-8"
            )
            self.question_runs()
            self.radar_runs()
            add_tickets(
                self.engine,
                [s for d in read("drafts") for s in d["sources"]],
                draft=True,
            )
            self.draft_runs()
            self.latency_runs()
            for doc in read("post_documents"):
                self.publish(doc)
            self.radar_runs("after")
        self.client.close()
        self.employee.close()
        self.app.state.engine.dispose()
        self.engine.dispose()

    def finish(self):
        metadata = json.loads((self.output / "metadata.json").read_text(encoding="utf-8"))
        files = {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((ROOT / "datasets").glob("*.json"))
        }
        product = {
            str(p.relative_to("/app")): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(Path("/app/app").rglob("*.py"))
        }
        if files != metadata["dataset_hashes"] or product != metadata["product_files"]:
            raise ValueError("入力または製品コードが変わったため再開できません。")
        rows = [json.loads(line) for line in self.records.read_text(encoding="utf-8").splitlines()]
        if (
            any(r["phase"] in {"cold", "warm", "after"} for r in rows)
            or sum(r["task"] == "draft" and r["phase"] == "baseline" for r in rows) != 30
            or sum(r["task"] == "answer" and r["phase"] == "baseline" for r in rows) != 120
        ):
            raise ValueError("基準線完了・時間計測未開始の状態だけ再開できます。")
        metadata["continuation"] = {
            "reason": "unload応答直後のresident残留。非resident確認を10秒以内で待つ制御へ修正。"
            "基準線の品質試行は再実行・置換しない。",
            "runner_hash": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "started_at": datetime.now(UTC).isoformat(),
        }
        (self.output / "metadata.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        self.documents = json.loads((self.output / "documents.json").read_text(encoding="utf-8"))
        self.login()

        def observe(client, *args, **kwargs):
            return self.observe(client, *args, **kwargs)

        with patch.object(OllamaClient, "_request", observe):
            self.latency_runs()
            for doc in read("post_documents"):
                self.publish(doc)
            self.radar_runs("after")
        self.client.close()
        self.employee.close()
        self.app.state.engine.dispose()
        self.engine.dispose()


def main():
    parser = argparse.ArgumentParser(description="S21 合成資料のみの実AI評価")
    parser.add_argument("command", choices=["run", "reset", "finish"])
    parser.add_argument("--output", type=Path, default=Path("/results/baseline-v1"))
    parser.add_argument("--confirm")
    args = parser.parse_args()
    if args.command == "reset":
        engine = build_engine(load_settings())
        reset(engine, args.confirm)
        print("評価専用DBをリセットしました。原本とデモは対象外です。")
        engine.dispose()
    elif args.command == "finish":
        Evaluation(args.output).finish()
    else:
        args.output.mkdir(parents=True, exist_ok=True)
        Evaluation(args.output).execute()


if __name__ == "__main__":
    main()
