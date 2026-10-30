"""既存の認証資料を保持して、本人変更と管理権限の基盤を追加する。"""

import sqlalchemy as sa
from alembic import op

revision = "0003_account_auth"
down_revision = "0002_auth"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("can_manage_accounts", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "users",
        sa.Column("must_change_password", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "users", sa.Column("row_version", sa.Integer(), server_default=sa.text("1"), nullable=False)
    )
    op.create_check_constraint("ck_users_row_version", "users", "row_version >= 1")
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT")),
        sa.Column(
            "target_user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("target_version", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "action IN ('create', 'deactivate', 'reactivate', 'reissue', "
            "'password_change', 'management_granted')",
            name="ck_audit_action",
        ),
        sa.CheckConstraint(
            "(action = 'management_granted' AND actor_id IS NULL) OR "
            "(action <> 'management_granted' AND actor_id IS NOT NULL)",
            name="ck_audit_actor",
        ),
        sa.CheckConstraint(
            "action <> 'password_change' OR actor_id = target_user_id",
            name="ck_audit_password_actor",
        ),
        sa.CheckConstraint("target_version >= 1", name="ck_audit_target_version"),
        sa.UniqueConstraint("target_user_id", "target_version", name="uq_audit_target_version"),
    )
    op.create_index("ix_audit_actor_id", "audit_events", ["actor_id"])
    op.create_index(
        "ix_audit_target_time",
        "audit_events",
        ["target_user_id", sa.text("occurred_at DESC"), sa.text("id DESC")],
    )


def downgrade() -> None:
    raise RuntimeError(
        "認証・監査資料の削除は行いません。必要ならバックアップから復元してください。"
    )
