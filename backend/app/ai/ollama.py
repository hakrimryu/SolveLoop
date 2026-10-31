import json
import math
from http.client import HTTPException
from threading import Lock
from time import perf_counter
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, ValidationError

from app.ai.config import AISettings

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
INFERENCE_LOCK = Lock()


class OllamaError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ResponseModel(BaseModel):
    model_config = ConfigDict(strict=True, hide_input_in_errors=True)


class Version(ResponseModel):
    version: str = Field(min_length=1)


class Model(ResponseModel):
    name: str
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    size: int = Field(gt=0)


class Models(ResponseModel):
    models: list[Model]


class ModelInfo(ResponseModel):
    details: dict
    model_info: dict
    capabilities: list[str]
    remote_host: str | None = None
    remote_model: str | None = None


class Generation(ResponseModel):
    model: str
    response: str = Field(min_length=1)
    done: bool
    done_reason: Literal["stop"]
    total_duration: int = Field(ge=0)
    load_duration: int = Field(ge=0)
    prompt_eval_count: int = Field(ge=0)
    eval_count: int = Field(gt=0)


class Embedding(ResponseModel):
    model: str
    embeddings: list[list[FiniteFloat]] = Field(min_length=1)
    total_duration: int = Field(ge=0)
    load_duration: int = Field(ge=0)
    prompt_eval_count: int = Field(gt=0)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class OllamaClient:
    def __init__(self, settings: AISettings):
        self.settings = settings
        # プロキシ・redirect経由の外部転送と自動再試行を使わない。
        # [ko] 프록시·redirect를 통한 외부 전달과 자동 재시도를 사용하지 않는다.
        # [en] Disable proxy forwarding, redirects, and automatic retries.
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def _request(self, path: str, body: dict | None = None, timeout: float = 5) -> dict:
        request = Request(
            self.settings.ollama_base_url + path,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise OllamaError(
                        "AI_INVALID_RESPONSE", "Ollamaの応答サイズが上限を超えました。"
                    )
                value = json.loads(raw)
                if not isinstance(value, dict) or "error" in value:
                    raise OllamaError("AI_INVALID_RESPONSE", "Ollamaの応答形式が不正です。")
                return value
        except HTTPError as error:
            status = error.code
            error.close()
            if status == 404 and path in {"/api/show", "/api/generate", "/api/embed"}:
                raise OllamaError(
                    "AI_MODEL_NOT_FOUND", "ローカルモデルが見つかりません。"
                ) from None
            if status in {429, 503}:
                raise OllamaError(
                    "AI_BUSY", "Ollamaが混雑しています。後で再実行してください。"
                ) from None
            if status == 400:
                raise OllamaError(
                    "AI_INPUT_REJECTED", "Ollamaが入力を受け付けませんでした。"
                ) from None
            raise OllamaError("AI_HTTP_ERROR", "Ollamaの要求に失敗しました。") from None
        except (TimeoutError, URLError) as error:
            reason = error.reason if isinstance(error, URLError) else error
            if isinstance(reason, TimeoutError):
                raise OllamaError(
                    "AI_TIMEOUT", "Ollamaの応答が制限時間内に届きませんでした。"
                ) from None
            raise OllamaError("AI_UNAVAILABLE", "ローカルOllamaに接続できません。") from None
        except (json.JSONDecodeError, UnicodeDecodeError, RecursionError):
            raise OllamaError("AI_INVALID_RESPONSE", "Ollamaの応答形式が不正です。") from None
        except (OSError, HTTPException):
            raise OllamaError("AI_UNAVAILABLE", "ローカルOllamaとの通信が中断しました。") from None

    @staticmethod
    def _parse(schema: type[ResponseModel], value: dict):
        try:
            return schema.model_validate(value)
        except ValidationError:
            raise OllamaError("AI_INVALID_RESPONSE", "Ollamaの応答形式が不正です。") from None

    def version(self) -> str:
        return self._parse(Version, self._request("/api/version")).version

    def local_model(self, name: str, capability: str) -> dict:
        models = self._parse(Models, self._request("/api/tags"))
        model = next((model for model in models.models if model.name == name), None)
        if model is None:
            raise OllamaError("AI_MODEL_NOT_FOUND", "ローカルモデルが見つかりません。")
        info = self._parse(ModelInfo, self._request("/api/show", {"model": name}))
        # ローカルAPIにもcloudモデルが登録できるため、重みの存在を別途検査する。
        # [ko] 로컬 API에도 cloud 모델을 등록할 수 있어 가중치 존재를 별도로 확인한다.
        # [en] A local API can register cloud models, so verify local weights separately.
        if info.remote_host or info.remote_model or info.details.get("format") != "gguf":
            raise OllamaError("AI_LOCAL_MODEL_REQUIRED", "ローカルGGUFモデルだけを利用できます。")
        if not info.model_info or capability not in info.capabilities:
            raise OllamaError("AI_MODEL_UNSUPPORTED", "モデルが必要な処理に対応していません。")
        return {**model.model_dump(), "details": info.details}

    def running(self) -> list[dict]:
        value = self._request("/api/ps")
        models = value.get("models")
        if not isinstance(models, list) or any(not isinstance(model, dict) for model in models):
            raise OllamaError("AI_INVALID_RESPONSE", "Ollamaの実行状態が不正です。")
        return models

    def generate(self, prompt: str) -> dict:
        return self._infer(prompt, embedding=False)

    def embed(self, text: str) -> dict:
        return self._infer(text, embedding=True)

    def _infer(self, text: str, *, embedding: bool) -> dict:
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise OllamaError("AI_INVALID_INPUT", "入力は空白以外の1〜2000文字にしてください。")
        if not INFERENCE_LOCK.acquire(blocking=False):
            raise OllamaError("AI_BUSY", "別のローカルAI処理が実行中です。")
        try:
            name = (
                self.settings.ollama_embed_model if embedding else self.settings.ollama_chat_model
            )
            model = self.local_model(name, "embedding" if embedding else "completion")
            started = perf_counter()
            if embedding:
                # 長い入力を黙って切り捨てず、分割規則は意味検索の実装時に定める。
                # [ko] 긴 입력을 조용히 잘라내지 않으며 분할 규칙은 의미 검색 구현 때 정한다.
                # [en] Reject oversized input; define chunking when adding semantic search.
                body = {
                    "model": name,
                    "input": [text],
                    "truncate": False,
                    "keep_alive": "5m",
                    "options": {"num_ctx": 2048},
                }
                result = self._parse(
                    Embedding,
                    self._request("/api/embed", body, self.settings.ollama_embed_timeout_seconds),
                )
                vector = result.embeddings[0]
                if (
                    len(result.embeddings) != 1
                    or not vector
                    or not math.isfinite(math.hypot(*vector))
                    or math.hypot(*vector) == 0
                ):
                    raise OllamaError("AI_INVALID_RESPONSE", "埋め込みベクトルが不正です。")
                output = result.model_dump()
                output["dimensions"] = len(vector)
            else:
                body = {
                    "model": name,
                    "prompt": text,
                    "stream": False,
                    "think": False,
                    "keep_alive": "5m",
                    "options": {"num_ctx": 2048, "num_predict": 128, "temperature": 0},
                }
                result = self._parse(
                    Generation,
                    self._request(
                        "/api/generate", body, self.settings.ollama_generate_timeout_seconds
                    ),
                )
                if not result.done or not result.response.strip():
                    raise OllamaError("AI_INVALID_RESPONSE", "生成応答が空です。")
                output = result.model_dump()
            if result.model != name:
                raise OllamaError("AI_INVALID_RESPONSE", "応答のモデル名が要求と一致しません。")
            return {
                **output,
                "elapsed_ms": round((perf_counter() - started) * 1000, 2),
                "local_model": model,
            }
        finally:
            INFERENCE_LOCK.release()
