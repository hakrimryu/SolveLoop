import argparse
import re
import secrets
import unicodedata
from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import Integer, and_, delete, func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, aliased

from app.auth import (
    COOKIE_NAME,
    Authenticated,
    DbSession,
    DepartmentRef,
    UserRef,
    clear_session_cookie,
    get_auth,
    lock_users,
    password_hasher,
    password_matches,
    require_account_manager,
    require_csrf,
    require_full_auth,
    require_json,
)
from app.config import load_settings
from app.database import build_engine
from app.errors import ApiError
from app.models import AuditEvent, AuthSession, Department, User

router = APIRouter(prefix="/api/v1/accounts", tags=["アカウント管理"])
Manager = Annotated[User, Depends(require_account_manager)]


class CreateAccountInput(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    display_name: str
    login_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9._-]+$")
    department_id: UUID
    role: Literal["employee", "operator"]

    @field_validator("display_name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        if any(unicodedata.category(char) == "Cc" or char in "\u2028\u2029" for char in value):
            raise ValueError("名前に制御文字は使用できません。")
        value = value.strip()
        value.encode("utf-8")
        if not 1 <= len(value) <= 100:
            raise ValueError("名前は1〜100文字で入力してください。")
        return value


class VersionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    expected_version: int = Field(strict=True, ge=1)


class EventQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=100)


class Account(BaseModel):
    id: UUID
    display_name: str
    login_id: str
    department: DepartmentRef | None
    role: Literal["employee", "operator"]
    active: bool
    can_manage_accounts: bool
    must_change_password: bool
    row_version: int = Field(ge=1)


class AccountList(BaseModel):
    items: list[Account]
    total: int = Field(ge=0)


class IssuedPassword(BaseModel):
    account: Account
    temporary_password: str = Field(repr=False)


class AccountEvent(BaseModel):
    id: UUID
    actor: UserRef | None
    target_user_id: UUID
    action: Literal[
        "create", "deactivate", "reactivate", "reissue", "password_change", "management_granted"
    ]
    occurred_at: datetime
    request_id: UUID


class AccountEventList(BaseModel):
    items: list[AccountEvent]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    page_count: int = Field(ge=1)
    total: int = Field(ge=0)


def no_query(request: Request) -> None:
    if request.query_params:
        raise ApiError(422, "VALIDATION_ERROR", "この操作に検索条件は指定できません。")


async def no_body(request: Request) -> None:
    if await request.body():
        raise ApiError(422, "VALIDATION_ERROR", "この参照操作に本文は指定できません。")


def account_snapshot(user: User, department: Department | None) -> Account:
    return Account(
        id=user.id,
        display_name=user.display_name,
        login_id=user.login_id,
        department=DepartmentRef.model_validate(department) if department else None,
        role=user.role,
        active=user.active,
        can_manage_accounts=user.can_manage_accounts,
        must_change_password=user.must_change_password,
        row_version=user.row_version,
    )


def management_write_auth(
    request: Request,
    session: Session,
    auth: tuple[AuthSession, User],
    target_id: UUID | None = None,
) -> tuple[User, dict[UUID, User]]:
    require_csrf(request, auth, request.headers.get("X-CSRF-Token"))
    require_account_manager(require_full_auth(auth))
    # 本人用依存性で先にactorだけをロックせず、対象を含む全UUIDを最初から並べる。
    users = lock_users(session, {auth[1].id} | ({target_id} if target_id is not None else set()))
    current = get_auth(session, request.cookies.get(COOKIE_NAME))
    require_csrf(request, current, request.headers.get("X-CSRF-Token"))
    return require_account_manager(require_full_auth(current)), users


def temporary_password(encoded: str | None = None) -> str:
    while True:
        value = secrets.token_urlsafe(32)
        if encoded is None or not password_matches(encoded, value):
            return value


def record_event(
    session: Session, request: Request, actor: User, target: User, action: str
) -> None:
    session.add(
        AuditEvent(
            actor_id=actor.id,
            target_user_id=target.id,
            action=action,
            occurred_at=datetime.now(UTC),
            request_id=request.state.request_id,
            target_version=target.row_version,
        )
    )


@router.get(
    "", summary="管理用アカウント一覧を取得", dependencies=[Depends(no_query), Depends(no_body)]
)
def list_accounts(manager: Manager, session: DbSession) -> AccountList:
    items = [
        account_snapshot(user, department)
        for user, department in session.execute(
            select(User, Department)
            .outerjoin(Department, Department.id == User.department_id)
            .order_by(User.login_id, User.id)
        )
    ]
    return AccountList(items=items, total=len(items))


