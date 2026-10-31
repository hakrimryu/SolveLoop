import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class DemoError(ValueError):
    pass


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class DepartmentInput(Input):
    id: str
    code: Literal["IT", "HR", "GENERAL", "ACCOUNTING"]
    name: str = Field(min_length=1, max_length=100)


class UserInput(Input):
    id: str
    login_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    display_name: str = Field(min_length=1, max_length=100)
    role: Literal["employee", "operator"]
    department_code: str
    can_manage_accounts: bool


class Company(Input):
    synthetic: Literal[True]
    name: Literal["株式会社 柳"]
    departments: list[DepartmentInput]
    users: list[UserInput]


class TicketInput(Input):
    id: str
    number: str
    requester_id: str
    assignee_id: str | None
    department_code: str | None
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=5000)
    status: Literal["open", "in_progress", "resolved"]
    resolution: str | None = Field(max_length=5000)
    created_days_ago: int = Field(ge=1, le=89)


class Tickets(Input):
    synthetic: Literal[True]
    tickets: list[TicketInput]


class DocumentInput(Input):
    id: str
    version_id: str
    number: str
    title: str = Field(min_length=1, max_length=120)
    audience: str = Field(min_length=1, max_length=300)
    department_code: str
    body_file: str
    created_days_ago: int = Field(ge=1, le=89)
    approved_days_ago: int = Field(ge=1, le=89)


class Catalog(Input):
    synthetic: Literal[True]
    documents: list[DocumentInput]


class Scenario(Input):
    name: str
    ticket_ids: list[str]
    source_ticket_ids: list[str]
    observation: str


class Scenarios(Input):
    synthetic: Literal[True]
    scope: Literal["demo_not_evaluation"]
    scenarios: list[Scenario]


class Manifest(Input):
    schema_version: Literal[1]
    seed_version: str = Field(min_length=1, max_length=100)
    random_seed: int
    as_of: str
    synthetic: Literal[True]
    files: dict[str, str]


def require(condition, message):
    if not condition:
        raise DemoError(message)


def unique(values):
    values = list(values)
    require(len(set(values)) == len(values), "ID・番号・ログインIDの重複があります。")


def read_json(raw):
    def pairs(items):
        unique(key for key, _ in items)
        return dict(items)

    return json.loads(raw, object_pairs_hook=pairs)


