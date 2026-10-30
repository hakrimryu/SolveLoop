FROM ghcr.io/astral-sh/uv:0.10.4@sha256:4cac394b6b72846f8a85a7a0e577c6d61d4e17fe2ccee65d9451a8b3c9efb4ac AS uv
FROM python:3.13.18-slim-bookworm@sha256:281d39ff02e3b389401586134ff9e6572954687822a58055ec07a60ded4e0b7f AS runtime

COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY THIRD_PARTY_NOTICES.txt ./
# 実行用には固定した本番依存だけを入れ、開発依存はtest段階に分ける。
# [ko] 실행 이미지에는 고정한 운영 의존성만 넣고 개발 의존성은 test 단계로 분리한다.
# [en] Install locked runtime dependencies here; keep development dependencies in the test stage.
RUN uv sync --locked --no-dev --no-cache --python /usr/local/bin/python
COPY app ./app
COPY alembic.ini ./
COPY migrations ./migrations
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]

FROM runtime AS test
ENV RUFF_NO_CACHE=true
USER root
RUN uv sync --locked --no-cache --python /usr/local/bin/python
COPY tests ./tests
USER 10001:10001
CMD ["pytest", "-q", "-p", "no:cacheprovider"]
