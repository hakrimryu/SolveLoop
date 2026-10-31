from uuid import uuid4

import pytest
from pydantic import ValidationError
from test_business import business_engine as business_engine
from test_business import clients as clients
from test_business import copy, draft, post, review
from test_radar import ai as ai
from test_radar import batch, run_for, start

from app.radar_review import ReviewInput


def test_review_requires_reason_all_distinct_tickets_and_document_for_link():
    data = dict(
        request_key=uuid4(),
        expected_context_hash="a" * 64,
        decision="needs_supplement",
        reason="原文を照合",
        ticket_ids=[uuid4() for _ in range(5)],
        documents=[],
    )
    assert ReviewInput(**data).decision == "needs_supplement"
    for changes in (
        {"reason": " "},
        {"decision": "covered"},
        {"decision": "linked"},
        {"ticket_ids": [uuid4()] * 5},
        {"ai_correct": True},
    ):
        with pytest.raises(ValidationError):
            ReviewInput(**{**data, **changes})


@pytest.mark.integration
def test_human_review_is_append_only_and_never_changes_ai_judgment(clients, ai):
    op = clients["operator"]
    published = review(op, draft(op))
    tickets, run = run_for(clients)
    coverage = start(op, run)
    assert batch(op, coverage).status_code == 200
    path = f"/radar/runs/{run['id']}/candidates/{run['candidates'][0]['id']}/reviews"
    detail = op.get(f"/api/v1/radar/runs/{run['id']}").json()
    original = detail["coverages"]
    data = dict(
        request_key=str(uuid4()),
        expected_context_hash=detail["review_context"]["hash"],
        decision="linked",
        reason="各原文の対象・手順・注意を照合した合成検証です。",
        ticket_ids=[ticket["id"] for ticket in tickets],
        documents=[
            {"document_id": published["document_id"], "version_id": published["version_id"]}
        ],
        coverage_id=coverage["id"],
    )
    saved = post(op, path, data)
    assert saved.status_code == 200, saved.text
    value = saved.json()
    assert value["current"] and value["documents"][0]["version_no"] == 1
    assert post(op, path, data).json()["id"] == value["id"]
    assert post(op, path, {**data, "reason": "異なる内容"}).status_code == 409
    assert post(clients["employee"], path, data).status_code == 403
    assert post(clients["limited"], path, data).status_code == 403
    assert (
        post(
            op, path, {**data, "request_key": str(uuid4()), "ticket_ids": data["ticket_ids"][:-1]}
        ).status_code
        == 422
    )
    after = op.get(f"/api/v1/radar/runs/{run['id']}").json()
    assert after["coverages"] == original and len(after["reviews"]) == 1
    next_version = copy(op, published)
    review(op, next_version)
    changed = op.get(f"/api/v1/radar/runs/{run['id']}").json()
    assert not changed["reviews"][0]["current"]
    assert changed["reviews"][0]["documents"][0]["version_no"] == 1
    assert post(op, path, {**data, "request_key": str(uuid4())}).status_code == 409
    assert (
        post(
            op,
            path,
            {
                **data,
                "request_key": str(uuid4()),
                "expected_context_hash": changed["review_context"]["hash"],
            },
        ).status_code
        == 422
    )
