from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Sequence,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.vector import Vector768


class Base(DeclarativeBase):
    pass


class GuidanceSession(Base):
    __tablename__ = "guidance_sessions"
    __table_args__ = (
        CheckConstraint(
            "state IN ('processing','answered','insufficient_evidence','error')",
            name="ck_guidance_state",
        ),
        CheckConstraint(
            "outcome IS NULL OR outcome IN ('solved','unresolved')", name="ck_guidance_outcome"
        ),
        Index("ix_guidance_owner_created", "user_id", "created_at"),
        Index("ix_guidance_expiry", "expires_at"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    query: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(String(24))
    response: Mapped[dict | None] = mapped_column(JSONB)
    error_code: Mapped[str | None] = mapped_column(String(64))
    outcome: Mapped[str | None] = mapped_column(String(16))
    feedback: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1)
    elapsed_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class TicketMessage(Base):
    __tablename__ = "ticket_messages"
    __table_args__ = (
        UniqueConstraint("ticket_id", "ticket_version", name="uq_ticket_message_version"),
        CheckConstraint("actor_role IN ('employee','operator')", name="ck_message_role"),
        CheckConstraint("length(btrim(body)) BETWEEN 1 AND 5000", name="ck_message_body"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    ticket_id: Mapped[UUID] = mapped_column(ForeignKey("tickets.id", ondelete="RESTRICT"))
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    actor_role: Mapped[str] = mapped_column(String(16))
    body: Mapped[str] = mapped_column(Text)
    ticket_version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class TicketRead(Base):
    __tablename__ = "ticket_reads"
    ticket_id: Mapped[UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="RESTRICT"), primary_key=True
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True
    )
    message_version: Mapped[int] = mapped_column(Integer)


ticket_number_sequence = Sequence("ticket_number_seq", metadata=Base.metadata)
knowledge_number_sequence = Sequence("knowledge_number_seq", metadata=Base.metadata)


class Department(Base):
    __tablename__ = "departments"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('employee', 'operator')", name="ck_users_role"),
        CheckConstraint("row_version >= 1", name="ck_users_row_version"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    department_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT")
    )
    display_name: Mapped[str] = mapped_column(String(100))
    login_id: Mapped[str] = mapped_column(String(100), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    can_manage_accounts: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    row_version: Mapped[int] = mapped_column(Integer, default=1, server_default=text("1"))


class AuthSession(Base):
    __tablename__ = "sessions"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    csrf_token_hash: Mapped[str] = mapped_column(String(64))


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        CheckConstraint(
            "action IN ('create', 'deactivate', 'reactivate', 'reissue', "
            "'password_change', 'management_granted')",
            name="ck_audit_action",
        ),
        CheckConstraint(
            "(action = 'management_granted' AND actor_id IS NULL) OR "
            "(action <> 'management_granted' AND actor_id IS NOT NULL)",
            name="ck_audit_actor",
        ),
        CheckConstraint(
            "action <> 'password_change' OR actor_id = target_user_id",
            name="ck_audit_password_actor",
        ),
        CheckConstraint("target_version >= 1", name="ck_audit_target_version"),
        UniqueConstraint("target_user_id", "target_version", name="uq_audit_target_version"),
        Index("ix_audit_actor_id", "actor_id"),
        Index("ix_audit_target_time", "target_user_id", text("occurred_at DESC"), text("id DESC")),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    actor_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    target_user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    action: Mapped[str] = mapped_column(String(32))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    request_id: Mapped[UUID] = mapped_column()
    target_version: Mapped[int] = mapped_column(Integer)


class Ticket(Base):
    __tablename__ = "tickets"
    guidance_context: Mapped[dict | None] = mapped_column(JSONB)
    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_tickets_version"),
        CheckConstraint("length(btrim(title)) BETWEEN 1 AND 120", name="ck_tickets_title"),
        CheckConstraint("length(btrim(body)) BETWEEN 1 AND 5000", name="ck_tickets_body"),
        CheckConstraint(
            "(status = 'open' AND resolution IS NULL AND resolved_at IS NULL "
            "AND (department_id IS NOT NULL OR assignee_id IS NULL)) OR "
            "(status = 'in_progress' AND department_id IS NOT NULL AND assignee_id IS NOT NULL "
            "AND resolution IS NULL AND resolved_at IS NULL) OR "
            "(status = 'resolved' AND department_id IS NOT NULL AND assignee_id IS NOT NULL "
            "AND resolution IS NOT NULL AND length(btrim(resolution)) BETWEEN 1 AND 5000 "
            "AND resolved_at IS NOT NULL)",
            name="ck_tickets_state",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    requester_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    assignee_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    department_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT")
    )
    title: Mapped[str] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16))
    resolution: Mapped[str | None] = mapped_column(Text)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class TicketEvent(Base):
    __tablename__ = "ticket_events"
    __table_args__ = (
        UniqueConstraint("ticket_id", "ticket_version", name="uq_ticket_event_version"),
        CheckConstraint("ticket_version >= 1", name="ck_ticket_event_version"),
        CheckConstraint(
            "event_type IN ('created','body_updated','assignment_changed',"
            "'started','resolved','reopened')",
            name="ck_ticket_event_type",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    ticket_id: Mapped[UUID] = mapped_column(ForeignKey("tickets.id", ondelete="RESTRICT"))
    ticket_version: Mapped[int] = mapped_column(Integer)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    event_type: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict] = mapped_column(JSONB)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class IdempotencyRecord(Base):
    __tablename__ = "idempotency_records"
    __table_args__ = (
        UniqueConstraint("user_id", "method", "path", "key", name="uq_idempotency_request"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    method: Mapped[str] = mapped_column(String(8))
    path: Mapped[str] = mapped_column(String(200))
    key: Mapped[str] = mapped_column(String(100))
    request_hash: Mapped[str] = mapped_column(String(64))
    response_status: Mapped[int] = mapped_column(Integer)
    response_body: Mapped[dict] = mapped_column(JSONB)
    entity_id: Mapped[UUID] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# 公開版ポインターを分け、改訂中も直前の承認版を公開し続ける。
# [ko] 공개 버전 포인터를 분리해 개정 중에도 직전 승인본을 계속 공개한다.
# [en] Keep a separate publication pointer so revisions do not replace the approved version early.
class KnowledgeDocument(Base):
    __tablename__ = "knowledge_documents"
    __table_args__ = (
        CheckConstraint("row_version >= 1", name="ck_document_row_version"),
        ForeignKeyConstraint(
            ["id", "published_version_id"],
            ["knowledge_versions.document_id", "knowledge_versions.id"],
            name="fk_document_published",
            use_alter=True,
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    published_version_id: Mapped[UUID | None] = mapped_column()
    publication_suspended: Mapped[bool] = mapped_column(default=False, server_default=text("false"))
    row_version: Mapped[int] = mapped_column(Integer)
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class KnowledgeVersion(Base):
    __tablename__ = "knowledge_versions"
    __table_args__ = (
        UniqueConstraint("document_id", "version_no", name="uq_knowledge_version_no"),
        UniqueConstraint("document_id", "id", name="uq_knowledge_version_owner"),
        ForeignKeyConstraint(
            ["document_id", "base_version_id"],
            ["knowledge_versions.document_id", "knowledge_versions.id"],
            name="fk_knowledge_base",
            ondelete="RESTRICT",
        ),
        Index(
            # 同じ文書への同時作成でも、未承認の下書きはDBで一つに制限する。
            # [ko] 같은 문서에 동시에 생성해도 미승인 초안은 DB에서 하나로 제한한다.
            # [en] Enforce one draft per document in the DB, including concurrent creation attempts.
            "uq_document_draft",
            "document_id",
            unique=True,
            postgresql_where=text("status = 'draft'"),
        ),
        CheckConstraint("version_no >= 1 AND row_version >= 1", name="ck_knowledge_versions"),
        CheckConstraint("length(btrim(title)) BETWEEN 1 AND 120", name="ck_knowledge_title"),
        CheckConstraint("length(btrim(audience)) BETWEEN 1 AND 300", name="ck_knowledge_audience"),
        CheckConstraint("length(btrim(body)) BETWEEN 1 AND 20000", name="ck_knowledge_body"),
        CheckConstraint(
            "(status = 'draft' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR "
            "(status = 'approved' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL "
            "AND department_id IS NOT NULL) OR "
            "(status = 'rejected' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)",
            name="ck_knowledge_state",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("knowledge_documents.id", ondelete="RESTRICT")
    )
    version_no: Mapped[int] = mapped_column(Integer)
    base_version_id: Mapped[UUID | None] = mapped_column()
    status: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(120))
    audience: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    department_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT")
    )
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    reviewed_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    row_version: Mapped[int] = mapped_column(Integer)


class KnowledgeSource(Base):
    __tablename__ = "knowledge_sources"
    __table_args__ = (
        UniqueConstraint("knowledge_version_id", "ticket_id", name="uq_knowledge_source"),
        CheckConstraint("ticket_version >= 1", name="ck_source_version"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    knowledge_version_id: Mapped[UUID] = mapped_column(
        ForeignKey("knowledge_versions.id", ondelete="RESTRICT")
    )
    ticket_id: Mapped[UUID] = mapped_column(ForeignKey("tickets.id", ondelete="RESTRICT"))
    ticket_version: Mapped[int] = mapped_column(Integer)
    evidence_snapshot: Mapped[dict] = mapped_column(JSONB)
    content_hash: Mapped[str] = mapped_column(String(64))
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class KnowledgeEvent(Base):
    __tablename__ = "knowledge_events"
    __table_args__ = (
        UniqueConstraint("knowledge_version_id", "row_version", name="uq_knowledge_event_version"),
        CheckConstraint("row_version >= 1", name="ck_knowledge_event_version"),
        CheckConstraint(
            "event_type IN ('draft_created','saved','sources_refreshed','approved','rejected',"
            "'publication_stopped','publication_resumed')",
            name="ck_knowledge_event_type",
        ),
        CheckConstraint(
            "(event_type = 'rejected' AND reason IS NOT NULL "
            "AND length(btrim(reason)) BETWEEN 1 AND 1000) "
            "OR (event_type <> 'rejected' AND reason IS NULL)",
            name="ck_knowledge_event_reason",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    knowledge_version_id: Mapped[UUID] = mapped_column(
        ForeignKey("knowledge_versions.id", ondelete="RESTRICT")
    )
    row_version: Mapped[int] = mapped_column(Integer)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    event_type: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(JSONB)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class KnowledgeGeneration(Base):
    __tablename__ = "knowledge_generations"
    __table_args__ = (CheckConstraint("expires_at > created_at", name="ck_generation_expiry"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    session_id: Mapped[UUID] = mapped_column()
    sources: Mapped[list] = mapped_column(JSONB)
    trace: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    saved_version_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("knowledge_versions.id", ondelete="SET NULL")
    )


class EmbeddingProfile(Base):
    __tablename__ = "embedding_profiles"
    __table_args__ = (CheckConstraint("length(id) = 64", name="ck_embedding_profile_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    specification: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class KnowledgeSearchState(Base):
    __tablename__ = "knowledge_search_state"
    __table_args__ = (
        CheckConstraint("id = 1 AND revision >= 1", name="ck_knowledge_search_singleton"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    active_profile_id: Mapped[str | None] = mapped_column(
        ForeignKey("embedding_profiles.id", ondelete="RESTRICT")
    )
    revision: Mapped[int] = mapped_column(Integer)


class KnowledgePreparation(Base):
    __tablename__ = "knowledge_preparations"
    __table_args__ = (
        UniqueConstraint("version_id", "profile_id", name="uq_preparation_version_profile"),
        CheckConstraint(
            "source_row_version >= 1 AND document_row_version >= 1 AND state_revision >= 1 "
            "AND chunk_count >= 1 AND "
            "(indexed_row_version IS NULL OR indexed_row_version >= source_row_version)",
            name="ck_preparation_versions",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    version_id: Mapped[UUID] = mapped_column(
        ForeignKey("knowledge_versions.id", ondelete="RESTRICT")
    )
    profile_id: Mapped[str] = mapped_column(
        ForeignKey("embedding_profiles.id", ondelete="RESTRICT")
    )
    source_row_version: Mapped[int] = mapped_column(Integer)
    document_row_version: Mapped[int] = mapped_column(Integer)
    state_revision: Mapped[int] = mapped_column(Integer)
    indexed_row_version: Mapped[int | None] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64))
    sources_hash: Mapped[str] = mapped_column(String(64))
    chunk_count: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class KnowledgeChunk(Base):
    __tablename__ = "knowledge_chunks"
    __table_args__ = (
        UniqueConstraint("preparation_id", "ordinal", name="uq_chunk_ordinal"),
        CheckConstraint(
            "ordinal >= 0 AND body_start >= 0 AND body_end > body_start "
            "AND body_end - body_start = length(text) "
            "AND line_start >= 1 AND line_end >= line_start "
            "AND input_tokens BETWEEN 1 AND 8192",
            name="ck_chunk_position",
        ),
        CheckConstraint(
            "vector_norm(embedding) BETWEEN 0.9999 AND 1.0001", name="ck_chunk_normalized"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    preparation_id: Mapped[UUID] = mapped_column(
        ForeignKey("knowledge_preparations.id", ondelete="CASCADE")
    )
    ordinal: Mapped[int] = mapped_column(Integer)
    body_start: Mapped[int] = mapped_column(Integer)
    body_end: Mapped[int] = mapped_column(Integer)
    line_start: Mapped[int] = mapped_column(Integer)
    line_end: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    context: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    input_tokens: Mapped[int] = mapped_column(Integer)
    embedding: Mapped[list[float]] = mapped_column(Vector768())


class TicketEmbedding(Base):
    __tablename__ = "ticket_embeddings"
    __table_args__ = (
        CheckConstraint(
            "ticket_version >= 1 AND input_tokens BETWEEN 1 AND 8192",
            name="ck_ticket_embedding_input",
        ),
        CheckConstraint(
            "vector_norm(embedding) BETWEEN 0.9999 AND 1.0001", name="ck_ticket_embedding_norm"
        ),
    )

    ticket_id: Mapped[UUID] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), primary_key=True
    )
    profile_id: Mapped[str] = mapped_column(
        ForeignKey("embedding_profiles.id", ondelete="RESTRICT"), primary_key=True
    )
    ticket_version: Mapped[int] = mapped_column(Integer)
    input_hash: Mapped[str] = mapped_column(String(64))
    input_tokens: Mapped[int] = mapped_column(Integer)
    embedding: Mapped[list[float]] = mapped_column(Vector768())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class RadarRun(Base):
    __tablename__ = "radar_runs"
    __table_args__ = (
        UniqueConstraint("actor_id", "request_key", name="uq_radar_run_request"),
        CheckConstraint("status IN ('running','complete','failed')", name="ck_radar_run_status"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    request_key: Mapped[UUID] = mapped_column()
    request_hash: Mapped[str] = mapped_column(String(64))
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    parameters: Mapped[dict] = mapped_column(JSONB)
    inputs: Mapped[list] = mapped_column(JSONB)
    candidates: Mapped[list] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16))
    error_code: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lease_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RadarCoverage(Base):
    __tablename__ = "radar_coverages"
    __table_args__ = (
        UniqueConstraint("actor_id", "request_key", name="uq_radar_coverage_request"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    run_id: Mapped[UUID] = mapped_column(ForeignKey("radar_runs.id", ondelete="RESTRICT"))
    candidate_id: Mapped[str] = mapped_column(String(64))
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    request_key: Mapped[UUID] = mapped_column()
    corpus_hash: Mapped[str] = mapped_column(String(64))
    search_profile_id: Mapped[str] = mapped_column(String(64))
    policy: Mapped[dict] = mapped_column(JSONB)
    judgments: Mapped[dict] = mapped_column(JSONB)
    batches: Mapped[list] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class RadarReview(Base):
    __tablename__ = "radar_reviews"
    __table_args__ = (
        UniqueConstraint("actor_id", "request_key", name="uq_radar_review_request"),
        CheckConstraint(
            "decision IN ('linked','needs_supplement')", name="ck_radar_review_decision"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    run_id: Mapped[UUID] = mapped_column(ForeignKey("radar_runs.id", ondelete="RESTRICT"))
    candidate_id: Mapped[str] = mapped_column(String(64))
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    request_key: Mapped[UUID] = mapped_column()
    request_hash: Mapped[str] = mapped_column(String(64))
    context_hash: Mapped[str] = mapped_column(String(64))
    decision: Mapped[str] = mapped_column(String(24))
    reason: Mapped[str] = mapped_column(Text)
    ticket_ids: Mapped[list] = mapped_column(JSONB)
    documents: Mapped[list] = mapped_column(JSONB)
    coverage_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("radar_coverages.id", ondelete="RESTRICT")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
