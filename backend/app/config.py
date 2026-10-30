from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict, SettingsError
from sqlalchemy import URL

BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(hide_input_in_errors=True)

    db_host: str = Field(default="db", min_length=1)
    db_port: int = Field(default=5432, ge=1, le=65535)
    postgres_db: str = Field(min_length=1)
    postgres_user: str = Field(min_length=1)
    postgres_password: SecretStr = Field(min_length=1)
    auth_allowed_origins: list[str] = [
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
    ]
    auth_cookie_secure: bool = False

    @field_validator("auth_allowed_origins")
    @classmethod
    def validate_origins(cls, origins: list[str]) -> list[str]:
        if not origins:
            raise ValueError("許可するOriginを指定してください。")
        for origin in origins:
            parsed = urlsplit(origin)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.path
                or parsed.query
                or parsed.fragment
                or "*" in origin
                or origin != f"{parsed.scheme}://{parsed.netloc}"
            ):
                raise ValueError("Originはスキームとホスト・ポートのみ指定してください。")
            _ = parsed.port
        return origins

    @property
    def database_url(self) -> URL:
        return URL.create(
            "postgresql+psycopg",
            username=self.postgres_user,
            password=self.postgres_password.get_secret_value(),
            host=self.db_host,
            port=self.db_port,
            database=self.postgres_db,
        )


def load_settings() -> Settings:
    try:
        return Settings()
    except (ValidationError, SettingsError):
        raise RuntimeError(
            "DB環境変数と認証設定を確認してください。設定値は表示しません。"
        ) from None
