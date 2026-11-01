import re
from datetime import UTC, datetime
from threading import Lock
from time import monotonic
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BeforeValidator, Field
from sqlalchemy import select

from app.accounts import no_query
from app.ai.knowledge import PROFILE_ID, SPECIFICATION, embed
from app.ai.ollama import OllamaError
from app.ai.tickets import GUIDANCE_PROMPT_VERSION, propose
from app.auth import COOKIE_NAME, DbSession, FullAuthenticated, get_auth, require_csrf, require_json
from app.business import Input, clean, write_actor
from app.errors import ApiError
from app.guidance_history import begin_guidance, complete_guidance
from app.knowledge_search import (
    Client,
    ai_error,
    retrieve_public_chunks,
    search_state,
    supported_profile,
)
from app.models import KnowledgeDocument, KnowledgeVersion
from app.ticket_analysis import context_changed, knowledge_source

router = APIRouter(prefix="/api/v1/knowledge", tags=["社員向けAI案内"])
GUIDANCE_LOCK = Lock()
GUIDANCE_WAIT_SECONDS = 8


class GuidanceInput(Input):
    query: Annotated[str, BeforeValidator(clean), Field(min_length=1, max_length=500)]


def guidance_result(value):
    if value["status"] != "insufficient_evidence":
        return value
    missing = [
        item
        for item in value["missing_information"]
        if item.strip(" ：:") not in {"対象サービス", "症状", "適用条件"}
    ]
    return {
        **value,
        "summary": "根拠となる情報が不足しています。",
        "missing_information": missing
        or ["判断に必要な根拠が不足しています。状況を補足するか、担当者に問い合わせてください。"],
    }


def source_notices(session, sources, value):
    used = {ident for step in value["steps"] for ident in step["citation_ids"]}
    documents = {source["document_id"]: source for source in sources if source["id"] in used}
    notices = []
    for source in documents.values():
        version = session.get(KnowledgeVersion, UUID(source["version_id"]))
        match = re.search(
            r"(?m)^\s*(?:#{1,6}\s*)?(?:注意(?:事項)?(?:・例外)?|禁止事項|例外)\s*$", version.body
        )
        caution = version.body[match.end() :].strip() if match else ""
        if caution:
            caution = re.split(r"(?m)^(?:#{1,6}\s|改訂確認\s*$)", caution, maxsplit=1)[0].strip()
        notices.append(
            dict(
                document_id=source["document_id"],
                number=source["number"],
                version_no=source["version_no"],
                audience=source["audience"],
                text=caution,
                href=source["href"],
            )
        )
    return notices


def recheck(session, request, revision, vector, sources):
    current = get_auth(session, request.cookies.get(COOKIE_NAME))
    write_actor(request, session, current)
    state = search_state(session, lock=True)
    if state.revision != revision or state.active_profile_id != PROFILE_ID:
        context_changed()
    supported_profile(session, state.active_profile_id)
    ids = sorted({UUID(source["document_id"]) for source in sources})
    list(
        session.scalars(
            select(KnowledgeDocument)
            .where(KnowledgeDocument.id.in_(ids))
            .order_by(KnowledgeDocument.id)
            .with_for_update(read=True)
        )
    )
    list(
        session.scalars(
            select(KnowledgeVersion)
            .where(KnowledgeVersion.document_id.in_(ids))
            .order_by(KnowledgeVersion.id)
            .with_for_update(read=True)
        )
    )
    found = retrieve_public_chunks(
        session, vector, state, 3, chunk_ids=[UUID(source["id"]) for source in sources]
    )
    if {s["id"]: s for s in map(knowledge_source, found)} != {s["id"]: s for s in sources}:
        context_changed()
    return state


@router.post(
    "/guidance",
    summary="現在の公開文書だけを根拠に社員へ案内",
    dependencies=[Depends(require_json), Depends(no_query)],
)
def guidance(
    data: GuidanceInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    client: Client,
):
    require_csrf(request, auth, request.headers.get("X-CSRF-Token"))
    ident = begin_guidance(session, request, auth, data.query)
    started = monotonic()
    acquired = GUIDANCE_LOCK.acquire(timeout=GUIDANCE_WAIT_SECONDS)
    try:
        if not acquired:
            raise ApiError(
                503,
                "AI_BUSY",
                "ただいま混み合っています。質問は履歴に保存しました。文書検索や担当者への問い合わせも利用できます。",
            )
        state = search_state(session)
        supported_profile(session, state.active_profile_id)
        revision = state.revision
        session.rollback()
        vector, _ = embed(client, SPECIFICATION["query_template"].format(query=data.query))
        state = recheck(session, request, revision, vector, [])
        sources = [
            knowledge_source(item) for item in retrieve_public_chunks(session, vector, state, 3)
        ]
        session.rollback()
        if sources:
            value, generation = propose(client, "guidance", {"question": data.query}, [], sources)
        else:
            value, generation = (
                {
                    "status": "insufficient_evidence",
                    "summary": "根拠となる情報が不足しています。",
                    "steps": [],
                    "missing_information": [
                        "参照できる公開文書がありません。担当者に問い合わせできます。"
                    ],
                },
                None,
            )
        recheck(session, request, revision, vector, sources)
        value = guidance_result(value)
        response = {
            "query": data.query,
            "mode": "live",
            "prompt_version": GUIDANCE_PROMPT_VERSION,
            "generation": generation,
            "profile_id": PROFILE_ID,
            "generated_at": datetime.now(UTC),
            "request_id": str(request.state.request_id),
            "guidance_id": str(ident),
            "feedback_version": 1,
            "result": value,
            "sources": sources,
            "notices": source_notices(session, sources, value),
        }
        # 公開状態を再検査したトランザクション内で、案内と根拠を確定する。
        from fastapi.encoders import jsonable_encoder

        from app.models import GuidanceSession

        row = session.get(GuidanceSession, ident)
        row.response = jsonable_encoder(response)
        row.state = value["status"]
        row.elapsed_ms = int((monotonic() - started) * 1000)
        session.commit()
        return response
    except OllamaError as error:
        complete_guidance(
            session, request, auth, ident, int((monotonic() - started) * 1000), error=error.code
        )
        ai_error(error)
    except ApiError as error:
        if error.status not in (401, 403):
            complete_guidance(
                session, request, auth, ident, int((monotonic() - started) * 1000), error=error.code
            )
        raise
    finally:
        if acquired:
            GUIDANCE_LOCK.release()
