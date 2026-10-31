import hashlib
import json
from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from pydantic import AfterValidator, BeforeValidator, Field, model_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.accounts import no_body, no_query
from app.auth import DbSession, FullAuthenticated, require_json, require_operator
from app.business import (
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
from app.models import (
    Department,
    IdempotencyRecord,
    KnowledgeDocument,
    KnowledgeEvent,
    KnowledgePreparation,
    KnowledgeSource,
    KnowledgeVersion,
    Ticket,
    knowledge_number_sequence,
)
from app.tickets import reference_filter

router = APIRouter(prefix="/api/v1/knowledge", tags=["手動ナレッジ・レビュー"])
Operator = Annotated[object, Depends(require_operator)]


class SourceRef(Input):
    ticket_id: UUID
    expected_ticket_version: Expected


def valid_refs(refs):
    if len({ref.ticket_id for ref in refs}) != len(refs):
        raise ValueError("根拠の問い合わせが重複しています。")
    return refs


Audience = Annotated[str, BeforeValidator(clean), Field(min_length=1, max_length=300)]
KnowledgeBody = Annotated[str, BeforeValidator(clean), Field(min_length=1, max_length=20000)]
Reason = Annotated[str, BeforeValidator(clean), Field(min_length=1, max_length=1000)]
Sources = Annotated[list[SourceRef], Field(max_length=20), AfterValidator(valid_refs)]


class DraftInput(Input):
    title: Title
    audience: Audience
    body: KnowledgeBody
    department_id: UUID | None
    source_refs: Sources
    # 既存の手動登録キーの内容ハッシュを維持する。
    generation_id: UUID | None = Field(default=None, exclude_if=lambda value: value is None)


class DraftEdit(Input):
    expected_version: Expected
    title: Title | None = None
    audience: Audience | None = None
    body: KnowledgeBody | None = None
    department_id: UUID | None = None
    source_refs: Sources | None = None
    generation_id: UUID | None = None

    @model_validator(mode="after")
    def fields(self):
        changed = self.model_fields_set - {"expected_version"}
        if not changed:
            raise ValueError("保存する項目を指定してください。")
        if any(getattr(self, key) is None for key in changed - {"department_id"}):
            raise ValueError("この項目は空にできません。")
        return self


class CopyInput(Input):
    base_version_no: Expected
    expected_document_version: Expected


class ReviewInput(Input):
    expected_version: Expected
    expected_document_version: Expected


class DocumentDeleteInput(ReviewInput):
    confirmation_number: Annotated[str, Field(min_length=1, max_length=32)]


class RejectInput(ReviewInput):
    reason: Reason


class KnowledgeQuery(PageQuery):
    q: Annotated[str, BeforeValidator(clean), Field(max_length=200)] = ""
    department_id: UUID | None = None


class ReviewQuery(PageQuery):
    status: Literal["draft", "rejected", "suspended"] | None = None


# 根拠は保存時の本文・解決内容・版を写し、後の変更と比較できる形にする。
# [ko] 근거의 본문·해결 내용·버전을 저장 시점의 사본으로 남겨 이후 변경과 비교한다.
# [en] Capture source text, resolution, and version so later changes can be compared.
def source_snapshot(session: Session, ticket: Ticket) -> dict:
    return jsonable_encoder(
        dict(
            ticket_id=str(ticket.id),
            ticket_version=ticket.version,
            title=ticket.title,
            body=ticket.body,
            resolution=ticket.resolution,
            department_id=str(ticket.department_id) if ticket.department_id else None,
            resolved_at=ticket.resolved_at,
            updated_at=ticket.updated_at,
        )
    )


def source_hash(snapshot: dict) -> str:
    return hashlib.sha256(
        json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def sources_for(session: Session, version_id: UUID) -> list[KnowledgeSource]:
    return list(
        session.scalars(
            select(KnowledgeSource)
            .where(KnowledgeSource.knowledge_version_id == version_id)
            .order_by(KnowledgeSource.ticket_id)
            .execution_options(populate_existing=True)
        )
    )


# 版番号だけでなく内容ハッシュも比較し、未解決へ戻った根拠も検出する。
# [ko] 버전 번호뿐 아니라 내용 해시도 비교하고 미해결로 돌아간 근거도 탐지한다.
# [en] Check source hashes as well as versions, and flag sources that are no longer resolved.
def source_issues(session: Session, sources: list[KnowledgeSource]) -> list[dict]:
    tickets = {
        ticket.id: ticket
        for ticket in session.scalars(
            select(Ticket)
            .where(Ticket.id.in_([source.ticket_id for source in sources]))
            .execution_options(populate_existing=True)
        )
    }
    issues = []
    for source in sources:
        ticket = tickets.get(source.ticket_id)
        code = None
        if ticket and ticket.status != "resolved":
            code = "SOURCE_NOT_RESOLVED"
        elif (
            ticket is None
            or ticket.version != source.ticket_version
            or source_hash(source_snapshot(session, ticket)) != source.content_hash
        ):
            code = "SOURCE_CHANGED"
        if code:
            issues.append(
                dict(
                    ticket_id=str(source.ticket_id),
                    code=code,
                    expected_ticket_version=source.ticket_version,
                    current_ticket_version=ticket.version if ticket else None,
                )
            )
    return issues


def source_dto(session: Session, source: KnowledgeSource) -> dict:
    snapshot = source.evidence_snapshot
    ticket = session.get(Ticket, source.ticket_id)
    return dict(
        ticket_id=str(source.ticket_id),
        ticket_number=ticket.number,
        ticket_version=source.ticket_version,
        **{
            key: snapshot[key]
            for key in ("title", "body", "resolution", "resolved_at", "updated_at")
        },
        department=department_ref(session, UUID(snapshot["department_id"]))
        if snapshot["department_id"]
        else None,
        content_hash=source.content_hash,
    )


def review_item(doc: KnowledgeDocument, version: KnowledgeVersion, dept: dict | None) -> dict:
    return dict(
        document_id=str(doc.id),
        number=doc.number,
        version_id=str(version.id),
        version_no=version.version_no,
        status=version.status,
        title=version.title,
        audience=version.audience,
        department=dept,
        updated_at=version.updated_at,
        row_version=version.row_version,
        publication_suspended=doc.publication_suspended,
    )


def public_item(doc: KnowledgeDocument, version: KnowledgeVersion, dept: dict | None) -> dict:
    return dict(
        document_id=str(doc.id),
        number=doc.number,
        version_no=version.version_no,
        title=version.title,
        audience=version.audience,
        department=dept,
        updated_at=version.updated_at,
        approved_at=version.reviewed_at,
        publication_suspended=doc.publication_suspended,
    )


def get_document(session: Session, document_id: UUID, lock: bool = False) -> KnowledgeDocument:
    stmt = select(KnowledgeDocument).where(KnowledgeDocument.id == document_id)
    if lock:
        stmt = stmt.with_for_update()
    doc = session.scalar(stmt.execution_options(populate_existing=True))
    if doc is None:
        not_found()
    return doc


def get_version(
    session: Session, document_id: UUID, version_no: int, lock: bool = False
) -> KnowledgeVersion:
    stmt = select(KnowledgeVersion).where(
        KnowledgeVersion.document_id == document_id, KnowledgeVersion.version_no == version_no
    )
    if lock:
        stmt = stmt.with_for_update()
    version = session.scalar(stmt.execution_options(populate_existing=True))
    if version is None:
        not_found()
    return version


def review_detail(session: Session, doc: KnowledgeDocument, version: KnowledgeVersion) -> dict:
    from app.knowledge_search import preparation_status

    versions = list(
        session.scalars(select(KnowledgeVersion).where(KnowledgeVersion.document_id == doc.id))
    )
    sources = sources_for(session, version.id)
    events = [
        dict(
            id=str(event.id),
            event_type=event.event_type,
            actor=user_ref(session, event.actor_id),
            occurred_at=event.occurred_at,
            version_no=version.version_no,
            row_version=event.row_version,
            payload=event.payload,
        )
        for event in session.scalars(
            select(KnowledgeEvent)
            .where(KnowledgeEvent.knowledge_version_id == version.id)
            .order_by(KnowledgeEvent.row_version)
        )
    ]
    return dict(
        **review_item(doc, version, department_ref(session, version.department_id)),
        body=version.body,
        document_row_version=doc.row_version,
        latest_version_no=max(v.version_no for v in versions),
        draft_version_no=next((v.version_no for v in versions if v.status == "draft"), None),
        published_version_no=next(
            (v.version_no for v in versions if v.id == doc.published_version_id), None
        ),
        base_version_no=next(
            (v.version_no for v in versions if v.id == version.base_version_id), None
        ),
        created_by=user_ref(session, version.created_by),
        created_at=version.created_at,
        reviewed_by=user_ref(session, version.reviewed_by),
        reviewed_at=version.reviewed_at,
        sources=[source_dto(session, source) for source in sources],
        source_issues=source_issues(session, sources),
        search_preparation=preparation_status(session, doc, version),
        events=events,
    )


def record(
    session: Session,
    version: KnowledgeVersion,
    actor,
    event_type: str,
    payload: dict,
    reason: str | None = None,
):
    session.add(
        KnowledgeEvent(
            knowledge_version_id=version.id,
            row_version=version.row_version,
            actor_id=actor.id,
            event_type=event_type,
            payload=jsonable_encoder(payload),
            reason=reason,
            occurred_at=version.updated_at,
        )
    )
    session.flush()


def lock_tickets(session: Session, ids: set[UUID]) -> dict[UUID, Ticket]:
    return {
        ticket.id: ticket
        for ticket in session.scalars(
            select(Ticket)
            .where(Ticket.id.in_(ids))
            .order_by(Ticket.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    }


def capture_sources(
    session: Session, version: KnowledgeVersion, refs: list[SourceRef], tickets: dict[UUID, Ticket]
):
    result = []
    for ref in refs:
        ticket = tickets.get(ref.ticket_id)
        if ticket is None:
            invalid("根拠の問い合わせが見つかりません。")
        if (
            ticket.status != "resolved"
            or not ticket.resolution
            or not ticket.resolution.strip()
            or not ticket.resolved_at
        ):
            raise ApiError(
                409, "SOURCE_NOT_RESOLVED", "未解決の問い合わせを根拠には使用できません。"
            )
        conflict(ref.expected_ticket_version, ticket.version)
        snapshot = source_snapshot(session, ticket)
        result.append(
            KnowledgeSource(
                knowledge_version_id=version.id,
                ticket_id=ticket.id,
                ticket_version=ticket.version,
                evidence_snapshot=snapshot,
                content_hash=source_hash(snapshot),
                captured_at=datetime.now(UTC),
            )
        )
    return result


def locked_version(
    request,
    session,
    auth,
    document_id,
    version_no,
    refs: list[SourceRef] | None = None,
    search: bool = False,
):
    discovered = get_version(session, document_id, version_no)
    ids = {source.ticket_id for source in sources_for(session, discovered.id)}
    all_ids = ids | ({ref.ticket_id for ref in refs} if refs else set())
    actor, _ = write_actor(request, session, auth, operator=True)
    if search:
        from app.knowledge_search import search_state

        search_state(session, lock=True)
    tickets = lock_tickets(session, all_ids)
    doc = get_document(session, document_id, True)
    version = get_version(session, document_id, version_no, True)
    # 根拠集合が変わったら、逆順でロックを追加せず再確認を求める。
    # [ko] 근거 집합이 바뀌면 잠금을 역순으로 추가하지 않고 재확인을 요구한다.
    # [en] If the source set changed, request a fresh review rather than add locks out of order.
    if {source.ticket_id for source in sources_for(session, version.id)} != ids:
        raise ApiError(
            409, "VERSION_CONFLICT", "根拠が更新されました。最新の保存内容を確認してください。"
        )
    return actor, tickets, doc, version


def knowledge_rows(session: Session, review: bool) -> tuple[list[dict], datetime]:
    stmt = (
        select(KnowledgeDocument, KnowledgeVersion, Department, func.statement_timestamp())
        .join(KnowledgeVersion, KnowledgeDocument.id == KnowledgeVersion.document_id)
        .outerjoin(Department, KnowledgeVersion.department_id == Department.id)
    )
    stmt = (
        stmt.where(
            KnowledgeVersion.status.in_(["draft", "rejected"])
            | (
                KnowledgeDocument.publication_suspended
                & (KnowledgeDocument.published_version_id == KnowledgeVersion.id)
            )
        )
        if review
        else stmt.where(
            KnowledgeDocument.published_version_id == KnowledgeVersion.id,
            KnowledgeVersion.status == "approved",
            KnowledgeDocument.publication_suspended.is_(False),
        )
    )
    rows = session.execute(stmt).all()
    items = []
    for doc, version, dept, _ in rows:
        dept_ref = dict(id=str(dept.id), code=dept.code, name=dept.name) if dept else None
        item = (
            review_item(doc, version, dept_ref) if review else public_item(doc, version, dept_ref)
        )
        item["_search"] = normalized(
            f"{doc.number} {version.title} {version.audience} {version.body}"
        )
        items.append(item)
    return items, rows[0][-1] if rows else datetime.now(UTC)


@router.get("/reviews", summary="下書きと差し戻しを一覧", dependencies=[Depends(no_body)])
def list_reviews(query: Annotated[ReviewQuery, Query()], operator: Operator, session: DbSession):
    items, as_of = knowledge_rows(session, True)
    filtered = [
        item
        for item in items
        if not query.status
        or (
            item["publication_suspended"] and item["status"] == "approved"
            if query.status == "suspended"
            else item["status"] == query.status
        )
    ]
    for item in items:
        del item["_search"]
    return page_result(items, filtered, query, as_of)


@router.get("", summary="現在の承認版をキーワード検索", dependencies=[Depends(no_body)])
def list_knowledge(
    query: Annotated[KnowledgeQuery, Query()], auth: FullAuthenticated, session: DbSession
):
    if query.department_id:
        reference_filter(session, str(query.department_id), Department, set())
    items, as_of = knowledge_rows(session, False)
    filtered = [
        item
        for item in items
        if all(term in item["_search"] for term in normalized(query.q).split())
        and (
            not query.department_id
            or item["department"]
            and item["department"]["id"] == str(query.department_id)
        )
    ]
    for item in items:
        del item["_search"]
    return page_result(items, filtered, query, as_of)


@router.get(
    "/{document_id}",
    summary="現在公開されている承認版を取得",
    dependencies=[Depends(no_body), Depends(no_query)],
)
def get_published(document_id: UUID, auth: FullAuthenticated, session: DbSession):
    doc = get_document(session, document_id)
    if doc.publication_suspended and auth[1].role != "operator":
        not_found()
    version = (
        session.get(KnowledgeVersion, doc.published_version_id)
        if doc.published_version_id
        else None
    )
    if version is None or version.status != "approved":
        not_found()
    return dict(
        **public_item(doc, version, department_ref(session, version.department_id)),
        body=version.body,
    )


@router.get(
    "/{document_id}/versions/{version_no}",
    summary="担当者用の版・根拠・レビュー履歴を取得",
    dependencies=[Depends(no_body), Depends(no_query)],
)
def get_review(
    document_id: UUID,
    version_no: Annotated[int, Field(ge=1)],
    operator: Operator,
    session: DbSession,
):
    return review_detail(
        session, get_document(session, document_id), get_version(session, document_id, version_no)
    )


@router.post(
    "/drafts",
    summary="手動の新規下書きを保存",
    status_code=201,
    dependencies=[Depends(require_json), Depends(no_query)],
)
def create_draft(
    data: DraftInput,
    request: Request,
    response: Response,
    auth: FullAuthenticated,
    session: DbSession,
    operator: Operator,
):
    actor, _ = write_actor(request, session, auth, operator=True)
    key, digest, previous = idempotent_result(request, session, actor, data)
    if previous:
        response.headers["Location"] = f"/api/v1/knowledge/{previous['document_id']}/versions/1"
        return previous
    department(session, data.department_id)
    tickets = lock_tickets(session, {ref.ticket_id for ref in data.source_refs})
    now = datetime.now(UTC)
    number = session.scalar(select(knowledge_number_sequence.next_value()))
    doc = KnowledgeDocument(
        number=f"KB-{number:04d}", row_version=1, created_by=actor.id, created_at=now
    )
    session.add(doc)
    session.flush()
    version = KnowledgeVersion(
        document_id=doc.id,
        version_no=1,
        status="draft",
        title=data.title,
        audience=data.audience,
        body=data.body,
        department_id=data.department_id,
        created_by=actor.id,
        created_at=now,
        updated_at=now,
        row_version=1,
    )
    session.add(version)
    session.flush()
    session.add_all(capture_sources(session, version, data.source_refs, tickets))
    from app.knowledge_generation import consume_generation

    trace = consume_generation(
        session, request, actor, data.generation_id, data.source_refs, tickets, version
    )
    record(
        session,
        version,
        actor,
        "draft_created",
        {"base_version_no": None, **({"generation": trace} if trace else {})},
    )
    result = review_detail(session, doc, version)
    response.headers["Location"] = f"/api/v1/knowledge/{doc.id}/versions/1"
    return finish_create(request, session, actor, key, digest, result, doc.id)


@router.post(
    "/{document_id}/drafts",
    summary="最新の承認・差し戻し版から次の下書きを作成",
    status_code=201,
    dependencies=[Depends(require_json), Depends(no_query)],
)
# 元の根拠をそのまま継承し、古い写しを新しい原本へ自動で置き換えない。
# [ko] 원래 근거를 그대로 계승하며 오래된 사본을 최신 원본으로 자동 교체하지 않는다.
# [en] Copy the original evidence unchanged; never silently refresh an outdated snapshot.
def copy_draft(
    document_id: UUID,
    data: CopyInput,
    request: Request,
    response: Response,
    auth: FullAuthenticated,
    session: DbSession,
    operator: Operator,
):
    actor, _ = write_actor(request, session, auth, operator=True)
    key, digest, previous = idempotent_result(request, session, actor, data)
    if previous:
        response.headers["Location"] = (
            f"/api/v1/knowledge/{document_id}/versions/{previous['version_no']}"
        )
        return previous
    base = get_version(session, document_id, data.base_version_no)
    sources = sources_for(session, base.id)
    lock_tickets(session, {source.ticket_id for source in sources})
    doc = get_document(session, document_id, True)
    conflict(data.expected_document_version, doc.row_version)
    versions = list(
        session.scalars(
            select(KnowledgeVersion)
            .where(KnowledgeVersion.document_id == doc.id)
            .execution_options(populate_existing=True)
        )
    )
    draft = next((version for version in versions if version.status == "draft"), None)
    if draft:
        raise ApiError(
            409,
            "DRAFT_EXISTS",
            "すでに下書きがあります。その版を確認してください。",
            {"draft_version_no": draft.version_no},
        )
    base = get_version(session, document_id, data.base_version_no, True)
    if base.version_no != max(version.version_no for version in versions) or base.status not in {
        "approved",
        "rejected",
    }:
        invalid_state()
    now = datetime.now(UTC)
    version = KnowledgeVersion(
        document_id=doc.id,
        version_no=base.version_no + 1,
        base_version_id=base.id,
        status="draft",
        title=base.title,
        audience=base.audience,
        body=base.body,
        department_id=base.department_id,
        created_by=actor.id,
        created_at=now,
        updated_at=now,
        row_version=1,
    )
    session.add(version)
    doc.row_version += 1
    session.flush()
    for source in sources:
        session.add(
            KnowledgeSource(
                knowledge_version_id=version.id,
                ticket_id=source.ticket_id,
                ticket_version=source.ticket_version,
                evidence_snapshot=source.evidence_snapshot,
                content_hash=source.content_hash,
                captured_at=source.captured_at,
            )
        )
    record(session, version, actor, "draft_created", {"base_version_no": base.version_no})
    result = review_detail(session, doc, version)
    response.headers["Location"] = f"/api/v1/knowledge/{doc.id}/versions/{version.version_no}"
    return finish_create(request, session, actor, key, digest, result, doc.id)


@router.patch(
    "/{document_id}/versions/{version_no}",
    summary="下書きと明示的に再確認した根拠を保存",
    dependencies=[Depends(require_json), Depends(no_query)],
)
def edit_draft(
    document_id: UUID,
    version_no: int,
    data: DraftEdit,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    operator: Operator,
):
    actor, tickets, doc, version = locked_version(
        request, session, auth, document_id, version_no, data.source_refs
    )
    conflict(data.expected_version, version.row_version)
    if version.status != "draft":
        invalid_state()
    changed = []
    for key in data.model_fields_set - {"expected_version", "source_refs", "generation_id"}:
        value = getattr(data, key)
        if key == "department_id" and value != version.department_id:
            department(session, value)
        if getattr(version, key) != value:
            setattr(version, key, value)
            changed.append(key)
    payload = {"changed_fields": sorted(changed)}
    if data.source_refs is not None:
        old = sources_for(session, version.id)
        new = capture_sources(session, version, data.source_refs, tickets)

        def summary(sources):
            return [
                {
                    "ticket_id": str(s.ticket_id),
                    "ticket_version": s.ticket_version,
                    "content_hash": s.content_hash,
                }
                for s in sorted(sources, key=lambda s: s.ticket_id)
            ]

        before, after = summary(old), summary(new)
        if before != after:
            session.execute(
                delete(KnowledgeSource).where(KnowledgeSource.knowledge_version_id == version.id)
            )
            session.add_all(new)
            changed.append("source_refs")
            payload.update(
                changed_fields=sorted(changed), before_sources=before, after_sources=after
            )
    from app.knowledge_generation import consume_generation

    trace = consume_generation(
        session, request, actor, data.generation_id, data.source_refs, tickets, version
    )
    if trace:
        payload["generation"] = trace
    if changed or trace:
        version.row_version += 1
        version.updated_at = datetime.now(UTC)
        record(
            session,
            version,
            actor,
            "sources_refreshed" if "source_refs" in changed else "saved",
            payload,
        )
    return finish(session, review_detail(session, doc, version))


def review_version(document_id, version_no, data, request, auth, session, reject=False):
    actor, _, doc, version = locked_version(
        request, session, auth, document_id, version_no, search=not reject
    )
    conflict(data.expected_version, version.row_version)
    conflict(data.expected_document_version, doc.row_version)
    if version.status != "draft":
        invalid_state()
    previous = (
        session.get(KnowledgeVersion, doc.published_version_id)
        if doc.published_version_id
        else None
    )
    if not reject:
        department(session, version.department_id, True)
        # 公開前に根拠を再確認し、不整合があれば既存の承認版を維持する。
        # [ko] 공개 전에 근거를 재확인하고 불일치하면 기존 승인본을 유지한다.
        # [en] Recheck evidence before publication; keep the current approved version on failure.
        issues = source_issues(session, sources_for(session, version.id))
        if issues:
            raise ApiError(
                409,
                "SOURCE_CHANGED",
                "根拠が変わりました。原本と写しを比較し、明示的に再確認して保存してください。",
                {"source_issues": issues},
            )
        from app.knowledge_search import require_prepared

        prepared = require_prepared(session, doc, version)
    version.status = "rejected" if reject else "approved"
    version.reviewed_by, version.reviewed_at = actor.id, datetime.now(UTC)
    version.updated_at = version.reviewed_at
    version.row_version += 1
    doc.row_version += 1
    if not reject:
        doc.published_version_id = version.id
        # 公開ポインター・検索対象の保存版・履歴を同時に確定する。
        # [ko] 공개 포인터·검색 대상 저장 버전·이력을 동시에 확정한다.
        # [en] Commit publication, the indexed row version, and history together.
        prepared.indexed_row_version = version.row_version
    payload = (
        {"reason": data.reason}
        if reject
        else {
            "previous_published_version_no": previous.version_no if previous else None,
            "published_version_no": version.version_no,
            "embedding_profile_id": prepared.profile_id,
            "content_hash": prepared.content_hash,
            "chunk_count": prepared.chunk_count,
        }
    )
    record(session, version, actor, version.status, payload, data.reason if reject else None)
    return finish(session, review_detail(session, doc, version))


@router.post(
    "/{document_id}/versions/{version_no}/approve",
    summary="保存済み下書きを承認して公開",
    dependencies=[Depends(require_json), Depends(no_query)],
)
def approve(
    document_id: UUID,
    version_no: int,
    data: ReviewInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    operator: Operator,
):
    return review_version(document_id, version_no, data, request, auth, session)


@router.post(
    "/{document_id}/versions/{version_no}/reject",
    summary="理由を記録して差し戻し",
    dependencies=[Depends(require_json), Depends(no_query)],
)
def reject(
    document_id: UUID,
    version_no: int,
    data: RejectInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    operator: Operator,
):
    return review_version(document_id, version_no, data, request, auth, session, True)


@router.post(
    "/{document_id}/versions/{version_no}/delete-document",
    summary="ナレッジ文書の全版と検索資料を完全に削除",
    dependencies=[Depends(require_json), Depends(no_query)],
)
def delete_document(
    document_id: UUID,
    version_no: int,
    data: DocumentDeleteInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    operator: Operator,
):
    from app.knowledge_search import search_state

    write_actor(request, session, auth, operator=True)
    search_state(session, lock=True)
    doc = get_document(session, document_id, True)
    version = get_version(session, document_id, version_no, True)
    conflict(data.expected_document_version, doc.row_version)
    conflict(data.expected_version, version.row_version)
    if data.confirmation_number != doc.number:
        invalid("削除する文書番号を正確に入力してください。")
    result = {"document_id": str(doc.id), "number": doc.number}
    ids = select(KnowledgeVersion.id).where(KnowledgeVersion.document_id == doc.id)
    # 循環参照を外して全版を同時に消し、再送用の本文も残さない。
    # [ko] 순환 참조를 해제해 모든 판을 함께 삭제하고 재전송용 본문도 남기지 않는다.
    # [en] Remove cyclic references and every version atomically, including replayed content.
    doc.published_version_id = None
    session.flush()
    session.execute(
        update(KnowledgeVersion)
        .where(KnowledgeVersion.document_id == doc.id)
        .values(base_version_id=None)
    )
    session.execute(delete(KnowledgePreparation).where(KnowledgePreparation.version_id.in_(ids)))
    session.execute(delete(KnowledgeSource).where(KnowledgeSource.knowledge_version_id.in_(ids)))
    session.execute(delete(KnowledgeEvent).where(KnowledgeEvent.knowledge_version_id.in_(ids)))
    session.execute(
        update(IdempotencyRecord)
        .where(IdempotencyRecord.entity_id == doc.id)
        .values(response_status=410, response_body={})
    )
    session.execute(delete(KnowledgeVersion).where(KnowledgeVersion.document_id == doc.id))
    session.delete(doc)
    return finish(session, result)


def change_publication(
    document_id: UUID,
    version_no: int,
    operation: Literal["stop-publication", "resume-publication"],
    data: ReviewInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    operator: Operator,
):
    from app.knowledge_search import preparation_status, search_state

    actor, _ = write_actor(request, session, auth, operator=True)
    search_state(session, lock=True)
    doc = get_document(session, document_id, True)
    version = get_version(session, document_id, version_no, True)
    conflict(data.expected_document_version, doc.row_version)
    conflict(data.expected_version, version.row_version)
    stopping = operation == "stop-publication"
    if (
        version.id != doc.published_version_id
        or version.status != "approved"
        or doc.publication_suspended == stopping
    ):
        invalid_state()
    if not stopping and preparation_status(session, doc, version)["status"] != "ready":
        raise ApiError(409, "EMBEDDING_NOT_READY", "再公開には承認版の検索準備が必要です。")
    previous_version = version.row_version
    version.updated_at = datetime.now(UTC)
    doc.publication_suspended = stopping
    doc.row_version += 1
    version.row_version += 1
    # 本文を変えない公開操作では、準備済みの同じ本文だけを新しい保存版へ引き継ぐ。
    # [ko] 본문이 그대로인 공개 조작에서는 준비된 동일 본문만 새 저장 버전으로 잇는다.
    # [en] Publication changes preserve indexing only for the unchanged, already indexed version.
    session.execute(
        update(KnowledgePreparation)
        .where(
            KnowledgePreparation.version_id == version.id,
            KnowledgePreparation.indexed_row_version == previous_version,
        )
        .values(indexed_row_version=version.row_version)
    )
    record(
        session,
        version,
        actor,
        "publication_stopped" if stopping else "publication_resumed",
        {"published_version_no": version.version_no},
    )
    return finish(session, review_detail(session, doc, version))


@router.post(
    "/{document_id}/versions/{version_no}/stop-publication",
    summary="承認文書の公開を停止",
    dependencies=[Depends(require_json), Depends(no_query)],
)
def stop_publication(
    document_id: UUID,
    version_no: int,
    data: ReviewInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    operator: Operator,
):
    return change_publication(
        document_id, version_no, "stop-publication", data, request, auth, session, operator
    )


@router.post(
    "/{document_id}/versions/{version_no}/resume-publication",
    summary="承認文書を再公開",
    dependencies=[Depends(require_json), Depends(no_query)],
)
def resume_publication(
    document_id: UUID,
    version_no: int,
    data: ReviewInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    operator: Operator,
):
    return change_publication(
        document_id, version_no, "resume-publication", data, request, auth, session, operator
    )
