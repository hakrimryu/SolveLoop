from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BeforeValidator, Field, model_validator
from sqlalchemy import select

from app.accounts import no_query
from app.ai.knowledge import fingerprint
from app.auth import DbSession, FullAuthenticated, require_json, require_operator
from app.business import Input, clean, finish, invalid, write_actor
from app.errors import ApiError
from app.knowledge_search import search_state
from app.models import KnowledgeDocument, KnowledgeVersion, RadarCoverage, RadarReview, User
from app.radar import candidate, current_inputs, find_run, require_current

router = APIRouter(prefix="/api/v1/radar", tags=["Radarの人による検討"])


class DocumentRef(Input):
    document_id: UUID
    version_id: UUID


class ReviewInput(Input):
    request_key: UUID
    expected_context_hash: Annotated[str, Field(pattern="^[0-9a-f]{64}$")]
    decision: Literal["linked", "needs_supplement"]
    reason: Annotated[str, BeforeValidator(clean), Field(min_length=1, max_length=2000)]
    ticket_ids: list[UUID] = Field(min_length=5, max_length=100)
    documents: list[DocumentRef] = Field(max_length=5)
    coverage_id: UUID | None = None

    @model_validator(mode="after")
    def distinct(self):
        if len(set(self.ticket_ids)) != len(self.ticket_ids):
            raise ValueError("問い合わせは重複できません。")
        if len({d.document_id for d in self.documents}) != len(self.documents):
            raise ValueError("文書は重複できません。")
        if self.decision == "linked" and not self.documents:
            raise ValueError("対応文書を一つ以上選んでください。")
        return self


def review_context(session):
    rows = session.execute(
        select(KnowledgeDocument, KnowledgeVersion)
        .join(KnowledgeVersion, KnowledgeDocument.published_version_id == KnowledgeVersion.id)
        .where(~KnowledgeDocument.publication_suspended, KnowledgeVersion.status == "approved")
        .order_by(KnowledgeDocument.id)
    ).all()
    docs = [
        {
            "document_id": str(doc.id),
            "version_id": str(version.id),
            "version_no": version.version_no,
            "number": doc.number,
            "title": version.title,
            "content_hash": fingerprint(
                {"title": version.title, "audience": version.audience, "body": version.body}
            ),
            "href": f"/knowledge/{doc.id}",
        }
        for doc, version in rows
    ]
    return {"hash": fingerprint(docs), "documents": docs}


def review_dto(session, row, run, context):
    actor = session.get(User, row.actor_id)
    return {
        "id": str(row.id),
        "run_id": str(row.run_id),
        "candidate_id": row.candidate_id,
        "decision": row.decision,
        "reason": row.reason,
        "ticket_ids": row.ticket_ids,
        "documents": row.documents,
        "coverage_id": str(row.coverage_id) if row.coverage_id else None,
        "reviewer": {"id": str(row.actor_id), "display_name": actor.display_name},
        "created_at": row.created_at,
        "context_hash": row.context_hash,
        "current": current_inputs(session, run) and row.context_hash == context["hash"],
        "request_key": str(row.request_key),
    }


@router.post(
    "/runs/{run_id}/candidates/{candidate_id}/reviews",
    summary="構成問い合わせと公開版を人が確認し記録（AI判定は保持）",
    dependencies=[Depends(require_operator), Depends(require_json), Depends(no_query)],
)
def record_review(
    run_id: UUID,
    candidate_id: str,
    data: ReviewInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
):
    actor, _ = write_actor(request, session, auth, operator=True)
    request_hash = fingerprint(
        {"run": str(run_id), "candidate": candidate_id, "input": data.model_dump(mode="json")}
    )
    previous = session.scalar(
        select(RadarReview).where(
            RadarReview.actor_id == actor.id, RadarReview.request_key == data.request_key
        )
    )
    run = find_run(session, run_id)
    if previous:
        if previous.request_hash != request_hash:
            raise ApiError(409, "IDEMPOTENCY_CONFLICT", "同じ要求キーの内容が異なります。")
        return review_dto(session, previous, run, review_context(session))
    search_state(session, lock=True)
    from app.knowledge import lock_tickets

    lock_tickets(session, [UUID(item["ticket_id"]) for item in run.inputs])
    require_current(session, run)
    group = candidate(run, candidate_id)
    if set(map(str, data.ticket_ids)) != set(group["ticket_ids"]):
        invalid("構成問い合わせをすべて確認してください。")
    context = review_context(session)
    if context["hash"] != data.expected_context_hash:
        raise ApiError(
            409, "RADAR_CONTEXT_CHANGED", "公開文書が変わりました。再取得して確認してください。"
        )
    documents = []
    for ref in data.documents:
        found = next(
            (
                doc
                for doc in context["documents"]
                if doc["document_id"] == str(ref.document_id)
                and doc["version_id"] == str(ref.version_id)
            ),
            None,
        )
        if found is None:
            invalid("現在公開中の文書の版を選んでください。")
        documents.append(found)
    if data.coverage_id:
        coverage = session.get(RadarCoverage, data.coverage_id)
        if coverage is None or coverage.run_id != run.id or coverage.candidate_id != candidate_id:
            invalid("この候補のAI判定記録を選んでください。")
    row = RadarReview(
        run_id=run.id,
        candidate_id=candidate_id,
        actor_id=actor.id,
        request_key=data.request_key,
        request_hash=request_hash,
        context_hash=context["hash"],
        decision=data.decision,
        reason=data.reason,
        ticket_ids=sorted(map(str, data.ticket_ids)),
        documents=documents,
        coverage_id=data.coverage_id,
        created_at=datetime.now(UTC),
    )
    session.add(row)
    session.flush()
    return finish(session, review_dto(session, row, run, context))
