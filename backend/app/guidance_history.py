from datetime import UTC, datetime, timedelta
from statistics import median
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import and_, delete, func, or_, select

from app.accounts import no_body, no_query
from app.auth import DbSession, FullAuthenticated, require_json, require_operator
from app.business import (
    Body,
    Expected,
    Input,
    conflict,
    finish,
    invalid_state,
    not_found,
    user_ref,
    write_actor,
)
from app.models import GuidanceSession, KnowledgeDocument

router = APIRouter(prefix="/api/v1/knowledge/guidance", tags=["AI案内の履歴"])


def purge_expired(session):
    return session.execute(
        delete(GuidanceSession).where(GuidanceSession.expires_at <= datetime.now(UTC))
    ).rowcount


def visible_guidance(session, actor, ident, *, owner=False, lock=False):
    query = select(GuidanceSession).where(
        GuidanceSession.id == ident, GuidanceSession.expires_at > datetime.now(UTC)
    )
    if owner or actor.role != "operator":
        query = query.where(GuidanceSession.user_id == actor.id)
    if lock:
        query = query.with_for_update()
    row = session.scalar(query.execution_options(populate_existing=True))
    if row is None:
        not_found()
    return row


def history_item(session, row):
    return dict(
        id=str(row.id),
        query=row.query,
        state=row.state,
        outcome=row.outcome,
        feedback=row.feedback,
        version=row.version,
        error_code=row.error_code,
        elapsed_ms=row.elapsed_ms,
        created_at=row.created_at,
        expires_at=row.expires_at,
        requester=user_ref(session, row.user_id),
    )


def current_response(session, response):
    if not response:
        return None
    used = {ident for step in response["result"]["steps"] for ident in step["citation_ids"]}
    selected = [source for source in response.get("sources", []) if source["id"] in used]
    for source in selected if used else response.get("sources", []):
        document = session.get(KnowledgeDocument, UUID(source["document_id"]))
        if (
            not document
            or document.publication_suspended
            or str(document.published_version_id) != source["version_id"]
        ):
            return None
    return {**response, "sources": selected}


def visible_context(session, actor, context):
    if not context or actor.role == "operator" or not context.get("response"):
        return context
    response = current_response(session, context["response"])
    return {**context, "response": response, "response_restricted": response is None}


class HistoryQuery(Input):
    unresolved_only: bool = False
    scope: Literal["all", "mine"] = "all"


@router.get("/history", dependencies=[Depends(no_body)])
def history(query: Annotated[HistoryQuery, Query()], auth: FullAuthenticated, session: DbSession):
    stmt = select(GuidanceSession).where(GuidanceSession.expires_at > datetime.now(UTC))
    if auth[1].role != "operator" or query.scope == "mine":
        stmt = stmt.where(GuidanceSession.user_id == auth[1].id)
    if query.unresolved_only:
        stmt = stmt.where(
            or_(
                GuidanceSession.outcome == "unresolved",
                and_(
                    GuidanceSession.state == "insufficient_evidence",
                    GuidanceSession.outcome.is_(None),
                ),
            ),
            GuidanceSession.state.in_(["answered", "insufficient_evidence"]),
        )
    rows = session.scalars(
        stmt.order_by(GuidanceSession.created_at.desc(), GuidanceSession.id).limit(100)
    ).all()
    return dict(items=[history_item(session, row) for row in rows], retention_days=30)


@router.get(
    "/metrics", dependencies=[Depends(no_body), Depends(no_query), Depends(require_operator)]
)
def metrics(auth: FullAuthenticated, session: DbSession):
    from app.models import Ticket, TicketMessage

    now = datetime.now(UTC)
    rows = session.scalars(select(GuidanceSession).where(GuidanceSession.expires_at > now)).all()
    states = {
        state: sum(row.state == state for row in rows)
        for state in ("answered", "insufficient_evidence", "error", "processing")
    }
    outcomes = {
        outcome: sum(row.outcome == outcome for row in rows) for outcome in ("solved", "unresolved")
    }
    completed = states["answered"] + states["insufficient_evidence"]
    elapsed = sorted(
        row.elapsed_ms
        for row in rows
        if row.elapsed_ms is not None and row.state in ("answered", "insufficient_evidence")
    )
    tickets = session.scalars(
        select(Ticket).where(Ticket.created_at >= now - timedelta(days=30))
    ).all()
    first_replies = []
    for ticket in tickets:
        first = session.scalar(
            select(func.min(TicketMessage.created_at)).where(
                TicketMessage.ticket_id == ticket.id, TicketMessage.actor_role == "operator"
            )
        )
        if first:
            first_replies.append(int((first - ticket.created_at).total_seconds()))
    return dict(
        as_of=now,
        window_days=30,
        total=len(rows),
        states=states,
        outcomes=outcomes,
        unconfirmed=completed - sum(outcomes.values()),
        median_processing_ms=median(elapsed) if elapsed else None,
        tickets=len(tickets),
        escalated=sum(ticket.guidance_context is not None for ticket in tickets),
        first_reply_samples=len(first_replies),
        mean_first_reply_seconds=sum(first_replies) / len(first_replies) if first_replies else None,
    )


@router.get("/{guidance_id}", dependencies=[Depends(no_body), Depends(no_query)])
def detail(guidance_id: UUID, auth: FullAuthenticated, session: DbSession):
    row = visible_guidance(session, auth[1], guidance_id)
    response = (
        row.response if auth[1].role == "operator" else current_response(session, row.response)
    )
    return dict(
        **history_item(session, row),
        response=response,
        response_restricted=row.response is not None and response is None,
    )


class FeedbackInput(Input):
    outcome: Literal["solved", "unresolved"]
    reason: Body | None = None
    expected_version: Expected


@router.post("/{guidance_id}/feedback", dependencies=[Depends(require_json), Depends(no_query)])
def feedback(
    guidance_id: UUID,
    data: FeedbackInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
):
    actor, _ = write_actor(request, session, auth)
    row = visible_guidance(session, actor, guidance_id, owner=True, lock=True)
    if row.outcome == data.outcome and row.feedback == data.reason:
        return finish(session, history_item(session, row))
    conflict(data.expected_version, row.version)
    if row.state not in ("answered", "insufficient_evidence"):
        invalid_state()
    row.outcome, row.feedback, row.version = data.outcome, data.reason, row.version + 1
    return finish(session, history_item(session, row))


def begin_guidance(session, request, auth, query):
    actor, _ = write_actor(request, session, auth)
    purge_expired(session)
    now = datetime.now(UTC)
    row = GuidanceSession(
        id=request.state.request_id,
        user_id=actor.id,
        query=query,
        state="processing",
        created_at=now,
        expires_at=now + timedelta(days=30),
    )
    session.add(row)
    session.flush()
    ident = row.id
    session.commit()
    return ident


def complete_guidance(session, request, auth, ident, elapsed_ms, response=None, error=None):
    from fastapi.encoders import jsonable_encoder

    session.rollback()
    actor, _ = write_actor(request, session, auth)
    row = visible_guidance(session, actor, ident, owner=True, lock=True)
    row.state = response["result"]["status"] if response else "error"
    row.response = jsonable_encoder(response) if response else None
    row.error_code = error
    row.elapsed_ms = elapsed_ms
    session.commit()