class Dataset:
    def __init__(self, root: Path):
        try:
            raw = (root / "manifest.json").read_bytes()
            self.manifest_hash = hashlib.sha256(raw).hexdigest()
            self.manifest = Manifest.model_validate(read_json(raw))
            self.as_of = datetime.fromisoformat(self.manifest.as_of)
            require(self.as_of.utcoffset() is not None, "基準時刻のタイムゾーンが必要です。")
            self.files = {}
            for name, expected in self.manifest.files.items():
                path = (root / name).resolve()
                require(
                    path.is_relative_to(root.resolve()) and path != root.resolve(),
                    "入力ファイルの場所が不正です。",
                )
                value = path.read_bytes()
                require(hashlib.sha256(value).hexdigest() == expected, "ファイルhashが不一致です。")
                self.files[name] = value.decode("utf-8")
            self.company = Company.model_validate(read_json(self.files["company/company.json"]))
            self.tickets = Tickets.model_validate(
                read_json(self.files["tickets/tickets.json"])
            ).tickets
            self.documents = Catalog.model_validate(
                read_json(self.files["knowledge/catalog.json"])
            ).documents
            self.scenarios = Scenarios.model_validate(
                read_json(self.files["scenarios/scenarios.json"])
            ).scenarios
            self.validate()
        except (OSError, KeyError, ValidationError, UnicodeError, json.JSONDecodeError) as error:
            raise DemoError("合成入力の形式・必須ファイルを確認してください。") from error

    def at(self, days):
        return self.as_of - timedelta(days=days)

    def validate(self):
        departments, users = self.company.departments, self.company.users
        require(
            (len(departments), len(users), len(self.tickets), len(self.documents))
            == (4, 15, 100, 15),
            "資料数は4部署・15人・100件・15文書である必要があります。",
        )
        unique(d.code for d in departments)
        unique(u.login_id for u in users)
        unique(t.number for t in self.tickets)
        unique(t.body for t in self.tickets)
        unique(d.number for d in self.documents)
        ids = [x.id for x in [*departments, *users, *self.tickets, *self.documents]]
        ids += [d.version_id for d in self.documents]
        unique(ids)
        require(all(str(UUID(i)) == i for i in ids), "UUIDは正規表記にしてください。")
        require(
            {t.number for t in self.tickets} == {f"REQ-{i:04d}" for i in range(1, 101)}
            and {d.number for d in self.documents} == {f"KB-{i:04d}" for i in range(1, 16)},
            "表示番号が連続していません。",
        )
        dept_codes = {d.code for d in departments}
        user_map = {u.id: u for u in users}
        for user in users:
            require(user.department_code in dept_codes, "社員の所属部署が不正です。")
        require(
            {u.login_id for u in users if u.can_manage_accounts} == {"operator"}
            and next(u for u in users if u.login_id == "operator").role == "operator"
            and {u.login_id for u in users} >= {"employee", "operator"},
            "初期の管理権限・最小アカウントが不正です。",
        )
        resolved = 0
        for ticket in self.tickets:
            require(ticket.requester_id in user_map, "問い合わせの依頼者が不明です。")
            require(ticket.department_code in dept_codes | {None}, "担当部署が不明です。")
            if ticket.assignee_id:
                require(
                    ticket.assignee_id in user_map
                    and user_map[ticket.assignee_id].role == "operator"
                    and ticket.department_code is not None,
                    "有効な担当者・部署が必要です。",
                )
            if ticket.status != "open":
                require(ticket.assignee_id is not None, "対応中・解決には担当者が必要です。")
            if ticket.status == "resolved":
                resolved += 1
                require(
                    bool(ticket.resolution and ticket.resolution.strip()), "解決内容が必要です。"
                )
            else:
                require(ticket.resolution is None, "未解決の問い合わせに解決内容は設定できません。")
            require(ticket.title.strip() and ticket.body.strip(), "空白だけの本文は使えません。")
        require(resolved >= 30, "30件以上の解決記録が必要です。")
        for doc in self.documents:
            require(doc.department_code in dept_codes, "文書の担当部署が不明です。")
            require(doc.created_days_ago > doc.approved_days_ago, "文書の時系列が不正です。")
            body = self.files[doc.body_file]
            require(1 <= len(body.strip()) <= 20000, "文書本文の長さが不正です。")
            require("架空企業・デモデータ" in body, "文書に合成資料表示が必要です。")
            for section in (
                "適用対象",
                "目的・症状",
                "手順",
                "例外・注意",
                "問い合わせ先",
                "改定日",
            ):
                require(section in body, "マニュアルの必須項目が不足しています。")
        expected = {
            "company/company.json",
            "tickets/tickets.json",
            "knowledge/catalog.json",
            "scenarios/scenarios.json",
            *(d.body_file for d in self.documents),
        }
        require(set(self.files) == expected, "manifestのファイル集合が不正です。")
        unique(s.name for s in self.scenarios)
        require(
            {s.name for s in self.scenarios}
            == {"knowledge-gap", "covered-repeat", "lookalike", "insufficient-evidence"},
            "シナリオが不足しています。",
        )
        ticket_map = {t.id: t for t in self.tickets}
        for scenario in self.scenarios:
            unique(scenario.ticket_ids)
            unique(scenario.source_ticket_ids)
            require(
                set(scenario.ticket_ids) <= ticket_map.keys(), "シナリオの問い合わせが不明です。"
            )
            require(
                set(scenario.source_ticket_ids) <= set(scenario.ticket_ids), "根拠集合が不正です。"
            )
            require(
                all(ticket_map[i].status == "resolved" for i in scenario.source_ticket_ids),
                "シナリオ根拠は解決済みである必要があります。",
            )
        gap = next(s for s in self.scenarios if s.name == "knowledge-gap")
        require(
            len(gap.ticket_ids) == 8
            and len(gap.source_ticket_ids) == 3
            and len({ticket_map[i].assignee_id for i in gap.source_ticket_ids}) == 3,
            "MFA8件・解決担当者3名が必要です。",
        )
        insufficient = next(s for s in self.scenarios if s.name == "insufficient-evidence")
        require(
            not insufficient.source_ticket_ids
            and all(ticket_map[i].status != "resolved" for i in insufficient.ticket_ids),
            "根拠不足シナリオに解決記録は設定できません。",
        )

    def summary(self):
        return {
            "synthetic": True,
            "seed_version": self.manifest.seed_version,
            "manifest_hash": self.manifest_hash,
            "as_of": self.manifest.as_of,
            "users": len(self.company.users),
            "tickets": len(self.tickets),
            "resolved": sum(t.status == "resolved" for t in self.tickets),
            "initial_approved_documents": len(self.documents),
        }