@router.post(
    "",
    summary="アカウントと仮パスワードを発行",
    status_code=201,
    dependencies=[Depends(require_json), Depends(no_query)],
)
def create_account(
    data: CreateAccountInput, request: Request, auth: Authenticated, session: DbSession
) -> IssuedPassword:
    actor, _ = management_write_auth(request, session, auth)
    department = session.scalar(
        select(Department).where(Department.id == data.department_id).with_for_update(read=True)
    )
    if department is None or not department.active:
        raise ApiError(422, "VALIDATION_ERROR", "有効な所属部署を指定してください。")
    password = temporary_password()
    user = User(
        id=uuid4(),
        display_name=data.display_name,
        login_id=data.login_id,
        department_id=department.id,
        role=data.role,
        active=True,
        password_hash=password_hasher.hash(password),
        can_manage_accounts=False,
        must_change_password=True,
        row_version=1,
    )
    session.add(user)
    try:
        session.flush()
        record_event(session, request, actor, user, "create")
        session.flush()
        result = IssuedPassword(
            account=account_snapshot(user, department), temporary_password=password
        )
        session.commit()
    except IntegrityError as error:
        session.rollback()
        if (
            getattr(error.orig, "sqlstate", None) == "23505"
            and getattr(getattr(error.orig, "diag", None), "constraint_name", None)
            == "users_login_id_key"
        ):
            raise ApiError(
                409, "LOGIN_ID_TAKEN", "このログインIDは既に使用されています。"
            ) from None
        raise
    return result


def change_account(
    action: Literal["deactivate", "reactivate", "reissue"],
    account_id: UUID,
    data: VersionInput,
    request: Request,
    response: Response,
    auth: tuple[AuthSession, User],
    session: Session,
) -> Account | IssuedPassword:
    actor, users = management_write_auth(request, session, auth, account_id)
    user = users.get(account_id)
    if user is None:
        raise ApiError(404, "NOT_FOUND", "指定されたアカウントが見つかりません。")
    if user.row_version != data.expected_version:
        raise ApiError(409, "VERSION_CONFLICT", "最新の一覧と履歴を確認してから操作してください。")
    password = None
    if action == "deactivate":
        if user.id == actor.id:
            raise ApiError(
                409, "SELF_DEACTIVATION_FORBIDDEN", "自分のアカウントは無効化できません。"
            )
        if not user.active:
            raise ApiError(409, "INVALID_STATE", "このアカウントは既に無効です。")
        user.active = False
    elif action == "reactivate":
        if user.active:
            raise ApiError(409, "INVALID_STATE", "このアカウントは既に有効です。")
        user.active = True
    else:
        if not user.active:
            raise ApiError(409, "ACCOUNT_INACTIVE", "有効なアカウントにのみ再発行できます。")
        password = temporary_password(user.password_hash)
        user.password_hash = password_hasher.hash(password)
        user.must_change_password = True
    user.row_version += 1
    if action != "reactivate":
        session.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    record_event(session, request, actor, user, action)
    session.flush()
    account = account_snapshot(
        user, session.get(Department, user.department_id) if user.department_id else None
    )
    result = (
        IssuedPassword(account=account, temporary_password=password)
        if password is not None
        else account
    )
    clear_cookie = action == "reissue" and actor.id == user.id
    session.commit()
    if clear_cookie:
        clear_session_cookie(request, response)
    return result


@router.post(
    "/{account_id}/deactivate",
    summary="アカウントを無効化",
    response_model=Account,
    dependencies=[Depends(require_json), Depends(no_query)],
)
def deactivate(
    account_id: UUID,
    data: VersionInput,
    request: Request,
    response: Response,
    auth: Authenticated,
    session: DbSession,
):
    return change_account("deactivate", account_id, data, request, response, auth, session)


@router.post(
    "/{account_id}/reactivate",
    summary="アカウントを再有効化",
    response_model=Account,
    dependencies=[Depends(require_json), Depends(no_query)],
)
def reactivate(
    account_id: UUID,
    data: VersionInput,
    request: Request,
    response: Response,
    auth: Authenticated,
    session: DbSession,
):
    return change_account("reactivate", account_id, data, request, response, auth, session)


