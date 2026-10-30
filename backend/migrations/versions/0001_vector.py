"""基盤用の vector 拡張とマイグレーション履歴を準備する。"""

from alembic import op

revision = "0001_vector"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")


def downgrade() -> None:
    # 既存環境でも共有する拡張のため、履歴を戻しても削除しない。
    pass
