from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BeforeValidator, Field, ValidationError
from pydantic_settings import SettingsError
from sqlalchemy import Float, bindparam, delete, func, select
from sqlalchemy.dialects.postgresql import insert

from app.accounts import no_query
from app.ai.config import AISettings
from app.ai.knowledge import PROFILE_ID, SPECIFICATION, Chunk, chunks, embed, fingerprint
from app.ai.ollama import OllamaClient, OllamaError
from app.auth import (
    COOKIE_NAME,
    DbSession,
    FullAuthenticated,
    get_auth,
    require_csrf,
    require_json,
    require_operator,
)
from app.business import Input, clean, conflict, finish, invalid_state, write_actor
from app.errors import ApiError
from app.knowledge import ReviewInput
from app.models import (
    Department,
    EmbeddingProfile,
    KnowledgeChunk,
    KnowledgeDocument,
    KnowledgePreparation,
    KnowledgeSearchState,
    KnowledgeVersion,
)
from app.vector import Vector768

router = APIRouter(prefix="/api/v1/knowledge", tags=["ナレッジの意味検索"])


def embedding_client() -> OllamaClient:
    try:
        return OllamaClient(AISettings())
    except (ValidationError, SettingsError):
        raise ApiError(
            503, "AI_CONFIGURATION_ERROR", "ローカルAIの設定を確認してください。"
        ) from None


Client = Annotated[OllamaClient, Depends(embedding_client)]


def ai_error(error: OllamaError):
    raise ApiError(504 if error.code == "AI_TIMEOUT" else 503, error.code, str(error)) from None


def search_state(session, lock=False, exclusive=False) -> KnowledgeSearchState:
    stmt = select(KnowledgeSearchState).where(KnowledgeSearchState.id == 1)
    if lock:
        stmt = stmt.with_for_update(read=not exclusive)
    state = session.scalar(stmt.execution_options(populate_existing=True))
    if state is None:
        raise ApiError(503, "SEARCH_NOT_READY", "検索用マイグレーションを確認してください。")
    return state


def register_profile(session):
    session.execute(
        insert(EmbeddingProfile)
        .values(id=PROFILE_ID, specification=SPECIFICATION, created_at=datetime.now(UTC))
        .on_conflict_do_nothing(index_elements=[EmbeddingProfile.id])
    )
    supported_profile(session, PROFILE_ID)


def supported_profile(session, profile_id):
    profile = session.get(EmbeddingProfile, profile_id) if profile_id else None
    if profile is None:
        raise ApiError(503, "SEARCH_NOT_READY", "全公開文書の検索準備と有効化が必要です。")
    if profile.id != PROFILE_ID or profile.specification != SPECIFICATION:
        raise ApiError(
            503, "SEARCH_PROFILE_UNSUPPORTED", "検索用の規格と実行コードが一致しません。"
        )


@dataclass(frozen=True)
class Snapshot:
    version_id: UUID
    document_id: UUID
    version_no: int
    row_version: int
    document_row_version: int
    status: str
    title: str
    audience: str
    body: str
    content_hash: str
    sources_hash: str
    state_revision: int
    active_profile_id: str | None


def snapshot(session, doc, version, state) -> Snapshot:
    from app.knowledge import sources_for

    return Snapshot(
        version.id,
        doc.id,
        version.version_no,
        version.row_version,
        doc.row_version,
        version.status,
        version.title,
        version.audience,
        version.body,
        fingerprint(
            {
                "title": version.title,
                "audience": version.audience,
                "body": version.body,
                "department_id": str(version.department_id) if version.department_id else None,
            }
        ),
        fingerprint(
            [
                {
                    "ticket_id": str(s.ticket_id),
                    "version": s.ticket_version,
                    "hash": s.content_hash,
                    "snapshot": s.evidence_snapshot,
                }
                for s in sources_for(session, version.id)
            ]
        ),
        state.revision,
        state.active_profile_id,
    )


