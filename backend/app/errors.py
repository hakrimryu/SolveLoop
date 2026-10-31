from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None) -> None:
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def error_response(
    request: Request, status: int, code: str, message: str, details: dict | None = None
) -> JSONResponse:
    return JSONResponse(
        {
            "code": code,
            "message": message,
            "request_id": str(request.state.request_id),
            **({"details": details} if details else {}),
        },
        status_code=status,
        headers={"Cache-Control": "no-store"},
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error(request: Request, error: ApiError) -> JSONResponse:
        return error_response(request, error.status, error.code, error.message, error.details)

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request: Request, error: RequestValidationError) -> JSONResponse:
        # 検証エラーの入力原文を返さず、パスワードや内部値の漏えいを防ぐ。
        # [ko] 검증 오류의 입력 원문을 반환하지 않아 비밀번호와 내부 값의 유출을 막는다.
        # [en] Hide raw validation inputs so passwords and internal values cannot leak.
        details = None
        if request.url.path.startswith(("/api/v1/tickets", "/api/v1/knowledge")):
            allowed = {
                "title",
                "body",
                "audience",
                "department_id",
                "assignee_id",
                "action",
                "resolution",
                "reason",
                "confirmation_number",
                "expected_version",
                "expected_document_version",
                "base_version_no",
                "source_refs",
                "ticket_id",
                "expected_ticket_version",
                "page",
                "page_size",
                "sort",
                "q",
                "query",
                "top_k",
                "status",
                "assignee",
                "document_id",
                "version_no",
            }
            fields = []
            for item in error.errors():
                field = next((str(part) for part in item["loc"] if part in allowed), "request")
                fields.append(
                    {
                        "field": field,
                        "code": "INVALID",
                        "message": "入力項目と形式を確認してください。",
                    }
                )
            details = {"fields": fields}
        return error_response(
            request, 422, "VALIDATION_ERROR", "入力項目と形式を確認してください。", details
        )

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, error: SQLAlchemyError) -> JSONResponse:
        return error_response(
            request, 503, "SERVICE_UNAVAILABLE", "DBの接続と準備状態を確認してください。"
        )

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException) -> JSONResponse:
        code = "NOT_FOUND" if error.status_code == 404 else "METHOD_NOT_ALLOWED"
        message = (
            "指定された情報が見つかりません。"
            if error.status_code == 404
            else "この操作方法は利用できません。"
        )
        response = error_response(request, error.status_code, code, message)
        if error.headers:
            response.headers.update(error.headers)
        return response
