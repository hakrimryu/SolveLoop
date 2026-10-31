"""AI判定を変更せず、人の文書確認を別の追記専用記録として保存。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0009_radar_reviews"
down_revision = "0008_radar"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "radar_reviews",
        sa.Column("id", UUID, primary_key=True),
        sa.Column(
            "run_id", UUID, sa.ForeignKey("radar_runs.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column("candidate_id", sa.String(64), nullable=False),
        sa.Column("actor_id", UUID, sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("request_key", UUID, nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("context_hash", sa.String(64), nullable=False),
        sa.Column("decision", sa.String(24), nullable=False),
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column("ticket_ids", JSONB, nullable=False),
        sa.Column("documents", JSONB, nullable=False),
        sa.Column("coverage_id", UUID, sa.ForeignKey("radar_coverages.id", ondelete="RESTRICT")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("actor_id", "request_key", name="uq_radar_review_request"),
        sa.CheckConstraint(
            "decision IN ('linked','needs_supplement')", name="ck_radar_review_decision"
        ),
    )


def downgrade() -> None:
    raise RuntimeError("人の検討記録を失わないため、自動ダウングレードは提供しません。")
