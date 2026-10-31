import json
import math
from datetime import UTC, datetime, timedelta
from time import monotonic
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from search_fixtures import FixtureEmbeddings
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session
from test_business import action, create_ticket, draft, post, review, review_path, solved
from test_business import business_engine as business_engine
from test_business import clients as clients

from app.ai.knowledge import PROFILE_ID
from app.ai.ollama import OllamaError
from app.ai.radar import TICKET_PROFILE, Coverage, groups, judge
from app.ai.tickets import CHAT_DIGEST
from app.knowledge_search import embedding_client
from app.models import (
    AuthSession,
    KnowledgeSearchState,
    RadarCoverage,
    RadarRun,
    Ticket,
    TicketEmbedding,
    User,
)
from app.radar import RADAR_LOCK, BatchInput, RunInput


class RadarAI(FixtureEmbeddings):
    """固定応答は契約・保存の検証専用。実モデルの精度ではない。"""

    hook = None
    error = None
    invalid = False
    embeds = 0
    generations = 0

    def embed(self, value, **kwargs):
        self.embeds += 1
        if self.hook:
            self.hook()
        if self.error:
            raise OllamaError(self.error, "試験のAI障害")
        return super().embed(value, **kwargs)

    def structured(self, prompt, schema, expected_digest, **kwargs):
        self.generations += 1
        assert expected_digest == CHAT_DIGEST
        if self.hook:
            self.hook()
        if self.error:
            raise OllamaError(self.error, "試験のAI障害")
        material = json.loads(prompt.split("資料JSON:\n")[1].split("\n前回")[0])
        source = material["sources"][0]
        value = {
            "status": "covered",
            "rationale": "対象と手順が記載されています。",
            "missing_information": [],
            "citations": [
                {"chunk_id": "invented" if self.invalid else source["id"], "quote": source["text"]}
            ],
        }
        return {
            "response": json.dumps(value),
            "local_model": {"name": "qwen3:8b", "digest": CHAT_DIGEST},
            "prompt_eval_count": 1000,
            "eval_count": 90,
        }


@pytest.fixture
def ai(clients):
    value = RadarAI()
    clients["operator"].app.dependency_overrides[embedding_client] = lambda: value
    return value


def detect(client, **changes):
    return post(
        client,
        "/radar/runs",
        {"request_key": str(uuid4()), "as_of": datetime.now(UTC).isoformat(), **changes},
    )


def repeated(clients, count=5):
    tickets = [solved(clients)]
    tickets.extend(create_ticket(clients["employee"]) for _ in range(count - 1))
    with Session(clients["operator"].app.state.engine) as session, session.begin():
        for ticket in tickets:
            session.get(Ticket, UUID(ticket["id"])).created_at = datetime.now(UTC) - timedelta(
                days=1
            )
    return tickets


def run_for(clients):
    tickets = repeated(clients)
    result = detect(clients["operator"])
    assert result.status_code == 200, result.text
    return tickets, result.json()


def start(client, run, **changes):
    result = post(
        client,
        f"/radar/runs/{run['id']}/candidates/{run['candidates'][0]['id']}/coverage",
        {"request_key": str(uuid4()), **changes},
    )
    assert result.status_code == 200, result.text
    return result.json()


def batch(client, coverage, ids=None, key=None):
    return post(
        client,
        f"/radar/coverage/{coverage['id']}/batches",
        {"request_key": key or str(uuid4()), "ticket_ids": ids or coverage["unanalyzed_ids"][:3]},
    )


def test_all_pair_rule_does_not_merge_chain_and_is_deterministic():
    vectors = {
        str(i): [math.cos(angle), math.sin(angle)]
        for i, angle in enumerate([0, 0.1, 0.2, 0.3, 0.4, 0.5])
    }
    found = groups(vectors, math.cos(0.41), minimum=3)
    assert found == groups(dict(reversed(list(vectors.items()))), math.cos(0.41), minimum=3)
    assert len(found) > 1 and all(item["overlap"] for item in found)
    assert all(len(item["ticket_ids"]) < 6 for item in found)
    assert all(pair["similarity"] >= math.cos(0.41) for item in found for pair in item["pairs"])
    assert not any(set(a["ticket_ids"]) < set(b["ticket_ids"]) for a in found for b in found)
    assert len(groups({str(i): [1.0, 0.0] for i in range(6)}, 0.92)) == 1
    assert groups({str(i): [1.0, 0.0] for i in range(4)}, 0.92) == []


