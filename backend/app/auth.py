import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.security import APIKeyCookie
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.database import get_session
from app.errors import ApiError
from app.models import AuthSession, Department, User

COOKIE_NAME = "solveloop_session"
SESSION_SECONDS = 8 * 60 * 60
password_hasher = PasswordHasher()
# 存在しないIDにも同じハッシュ検証を行い、認証失敗の差を減らす。
dummy_password_hash = password_hasher.hash(secrets.token_urlsafe(32))
session_cookie = APIKeyCookie(name=COOKIE_NAME, auto_error=False)
DbSession = Annotated[Session, Depends(get_session)]
router = APIRouter(prefix="/api/v1", tags=["認証・参照資料"])


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    login_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9._-]+$")
    password: SecretStr = Field(min_length=1, max_length=256)


class DepartmentRef(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    name: str


class UserRef(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    display_name: str


class CurrentUser(UserRef):
    role: Literal["employee", "operator"]
    department: DepartmentRef | None


class LoginResult(BaseModel):
    user: CurrentUser
    csrf_token: str
    expires_at: datetime


class CsrfResult(BaseModel):
    csrf_token: str


class EmployeeReferenceData(BaseModel):
    departments: list[DepartmentRef]


class OperatorReferenceData(EmployeeReferenceData):
    operators: list[UserRef]


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def csrf_token(token: str) -> str:
    # 再読み込みや別タブでも同じ値を復元し、DBには検証用ハッシュだけを保存する。
    return hmac.new(token.encode(), b"solveloop:csrf:v1", hashlib.sha256).hexdigest()


def require_origin(request: Request) -> None:
    if request.headers.get("origin") not in request.app.state.settings.auth_allowed_origins:
        raise ApiError(403, "CSRF_FAILED", "許可されたOriginから操作してください。")


def get_auth(
    session: DbSession,
    token: Annotated[str | None, Depends(session_cookie)],
) -> tuple[AuthSession, User]:
    if not token or len(token) != 43:
        raise ApiError(401, "AUTHENTICATION_REQUIRED", "ログインしてください。")
    row = session.execute(
        select(AuthSession, User)
        .join(User, User.id == AuthSession.user_id)
        .where(
            AuthSession.token_hash == token_hash(token),
            AuthSession.expires_at > datetime.now(UTC),
            User.active.is_(True),
        )
    ).first()
    if row is None:
        raise ApiError(401, "AUTHENTICATION_REQUIRED", "ログインしてください。")
    return row[0], row[1]


Authenticated = Annotated[tuple[AuthSession, User], Depends(get_auth)]


def require_operator(auth: Authenticated) -> User:
    if auth[1].role != "operator":
        raise ApiError(403, "FORBIDDEN", "担当者のみ操作できます。")
    return auth[1]


def require_csrf(
    request: Request,
    auth: Authenticated,
    supplied: Annotated[str | None, Header(alias="X-CSRF-Token")] = None,
) -> None:
    require_origin(request)
    if (
        not supplied
        or len(supplied) != 64
        or not hmac.compare_digest(token_hash(supplied), auth[0].csrf_token_hash)
    ):
        raise ApiError(403, "CSRF_FAILED", "CSRFトークンを確認してください。")


def current_user(user: User, session: Session) -> CurrentUser:
    department = session.get(Department, user.department_id) if user.department_id else None
    return CurrentUser(
        id=user.id,
        display_name=user.display_name,
        role=user.role,
        department=DepartmentRef.model_validate(department) if department else None,
    )


@router.post("/auth/login", summary="デモアカウントでログイン", response_model=LoginResult)
def login(
    data: LoginInput,
    request: Request,
    response: Response,
    session: DbSession,
    origin: Annotated[None, Depends(require_origin)],
) -> LoginResult:
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise ApiError(422, "VALIDATION_ERROR", "JSON形式で入力してください。")
    user = session.scalar(select(User).where(User.login_id == data.login_id))
    try:
        password_hasher.verify(
            user.password_hash if user else dummy_password_hash, data.password.get_secret_value()
        )
    except VerificationError:
        raise ApiError(
            401, "INVALID_CREDENTIALS", "ログインIDまたはパスワードを確認してください。"
        ) from None
    if user is None or not user.active:
        raise ApiError(401, "INVALID_CREDENTIALS", "ログインIDまたはパスワードを確認してください。")

    old_token = request.cookies.get(COOKIE_NAME)
    if old_token and len(old_token) == 43:
        session.execute(delete(AuthSession).where(AuthSession.token_hash == token_hash(old_token)))
    session.execute(delete(AuthSession).where(AuthSession.expires_at <= datetime.now(UTC)))
    if password_hasher.check_needs_rehash(user.password_hash):
        user.password_hash = password_hasher.hash(data.password.get_secret_value())
    token = secrets.token_urlsafe(32)
    csrf = csrf_token(token)
    expires_at = datetime.now(UTC) + timedelta(seconds=SESSION_SECONDS)
    session.add(
        AuthSession(
            token_hash=token_hash(token),
            user_id=user.id,
            expires_at=expires_at,
            csrf_token_hash=token_hash(csrf),
        )
    )
    result = LoginResult(user=current_user(user, session), csrf_token=csrf, expires_at=expires_at)
    session.commit()
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_SECONDS,
        expires=expires_at,
        path="/",
        secure=request.app.state.settings.auth_cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return result


@router.get("/auth/me", summary="現在の利用者を確認", response_model=CurrentUser)
def me(auth: Authenticated, session: DbSession) -> CurrentUser:
    return current_user(auth[1], session)


@router.get("/auth/csrf", summary="ログイン済みのCSRFトークンを取得", response_model=CsrfResult)
def get_csrf(request: Request, auth: Authenticated) -> CsrfResult:
    return CsrfResult(csrf_token=csrf_token(request.cookies[COOKIE_NAME]))


@router.post("/auth/logout", summary="現在のセッションを終了", status_code=204)
def logout(
    request: Request,
    response: Response,
    auth: Authenticated,
    session: DbSession,
    csrf: Annotated[None, Depends(require_csrf)],
) -> None:
    session.execute(delete(AuthSession).where(AuthSession.id == auth[0].id))
    session.commit()
    response.delete_cookie(
        COOKIE_NAME,
        path="/",
        secure=request.app.state.settings.auth_cookie_secure,
        httponly=True,
        samesite="lax",
    )


@router.get("/reference-data", summary="役割に応じた参照資料を取得")
def reference_data(
    auth: Authenticated, session: DbSession
) -> EmployeeReferenceData | OperatorReferenceData:
    departments = [
        DepartmentRef.model_validate(item)
        for item in session.scalars(
            select(Department).where(Department.active.is_(True)).order_by(Department.code)
        )
    ]
    if auth[1].role == "operator":
        operators = [
            UserRef.model_validate(item)
            for item in session.scalars(
                select(User)
                .where(User.active.is_(True), User.role == "operator")
                .order_by(User.display_name, User.id)
            )
        ]
        return OperatorReferenceData(departments=departments, operators=operators)
    return EmployeeReferenceData(departments=departments)
