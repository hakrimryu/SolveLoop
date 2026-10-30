from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth import password_hasher
from app.config import load_settings
from app.database import build_engine
from app.models import Department, User

# 架空企業「株式会社 柳」の公開デモ専用資料。実在の人物・認証情報ではない。
DEMO_PASSWORD = "SolveLoop-Demo-2026!"
DEPARTMENTS = (("IT", "IT"), ("HR", "人事"), ("GENERAL", "総務"), ("ACCOUNTING", "経理"))
USERS = (
    ("employee", "佐藤 美咲", "employee", "GENERAL"),
    ("operator", "山田 花子", "operator", "IT"),
)


def seed_auth(session: Session) -> None:
    # 同時実行でも既存資料を上書きせず、最小シード全体を一括して追加する。
    session.execute(text("SELECT pg_advisory_xact_lock(7309001)"))
    for index, (code, name) in enumerate(DEPARTMENTS, 1):
        if session.scalar(select(Department).where(Department.code == code)) is None:
            session.add(Department(id=UUID(int=100 + index), code=code, name=name, active=True))
    session.flush()
    for index, (login_id, name, role, code) in enumerate(USERS, 1):
        if session.scalar(select(User).where(User.login_id == login_id)) is None:
            department = session.scalar(select(Department).where(Department.code == code))
            session.add(
                User(
                    id=UUID(int=200 + index),
                    department_id=department.id,
                    display_name=name,
                    login_id=login_id,
                    role=role,
                    password_hash=password_hasher.hash(DEMO_PASSWORD),
                    active=True,
                )
            )
    session.flush()


def main() -> None:
    engine = build_engine(load_settings())
    try:
        with Session(engine) as session, session.begin():
            seed_auth(session)
    except SQLAlchemyError:
        raise RuntimeError(
            "シードを追加できません。DBとマイグレーションを確認してください。"
        ) from None
    finally:
        engine.dispose()
    print("架空企業の最小シードを追加しました。既存資料・パスワードは変更していません。")


if __name__ == "__main__":
    main()
