from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BeforeValidator, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from app.accounts import no_body, no_query
from app.auth import DbSession, FullAuthenticated, require_json
from app.business import (
    Body,
    Expected,
    Input,
    PageQuery,
    Title,
    clean,
    conflict,
    department,
    department_ref,
    finish,
    finish_create,
    idempotent_result,
    invalid,
    invalid_state,
    normalized,
    not_found,
    page_result,
    user_ref,
    write_actor,
)
from app.errors import ApiError
from app.models import Department, Ticket, TicketEvent, User, ticket_number_sequence

router = APIRouter(prefix="/api/v1/tickets", tags=["問い合わせ"])


class TicketInput(Input):
    title: Title
    body: Body
    department_id: UUID | None


class EditInput(Input):
    body: Body
    expected_version: Expected


class AssignmentInput(Input):
    department_id: UUID | None
    assignee_id: UUID | None
    expected_version: Expected


class TransitionInput(Input):
    action: Literal["start", "resolve", "reopen"]
    expected_version: Expected
    resolution: Body | None = None
    assignee_id: UUID | None = None

    @model_validator(mode="after")
    def action_fields(self):
        if self.action == "resolve":
            if self.resolution is None:
                raise ValueError("解決内容を入力してください。")
        elif "resolution" in self.model_fields_set:
            raise ValueError("この操作では解決内容を指定できません。")
        if "assignee_id" in self.model_fields_set and (
            self.action != "reopen" or self.assignee_id is None
        ):
            raise ValueError("再開時に有効な担当者だけを指定できます。")
        return self


class TicketQuery(PageQuery):
    q: Annotated[str, BeforeValidator(clean), Field(max_length=200)] = ""
    status: Literal["open", "in_progress", "resolved", "unresolved"] | None = None
    department_id: str | None = None
    assignee: str | None = None


def visible_ticket(session: Session, actor: User, ticket_id: UUID, lock: bool = False) -> Ticket:
    stmt = select(Ticket).where(Ticket.id == ticket_id)
    if actor.role != "operator":
        stmt = stmt.where(Ticket.requester_id == actor.id)
    if lock:
        stmt = stmt.with_for_update()
    ticket = session.scalar(stmt.execution_options(populate_existing=True))
    if ticket is None:
        not_found()
    return ticket


def ticket_item(
    ticket: Ticket, requester: dict | None, assignee: dict | None, dept: dict | None, operator: bool
) -> dict:
    item = dict(
        id=str(ticket.id),
        number=ticket.number,
        title=ticket.title,
        status=ticket.status,
        department=dept,
        assignee=assignee,
        created_at=ticket.created_at,
        updated_at=ticket.updated_at,
    )
    if operator:
        item["requester"] = requester
    return item


def ticket_detail(session: Session, actor: User, ticket: Ticket) -> dict:
    item = ticket_item(
        ticket,
        user_ref(session, ticket.requester_id),
        user_ref(session, ticket.assignee_id),
        department_ref(session, ticket.department_id),
        True,
    )
    events = []
    for event in session.scalars(
        select(TicketEvent)
        .where(TicketEvent.ticket_id == ticket.id)
        .order_by(TicketEvent.ticket_version)
    ):
        payload = event.payload
        if actor.role != "operator":
            allowed = {
                "created": (),
                "body_updated": ("fields",),
                "assignment_changed": ("before", "after"),
                "started": ("from_status", "to_status"),
                "resolved": ("from_status", "to_status", "resolution", "resolved_at"),
                "reopened": (
                    "from_status",
                    "to_status",
                    "previous_resolution",
                    "previous_resolved_at",
                ),
            }
            payload = {key: payload[key] for key in allowed[event.event_type]}
        events.append(
            dict(
                id=str(event.id),
                event_type=event.event_type,
                actor=user_ref(session, event.actor_id),
                occurred_at=event.occurred_at,
                payload=payload,
            )
        )
    return dict(
        **item,
        body=ticket.body,
        resolution=ticket.resolution,
        resolved_at=ticket.resolved_at,
        version=ticket.version,
        events=events,
    )


def record(session: Session, ticket: Ticket, actor: User, event_type: str, payload: dict) -> None:
    from fastapi.encoders import jsonable_encoder

    session.add(
        TicketEvent(
            ticket_id=ticket.id,
            ticket_version=ticket.version,
            actor_id=actor.id,
            event_type=event_type,
            payload=jsonable_encoder(payload),
            occurred_at=ticket.updated_at,
        )
    )
    session.flush()


