import argparse
import re
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth import lock_users
from app.config import load_settings
from app.database import build_engine
from app.models import AuditEvent, AuthSession, User


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
