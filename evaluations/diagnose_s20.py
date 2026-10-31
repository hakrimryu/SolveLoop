"""S20のLF入力を隔離評価DBで再実行する。保留評価の採点対象外。"""

import argparse
import json
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

from run import Evaluation, guard
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.config import AISettings
from app.ai.knowledge import PROFILE_ID
from app.ai.ollama import OllamaClient
from app.demo import insert_dataset
from app.demo_data import Dataset
from app.knowledge_search import activate, backfill
from app.models import Ticket, User


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("/results/s20-diagnostic-v1"))
    output = parser.parse_args().output
    output.mkdir(parents=True, exist_ok=True)
    e = Evaluation(output)
    guard(e.engine)
    if e.records.exists():
        raise ValueError("結果は上書きできません。")
    with Session(e.engine) as s:
        if s.scalar(select(Ticket.id).limit(1)) or s.scalar(select(User.id).limit(1)):
            raise ValueError("先に評価DBのみを明示resetしてください。")
    data = Dataset(Path("/demo"))
    with Session(e.engine) as s, s.begin():
        insert_dataset(s, data)
    gap = next(s for s in data.scenarios if s.name == "knowledge-gap")
    e.login()

    def observe(client, *args, **kwargs):
        return e.observe(client, *args, **kwargs)

    summaries = []
    with patch.object(OllamaClient, "_request", observe):
        e.context = {"phase": "s20_initial_real_embedding"}
        backfill(e.engine, OllamaClient(AISettings()))
        activate(e.engine)
        row = e.record(
            "S20-RUN",
            "diagnostic",
            "detect",
            1,
            lambda: e.call(
                "/radar/runs",
                {
                    "request_key": str(uuid4()),
                    "as_of": data.manifest.as_of,
                    "days": 30,
                    "threshold": 0.92,
                },
            ),
            "diagnostic",
        )
        if row["status"] != 200:
            raise RuntimeError("診断用探知が失敗しました。")
        run = row["value"]
        candidates = [
            c for c in run["candidates"] if set(gap.source_ticket_ids) <= set(c["ticket_ids"])
        ]
        if not candidates:
            raise RuntimeError("診断対象候補を検出できませんでした。")
        candidate = max(candidates, key=lambda c: len(set(c["ticket_ids"]) & set(gap.ticket_ids)))
        for repeat in range(1, 4):
            e.coverage("diagnostic", repeat, "s20_before", run, candidate)
        refs = [
            {
                "ticket_id": i,
                "expected_ticket_version": e.call("/tickets/" + i, expected=200)[1]["version"],
            }
            for i in gap.source_ticket_ids
        ]
        for repeat in range(1, 4):
            e.record(
                "S20-DRAFT",
                "diagnostic",
                "draft",
                repeat,
                lambda: e.call("/knowledge/generations", {"source_refs": refs}),
                "diagnostic",
            )
        # S20で人が編集した公開文書と同じ内容。今回の利用者レビュー済みとは扱わない。
        _, version = e.call(
            "/knowledge/drafts",
            {
                "title": "携帯交換後のVPN MFA認証の再登録",
                "audience": "携帯電話を交換してVPNのMFA認証ができない社員",
                "body": "架空企業・デモデータ\n症状\n"
                "携帯交換後、旧端末の認証アプリが使えずVPNのMFAが失敗する。"
                "\n\n手順\n1. IT担当者が本人確認を行う。\n2. 旧端末の認証登録を失効する。"
                "\n3. 新端末用の認証登録を再発行する。\n4. 新端末の認証アプリを登録する。"
                "\n5. 認証コードでVPNに接続できることを本人と確認する。"
                "\n\n注意\n本人確認が完了するまでは登録を再発行しない。"
                "\n問い合わせ先\nIT担当へ社内問い合わせで相談する。",
                "department_id": str(UUID(int=101)),
                "source_refs": refs,
            },
            expected=201,
        )
        path = f"/knowledge/{version['document_id']}/versions/1"
        expected = {
            "expected_version": version["row_version"],
            "expected_document_version": version["document_row_version"],
        }
        e.call(path + "/prepare-search", expected, expected=200)
        e.call(path + "/approve", expected, expected=200)
        for repeat in range(1, 4):
            e.coverage("diagnostic", repeat, "s20_after", run, candidate)
    rows = [json.loads(line) for line in e.records.read_text(encoding="utf-8").splitlines()]
    for phase in ["s20_before", "s20_after"]:
        for repeat in range(1, 4):
            selected = [
                r
                for r in rows
                if r["phase"] == phase and r["repeat"] == repeat and r["status"] == 200
            ]
            if selected:
                value = selected[-1]["value"]
                summaries.append(
                    {
                        "phase": phase,
                        "repeat": repeat,
                        "summary": value["summary"],
                        "judgments": value["judgments"],
                        "elapsed_ms": sum(r["elapsed_ms"] for r in selected),
                    }
                )
    (output / "summary.json").write_text(
        json.dumps(
            {
                "scope": "s20_diagnostic_not_holdout",
                "manifest_hash": data.manifest_hash,
                "search_profile": PROFILE_ID,
                "run": run,
                "candidate": candidate,
                "results": summaries,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    e.client.close()
    e.employee.close()
    e.app.state.engine.dispose()
    e.engine.dispose()


if __name__ == "__main__":
    main()
