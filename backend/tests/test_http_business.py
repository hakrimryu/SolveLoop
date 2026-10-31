import json
import os
from contextlib import suppress
from http.cookiejar import CookieJar
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import HTTPCookieProcessor, Request, build_opener
from uuid import UUID, uuid4

import pytest
from search_fixtures import initialize_search, prepare_fixture
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.auth import password_hasher
from app.config import load_settings
from app.database import build_engine
from app.models import (
    AuditEvent,
    AuthSession,
    IdempotencyRecord,
    KnowledgeDocument,
    KnowledgeEvent,
    KnowledgePreparation,
    KnowledgeSource,
    KnowledgeVersion,
    Ticket,
    TicketEvent,
    User,
)
from app.seed import DEMO_PASSWORD

# 起動済みの検証APIと専用DBを明示した場合だけ、実HTTPで業務を変更する。
# [ko] 실행 중인 검증 API와 전용 DB를 명시한 경우에만 실제 HTTP로 업무 자료를 변경한다.
# [en] Allow real HTTP business writes only when a running test API and dedicated DB are specified.
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.getenv("AUTH_TEST_BASE_URL") or os.getenv("RUN_DB_TESTS") != "1",
        reason="起動済みの専用APIと専用DBでのみ実行します。",
    ),
]


class Client:
    def __init__(self):
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()))
        self.csrf = ""
        self.timeout = 10

    def call(self, path, body=None, method=None, key=None):
        headers = {"Origin": "http://127.0.0.1:8000", "X-CSRF-Token": self.csrf}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if key:
            headers["Idempotency-Key"] = key
        request = Request(
            os.environ["AUTH_TEST_BASE_URL"] + "/api/v1" + quote(path, safe="/?&=%+"),
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers,
            method=method,
        )
        try:
            response = self.opener.open(request, timeout=self.timeout)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read()
            value = json.loads(raw) if raw else None
            assert response.headers["Cache-Control"] == "no-store"
            UUID(response.headers["X-Request-ID"])
            if response.status >= 400:
                assert value["request_id"] == response.headers["X-Request-ID"]
            return response.status, value

    def login(self, login_id):
        status, data = self.call("/auth/login", {"login_id": login_id, "password": DEMO_PASSWORD})
        assert status == 200
        self.csrf = data["csrf_token"]

    def ok(self, path, body=None, method=None, status=200, key=None):
        actual, value = self.call(path, body, method, key)
        assert actual == status, value
        return value


