from alembic import context
from sqlalchemy.exc import SQLAlchemyError

from app.config import load_settings
from app.database import build_engine


def run_migrations() -> None:
    engine = build_engine(load_settings())
    try:
        with engine.connect() as connection:
            context.configure(connection=connection, target_metadata=None)
            with context.begin_transaction():
                context.run_migrations()
    except SQLAlchemyError:
        raise RuntimeError(
            "マイグレーションに失敗しました。DB接続と権限を確認してください。"
        ) from None
    finally:
        engine.dispose()


if context.is_offline_mode():
    raise RuntimeError("接続先を確認できるオンライン実行を使用してください。")
run_migrations()