@pytest.mark.parametrize(
    "changes",
    [
        {"as_of": "2026-10-01"},
        {"days": True},
        {"days": 91},
        {"threshold": "0.92"},
        {"threshold": float("nan")},
        {"other": True},
    ],
)
def test_strict_conditions(changes):
    data = {"request_key": uuid4(), "as_of": datetime.now(UTC), **changes}
    with pytest.raises(ValidationError):
        RunInput(**data)


def test_strict_batch_and_coverage_output():
    with pytest.raises(ValidationError):
        BatchInput(request_key=uuid4(), ticket_ids=[uuid4()] * 2)
    with pytest.raises(ValidationError):
        Coverage(status="covered", rationale="理由", missing_information=[], citations=[])
    with pytest.raises(ValidationError):
        Coverage(status="uncovered", rationale="理由", missing_information=[], citations=[])


def test_detect_cache_replay_and_modified_input(clients, ai, business_engine):
    tickets, run = run_for(clients)
    client = clients["operator"]
    assert run["input_count"] == 5 and len(run["candidates"]) == 1 and ai.embeds == 5
    assert run["parameters"]["ticket_profile_id"] == TICKET_PROFILE
    assert TICKET_PROFILE != PROFILE_ID
    result = detect(client, request_key=run["request_key"], as_of=run["as_of"])
    assert result.json()["id"] == run["id"] and ai.embeds == 5
    assert (
        detect(client, request_key=run["request_key"], as_of=run["as_of"], days=29).status_code
        == 409
    )
    assert detect(client, as_of=run["as_of"]).status_code == 200 and ai.embeds == 5
    changed = client.patch(
        f"/api/v1/tickets/{tickets[1]['id']}",
        json={
            "expected_version": tickets[1]["version"],
            "body": "機種変更後の認証手順を確認したいです。",
        },
    )
    assert changed.status_code == 200, changed.text
    history = client.get(f"/api/v1/radar/runs/{run['id']}").json()
    assert history["current"] is False
    assert detect(client, as_of=run["as_of"]).status_code == 200 and ai.embeds == 6
    with Session(business_engine) as session:
        assert session.scalar(select(func.count()).select_from(TicketEmbedding)) == 5
        assert (
            session.get(TicketEmbedding, (UUID(tickets[1]["id"]), TICKET_PROFILE)).ticket_version
            == changed.json()["version"]
        )


def test_period_created_at_not_updated_and_limit(clients, ai, business_engine):
    tickets = repeated(clients)
    as_of = datetime.now(UTC)
    with Session(business_engine) as session, session.begin():
        ticket = session.get(Ticket, UUID(tickets[-1]["id"]))
        ticket.created_at = as_of - timedelta(days=31)
        ticket.updated_at = as_of
    run = detect(clients["operator"], as_of=as_of.isoformat()).json()
    assert run["input_count"] == 4 and run["candidate_count"] == 0
    assert (
        detect(clients["operator"], as_of=(as_of + timedelta(days=1)).isoformat()).status_code
        == 422
    )


def test_partial_empty_corpus_approval_reanalysis_and_no_overwrite(clients, ai):
    _, run = run_for(clients)
    client = clients["operator"]
    first = start(client, run)
    assert first["summary"]["unanalyzed"] == 5 and first["summary"]["unknown"] == 0
    key = str(uuid4())
    part = batch(client, first, key=key)
    assert part.status_code == 200, part.text
    part = part.json()
    assert part["summary"]["uncovered"] == 3 and part["summary"]["unanalyzed"] == 2
    assert part["summary"]["rates"]["uncovered"] == 0.6 and ai.generations == 0
    replay = batch(client, first, key=key)
    assert replay.json()["summary"] == part["summary"]
    complete = batch(client, part).json()
    assert complete["summary"]["gap_status"] == "gap"
    assert batch(client, complete, first["unanalyzed_ids"][:1]).status_code == 409
    version = draft(client)
    review(client, version)
    current = client.get(f"/api/v1/radar/runs/{run['id']}").json()
    assert current["current"] is True
    assert current["coverages"][0]["current"] is False
    assert all(
        value.get("historical") and "rationale" not in value
        for value in current["coverages"][0]["judgments"].values()
    )
    second = start(client, run)
    part = batch(client, second).json()
    complete2 = batch(client, part)
    assert complete2.status_code == 200, complete2.text
    complete2 = complete2.json()
    assert complete2["summary"]["covered"] == 5 and complete2["summary"]["gap_status"] == "covered"
    assert complete["summary"]["uncovered"] == 5
    assert all(v["citations"][0]["quote"] for v in complete2["judgments"].values())