def preparation(session, version_id, profile_id=PROFILE_ID):
    return session.scalar(
        select(KnowledgePreparation)
        .where(
            KnowledgePreparation.version_id == version_id,
            KnowledgePreparation.profile_id == profile_id,
        )
        .execution_options(populate_existing=True)
    )


def complete(session, prepared) -> bool:
    if prepared is None:
        return False
    count = session.scalar(
        select(func.count())
        .select_from(KnowledgeChunk)
        .where(KnowledgeChunk.preparation_id == prepared.id)
    )
    return count == prepared.chunk_count


def matches(prepared, value: Snapshot, *, draft: bool) -> bool:
    if prepared is None or (
        prepared.profile_id != PROFILE_ID
        or prepared.content_hash != value.content_hash
        or prepared.sources_hash != value.sources_hash
    ):
        return False
    if draft:
        return (
            prepared.source_row_version == value.row_version
            and prepared.document_row_version == value.document_row_version
            and prepared.state_revision == value.state_revision
            and prepared.indexed_row_version is None
        )
    return prepared.indexed_row_version == value.row_version


def preparation_status(session, doc, version):
    state = search_state(session)
    supported = state.active_profile_id == PROFILE_ID
    value = snapshot(session, doc, version, state)
    prepared = preparation(session, version.id)
    ready = supported and matches(prepared, value, draft=version.status == "draft")
    ready = ready and complete(session, prepared)
    return {
        "status": "ready" if ready else "required",
        "profile_id": state.active_profile_id,
        "chunk_count": prepared.chunk_count if ready else 0,
    }


def compute(client, value: Snapshot) -> list[tuple[Chunk, list[float], int]]:
    return [
        (chunk, *embed(client, chunk.input))
        for chunk in chunks(value.title, value.audience, value.body)
    ]


def store(session, value: Snapshot, vectors):
    register_profile(session)
    prepared = preparation(session, value.version_id)
    if prepared:
        session.execute(delete(KnowledgeChunk).where(KnowledgeChunk.preparation_id == prepared.id))
    else:
        prepared = KnowledgePreparation(version_id=value.version_id, profile_id=PROFILE_ID)
        session.add(prepared)
    prepared.source_row_version = value.row_version
    prepared.document_row_version = value.document_row_version
    prepared.state_revision = value.state_revision
    prepared.indexed_row_version = value.row_version if value.status == "approved" else None
    prepared.content_hash = value.content_hash
    prepared.sources_hash = value.sources_hash
    prepared.chunk_count = len(vectors)
    prepared.created_at = datetime.now(UTC)
    session.flush()
    session.add_all(
        [
            KnowledgeChunk(
                preparation_id=prepared.id,
                ordinal=ordinal,
                body_start=chunk.start,
                body_end=chunk.end,
                line_start=chunk.line_start,
                line_end=chunk.line_end,
                text=chunk.text,
                context=chunk.context,
                content_hash=chunk.content_hash,
                input_tokens=tokens,
                embedding=vector,
            )
            for ordinal, (chunk, vector, tokens) in enumerate(vectors)
        ]
    )
    session.flush()


def require_prepared(session, doc, version):
    state = search_state(session)
    supported_profile(session, state.active_profile_id)
    value = snapshot(session, doc, version, state)
    prepared = preparation(session, version.id)
    if not matches(prepared, value, draft=True) or not complete(session, prepared):
        raise ApiError(
            409, "EMBEDDING_NOT_READY", "保存内容の検索準備を実行してから、改めて承認してください。"
        )
    return prepared


class SearchInput(Input):
    query: Annotated[str, BeforeValidator(clean), Field(min_length=1, max_length=500)]
    top_k: Annotated[int, Field(strict=True, ge=1, le=20)] = 5
    department_id: UUID | None = None


