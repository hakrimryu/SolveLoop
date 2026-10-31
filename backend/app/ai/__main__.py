import argparse
import json
import sys

from pydantic import ValidationError
from pydantic_settings import SettingsError

from app.ai.config import AISettings
from app.ai.ollama import OllamaClient, OllamaError

GENERATION_INPUT = (
    "これは架空の社内問い合わせです。"
    "『VPNに接続できません』を丁寧な日本語一文に言い換えてください。"
)
EMBEDDING_INPUT = "新しいスマートフォンに変更した後、VPNの多要素認証ができません。"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="ローカルOllamaの接続検証。業務資料は保存しません。"
    )
    parser.add_argument("command", choices=["check", "generate", "embed", "smoke"])
    args = parser.parse_args()
    try:
        client = OllamaClient(AISettings())
        report = {"scope": "local_connection_smoke", "ollama_version": client.version()}
        if args.command == "check":
            report["models"] = [
                client.local_model(client.settings.ollama_chat_model, "completion"),
                client.local_model(client.settings.ollama_embed_model, "embedding"),
            ]
        if args.command in {"generate", "smoke"}:
            report["generation"] = client.generate(GENERATION_INPUT)
            report["generation"]["running_models"] = client.running()
        if args.command in {"embed", "smoke"}:
            result = client.embed(EMBEDDING_INPUT)
            # 数値全体は呼出元へ返すが、接続検証CLIには次元とノルムだけを表示する。
            # [ko] 호출 코드에는 전체 벡터를 반환하되 연결 확인 CLI에는 차원과 노름만 표시한다.
            # [en] Return full vectors to callers; print only dimensions and norm in this CLI.
            vector = result.pop("embeddings")[0]
            result["vector_norm"] = sum(value * value for value in vector) ** 0.5
            result["running_models"] = client.running()
            report["embedding"] = result
        print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
        return 0
    except OllamaError as error:
        print(
            json.dumps({"code": error.code, "message": str(error)}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 1
    except (ValidationError, SettingsError):
        print("Ollamaの環境設定を確認してください。設定値は表示しません。", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
