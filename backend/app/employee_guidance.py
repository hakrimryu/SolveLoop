from datetime import UTC, datetime
from threading import Lock
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


class GuidanceInput(Input):
    query: Annotated[str, BeforeValidator(clean), Field(min_length=1, max_length=500)]


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
    if not GUIDANCE_LOCK.acquire(blocking=False):
        raise ApiError(503, "AI_BUSY", "別のAI案内を処理中です。後で確認してください。")
    try:
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
        if value["status"] == "insufficient_evidence":
            value["summary"] = "根拠となる情報が不足しています。"
        return {
            "query": data.query,
            "mode": "live",
            "prompt_version": GUIDANCE_PROMPT_VERSION,
            "generation": generation,
            "profile_id": PROFILE_ID,
            "generated_at": datetime.now(UTC),
            "request_id": str(request.state.request_id),
            "result": value,
            "sources": sources,
        }
    except OllamaError as error:
        ai_error(error)
    finally:
        GUIDANCE_LOCK.release()
