"""問い合わせ・手動ナレッジと原子的な業務履歴を追加。"""

from alembic import op

revision = "0004_business"
down_revision = "0003_account_auth"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE SEQUENCE ticket_number_seq
    """)
    op.execute("""
        CREATE SEQUENCE knowledge_number_seq
    """)
    op.execute("""
        CREATE TABLE idempotency_records (
        id UUID NOT NULL,
        user_id UUID NOT NULL,
        method VARCHAR(8) NOT NULL,
        path VARCHAR(200) NOT NULL,
        key VARCHAR(100) NOT NULL,
        request_hash VARCHAR(64) NOT NULL,
        response_status INTEGER NOT NULL,
        response_body JSONB NOT NULL,
        entity_id UUID NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_idempotency_request UNIQUE (user_id, method, path, key),
        FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE RESTRICT
        )
    """)
    op.execute("""
        CREATE TABLE knowledge_documents (
        id UUID NOT NULL,
        number VARCHAR(32) NOT NULL,
        published_version_id UUID,
        row_version INTEGER NOT NULL,
        created_by UUID NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT ck_document_row_version CHECK (row_version >= 1),
        UNIQUE (number),
        FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE RESTRICT
        )
    """)
    op.execute("""
        CREATE TABLE tickets (
        id UUID NOT NULL,
        number VARCHAR(32) NOT NULL,
        requester_id UUID NOT NULL,
        assignee_id UUID,
        department_id UUID,
        title VARCHAR(120) NOT NULL,
        body TEXT NOT NULL,
        status VARCHAR(16) NOT NULL,
        resolution TEXT,
        resolved_at TIMESTAMP WITH TIME ZONE,
        version INTEGER NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT ck_tickets_version CHECK (version >= 1),
        CONSTRAINT ck_tickets_title CHECK (length(btrim(title)) BETWEEN 1 AND 120),
        CONSTRAINT ck_tickets_body CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
        CONSTRAINT ck_tickets_state CHECK ((status = 'open' AND resolution IS NULL AND
        resolved_at IS NULL AND (department_id IS NOT NULL OR assignee_id IS NULL)) OR (status
        = 'in_progress' AND department_id IS NOT NULL AND assignee_id IS NOT NULL AND
        resolution IS NULL AND resolved_at IS NULL) OR (status = 'resolved' AND department_id
        IS NOT NULL AND assignee_id IS NOT NULL AND resolution IS NOT NULL AND
        length(btrim(resolution)) BETWEEN 1 AND 5000 AND resolved_at IS NOT NULL)),
        UNIQUE (number),
        FOREIGN KEY(requester_id) REFERENCES users (id) ON DELETE RESTRICT,
        FOREIGN KEY(assignee_id) REFERENCES users (id) ON DELETE RESTRICT,
        FOREIGN KEY(department_id) REFERENCES departments (id) ON DELETE RESTRICT
        )
    """)
    op.execute("""
        CREATE INDEX ix_tickets_assignee_id ON tickets (assignee_id)
    """)
    op.execute("""
        CREATE INDEX ix_tickets_requester_id ON tickets (requester_id)
    """)
    op.execute("""
        CREATE INDEX ix_tickets_updated_at ON tickets (updated_at)
    """)
    op.execute("""
        CREATE TABLE knowledge_versions (
        id UUID NOT NULL,
        document_id UUID NOT NULL,
        version_no INTEGER NOT NULL,
        base_version_id UUID,
        status VARCHAR(16) NOT NULL,
        title VARCHAR(120) NOT NULL,
        audience VARCHAR(300) NOT NULL,
        body TEXT NOT NULL,
        department_id UUID,
        created_by UUID NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
        reviewed_by UUID,
        reviewed_at TIMESTAMP WITH TIME ZONE,
        row_version INTEGER NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_knowledge_version_no UNIQUE (document_id, version_no),
        CONSTRAINT uq_knowledge_version_owner UNIQUE (document_id, id),
        CONSTRAINT fk_knowledge_base FOREIGN KEY(document_id, base_version_id) REFERENCES
        knowledge_versions (document_id, id) ON DELETE RESTRICT,
        CONSTRAINT ck_knowledge_versions CHECK (version_no >= 1 AND row_version >= 1),
        CONSTRAINT ck_knowledge_title CHECK (length(btrim(title)) BETWEEN 1 AND 120),
        CONSTRAINT ck_knowledge_audience CHECK (length(btrim(audience)) BETWEEN 1 AND 300),
        CONSTRAINT ck_knowledge_body CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
        CONSTRAINT ck_knowledge_state CHECK ((status = 'draft' AND reviewed_by IS NULL AND
        reviewed_at IS NULL) OR (status = 'approved' AND reviewed_by IS NOT NULL AND
        reviewed_at IS NOT NULL AND department_id IS NOT NULL) OR (status = 'rejected' AND
        reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
        FOREIGN KEY(document_id) REFERENCES knowledge_documents (id) ON DELETE RESTRICT,
        FOREIGN KEY(department_id) REFERENCES departments (id) ON DELETE RESTRICT,
        FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE RESTRICT,
        FOREIGN KEY(reviewed_by) REFERENCES users (id) ON DELETE RESTRICT
        )
    """)
    op.execute("""
        CREATE INDEX ix_knowledge_versions_updated_at ON knowledge_versions (updated_at)
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_document_draft ON knowledge_versions (document_id) WHERE status
        = 'draft'
    """)
    op.execute("""
        CREATE TABLE ticket_events (
        id UUID NOT NULL,
        ticket_id UUID NOT NULL,
        ticket_version INTEGER NOT NULL,
        actor_id UUID NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_ticket_event_version UNIQUE (ticket_id, ticket_version),
        CONSTRAINT ck_ticket_event_version CHECK (ticket_version >= 1),
        CONSTRAINT ck_ticket_event_type CHECK (event_type IN
        ('created','body_updated','assignment_changed','started','resolved','reopened')),
        FOREIGN KEY(ticket_id) REFERENCES tickets (id) ON DELETE RESTRICT,
        FOREIGN KEY(actor_id) REFERENCES users (id) ON DELETE RESTRICT
        )
    """)
    op.execute("""
        CREATE TABLE knowledge_events (
        id UUID NOT NULL,
        knowledge_version_id UUID NOT NULL,
        row_version INTEGER NOT NULL,
        actor_id UUID NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        reason TEXT,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_knowledge_event_version UNIQUE (knowledge_version_id, row_version),
        CONSTRAINT ck_knowledge_event_version CHECK (row_version >= 1),
        CONSTRAINT ck_knowledge_event_type CHECK (event_type IN
        ('draft_created','saved','sources_refreshed','approved','rejected')),
        CONSTRAINT ck_knowledge_event_reason CHECK ((event_type = 'rejected' AND reason IS NOT
        NULL AND length(btrim(reason)) BETWEEN 1 AND 1000) OR (event_type <> 'rejected' AND
        reason IS NULL)),
        FOREIGN KEY(knowledge_version_id) REFERENCES knowledge_versions (id) ON DELETE
        RESTRICT,
        FOREIGN KEY(actor_id) REFERENCES users (id) ON DELETE RESTRICT
        )
    """)
    op.execute("""
        CREATE TABLE knowledge_sources (
        id UUID NOT NULL,
        knowledge_version_id UUID NOT NULL,
        ticket_id UUID NOT NULL,
        ticket_version INTEGER NOT NULL,
        evidence_snapshot JSONB NOT NULL,
        content_hash VARCHAR(64) NOT NULL,
        captured_at TIMESTAMP WITH TIME ZONE NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_knowledge_source UNIQUE (knowledge_version_id, ticket_id),
        CONSTRAINT ck_source_version CHECK (ticket_version >= 1),
        FOREIGN KEY(knowledge_version_id) REFERENCES knowledge_versions (id) ON DELETE
        RESTRICT,
        FOREIGN KEY(ticket_id) REFERENCES tickets (id) ON DELETE RESTRICT
        )
    """)
    op.execute("""
        ALTER TABLE knowledge_documents ADD CONSTRAINT fk_document_published FOREIGN KEY(id,
        published_version_id) REFERENCES knowledge_versions (document_id, id) ON DELETE
        RESTRICT
    """)


def downgrade() -> None:
    raise RuntimeError("業務資料を削除する逆行は許可していません。")