def ticket_rows(session: Session, actor: User) -> tuple[list[dict], datetime]:
    requester, assignee = aliased(User), aliased(User)
    stmt = (
        select(Ticket, requester, assignee, Department, func.statement_timestamp())
        .join(requester, Ticket.requester_id == requester.id)
        .outerjoin(assignee, Ticket.assignee_id == assignee.id)
        .outerjoin(Department, Ticket.department_id == Department.id)
    )
    if actor.role != "operator":
        stmt = stmt.where(Ticket.requester_id == actor.id)
    rows = session.execute(stmt).all()
    items = []
    for ticket, owner, assigned, dept, _ in rows:

        def ref(user):
            return {"id": str(user.id), "display_name": user.display_name} if user else None

        item = ticket_item(
            ticket,
            ref(owner),
            ref(assigned),
            {"id": str(dept.id), "code": dept.code, "name": dept.name} if dept else None,
            actor.role == "operator",
        )
        item["_search"] = normalized(f"{ticket.number} {ticket.title} {ticket.body}")
        items.append(item)
    return items, rows[0][-1] if rows else datetime.now(UTC)


def reference_filter(session: Session, value: str, model: type, special: set[str]) -> str:
    if value in special:
        return value
    try:
        item_id = UUID(value)
    except ValueError:
        invalid()
    row = session.get(model, item_id)
    if row is None or (model is User and row.role != "operator"):
        invalid()
    return str(item_id)


@router.get("", summary="権限内の問い合わせを検索", dependencies=[Depends(no_body)])
def list_tickets(
    query: Annotated[TicketQuery, Query()], auth: FullAuthenticated, session: DbSession
):
    actor = auth[1]
    dept = (
        reference_filter(session, query.department_id, Department, {"unassigned"})
        if query.department_id is not None
        else None
    )
    if query.assignee is not None and actor.role != "operator":
        invalid("社員は担当者の条件を指定できません。")
    assigned = (
        reference_filter(session, query.assignee, User, {"me", "unassigned"})
        if query.assignee is not None
        else None
    )
    items, as_of = ticket_rows(session, actor)
    filtered = []
    for item in items:
        if normalized(query.q.strip()) not in item["_search"]:
            continue
        if query.status == "unresolved" and item["status"] == "resolved":
            continue
        if query.status and query.status != "unresolved" and item["status"] != query.status:
            continue
        if dept and (item["department"]["id"] if item["department"] else "unassigned") != dept:
            continue
        if assigned == "unassigned" and (item["assignee"] or item["status"] == "resolved"):
            continue
        if (
            assigned
            and assigned != "unassigned"
            and (item["assignee"]["id"] if item["assignee"] else None)
            != (str(actor.id) if assigned == "me" else assigned)
        ):
            continue
        filtered.append(item)
    for item in items:
        del item["_search"]
    return page_result(items, filtered, query, as_of)


@router.get(
    "/{ticket_id}",
    summary="問い合わせと公開可能な履歴を取得",
    dependencies=[Depends(no_body), Depends(no_query)],
)
def get_ticket(ticket_id: UUID, auth: FullAuthenticated, session: DbSession):
    return ticket_detail(session, auth[1], visible_ticket(session, auth[1], ticket_id))


@router.post(
    "",
    summary="問い合わせを登録",
    status_code=201,
    dependencies=[Depends(require_json), Depends(no_query)],
)
def create_ticket(
    data: TicketInput,
    request: Request,
    response: Response,
    auth: FullAuthenticated,
    session: DbSession,
):
    actor, _ = write_actor(request, session, auth)
    key, digest, previous = idempotent_result(request, session, actor, data)
    if previous:
        response.headers["Location"] = f"/api/v1/tickets/{previous['id']}"
        return previous
    department(session, data.department_id)
    now = datetime.now(UTC)
    number = session.scalar(select(ticket_number_sequence.next_value()))
    ticket = Ticket(
        number=f"REQ-{number:04d}",
        requester_id=actor.id,
        department_id=data.department_id,
        title=data.title,
        body=data.body,
        status="open",
        version=1,
        created_at=now,
        updated_at=now,
    )
    session.add(ticket)
    session.flush()
    record(session, ticket, actor, "created", {})
    result = ticket_detail(session, actor, ticket)
    response.headers["Location"] = f"/api/v1/tickets/{ticket.id}"
    return finish_create(request, session, actor, key, digest, result, ticket.id)


def locked_ticket(
    request: Request,
    session: Session,
    auth,
    ticket_id: UUID,
    expected: int,
    assignee_id: UUID | None = None,
    operator: bool = False,
):
    from app.auth import require_operator

    if operator:
        require_operator(auth)
    discovered = visible_ticket(session, auth[1], ticket_id)
    related = {
        value for value in (discovered.requester_id, discovered.assignee_id, assignee_id) if value
    }
    actor, users = write_actor(request, session, auth, related, operator)
    ticket = visible_ticket(session, actor, ticket_id, True)
    conflict(expected, ticket.version)
    if ticket.assignee_id and ticket.assignee_id not in users:
        raise ApiError(409, "VERSION_CONFLICT", "担当者が変わりました。再取得してください。")
    return actor, users, ticket


