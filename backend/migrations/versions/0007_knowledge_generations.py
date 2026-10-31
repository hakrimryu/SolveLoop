"""既存資料を変更せず、成功した知識生成の追跡を追加。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0007_knowledge_generations"
down_revision = "0006_publication_control"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "knowledge_generations",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("actor_id", UUID, sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("session_id", UUID, nullable=False),
        sa.Column("sources", JSONB, nullable=False),
        sa.Column("trace", JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True)),
        sa.Column(
            "saved_version_id", UUID, sa.ForeignKey("knowledge_versions.id", ondelete="SET NULL")
        ),
        sa.CheckConstraint("expires_at > created_at", name="ck_generation_expiry"),
    )


def downgrade() -> None:
    raise RuntimeError("生成と保存の追跡を失わないため、自動ダウングレードは提供しません。")