@router.post(
    "/search",
    summary="現在の承認版を意味検索",
    dependencies=[Depends(require_json), Depends(no_query)],
)
def search(
    data: SearchInput, request: Request, auth: FullAuthenticated, session: DbSession, client: Client
):
    from app.knowledge import public_item
    from app.tickets import reference_filter

    require_csrf(request, auth, request.headers.get("X-CSRF-Token"))
    state = search_state(session)
    supported_profile(session, state.active_profile_id)
    revision = state.revision
    if data.department_id:
        reference_filter(session, str(data.department_id), Department, set())
    # 推論中は接続・行ロックを持たず、終了後に資格と検索規格を再確認する。
    # [ko] 추론 중 접속·행 잠금을 유지하지 않고 종료 후 자격과 검색 규격을 재확인한다.
    # [en] Release the DB during inference, then recheck credentials and the search profile.
    session.rollback()
    try:
        vector, _ = embed(client, SPECIFICATION["query_template"].format(query=data.query))
    except OllamaError as error:
        ai_error(error)
    current = get_auth(session, request.cookies.get(COOKIE_NAME))
    write_actor(request, session, current)
    state = search_state(session, lock=True)
    if state.active_profile_id != PROFILE_ID or state.revision != revision:
        raise ApiError(
            409, "SEARCH_PROFILE_CHANGED", "検索用の規格が変わりました。再検索してください。"
        )
    supported_profile(session, state.active_profile_id)
    distance = KnowledgeChunk.embedding.op("<=>", return_type=Float)(
        # bindparamの型を固定し、ユーザー入力をSQL文字列へ組み込まない。
        # [ko] bindparam 타입을 고정해 사용자 입력을 SQL 문자열에 넣지 않는다.
        # [en] Bind a typed vector rather than interpolating user input into SQL.
        bindparam("query_vector", vector, type_=Vector768())
    )
    stmt = (
        select(
            KnowledgeDocument,
            KnowledgeVersion,
            Department,
            KnowledgePreparation,
            KnowledgeChunk,
            distance.label("distance"),
        )
        .join(KnowledgeVersion, KnowledgeDocument.published_version_id == KnowledgeVersion.id)
        .join(KnowledgePreparation, KnowledgePreparation.version_id == KnowledgeVersion.id)
        .join(KnowledgeChunk, KnowledgeChunk.preparation_id == KnowledgePreparation.id)
        .outerjoin(Department, KnowledgeVersion.department_id == Department.id)
        .where(
            KnowledgeVersion.document_id == KnowledgeDocument.id,
            KnowledgeVersion.status == "approved",
            KnowledgeDocument.publication_suspended.is_(False),
            KnowledgePreparation.profile_id == state.active_profile_id,
            KnowledgePreparation.indexed_row_version == KnowledgeVersion.row_version,
        )
    )
    if data.department_id:
        stmt = stmt.where(KnowledgeVersion.department_id == data.department_id)
    rows = session.execute(
        stmt.order_by(distance, KnowledgeDocument.id, KnowledgeChunk.ordinal).limit(data.top_k)
    ).all()
    items = []
    for doc, version, dept, prepared, chunk, score in rows:
        items.append(
            {
                **public_item(
                    doc,
                    version,
                    {"id": str(dept.id), "code": dept.code, "name": dept.name} if dept else None,
                ),
                "version_id": str(version.id),
                "chunk_id": str(chunk.id),
                "ordinal": chunk.ordinal,
                "text": chunk.text,
                "context": chunk.context,
                "body_start": chunk.body_start,
                "body_end": chunk.body_end,
                "line_start": chunk.line_start,
                "line_end": chunk.line_end,
                "content_hash": prepared.content_hash,
                "chunk_hash": chunk.content_hash,
                "cosine_distance": score,
            }
        )
    return {
        "items": items,
        "top_k": data.top_k,
        "profile_id": PROFILE_ID,
        "as_of": datetime.now(UTC),
    }


