from collections.abc import Iterator

from fastapi import Request
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from app.config import Settings


def build_engine(settings: Settings) -> Engine:
    # 接続待ちとSQLの実行時間を制限し、DB障害時に要求を待たせ続けない。
    # [ko] 연결 대기와 SQL 실행 시간을 제한해 DB 장애 시 요청이 계속 대기하지 않게 한다.
    # [en] Bound connection waits and SQL execution time so DB failures do not hang requests.
    return create_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=0,
        pool_timeout=3,
        hide_parameters=True,
        connect_args={"connect_timeout": 3, "options": "-c statement_timeout=3000"},
    )


def get_session(request: Request) -> Iterator[Session]:
    # コミットは業務処理側で明示し、未確定の変更は終了時に破棄する。
    # [ko] 커밋은 업무 처리 측에서 명시하고 미확정 변경은 세션 종료 시 폐기한다.
    # [en] Business handlers commit explicitly; discard uncommitted changes when the session closes.
    with Session(request.app.state.engine) as session:
        yield session
