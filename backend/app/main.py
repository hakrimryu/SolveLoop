import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import uuid4

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from fastapi import Depends, FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import BACKEND_DIR, Settings, load_settings
from app.database import build_engine, get_session

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    engine = build_engine(settings if settings is not None else load_settings())
    expected_heads = set(
        ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini"))).get_heads()
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        yield
        engine.dispose()

    app = FastAPI(title="SolveLoop API", version="0.1.0", lifespan=lifespan)
    app.state.engine = engine

    @app.get("/health/live", summary="APIプロセスの生存確認")
    def live() -> dict[str, str]:
        return {"status": "alive"}

    @app.get("/health/ready", summary="現在の基盤スキーマとDB接続の確認")
    def ready(session: Annotated[Session, Depends(get_session)]) -> JSONResponse:
        checks = {"database": "unavailable", "schema": "unchecked", "vector": "unchecked"}
        try:
            session.execute(text("SELECT 1"))
            checks["database"] = "up"
            current_heads = set(
                MigrationContext.configure(session.connection()).get_current_heads()
            )
            checks["schema"] = "current" if current_heads == expected_heads else "outdated"
            vector_exists = session.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_extension e "
                    "JOIN pg_namespace n ON n.oid = e.extnamespace "
                    "WHERE e.extname = 'vector' AND n.nspname = 'public')"
                )
            )
            checks["vector"] = "available" if vector_exists else "missing"
        except SQLAlchemyError:
            logger.warning("DBの準備状態を確認できません。接続設定とDBを確認してください。")

        is_ready = checks == {"database": "up", "schema": "current", "vector": "available"}
        body = {
            "status": "ready" if is_ready else "not_ready",
            "scope": "backend_foundation",
            "checks": checks,
        }
        if not is_ready:
            body["error"] = {
                "code": "SERVICE_UNAVAILABLE",
                "message": "DB接続とマイグレーションの適用状態を確認してください。",
                "request_id": str(uuid4()),
            }
        return JSONResponse(body, status_code=200 if is_ready else 503)

    return app