@router.post(
    "/{document_id}/versions/{version_no}/prepare-search",
    summary="保存済み下書きの検索用ベクトルを準備（承認・公開はしない）",
    dependencies=[Depends(require_json), Depends(no_query), Depends(require_operator)],
)
def prepare_search(
    document_id: UUID,
    version_no: int,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    client: Client,
    data: ReviewInput,
):
    from app.knowledge import (
        get_document,
        get_version,
        locked_version,
        review_detail,
        source_issues,
        sources_for,
    )

    require_csrf(request, auth, request.headers.get("X-CSRF-Token"))
    doc = get_document(session, document_id)
    version = get_version(session, document_id, version_no)
    conflict(data.expected_version, version.row_version)
    conflict(data.expected_document_version, doc.row_version)
    if version.status != "draft":
        invalid_state()
    state = search_state(session)
    supported_profile(session, state.active_profile_id)
    value = snapshot(session, doc, version, state)
    session.rollback()
    try:
        vectors = compute(client, value)
    except OllamaError as error:
        ai_error(error)
    current = get_auth(session, request.cookies.get(COOKIE_NAME))
    _, _, doc, version = locked_version(
        request, session, current, document_id, version_no, search=True
    )
    state = search_state(session)
    if snapshot(session, doc, version, state) != value:
        raise ApiError(
            409,
            "EMBEDDING_STALE",
            "本文・根拠・検索規格が変わりました。保存内容を確認してください。",
        )
    if source_issues(session, sources_for(session, version.id)):
        raise ApiError(409, "SOURCE_CHANGED", "原本の変更を確認して根拠を保存し直してください。")
    store(session, value, vectors)
    return finish(session, review_detail(session, doc, version))


def backfill(engine, client) -> int:
    from sqlalchemy.orm import Session

    from app.knowledge import get_document, get_version

    with Session(engine) as session:
        register_profile(session)
        session.commit()
        targets = session.execute(
            select(KnowledgeDocument.id, KnowledgeVersion.version_no)
            .join(KnowledgeVersion, KnowledgeDocument.published_version_id == KnowledgeVersion.id)
            .where(KnowledgeVersion.status == "approved")
            .order_by(KnowledgeDocument.id)
        ).all()
        session.rollback()
        for doc_id, version_no in targets:
            doc = get_document(session, doc_id)
            version = get_version(session, doc_id, version_no)
            if doc.published_version_id != version.id:
                raise ApiError(
                    409, "EMBEDDING_STALE", "公開版が変わりました。準備を再実行してください。"
                )
            value = snapshot(session, doc, version, search_state(session))
            prepared = preparation(session, version.id)
            if matches(prepared, value, draft=False) and complete(session, prepared):
                session.rollback()
                continue
            session.rollback()
            vectors = compute(client, value)
            search_state(session, lock=True)
            doc = get_document(session, doc_id, True)
            version = get_version(session, doc_id, version_no, True)
            if (
                doc.published_version_id != version.id
                or snapshot(session, doc, version, search_state(session)) != value
            ):
                raise ApiError(
                    409, "EMBEDDING_STALE", "公開版が変わりました。準備を再実行してください。"
                )
            store(session, value, vectors)
            session.commit()
    return len(targets)


def activate(engine) -> int:
    from sqlalchemy.orm import Session

    with Session(engine) as session, session.begin():
        state = search_state(session, lock=True, exclusive=True)
        register_profile(session)
        # 全公開版を同じ短いトランザクションで確認し、不完全な規格へ切り替えない。
        # [ko] 모든 공개판을 같은 짧은 트랜잭션에서 확인해 불완전한 규격으로 전환하지 않는다.
        # [en] Validate every published version in one short transaction before profile activation.
        docs = list(
            session.scalars(
                select(KnowledgeDocument).order_by(KnowledgeDocument.id).with_for_update()
            )
        )
        count = 0
        for doc in docs:
            if not doc.published_version_id:
                continue
            version = session.get(KnowledgeVersion, doc.published_version_id)
            value = snapshot(session, doc, version, state)
            prepared = preparation(session, version.id)
            if (
                version.status != "approved"
                or not matches(prepared, value, draft=False)
                or not complete(session, prepared)
            ):
                raise ApiError(
                    409, "EMBEDDING_NOT_READY", "すべての現在公開版の検索準備が必要です。"
                )
            count += 1
        if state.active_profile_id != PROFILE_ID:
            state.active_profile_id = PROFILE_ID
            state.revision += 1
        return count
