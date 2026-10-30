from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        self.status = status
        self.code = code
        self.message = message


def error_response(request: Request, status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        {"code": code, "message": message, "request_id": str(request.state.request_id)},
        status_code=status,
        headers={"Cache-Control": "no-store"},
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error(request: Request, error: ApiError) -> JSONResponse:
        return error_response(request, error.status, error.code, error.message)

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request: Request, error: RequestValidationError) -> JSONResponse:
        # 標準の検証エラーに含まれる入力値から、パスワードが漏れるのを防ぐ。
        return error_response(
            request, 422, "VALIDATION_ERROR", "入力項目と形式を確認してください。"
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