@router.patch(
    "/{ticket_id}",
    summary="未解決の問い合わせ本文を編集",
    dependencies=[Depends(require_json), Depends(no_query)],
)
def edit_ticket(
    ticket_id: UUID, data: EditInput, request: Request, auth: FullAuthenticated, session: DbSession
):
    actor, _, ticket = locked_ticket(request, session, auth, ticket_id, data.expected_version)
    if ticket.status == "resolved":
        invalid_state()
    if ticket.body == data.body:
        return finish(session, ticket_detail(session, actor, ticket))
    before = ticket.body
    ticket.body, ticket.version, ticket.updated_at = (
        data.body,
        ticket.version + 1,
        datetime.now(UTC),
    )
    record(
        session,
        ticket,
        actor,
        "body_updated",
        {"fields": ["body"], "before": {"body": before}, "after": {"body": data.body}},
    )
    return finish(session, ticket_detail(session, actor, ticket))


def active_assignee(users: dict[UUID, User], user_id: UUID | None, required: bool):
    user = users.get(user_id)
    if user_id is None and not required:
        return
    if user is None or not user.active or user.role != "operator":
        invalid("有効な担当者を選択してください。")


@router.post(
    "/{ticket_id}/assignment",
    summary="部署と担当者を割り当て",
    dependencies=[Depends(require_json), Depends(no_query)],
)
def assign_ticket(
    ticket_id: UUID,
    data: AssignmentInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
):
    actor, users, ticket = locked_ticket(
        request, session, auth, ticket_id, data.expected_version, data.assignee_id, True
    )
    if ticket.status == "resolved":
        invalid_state()
    if (ticket.department_id, ticket.assignee_id) == (data.department_id, data.assignee_id):
        return finish(session, ticket_detail(session, actor, ticket))
    department(
        session, data.department_id, ticket.status == "in_progress" or data.assignee_id is not None
    )
    active_assignee(users, data.assignee_id, ticket.status == "in_progress")
    before = dict(
        department=department_ref(session, ticket.department_id),
        assignee=user_ref(session, ticket.assignee_id),
    )
    ticket.department_id, ticket.assignee_id = data.department_id, data.assignee_id
    ticket.version, ticket.updated_at = ticket.version + 1, datetime.now(UTC)
    after = dict(
        department=department_ref(session, ticket.department_id),
        assignee=user_ref(session, ticket.assignee_id),
    )
    record(session, ticket, actor, "assignment_changed", dict(before=before, after=after))
    return finish(session, ticket_detail(session, actor, ticket))


@router.post(
    "/{ticket_id}/transition",
    summary="対応開始・解決・再開",
    dependencies=[Depends(require_json), Depends(no_query)],
)
def transition_ticket(
    ticket_id: UUID,
    data: TransitionInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
):
    actor, users, ticket = locked_ticket(
        request, session, auth, ticket_id, data.expected_version, data.assignee_id, True
    )
    expected_state = {"start": "open", "resolve": "in_progress", "reopen": "resolved"}[data.action]
    if ticket.status != expected_state:
        invalid_state()
    if ticket.department_id is None:
        invalid("担当部署を確定してください。")
    active_assignee(users, data.assignee_id or ticket.assignee_id, True)
    now = datetime.now(UTC)
    payload = dict(
        from_status=ticket.status,
        to_status="resolved" if data.action == "resolve" else "in_progress",
    )
    if data.action == "resolve":
        ticket.resolution, ticket.resolved_at = data.resolution, now
        payload.update(resolution=data.resolution, resolved_at=now)
    elif data.action == "reopen":
        payload.update(
            previous_resolution=ticket.resolution, previous_resolved_at=ticket.resolved_at
        )
        if data.assignee_id:
            payload.update(
                previous_assignee=user_ref(session, ticket.assignee_id),
                assignee=user_ref(session, data.assignee_id),
            )
            ticket.assignee_id = data.assignee_id
        ticket.resolution, ticket.resolved_at = None, None
    ticket.status, ticket.version, ticket.updated_at = payload["to_status"], ticket.version + 1, now
    record(
        session,
        ticket,
        actor,
        {"start": "started", "resolve": "resolved", "reopen": "reopened"}[data.action],
        payload,
    )
    return finish(session, ticket_detail(session, actor, ticket))
