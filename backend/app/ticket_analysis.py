from datetime import UTC, datetime
from threading import Lock
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select

from app.accounts import no_query
from app.ai.knowledge import PROFILE_ID, SPECIFICATION, chunks, embed, fingerprint
from app.ai.ollama import OllamaError
from app.ai.tickets import PROMPT_VERSION, propose
from app.auth import (
    COOKIE_NAME,
    DbSession,
    FullAuthenticated,
    get_auth,
    require_csrf,
    require_json,
    require_operator,
)
from app.business import Expected, Input, conflict, normalized, write_actor
from app.errors import ApiError
from app.knowledge_search import (
    Client,
    ai_error,
    retrieve_public_chunks,
    search_state,
    supported_profile,
)
from app.models import Department, KnowledgeDocument, KnowledgeVersion, Ticket
from app.tickets import ticket_messages, visible_ticket

router = APIRouter(prefix="/api/v1/tickets", tags=["問い合わせのAI提案"])
ANALYSIS_LOCK = Lock()


class AnalysisInput(Input):
    expected_version: Expected
    task: Literal["classification", "answer"]


def context_changed():
    raise ApiError(409, "AI_CONTEXT_CHANGED", "根拠または部署が変わりました。再実行してください。")


def departments_for(session):
    return [
        {"id": str(row.id), "code": row.code, "name": row.name}
        for row in session.scalars(
            select(Department).where(Department.active).order_by(Department.code)
        )
    ]


def ticket_context(ticket):
    return {
        "id": str(ticket.id),
        "version": ticket.version,
        "title": ticket.title,
        "body": ticket.body,
    }


def analysis_context(session, ticket):
    context = ticket_context(ticket)
    messages = ticket_messages(session, ticket.id)
    context["messages"] = [
        {"role": message.actor_role, "body": message.body} for message in messages[-4:]
    ]
    context["message_count"] = len(messages)
    return context


def knowledge_source(item):
    return {
        "id": item["chunk_id"],
        "kind": "knowledge",
        "document_id": item["document_id"],
        "version_id": item["version_id"],
        "version_no": item["version_no"],
        "chunk_id": item["chunk_id"],
        "number": item["number"],
        "title": item["title"],
        "audience": item["audience"],
        "context": item["context"],
        "text": item["text"],
        "content_hash": item["content_hash"],
        "chunk_hash": item["chunk_hash"],
        "body_start": item["body_start"],
        "body_end": item["body_end"],
        "href": f"/knowledge/{item['document_id']}?match_version={item['version_no']}"
        f"&start={item['body_start']}&end={item['body_end']}#search-passage",
    }


def bigrams(text):
    value = "".join(normalized(text).split())
    return {value[index : index + 2] for index in range(len(value) - 1)}


def similarity(left, right):
    return 2 * len(left & right) / (len(left) + len(right)) if left and right else 0


def case_sources(session, actor, target):
    require_operator((None, actor))
    rows = list(
        session.scalars(
            select(Ticket)
            .where(
                Ticket.id != UUID(target["id"]),
                Ticket.status == "resolved",
                Ticket.resolution.is_not(None),
            )
            .order_by(Ticket.id)
            .limit(101)
        )
    )
    if len(rows) > 100:
        raise ApiError(503, "AI_CORPUS_TOO_LARGE", "解決事例検索の対応範囲は100件までです。")
    query = bigrams(target["title"] + target["body"])
    ranked = []
    for row in rows:
        score = similarity(query, bigrams(row.title + row.body + row.resolution))
        if not score:
            continue
        fragments = chunks(row.title, "担当者向け解決事例", row.resolution)
        fragment = max(fragments, key=lambda part: similarity(query, bigrams(part.text)))
        source = {
            "id": str(row.id),
            "kind": "ticket",
            "ticket_id": str(row.id),
            "ticket_version": row.version,
            "number": row.number,
            "title": row.title,
            "text": fragment.text,
            "resolution_start": fragment.start,
            "resolution_end": fragment.end,
            "content_hash": fingerprint(
                {"ticket": ticket_context(row), "resolution": row.resolution}
            ),
            "href": f"/requests/{row.id}",
        }
        ranked.append((score, str(row.id), source))
    ranked.sort(key=lambda entry: (-entry[0], entry[1]))
    return [source for _, _, source in ranked[:2]]