@router.post(
    "/{account_id}/temporary-password",
    summary="仮パスワードを再発行",
    response_model=IssuedPassword,
    dependencies=[Depends(require_json), Depends(no_query)],
)
def reissue(
    account_id: UUID,
    data: VersionInput,
    request: Request,
    response: Response,
    auth: Authenticated,
    session: DbSession,
):
    return change_account("reissue", account_id, data, request, response, auth, session)


@router.get(
    "/{account_id}/events", summary="アカウントの変更履歴を取得", dependencies=[Depends(no_body)]
)
def account_events(
    account_id: UUID, query: Annotated[EventQuery, Query()], manager: Manager, session: DbSession
) -> AccountEventList:
    if session.get(User, account_id) is None:
        raise ApiError(404, "NOT_FOUND", "指定されたアカウントが見つかりません。")
    ranked = (
        select(
            AuditEvent,
            func.row_number()
            .over(order_by=(AuditEvent.occurred_at.desc(), AuditEvent.id.desc()))
            .label("position"),
        )
        .where(AuditEvent.target_user_id == account_id)
        .cte("ranked_events")
    )
    counts = select(func.count().label("total")).select_from(ranked).cte("event_count")
    page_count = func.greatest(1, (counts.c.total + query.page_size - 1) // query.page_size)
    meta = select(
        counts.c.total,
        page_count.label("page_count"),
        func.least(query.page, page_count).cast(Integer).label("page"),
    ).cte("page_meta")
    entry = aliased(AuditEvent, ranked)
    actor = aliased(User)
    # 0件・最終ページ補正も含め、件数と資料を同じSQLの読み取り時点で取得する。
    rows = session.execute(
        select(entry, actor, meta.c.total, meta.c.page_count, meta.c.page)
        .select_from(meta)
        .outerjoin(
            ranked,
            and_(
                ranked.c.position > (meta.c.page - 1) * query.page_size,
                ranked.c.position <= meta.c.page * query.page_size,
            ),
        )
        .outerjoin(actor, actor.id == entry.actor_id)
        .order_by(ranked.c.position)
    ).all()
    items = [
        AccountEvent(
            id=item.id,
            actor=UserRef.model_validate(person) if person else None,
            target_user_id=item.target_user_id,
            action=item.action,
            occurred_at=item.occurred_at,
            request_id=item.request_id,
        )
        for item, person, *_ in rows
        if item is not None
    ]
    return AccountEventList(
        items=items,
        page=rows[0].page,
        page_size=query.page_size,
        page_count=rows[0].page_count,
        total=rows[0].total,
    )


def bootstrap_manager(session: Session, login_id: str) -> bool:
    user_id = session.scalar(select(User.id).where(User.login_id == login_id))
    user = lock_users(session, {user_id}).get(user_id) if user_id is not None else None
    if user is None or not user.active:
        raise ValueError("指定した有効なアカウントが見つかりません。")
    if user.can_manage_accounts:
        return False
    user.can_manage_accounts = True
    user.row_version += 1
    session.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    session.add(
        AuditEvent(
            actor_id=None,
            target_user_id=user.id,
            action="management_granted",
            occurred_at=datetime.now(UTC),
            request_id=uuid4(),
            target_version=user.row_version,
        )
    )
    session.flush()
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="ローカルの指定アカウントに管理権限を準備します。")
    subcommands = parser.add_subparsers(dest="command", required=True)
    bootstrap = subcommands.add_parser(
        "bootstrap-manager", help="指定アカウントに初期管理権限を付与"
    )
    bootstrap.add_argument("--login-id", required=True, help="既存の有効なログインID（完全一致）")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9._-]{1,100}", args.login_id):
        parser.exit(1, "ログインIDの形式を確認してください。\n")
    engine = build_engine(load_settings())
    try:
        with Session(engine) as session, session.begin():
            changed = bootstrap_manager(session, args.login_id)
    except ValueError:
        parser.exit(1, "指定した有効なアカウントが見つかりません。\n")
    except SQLAlchemyError:
        parser.exit(1, "管理権限を準備できません。DBとマイグレーションを確認してください。\n")
    finally:
        engine.dispose()
    print(
        "管理権限を付与し、対象の全セッションを終了しました。"
        if changed
        else "管理権限は既に付与済みです。変更はありません。"
    )


if __name__ == "__main__":
    main()
