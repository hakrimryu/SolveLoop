import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from test_http_business import Client

from app.config import load_settings
from app.database import build_engine
from app.knowledge_search import activate
from app.models import KnowledgeDocument, Ticket

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("RUN_OLLAMA_TESTS") != "1"
        or os.getenv("RUN_DB_TESTS") != "1"
        or not os.getenv("AUTH_TEST_BASE_URL"),
        reason="空の専用DBと実API・ローカルOllamaを明示した場合だけ実行します。",
    ),
]


def test_live_repetition_coverage_draft_approval_and_same_scope_reanalysis():
    settings = load_settings()
    assert settings.postgres_db == "solveloop_test"
    engine = build_engine(settings)
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(Ticket)) == 0
        assert session.scalar(select(func.count()).select_from(KnowledgeDocument)) == 0
    activate(engine)
    op, emp = Client(), Client()
    op.timeout = emp.timeout = 300
    op.login("operator")
    emp.login("employee")

    def publish(version):
        path = f"/knowledge/{version['document_id']}/versions/{version['version_no']}"
        expected = {
            "expected_version": version["row_version"],
            "expected_document_version": version["document_row_version"],
        }
        op.ok(path + "/prepare-search", expected)
        return op.ok(path + "/approve", expected)

    def manual(title, audience, body):
        return publish(
            op.ok(
                "/knowledge/drafts",
                {
                    "title": title,
                    "audience": audience,
                    "body": body,
                    "department_id": str(UUID(int=101)),
                    "source_refs": [],
                },
                status=201,
                key=str(uuid4()),
            )
        )

    manual(
        "合成：VPNの基本接続",
        "VPNを初めて利用する社員",
        "会社PCでVPNクライアントを起動し、会社IDとパスワードを入力して接続を押します。これは初回の基本接続手順です。端末交換後の認証アプリ再登録手順は含みません。",
    )
    manual(
        "合成：出張交通費の経費申請",
        "出張交通費を精算する社員",
        "経費システムを開き、新規申請を選びます。交通費の金額と利用日を入力します。添付欄から領収書の画像をアップロードします。内容を確認して申請を送信します。添付できない場合は経理に相談してください。",
    )
    calibration = json.loads(
        (Path(__file__).parent / "fixtures/radar_calibration.json").read_text(encoding="utf-8")
    )
    bodies = calibration["bodies"][:5] + [
        calibration["bodies"][6],
        calibration["bodies"][7],
        "出張の交通費精算で領収書画像の添付欄と申請の送信ボタンを見つけられません。",
        "出張交通費を経費システムから申請するため、領収書のアップロードと送信の手順を知りたいです。",
        "交通費の出張精算を申請したいのですが、経費画面で領収書を添付して送信する操作を教えてください。",
        calibration["bodies"][5],
    ]
    tickets = [
        emp.ok(
            "/tickets",
            {
                "title": "合成動作確認："
                + (
                    "携帯交換後の追加認証"
                    if index < 5
                    else "経費申請"
                    if index < 10
                    else "VPNのインストール"
                ),
                "body": body,
                "department_id": None,
            },
            status=201,
            key=str(uuid4()),
        )
        for index, body in enumerate(bodies)
    ]
    ticket = tickets[0]
    path = f"/tickets/{ticket['id']}"
    ticket = op.ok(
        path + "/assignment",
        {
            "expected_version": ticket["version"],
            "department_id": str(UUID(int=101)),
            "assignee_id": str(UUID(int=202)),
        },
    )
    ticket = op.ok(path + "/transition", {"expected_version": ticket["version"], "action": "start"})
    ticket = op.ok(
        path + "/transition",
        {
            "expected_version": ticket["version"],
            "action": "resolve",
            "resolution": "対象は携帯電話を交換してVPNのMFA認証ができない社員です。"
            "IT担当者が本人確認を行った。旧端末の認証登録を失効した。"
            "新端末用の認証登録を再発行した。新端末の認証アプリを登録し、"
            "認証コードでVPNに接続できることを確認した。"
            "本人確認が完了するまでは登録を再発行しない。",
        },
    )
    tickets[0] = ticket
    # 実時刻の境界揺れから合成資料を分離し、固定の最近期間に置く。
    with Session(engine) as session, session.begin():
        for item in tickets:
            session.get(Ticket, UUID(item["id"])).created_at = datetime.now(UTC) - timedelta(days=1)
    run = op.ok(
        "/radar/runs", {"request_key": str(uuid4()), "as_of": datetime.now(UTC).isoformat()}
    )
    assert run["input_count"] == 11
    mfa_ids = {item["id"] for item in tickets[:5]}
    expense_ids = {item["id"] for item in tickets[5:10]}
    mfa = next(group for group in run["candidates"] if set(group["ticket_ids"]) == mfa_ids)
    expense = next(group for group in run["candidates"] if set(group["ticket_ids"]) == expense_ids)
    assert all(tickets[10]["id"] not in group["ticket_ids"] for group in run["candidates"])

    def analyze(group):
        value = op.ok(
            f"/radar/runs/{run['id']}/candidates/{group['id']}/coverage",
            {"request_key": str(uuid4())},
        )
        while value["unanalyzed_ids"]:
            value = op.ok(
                f"/radar/coverage/{value['id']}/batches",
                {"request_key": str(uuid4()), "ticket_ids": value["unanalyzed_ids"][:3]},
            )
        return value

    before = analyze(mfa)
    expense_coverage = analyze(expense)
    assert before["summary"]["uncovered"] == 5, before
    # 実モデルの小さな動作確認であり、全件対応や精度目標を要求する評価ではない。
    assert expense_coverage["summary"]["covered"] >= 1, expense_coverage
    assert expense_coverage["summary"]["unknown"] == 0, expense_coverage
    refs = [{"ticket_id": ticket["id"], "expected_ticket_version": ticket["version"]}]
    proposal = op.ok("/knowledge/generations", {"source_refs": refs})
    assert proposal["trace"]["mode"] == "live"
    body = {
        **proposal["draft"],
        "title": "合成：携帯交換後のVPN MFA再登録",
        "audience": "携帯電話を交換してVPNのMFA認証ができない社員",
        "body": "症状\n携帯電話を交換し、旧端末の認証アプリが使えずVPNのMFA認証ができない。"
        "\n\n解決手順\n1. IT担当者が本人確認を行う。\n2. 旧端末の認証登録を失効する。"
        "\n3. 新端末用の認証登録を再発行する。\n4. 新端末の認証アプリを登録する。"
        "\n5. 新端末の認証コードでVPN接続を確認する。"
        "\n\n注意\n本人確認が完了するまでは登録を再発行しない。",
        "department_id": str(UUID(int=101)),
        "source_refs": refs,
        "generation_id": proposal["generation_id"],
    }
    version = op.ok("/knowledge/drafts", body, status=201, key=str(uuid4()))
    assert version["status"] == "draft"
    publish(version)
    after = analyze(mfa)
    assert after["summary"]["covered"] > before["summary"]["covered"], after
    assert after["summary"]["unknown"] == 0 and after["summary"]["unanalyzed"] == 0, after
    history = op.ok(f"/radar/runs/{run['id']}")
    assert history["current"] and history["input_snapshot_hash"] == run["input_snapshot_hash"]
    assert history["coverages"][0]["summary"] == before["summary"]
    assert history["coverages"][0]["current"] is False
    assert emp.call("/radar/runs")[0] == 403
    assert op.ok(path)["version"] == ticket["version"]
    print(
        json.dumps(
            {
                "scope": "synthetic_live_smoke_not_formal_evaluation",
                "run_id": run["id"],
                "candidate_ids": [group["id"] for group in run["candidates"]],
                "before": before["summary"],
                "expense": expense_coverage["summary"],
                "after": after["summary"],
                "generation": proposal["trace"],
                "document_id": version["document_id"],
            },
            ensure_ascii=False,
        )
    )
    engine.dispose()
