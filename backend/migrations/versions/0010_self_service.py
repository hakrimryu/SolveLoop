"""社員のAI案内履歴と非同期の問い合わせ回答を追加。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0010_self_service"
down_revision = "0009_radar_reviews"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "guidance_sessions",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("query", sa.Text, nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("response", JSONB),
        sa.Column("error_code", sa.String(64)),
        sa.Column("outcome", sa.String(16)),
        sa.Column("feedback", sa.Text),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("elapsed_ms", sa.Integer),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "state IN ('processing','answered','insufficient_evidence','error')",
            name="ck_guidance_state",
        ),
        sa.CheckConstraint(
            "outcome IS NULL OR outcome IN ('solved','unresolved')", name="ck_guidance_outcome"
        ),
    )
    op.create_index("ix_guidance_owner_created", "guidance_sessions", ["user_id", "created_at"])
    op.create_index("ix_guidance_expiry", "guidance_sessions", ["expires_at"])
    op.create_table(
        "ticket_messages",
        sa.Column("id", UUID, primary_key=True),
        sa.Column(
            "ticket_id", UUID, sa.ForeignKey("tickets.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column("actor_id", UUID, sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("actor_role", sa.String(16), nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("ticket_version", sa.Integer, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("ticket_id", "ticket_version", name="uq_ticket_message_version"),
        sa.CheckConstraint("actor_role IN ('employee','operator')", name="ck_message_role"),
        sa.CheckConstraint("length(btrim(body)) BETWEEN 1 AND 5000", name="ck_message_body"),
    )
    op.create_table(
        "ticket_reads",
        sa.Column(
            "ticket_id", UUID, sa.ForeignKey("tickets.id", ondelete="RESTRICT"), primary_key=True
        ),
        sa.Column(
            "user_id", UUID, sa.ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True
        ),
        sa.Column("message_version", sa.Integer, nullable=False),
    )
    op.add_column("tickets", sa.Column("guidance_context", JSONB, nullable=True))


def downgrade() -> None:
    raise RuntimeError("問い合わせの回答と案内履歴を失わないよう、自動削除は行いません。")