def test_running_manual_business_flow():
    settings = load_settings()
    assert settings.postgres_db == "solveloop_test"
    engine = build_engine(settings)
    ids = [uuid4() for _ in range(3)]
    logins = ["business-http-" + value.hex for value in ids]
    docs, tickets = [], []
    clients = [Client() for _ in ids]
    with Session(engine) as session, session.begin():
        initialize_search(session)
        for user_id, login_id, role, manager in zip(
            ids, logins, ["employee", "operator", "employee"], [False, False, True], strict=True
        ):
            session.add(
                User(
                    id=user_id,
                    login_id=login_id,
                    display_name="実HTTP業務検証専用",
                    password_hash=password_hasher.hash(DEMO_PASSWORD),
                    role=role,
                    department_id=UUID(int=101),
                    active=True,
                    can_manage_accounts=manager,
                )
            )
    try:
        for client, login_id in zip(clients, logins, strict=True):
            client.login(login_id)
        emp, op, manager = clients
        key = str(uuid4())
        data = dict(
            title="実HTTP VPN端末変更", body="変更後の認証を確認したい。", department_id=None
        )
        ticket = emp.ok("/tickets", data, status=201, key=key)
        tickets.append(UUID(ticket["id"]))
        assert emp.ok("/tickets", data, status=201, key=key) == ticket
        path = "/tickets/" + ticket["id"]
        assert manager.call(path)[0] == 404
        assert emp.call(path + "/transition", {"action": "start", "expected_version": 1})[0] == 403
        ticket = op.ok(
            path + "/assignment",
            dict(department_id=str(UUID(int=101)), assignee_id=str(ids[1]), expected_version=1),
        )
        ticket = op.ok(
            path + "/transition", dict(action="start", expected_version=ticket["version"])
        )
        assert (
            op.call(
                path + "/transition",
                dict(action="resolve", resolution=" ", expected_version=ticket["version"]),
            )[0]
            == 422
        )
        ticket = op.ok(
            path + "/transition",
            dict(
                action="resolve",
                resolution="端末登録を更新して確認。",
                expected_version=ticket["version"],
            ),
        )
        version = op.ok(
            "/knowledge/drafts",
            dict(
                title="実HTTP VPN端末変更の手順",
                audience="全社員",
                body="端末登録を確認して更新します。",
                department_id=str(UUID(int=101)),
                source_refs=[
                    dict(ticket_id=ticket["id"], expected_ticket_version=ticket["version"])
                ],
            ),
            status=201,
            key=str(uuid4()),
        )
        docs.append(UUID(version["document_id"]))
        knowledge_path = "/knowledge/" + version["document_id"]
        assert emp.call(knowledge_path)[0] == 404
        assert emp.call(knowledge_path + "/versions/1")[0] == 403

        def review(version, operation="approve"):
            if operation == "approve":
                with Session(engine) as session, session.begin():
                    prepare_fixture(session, version)
            return op.ok(
                knowledge_path + f"/versions/{version['version_no']}/" + operation,
                dict(
                    expected_version=version["row_version"],
                    expected_document_version=version["document_row_version"],
                    **({"reason": "注意事項を追記"} if operation == "reject" else {}),
                ),
            )

        version = review(version)
        public = emp.ok(knowledge_path)
        assert "sources" not in public and public["version_no"] == 1
        assert emp.ok("/knowledge?q=VPN+端末")["filtered_count"] >= 1
        revision = op.ok(
            knowledge_path + "/drafts",
            dict(base_version_no=1, expected_document_version=version["document_row_version"]),
            status=201,
            key=str(uuid4()),
        )
        assert emp.ok(knowledge_path) == public
        revision = review(revision, "reject")
        next_version = op.ok(
            knowledge_path + "/drafts",
            dict(base_version_no=2, expected_document_version=revision["document_row_version"]),
            status=201,
            key=str(uuid4()),
        )
        assert next_version["version_no"] == 3
        ticket = op.ok(
            path + "/transition", dict(action="reopen", expected_version=ticket["version"])
        )
        assert (
            op.call(
                knowledge_path + "/versions/3/approve",
                dict(
                    expected_version=1,
                    expected_document_version=next_version["document_row_version"],
                ),
            )[1]["code"]
            == "SOURCE_CHANGED"
        )
        ticket = op.ok(
            path + "/transition",
            dict(
                action="resolve",
                resolution="注意事項を含む再確認済みの手順。",
                expected_version=ticket["version"],
            ),
        )
        next_version = op.ok(
            knowledge_path + "/versions/3",
            dict(
                expected_version=1,
                body="注意事項を含む手順を確認します。",
                source_refs=[
                    dict(ticket_id=ticket["id"], expected_ticket_version=ticket["version"])
                ],
            ),
            method="PATCH",
        )
        next_version = review(next_version)
        assert emp.ok(knowledge_path)["version_no"] == 3
        assert op.ok("/dashboard")["counts"]["resolved"] >= 1
        for user_id in ids[:2]:
            manager.ok(f"/accounts/{user_id}/deactivate", {"expected_version": 1})
        assert emp.call("/tickets")[0] == op.call("/knowledge")[0] == 401
        manager.ok(f"/accounts/{ids[0]}/reactivate", {"expected_version": 2})
        assert emp.call("/tickets")[0] == 401
        emp.login(logins[0])
        assert emp.ok(path)["events"][-1]["actor"]["id"] == str(ids[1])
        assert emp.ok(knowledge_path)["version_no"] == 3
    finally:
        for client in clients:
            with suppress(Exception):
                client.call("/auth/logout", {})
        with Session(engine) as session, session.begin():
            versions = select(KnowledgeVersion.id).where(KnowledgeVersion.document_id.in_(docs))
            session.execute(
                delete(KnowledgePreparation).where(KnowledgePreparation.version_id.in_(versions))
            )
            session.execute(delete(IdempotencyRecord).where(IdempotencyRecord.user_id.in_(ids)))
            session.execute(
                update(KnowledgeDocument)
                .where(KnowledgeDocument.id.in_(docs))
                .values(published_version_id=None)
            )
            session.execute(
                delete(KnowledgeEvent).where(KnowledgeEvent.knowledge_version_id.in_(versions))
            )
            session.execute(
                delete(KnowledgeSource).where(KnowledgeSource.knowledge_version_id.in_(versions))
            )
            session.execute(delete(KnowledgeVersion).where(KnowledgeVersion.document_id.in_(docs)))
            session.execute(delete(KnowledgeDocument).where(KnowledgeDocument.id.in_(docs)))
            session.execute(delete(TicketEvent).where(TicketEvent.ticket_id.in_(tickets)))
            session.execute(delete(Ticket).where(Ticket.id.in_(tickets)))
            session.execute(delete(AuditEvent).where(AuditEvent.target_user_id.in_(ids)))
            session.execute(delete(AuthSession).where(AuthSession.user_id.in_(ids)))
            session.execute(delete(User).where(User.id.in_(ids)))
        engine.dispose()
