"""既存の業務資料を変更せず、Radarの派生資料と分析記録を追加。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.vector import Vector768

revision = "0008_radar"
down_revision = "0007_knowledge_generations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ticket_embeddings",
        sa.Column(
            "ticket_id", UUID, sa.ForeignKey("tickets.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column(
            "profile_id",
            sa.String(64),
            sa.ForeignKey("embedding_profiles.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        sa.Column("ticket_version", sa.Integer, nullable=False),
        sa.Column("input_hash", sa.String(64), nullable=False),
        sa.Column("input_tokens", sa.Integer, nullable=False),
        sa.Column("embedding", Vector768(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "ticket_version >= 1 AND input_tokens BETWEEN 1 AND 8192",
            name="ck_ticket_embedding_input",
        ),
        sa.CheckConstraint(
            "vector_norm(embedding) BETWEEN 0.9999 AND 1.0001", name="ck_ticket_embedding_norm"
        ),
    )
    op.create_table(
        "radar_runs",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("actor_id", UUID, sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("request_key", UUID, nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("parameters", JSONB, nullable=False),
        sa.Column("inputs", JSONB, nullable=False),
        sa.Column("candidates", JSONB, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error_code", sa.String(64)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("actor_id", "request_key", name="uq_radar_run_request"),
        sa.CheckConstraint("status IN ('running','complete','failed')", name="ck_radar_run_status"),
    )
    op.create_table(
        "radar_coverages",
        sa.Column("id", UUID, primary_key=True),
        sa.Column(
            "run_id", UUID, sa.ForeignKey("radar_runs.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column("candidate_id", sa.String(64), nullable=False),
        sa.Column("actor_id", UUID, sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("request_key", UUID, nullable=False),
        sa.Column("corpus_hash", sa.String(64), nullable=False),
        sa.Column("search_profile_id", sa.String(64), nullable=False),
        sa.Column("policy", JSONB, nullable=False),
        sa.Column("judgments", JSONB, nullable=False),
        sa.Column("batches", JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("actor_id", "request_key", name="uq_radar_coverage_request"),
    )


def downgrade() -> None:
    raise RuntimeError("分析記録を失わないため、自動ダウングレードは提供しません。")
