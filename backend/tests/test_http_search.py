import os
from uuid import UUID, uuid4

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session
from test_http_business import Client

from app.ai.knowledge import PROFILE_ID
from app.config import load_settings
from app.database import build_engine
from app.knowledge_search import activate
from app.models import (
    IdempotencyRecord,
    KnowledgeDocument,
    KnowledgeEvent,
    KnowledgePreparation,
    KnowledgeSource,
    KnowledgeVersion,
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("RUN_OLLAMA_TESTS") != "1"
        or os.getenv("RUN_DB_TESTS") != "1"
        or not os.getenv("AUTH_TEST_BASE_URL"),
        reason="実Ollamaと専用DB/APIを明示した場合だけ実行します。",
    ),
]


def test_local_ollama_storage_search_and_revision(capsys):
    settings = load_settings()
    assert settings.postgres_db == "solveloop_test"
    engine = build_engine(settings)
    op, emp = Client(), Client()
    op.timeout = emp.timeout = 150
    op.login("operator")
    emp.login("employee")
    docs = []
    try:
        activate(engine)
        for title, audience, body in [
            (
                "スマートフォン交換後のVPN認証",
                "会社のVPNを使う社員",
                "手順\n認証ポータルで新しい携帯端末を登録します。旧端末の認証登録を失効し、"
                "新端末の認証アプリでコードを確認してVPNに接続します。\n\n例外\n旧端末がなく"
                "本人確認ができない場合はIT担当者へ連絡し、本人確認後に登録を再発行します。",
            ),
            (
                "経費精算の領収書添付",
                "出張経費を申請する社員",
                "手順\n経費申請の明細画面で領収書の画像を添付し、金額と日付を確認して申請します。"
                "\n\n例外\n領収書を紛失した場合は経理担当者へ連絡し、再発行の可否を確認します。",
            ),
            (
                "複合機の両面印刷",
                "社内のプリンターを使う社員",
                "手順\n印刷設定で両面を選び、とじ方向を確認してから印刷します。\n\n例外\n"
                "厚紙を使う場合は両面にせず、手差しトレイで片面ずつ印刷します。",
            ),
        ]:
            version = op.ok(
                "/knowledge/drafts",
                dict(
                    title=title,
                    audience=audience,
                    body=body,
                    department_id=str(UUID(int=101)),
                    source_refs=[],
                ),
                status=201,
                key=str(uuid4()),
            )
            docs.append(UUID(version["document_id"]))
            path = f"/knowledge/{version['document_id']}/versions/1"
            expected = dict(expected_version=1, expected_document_version=1)
            assert op.call(path + "/approve", expected)[1]["code"] == "EMBEDDING_NOT_READY"
            prepared = op.ok(path + "/prepare-search", expected)
            assert prepared["search_preparation"]["status"] == "ready"
            op.ok(path + "/approve", expected)
        query = "携帯を買い替えてから社外のネットワークに入れません"
        first = emp.ok("/knowledge/search", {"query": query, "top_k": 3})
        assert first["profile_id"] == PROFILE_ID
        assert first["items"][0]["document_id"] == str(docs[0])
        assert all(item["version_no"] == 1 for item in first["items"])
        original_chunk = first["items"][0]["chunk_id"]
        saved = op.ok(f"/knowledge/{docs[0]}/versions/1")
        revision = op.ok(
            f"/knowledge/{docs[0]}/drafts",
            dict(base_version_no=1, expected_document_version=saved["document_row_version"]),
            status=201,
            key=str(uuid4()),
        )
        path = f"/knowledge/{docs[0]}/versions/2"
        revision = op.ok(
            path,
            dict(
                expected_version=1,
                body="手順\n新端末の認証アプリを登録し、IT担当者の本人確認を受けてからVPNへ"
                "接続します。旧端末の認証登録は失効します。\n\n例外\n紛失時はIT担当者に"
                "連絡してください。本人確認が終わるまでは登録を再発行できません。",
            ),
            method="PATCH",
        )
        assert (
            emp.ok("/knowledge/search", {"query": query, "top_k": 1})["items"][0]["chunk_id"]
            == original_chunk
        )
        expected = dict(
            expected_version=revision["row_version"],
            expected_document_version=revision["document_row_version"],
        )
        op.ok(path + "/prepare-search", expected)
        op.ok(path + "/approve", expected)
        latest = emp.ok("/knowledge/search", {"query": query, "top_k": 3})
        assert latest["items"][0]["document_id"] == str(docs[0])
        assert latest["items"][0]["version_no"] == 2
        assert all(item["chunk_id"] != original_chunk for item in latest["items"])
        print(
            {
                "scope": "synthetic_local_smoke",
                "profile_id": PROFILE_ID,
                "first_distance": first["items"][0]["cosine_distance"],
                "revision_distance": latest["items"][0]["cosine_distance"],
                "published_documents": len(docs),
                "latest_version_no": 2,
            }
        )
    finally:
        for client in (op, emp):
            client.call("/auth/logout", {})
        with Session(engine) as session, session.begin():
            versions = select(KnowledgeVersion.id).where(KnowledgeVersion.document_id.in_(docs))
            session.execute(delete(IdempotencyRecord).where(IdempotencyRecord.entity_id.in_(docs)))
            session.execute(
                delete(KnowledgePreparation).where(KnowledgePreparation.version_id.in_(versions))
            )
            session.execute(
                update(KnowledgeDocument)
                .where(KnowledgeDocument.id.in_(docs))
                .values(published_version_id=None)
            )
            session.execute(
                delete(KnowledgeEvent).where(KnowledgeEvent.knowledge_version_id.in_(versions))
            )
            session.execute(
                delete(KnowledgeSource).where(KnowledgeSource.knowledge_version_id.in_(versions))
            )
            session.execute(delete(KnowledgeVersion).where(KnowledgeVersion.document_id.in_(docs)))
            session.execute(delete(KnowledgeDocument).where(KnowledgeDocument.id.in_(docs)))
        engine.dispose()
