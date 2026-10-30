from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import case, func, literal, select, union_all
from sqlalchemy.orm import aliased

from app.accounts import no_body, no_query
from app.auth import DbSession, FullAuthenticated
from app.models import Department, KnowledgeDocument, KnowledgeVersion, Ticket, User

router = APIRouter(prefix="/api/v1/dashboard", tags=["業務集計"])


@router.get(
    "",
    summary="権限に応じた現在の業務件数を集計",
    dependencies=[Depends(no_body), Depends(no_query)],
)
def dashboard(auth: FullAuthenticated, session: DbSession):
    actor = auth[1]
    requester, assignee = aliased(User), aliased(User)
    dept = case(
        (Department.id.is_(None), None),
        else_=func.jsonb_build_object(
            "id", Department.id, "code", Department.code, "name", Department.name
        ),
    )
    assigned = case(
        (assignee.id.is_(None), None),
        else_=func.jsonb_build_object("id", assignee.id, "display_name", assignee.display_name),
    )
    fields = [
        "id",
        Ticket.id,
        "number",
        Ticket.number,
        "title",
        Ticket.title,
        "status",
        Ticket.status,
        "department",
        dept,
        "assignee",
        assigned,
        "created_at",
        Ticket.created_at,
        "updated_at",
        Ticket.updated_at,
    ]
    if actor.role == "operator":
        fields += [
            "requester",
            func.jsonb_build_object("id", requester.id, "display_name", requester.display_name),
        ]
    tickets = (
        select(literal("ticket").label("kind"), func.jsonb_build_object(*fields).label("item"))
        .select_from(Ticket)
        .join(requester, requester.id == Ticket.requester_id)
        .outerjoin(assignee, assignee.id == Ticket.assignee_id)
        .outerjoin(Department, Department.id == Ticket.department_id)
    )
    if actor.role != "operator":
        tickets = tickets.where(Ticket.requester_id == actor.id)
    queries = [tickets]
    if actor.role == "operator":
        queries.append(
            select(
                literal("review"),
                func.jsonb_build_object(
                    "document_id",
                    KnowledgeDocument.id,
                    "number",
                    KnowledgeDocument.number,
                    "version_id",
                    KnowledgeVersion.id,
                    "version_no",
                    KnowledgeVersion.version_no,
                    "status",
                    KnowledgeVersion.status,
                    "title",
                    KnowledgeVersion.title,
                    "audience",
                    KnowledgeVersion.audience,
                    "department",
                    dept,
                    "updated_at",
                    KnowledgeVersion.updated_at,
                    "row_version",
                    KnowledgeVersion.row_version,
                ),
            )
            .select_from(KnowledgeVersion)
            .join(KnowledgeDocument, KnowledgeDocument.id == KnowledgeVersion.document_id)
            .outerjoin(Department, Department.id == KnowledgeVersion.department_id)
            .where(KnowledgeVersion.status == "draft")
        )
    # 問い合わせとレビューを一つのSQLで読み、件数と明細の観測時点を揃える。
    records = union_all(*queries).subquery()
    rows = session.execute(select(records.c.kind, records.c.item, func.statement_timestamp())).all()
    items = [item for kind, item, _ in rows if kind == "ticket"]
    reviews = [item for kind, item, _ in rows if kind == "review"]
    recent = [
        item
        for item in items
        if actor.role != "operator" or item["assignee"] and item["assignee"]["id"] == str(actor.id)
    ]
    recent.sort(key=lambda item: (item["updated_at"], item["id"]), reverse=True)
    reviews.sort(key=lambda item: (item["updated_at"], item["version_id"]), reverse=True)
    result = dict(
        as_of=rows[0][-1] if rows else datetime.now(UTC),
        total=len(items),
        counts={
            status: sum(item["status"] == status for item in items)
            for status in ("open", "in_progress", "resolved")
        },
        recent_tickets=recent[:5],
    )
    if actor.role == "operator":
        result.update(
            unassigned_count=sum(
                item["assignee"] is None and item["status"] != "resolved" for item in items
            ),
            own_unresolved_count=sum(
                item["assignee"]
                and item["assignee"]["id"] == str(actor.id)
                and item["status"] != "resolved"
                or False
                for item in items
            ),
            review_pending_count=len(reviews),
            reviews=reviews[:5],
        )
    return result