@pytest.mark.parametrize("error", ["AI_TIMEOUT", "AI_UNAVAILABLE", "AI_INVALID_RESPONSE"])
def test_model_failure_unknown_and_preserves_unanalyzed(clients, ai, error):
    _, run = run_for(clients)
    review(clients["operator"], draft(clients["operator"]))
    coverage = start(clients["operator"], run)
    ai.error = error
    result = batch(clients["operator"], coverage)
    assert result.status_code == 200, result.text
    summary = result.json()["summary"]
    assert summary["unknown"] == 3 and summary["uncovered"] == 0 and summary["unanalyzed"] == 2
    assert all(value["error_code"] == error for value in result.json()["judgments"].values())
    assert create_ticket(clients["employee"])["status"] == "open"


def test_false_citation_unknown_after_one_correction(clients, ai):
    _, run = run_for(clients)
    review(clients["operator"], draft(clients["operator"]))
    coverage = start(clients["operator"], run)
    ai.invalid = True
    result = batch(clients["operator"], coverage, coverage["unanalyzed_ids"][:1]).json()
    assert result["summary"]["unknown"] == 1 and ai.generations == 2
    assert next(iter(result["judgments"].values()))["error_code"] == "AI_INVALID_OUTPUT"


@pytest.mark.parametrize("change", ["ticket", "session", "role", "active"])
def test_detection_returns_connection_and_rechecks(clients, ai, business_engine, change):
    tickets = repeated(clients)
    client = clients["operator"]
    once = False

    def mutate():
        nonlocal once
        assert business_engine.pool.checkedout() == 0
        if once:
            return
        once = True
        with Session(business_engine) as session, session.begin():
            if change == "ticket":
                row = session.get(Ticket, UUID(tickets[0]["id"]))
                row.version += 1
            elif change == "session":
                session.query(AuthSession).filter(AuthSession.user_id == UUID(int=202)).delete()
            else:
                user = session.get(User, UUID(int=202))
                if change == "role":
                    user.role = "employee"
                else:
                    user.active = False

    ai.hook = mutate
    result = detect(client)
    assert result.status_code in {401, 403, 409}, result.text
    with Session(business_engine) as session:
        assert session.scalar(select(RadarRun.status)) == "failed"
        assert session.scalar(select(func.count()).select_from(TicketEmbedding)) == 0


@pytest.mark.parametrize(
    "change", ["ticket", "reopen", "publication", "delete", "profile", "session"]
)
def test_batch_rechecks_context_and_preserves_completed_range(clients, ai, business_engine, change):
    tickets, run = run_for(clients)
    client = clients["operator"]
    version = review(client, draft(client))
    coverage = start(client, run)
    first = batch(client, coverage, coverage["unanalyzed_ids"][:1]).json()
    once = False

    def mutate():
        nonlocal once
        assert business_engine.pool.checkedout() == 0
        if once:
            return
        once = True
        if change == "reopen":
            action(client, tickets[0], "reopen", assignee_id=str(UUID(int=202)))
            return
        if change == "publication":
            result = post(
                client,
                review_path(version) + "/stop-publication",
                {
                    "expected_version": version["row_version"],
                    "expected_document_version": version["document_row_version"],
                },
            )
            assert result.status_code == 200, result.text
            return
        if change == "delete":
            result = post(
                client,
                review_path(version) + "/delete-document",
                {
                    "expected_version": version["row_version"],
                    "expected_document_version": version["document_row_version"],
                    "confirmation_number": version["number"],
                },
            )
            assert result.status_code == 200, result.text
            return
        with Session(business_engine) as session, session.begin():
            if change == "ticket":
                row = session.get(Ticket, UUID(tickets[1]["id"]))
                row.body += "更新"
                row.version += 1
            elif change == "profile":
                session.get(KnowledgeSearchState, 1).revision += 1
            else:
                session.query(AuthSession).filter(AuthSession.user_id == UUID(int=202)).delete()

    ai.hook = mutate
    result = batch(client, first, first["unanalyzed_ids"][:1])
    assert result.status_code in {401, 409}, result.text
    with Session(business_engine) as session:
        row = session.get(RadarCoverage, UUID(coverage["id"]))
        assert len(row.judgments) == 1 and row.batches[-1]["status"] == "failed"


