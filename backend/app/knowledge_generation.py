from datetime import UTC, datetime, timedelta
from threading import Lock
from time import monotonic
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import AfterValidator, Field
from sqlalchemy import select

from app.accounts import no_query
from app.ai.drafts import REQUEST_SECONDS, propose_draft
from app.ai.knowledge import fingerprint
from app.ai.ollama import OllamaError
from app.auth import (
    COOKIE_NAME,
    DbSession,
    FullAuthenticated,
    get_auth,
    require_csrf,
    require_json,
    require_operator,
)
from app.business import Input, conflict, department_ref, finish, write_actor
from app.errors import ApiError
from app.knowledge import SourceRef, lock_tickets, source_hash, source_snapshot, valid_refs
from app.knowledge_search import Client, ai_error
from app.models import KnowledgeGeneration
from app.tickets import visible_ticket

router = APIRouter(prefix="/api/v1/knowledge", tags=["解決履歴からの知識生成"])
GENERATION_LOCK = Lock()


class GenerationInput(Input):
    source_refs: Annotated[
        list[SourceRef], Field(min_length=1, max_length=5), AfterValidator(valid_refs)
    ]


def changed():
    raise ApiError(
        409, "AI_CONTEXT_CHANGED", "生成の根拠が変わりました。原本を再確認して生成してください。"
    )


def evidence(session, actor, refs):
    sources = []
    for ref in sorted(refs, key=lambda item: item.ticket_id):
        ticket = visible_ticket(session, actor, ref.ticket_id)
        conflict(ref.expected_ticket_version, ticket.version)
        if (
            ticket.status != "resolved"
            or not ticket.resolution
            or not ticket.resolution.strip()
            or not ticket.resolved_at
        ):
            raise ApiError(409, "SOURCE_NOT_RESOLVED", "有効な解決内容と解決日時が必要です。")
        snapshot = source_snapshot(session, ticket)
        sources.append(
            {
                "ticket_id": str(ticket.id),
                "ticket_number": ticket.number,
                "ticket_version": ticket.version,
                "content_hash": source_hash(snapshot),
                "snapshot": snapshot,
            }
        )
    return sources


def current_actor(request, session):
    return write_actor(
        request, session, get_auth(session, request.cookies.get(COOKIE_NAME)), operator=True
    )[0]


def consume_generation(session, request, actor, generation_id, refs, tickets, version):
    if generation_id is None:
        return None
    row = session.scalar(
        select(KnowledgeGeneration).where(KnowledgeGeneration.id == generation_id).with_for_update()
    )
    auth = get_auth(session, request.cookies.get(COOKIE_NAME))
    if row is None or row.actor_id != actor.id or row.session_id != auth[0].id:
        raise ApiError(404, "NOT_FOUND", "このセッションで生成した案が見つかりません。")
    if row.consumed_at is not None:
        raise ApiError(
            409,
            "AI_GENERATION_USED",
            "この生成案は保存済みです。保存先の一覧・履歴を確認してください。",
        )
    if row.expires_at <= datetime.now(UTC):
        raise ApiError(
            409,
            "AI_GENERATION_EXPIRED",
            "生成案の保存期限が切れました。入力を保持して再生成してください。",
        )
    actual_refs = {(str(ref.ticket_id), ref.expected_ticket_version) for ref in refs or []}
    if actual_refs != {(s["ticket_id"], s["ticket_version"]) for s in row.sources}:
        changed()
    for source in row.sources:
        ticket = tickets.get(UUID(source["ticket_id"]))
        if (
            ticket is None
            or ticket.status != "resolved"
            or source_hash(source_snapshot(session, ticket)) != source["content_hash"]
        ):
            changed()
    fields = {key: getattr(version, key) for key in ("title", "audience", "body")}
    trace = {
        **row.trace,
        "generation_id": str(row.id),
        "generated_at": row.created_at.isoformat(),
        "saved_content_hash": fingerprint(fields),
        "edited": fingerprint(fields) != row.trace["output_hash"],
    }
    row.consumed_at = datetime.now(UTC)
    row.saved_version_id = version.id
    return trace


@router.post(
    "/generations",
    summary="選んだ解決記録から知識案を生成（下書き保存・承認は別操作）",
    dependencies=[Depends(require_json), Depends(no_query), Depends(require_operator)],
)
def generate(
    data: GenerationInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    client: Client,
):
    require_csrf(request, auth, request.headers.get("X-CSRF-Token"))
    started = monotonic()
    deadline = started + REQUEST_SECONDS
    if not GENERATION_LOCK.acquire(blocking=False):
        raise ApiError(503, "AI_BUSY", "別の知識案を生成中です。後で再実行してください。")
    try:
        session_id = auth[0].id
        sources = evidence(session, auth[1], data.source_refs)
        session.rollback()
        value, fields, trace = propose_draft(client, sources, deadline)
        if monotonic() >= deadline:
            raise OllamaError("AI_TIMEOUT", "生成要求の制限時間を超えました。")
        actor = current_actor(request, session)
        lock_tickets(session, {ref.ticket_id for ref in data.source_refs})
        if evidence(session, actor, data.source_refs) != sources:
            changed()
        now = datetime.now(UTC)
        trace.update(
            request_id=str(request.state.request_id),
            elapsed_ms=round((monotonic() - started) * 1000, 2),
        )
        row = KnowledgeGeneration(
            actor_id=actor.id,
            session_id=session_id,
            sources=[
                {key: value for key, value in source.items() if key != "snapshot"}
                for source in sources
            ],
            trace=trace,
            created_at=now,
            expires_at=now + timedelta(hours=1),
        )
        session.add(row)
        session.flush()
        dto_sources = [
            {
                **{
                    key: source[key]
                    for key in ("ticket_id", "ticket_number", "ticket_version", "content_hash")
                },
                **{
                    key: source["snapshot"][key]
                    for key in ("title", "body", "resolution", "resolved_at", "updated_at")
                },
                "department": department_ref(session, UUID(source["snapshot"]["department_id"]))
                if source["snapshot"]["department_id"]
                else None,
            }
            for source in sources
        ]
        return finish(
            session,
            {
                "generation_id": str(row.id),
                "generated_at": now,
                "expires_at": row.expires_at,
                "result": value,
                "draft": fields,
                "sources": dto_sources,
                "trace": trace,
            },
        )
    except OllamaError as error:
        ai_error(error)
    finally:
        GENERATION_LOCK.release()