def recheck(session, request, expected, target, departments, sources, vector, revision):
    current = get_auth(session, request.cookies.get(COOKIE_NAME))
    actor, _ = write_actor(request, session, current, operator=True)
    state = search_state(session, lock=True) if vector is not None else None
    ids = {UUID(target["id"])} | {UUID(s["ticket_id"]) for s in sources if s["kind"] == "ticket"}
    list(
        session.scalars(
            select(Ticket).where(Ticket.id.in_(ids)).order_by(Ticket.id).with_for_update()
        )
    )
    ticket = visible_ticket(session, actor, UUID(target["id"]))
    conflict(expected, ticket.version)
    if analysis_context(session, ticket) != target or departments_for(session) != departments:
        context_changed()
    if vector is None:
        return actor
    if state.revision != revision or state.active_profile_id != PROFILE_ID:
        context_changed()
    supported_profile(session, state.active_profile_id)
    doc_ids = sorted({UUID(s["document_id"]) for s in sources if s["kind"] == "knowledge"})
    list(
        session.scalars(
            select(KnowledgeDocument)
            .where(KnowledgeDocument.id.in_(doc_ids))
            .order_by(KnowledgeDocument.id)
            .with_for_update(read=True)
        )
    )
    list(
        session.scalars(
            select(KnowledgeVersion)
            .where(KnowledgeVersion.document_id.in_(doc_ids))
            .order_by(KnowledgeVersion.id)
            .with_for_update(read=True)
        )
    )
    doc_sources = [s for s in sources if s["kind"] == "knowledge"]
    found = retrieve_public_chunks(
        session,
        vector,
        state,
        2,
        chunk_ids=[UUID(s["id"]) for s in doc_sources],
    )
    actual = {s["id"]: s for s in map(knowledge_source, found)}
    for source in sources:
        if source["kind"] == "knowledge":
            if actual.get(source["id"]) != source:
                context_changed()
        else:
            row = visible_ticket(session, actor, UUID(source["ticket_id"]))
            if (
                row.status != "resolved"
                or fingerprint(
                    {
                        "ticket": ticket_context(row),
                        "resolution": row.resolution,
                    }
                )
                != source["content_hash"]
            ):
                context_changed()
    return actor


@router.post(
    "/{ticket_id}/analysis",
    summary="部署分類または根拠付き回答案を提案（業務状態は変更しない）",
    dependencies=[Depends(require_json), Depends(no_query), Depends(require_operator)],
)
def analyze(
    ticket_id: UUID,
    data: AnalysisInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    client: Client,
):
    require_csrf(request, auth, request.headers.get("X-CSRF-Token"))
    if not ANALYSIS_LOCK.acquire(blocking=False):
        raise ApiError(
            503, "AI_BUSY", "別の問い合わせのAI提案を処理中です。後で再実行してください。"
        )
    try:
        ticket = visible_ticket(session, auth[1], ticket_id)
        conflict(data.expected_version, ticket.version)
        target, departments = analysis_context(session, ticket), departments_for(session)
        sources, vector, revision = [], None, None
        if data.task == "answer":
            state = search_state(session)
            supported_profile(session, state.active_profile_id)
            revision = state.revision
        session.rollback()
        if data.task == "answer":
            vector, _ = embed(
                client,
                SPECIFICATION["query_template"].format(
                    query=target["title"]
                    + "\n"
                    + target["body"]
                    + "\n"
                    + "\n".join(message["body"][:500] for message in target["messages"]),
                ),
            )
            actor = recheck(
                session, request, data.expected_version, target, departments, [], vector, revision
            )
            state = search_state(session)
            sources = [
                knowledge_source(item) for item in retrieve_public_chunks(session, vector, state, 2)
            ]
            sources += case_sources(session, actor, target)
            session.rollback()
        if data.task == "answer" and not sources:
            value = {
                "status": "insufficient_evidence",
                "summary": "根拠となる情報が不足しています。",
                "steps": [],
                "missing_information": ["参照できる公開文書・解決事例を確認してください。"],
            }
            generation = None
        else:
            value, generation = propose(client, data.task, target, departments, sources)
        recheck(
            session, request, data.expected_version, target, departments, sources, vector, revision
        )
        if data.task == "classification":
            value["department"] = next(
                (d for d in departments if d["code"] == value["department_code"]), None
            )
        else:
            used = {ref for step in value["steps"] for ref in step["citation_ids"]}
            sources = [source for source in sources if source["id"] in used]
            if value["status"] == "insufficient_evidence":
                value["summary"] = "根拠となる情報が不足しています。"
        return {
            "task": data.task,
            "ticket_id": str(ticket_id),
            "ticket_version": data.expected_version,
            "mode": "live",
            "prompt_version": PROMPT_VERSION,
            "generation": generation,
            "profile_id": PROFILE_ID if vector is not None else None,
            "retrieval": {"knowledge": "semantic_top2", "tickets": "character_bigram_dice_top2"}
            if vector is not None
            else None,
            "generated_at": datetime.now(UTC),
            "request_id": str(request.state.request_id),
            "result": value,
            "sources": sources,
        }
    except OllamaError as error:
        ai_error(error)
    finally:
        ANALYSIS_LOCK.release()