def test_permissions_csrf_busy_and_no_automatic_generation(clients, ai):
    for name in ("employee", "limited"):
        assert detect(clients[name]).status_code == 403
        assert clients[name].get("/api/v1/radar/runs").status_code == 403
    client = clients["operator"]
    original = client.headers.pop("X-CSRF-Token")
    assert detect(client).status_code == 403
    client.headers["X-CSRF-Token"] = original
    RADAR_LOCK.acquire()
    try:
        assert detect(client).status_code == 503
    finally:
        RADAR_LOCK.release()
    _, run = run_for(clients)
    assert sum(member["can_generate"] for member in run["candidates"][0]["members"]) == 1
    assert ai.generations == 0


def test_detection_failure_not_empty_success(clients, ai, business_engine):
    repeated(clients)
    ai.error = "AI_UNAVAILABLE"
    assert detect(clients["operator"]).status_code == 503
    with Session(business_engine) as session:
        row = session.scalar(select(RadarRun))
        assert (
            row.status == "failed" and row.error_code == "AI_UNAVAILABLE" and row.candidates == []
        )


def test_deadline_and_empty_corpus_do_not_invoke_generator():
    fake = RadarAI()
    assert judge(fake, {}, [], monotonic() + 1)["status"] == "uncovered"
    with pytest.raises(OllamaError, match="経過時間"):
        judge(fake, {}, [], monotonic() - 1)


def test_scope_upper_bound_is_explicit_and_does_not_create_zero_run(clients, ai, business_engine):
    repeated(clients, 101)
    response = detect(clients["operator"])
    assert response.status_code == 422 and response.json()["code"] == "RADAR_SCOPE_TOO_LARGE"
    assert ai.embeds == 0
    with Session(business_engine) as session:
        assert session.scalar(select(func.count()).select_from(RadarRun)) == 0


def test_batch_budget_keeps_unattempted_tickets_separate(clients, ai, monkeypatch):
    _, run = run_for(clients)
    coverage = start(clients["operator"], run)
    monkeypatch.setattr("app.radar.BATCH_SECONDS", -1)
    response = batch(clients["operator"], coverage)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["summary"]["unanalyzed"] == 5 and value["summary"]["unknown"] == 0
    assert value["batches"][0]["budget_exhausted"] is True


def test_interrupted_batch_replay_and_explicit_new_request(clients, ai, business_engine):
    _, run = run_for(clients)
    coverage = start(clients["operator"], run)
    key = str(uuid4())
    ids = sorted(coverage["unanalyzed_ids"][:1])
    with Session(business_engine) as session, session.begin():
        session.get(RadarCoverage, UUID(coverage["id"])).batches = [
            {
                "request_key": key,
                "ticket_ids": ids,
                "status": "running",
                "lease_until": (datetime.now(UTC) - timedelta(seconds=1)).isoformat(),
            }
        ]
    replay = batch(clients["operator"], coverage, ids, key).json()
    assert replay["batches"][0]["status"] == "interrupted" and not replay["judgments"]
    continued = batch(clients["operator"], coverage, ids).json()
    assert continued["summary"]["uncovered"] == 1
    assert continued["batches"][0]["status"] == "interrupted"


def test_failed_result_commit_does_not_save_partial_judgments(clients, ai, business_engine):
    _, run = run_for(clients)
    coverage = start(clients["operator"], run)
    once = False

    def fail_update(connection, cursor, statement, parameters, context, many):
        nonlocal once
        if (
            not once
            and "UPDATE solveloop_business_test.radar_coverages SET judgments=" in statement
        ):
            once = True
            raise RuntimeError("試験の保存失敗")

    event.listen(business_engine, "before_cursor_execute", fail_update)
    try:
        response = batch(clients["operator"], coverage)
    finally:
        event.remove(business_engine, "before_cursor_execute", fail_update)
    assert once and response.status_code == 500, response.text
    with Session(business_engine) as session:
        row = session.get(RadarCoverage, UUID(coverage["id"]))
        assert row.judgments == {} and row.batches[-1]["status"] == "failed"
