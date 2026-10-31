from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AISettings(BaseSettings):
    model_config = SettingsConfigDict(hide_input_in_errors=True)

    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_chat_model: str = "qwen3:8b"
    ollama_embed_model: str = "embeddinggemma-2:270m-q8_0-text"
    ollama_generate_timeout_seconds: float = Field(default=120, gt=0, le=300)
    ollama_embed_timeout_seconds: float = Field(default=120, gt=0, le=120)

    # 接続先の誤設定で業務資料を外部へ送らないよう、ローカル接続だけを許可する。
    # [ko] 접속 주소 오설정으로 업무 자료가 외부로 나가지 않도록 로컬 연결만 허용한다.
    # [en] Restrict destinations to local connections to prevent accidental external disclosure.
    @field_validator("ollama_base_url")
    @classmethod
    def local_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "http"
            or parsed.hostname not in {"127.0.0.1", "localhost", "::1", "host.docker.internal"}
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or not parsed.port
        ):
            raise ValueError("Ollamaはポートを指定したローカルHTTP接続だけを利用できます。")
        return value.rstrip("/")

    @field_validator("ollama_chat_model", "ollama_embed_model")
    @classmethod
    def local_model_name(cls, value: str) -> str:
        if (
            not value
            or len(value) > 200
            or any(
                c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/:"
                for c in value
            )
            or "cloud" in value.lower()
            or ":" not in value
        ):
            raise ValueError("タグ付きのローカルモデル名を指定してください。")
        return value
