import hashlib
import json
import re
import unicodedata
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import (
    COOKIE_NAME,
    get_auth,
    lock_users,
    require_csrf,
    require_full_auth,
    require_operator,
)
from app.errors import ApiError
from app.models import AuthSession, Department, IdempotencyRecord, User


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)


def clean(value: object) -> object:
    if isinstance(value, str):
        value = value.replace("\r\n", "\n").strip()
        value.encode("utf-8")
        if "\x00" in value:
            raise ValueError("使用できない文字が含まれています。")
    return value


Title = Annotated[str, BeforeValidator(clean), Field(min_length=1, max_length=120)]
Body = Annotated[str, BeforeValidator(clean), Field(min_length=1, max_length=5000)]
Expected = Annotated[int, Field(strict=True, ge=1)]


class PageQuery(Input):
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=100)
    sort: Literal["updated_at_desc", "updated_at_asc"] = "updated_at_desc"


def normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


def page_result(
    visible: list[dict], filtered: list[dict], query: PageQuery, as_of: datetime
) -> dict:
    # shortcut: 小規模では権限内を一括読取。大量運用時は正規化検索列とSQLページングへ移す。
    # [ko] 소규모는 일괄 조회하고, 대량 운영 시 정규화 검색 열·SQL 페이지로 전환한다.
    # [en] Read authorized rows together; use normalized SQL search and paging at larger scale.
    filtered.sort(
        key=lambda item: (
            item["updated_at"],
            item.get("id", item.get("version_id", item.get("document_id"))),
        ),
        reverse=query.sort == "updated_at_desc",
    )
    count = len(filtered)
    pages = max(1, (count + query.page_size - 1) // query.page_size)
    page = min(query.page, pages)
    return dict(
        items=filtered[(page - 1) * query.page_size : page * query.page_size],
        page=page,
        page_size=query.page_size,
        page_count=pages,
        filtered_count=count,
        visible_total=len(visible),
        sort=query.sort,
        as_of=as_of,
    )


def conflict(expected: int, current: int) -> None:
    if expected != current:
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "別の担当者が更新しました。入力を保持して最新の内容を確認してください。",
            {"expected_version": expected, "current_version": current},
        )


def not_found() -> None:
    raise ApiError(404, "NOT_FOUND", "指定された情報が見つかりません。")


def invalid(message: str = "入力項目と参照先を確認してください。") -> None:
    raise ApiError(422, "VALIDATION_ERROR", message)


def invalid_state() -> None:
    raise ApiError(
        409, "INVALID_STATE", "現在の状態では操作できません。最新の内容を確認してください。"
    )


def write_actor(
    request: Request,
    session: Session,
    auth: tuple[AuthSession, User],
    related: set[UUID] | None = None,
    operator: bool = False,
) -> tuple[User, dict[UUID, User]]:
    require_full_auth(auth)
    if operator:
        require_operator(auth)
    require_csrf(request, auth, request.headers.get("X-CSRF-Token"))
    # 関連利用者のロック後に資格を再検査し、失効と業務更新の競合を防ぐ。
    # [ko] 관련 사용자를 잠근 뒤 자격을 재검사해 세션 무효화와 업무 갱신의 경합을 막는다.
    # [en] Recheck credentials after user locks to serialize revocation with business writes.
    users = lock_users(session, {auth[1].id} | (related or set()))
    current = require_full_auth(get_auth(session, request.cookies.get(COOKIE_NAME)))
    require_csrf(request, current, request.headers.get("X-CSRF-Token"))
    actor = require_operator(current) if operator else current[1]
    return actor, users


def department(session: Session, department_id: UUID | None, required: bool = False) -> None:
    if department_id is None:
        if required:
            invalid("担当部署を確定してください。")
        return
    row = session.scalar(
        select(Department).where(Department.id == department_id).with_for_update(read=True)
    )
    if row is None or not row.active:
        invalid("有効な担当部署を選択してください。")


def user_ref(session: Session, user_id: UUID | None) -> dict | None:
    user = session.get(User, user_id) if user_id else None
    return {"id": str(user.id), "display_name": user.display_name} if user else None


def department_ref(session: Session, department_id: UUID | None) -> dict | None:
    row = session.get(Department, department_id) if department_id else None
    return {"id": str(row.id), "code": row.code, "name": row.name} if row else None


# 利用者・method・path・keyと内容ハッシュで、同じ登録だけを再生する。
# [ko] 사용자·method·path·key와 내용 해시를 비교해 같은 등록 요청만 재생한다.
# [en] Replay only matching user, method, path, key, and payload hash combinations.
def idempotent_result(
    request: Request, session: Session, actor: User, data: BaseModel
) -> tuple[str, str, dict | None]:
    key = request.headers.get("Idempotency-Key", "")
    if not re.fullmatch(r"[!-~]{1,100}", key):
        invalid("新規登録には1〜100文字のIdempotency-Keyが必要です。")
    digest = hashlib.sha256(
        json.dumps(
            data.model_dump(mode="json"), ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()
    row = session.scalar(
        select(IdempotencyRecord).where(
            IdempotencyRecord.user_id == actor.id,
            IdempotencyRecord.method == request.method,
            IdempotencyRecord.path == request.url.path,
            IdempotencyRecord.key == key,
        )
    )
    if row:
        if row.response_status == 410:
            raise ApiError(
                410, "RESOURCE_DELETED", "この登録結果は削除されています。再送しません。"
            )
        if row.request_hash != digest:
            raise ApiError(
                409, "IDEMPOTENCY_KEY_REUSED", "同じ登録キーを別の内容には使用できません。"
            )
        if row.expires_at <= datetime.now(UTC):
            raise ApiError(
                409,
                "IDEMPOTENCY_KEY_EXPIRED",
                "登録キーの期限が切れています。一覧と履歴で結果を確認してください。",
            )
        return key, digest, row.response_body
    return key, digest, None


def finish_create(
    request: Request,
    session: Session,
    actor: User,
    key: str,
    digest: str,
    result: dict,
    entity_id: UUID,
) -> dict:
    result = jsonable_encoder(result)
    now = datetime.now(UTC)
    # 業務資料と再送用の結果を同じトランザクションで保存し、片方だけの確定を防ぐ。
    # [ko] 업무 자료와 재전송용 결과를 같은 트랜잭션에 저장해 한쪽만 확정되는 것을 막는다.
    # [en] Commit business data and its replay record together so neither can exist alone.
    session.add(
        IdempotencyRecord(
            user_id=actor.id,
            method=request.method,
            path=request.url.path,
            key=key,
            request_hash=digest,
            response_status=201,
            response_body=result,
            entity_id=entity_id,
            created_at=now,
            expires_at=now + timedelta(hours=24),
        )
    )
    session.flush()
    session.commit()
    return result


def finish(session: Session, result: dict) -> dict:
    result = jsonable_encoder(result)
    session.flush()
    session.commit()
    return result
