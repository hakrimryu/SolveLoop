"""業務資料を保ち、ナレッジの検索準備と固定次元ベクトルを追加。"""

from alembic import op

revision = "0005_knowledge_search"
down_revision = "0004_business"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE embedding_profiles (
            id VARCHAR(64) PRIMARY KEY,
            specification JSONB NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT ck_embedding_profile_id CHECK (length(id) = 64)
        )
    """)
    op.execute("""
        CREATE TABLE knowledge_search_state (
            id INTEGER PRIMARY KEY,
            active_profile_id VARCHAR(64) REFERENCES embedding_profiles(id) ON DELETE RESTRICT,
            revision INTEGER NOT NULL,
            CONSTRAINT ck_knowledge_search_singleton CHECK (id = 1 AND revision >= 1)
        )
    """)
    op.execute("INSERT INTO knowledge_search_state VALUES (1, NULL, 1)")
    op.execute("""
        CREATE TABLE knowledge_preparations (
            id UUID PRIMARY KEY,
            version_id UUID NOT NULL REFERENCES knowledge_versions(id) ON DELETE RESTRICT,
            profile_id VARCHAR(64) NOT NULL REFERENCES embedding_profiles(id) ON DELETE RESTRICT,
            source_row_version INTEGER NOT NULL,
            document_row_version INTEGER NOT NULL,
            state_revision INTEGER NOT NULL,
            indexed_row_version INTEGER,
            content_hash VARCHAR(64) NOT NULL,
            sources_hash VARCHAR(64) NOT NULL,
            chunk_count INTEGER NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT uq_preparation_version_profile UNIQUE (version_id, profile_id),
            CONSTRAINT ck_preparation_versions CHECK (
                source_row_version >= 1 AND document_row_version >= 1 AND state_revision >= 1
                AND chunk_count >= 1 AND
                (indexed_row_version IS NULL OR indexed_row_version >= source_row_version)
            )
        )
    """)
    op.execute("""
        CREATE TABLE knowledge_chunks (
            id UUID PRIMARY KEY,
            preparation_id UUID NOT NULL REFERENCES knowledge_preparations(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            body_start INTEGER NOT NULL,
            body_end INTEGER NOT NULL,
            line_start INTEGER NOT NULL,
            line_end INTEGER NOT NULL,
            text TEXT NOT NULL,
            context TEXT NOT NULL,
            content_hash VARCHAR(64) NOT NULL,
            input_tokens INTEGER NOT NULL,
            embedding VECTOR(768) NOT NULL,
            CONSTRAINT uq_chunk_ordinal UNIQUE (preparation_id, ordinal),
            CONSTRAINT ck_chunk_position CHECK (
                ordinal >= 0 AND body_start >= 0 AND body_end > body_start
                AND body_end - body_start = length(text) AND line_start >= 1
                AND line_end >= line_start AND input_tokens BETWEEN 1 AND 8192
            ),
            CONSTRAINT ck_chunk_normalized CHECK (
                vector_norm(embedding) BETWEEN 0.9999 AND 1.0001
            )
        )
    """)


def downgrade() -> None:
    raise RuntimeError("検索資料を削除する逆行は許可していません。")
