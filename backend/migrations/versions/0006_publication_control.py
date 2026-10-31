"""文書と検索資料を保ち、公開停止と再公開を追加。"""

from alembic import op

revision = "0006_publication_control"
down_revision = "0005_knowledge_search"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE knowledge_documents ADD COLUMN "
        "publication_suspended BOOLEAN NOT NULL DEFAULT false"
    )
    op.execute("ALTER TABLE knowledge_events DROP CONSTRAINT ck_knowledge_event_type")
    op.execute("""ALTER TABLE knowledge_events ADD CONSTRAINT ck_knowledge_event_type CHECK (
        event_type IN ('draft_created','saved','sources_refreshed','approved','rejected',
        'publication_stopped','publication_resumed'))""")


def downgrade() -> None:
    raise RuntimeError("公開停止の履歴を失わないため、自動ダウングレードは提供しません。")
