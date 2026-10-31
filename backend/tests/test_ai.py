import json
from contextlib import suppress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.ai.__main__ import main
from app.ai.config import AISettings
from app.ai.ollama import INFERENCE_LOCK, MAX_RESPONSE_BYTES, OllamaClient, OllamaError


@pytest.fixture
def ollama_server():
    calls = []
    release = Event()
    chat = "qwen3:8b"
    embed = "embeddinggemma-2:270m-q8_0-text"
    routes = {
        "/api/version": {"version": "test-only"},
        "/api/tags": {
            "models": [{"name": name, "digest": "a" * 64, "size": 100} for name in (chat, embed)]
        },
        "/api/show": {
            "details": {"format": "gguf"},
            "model_info": {"general.architecture": "test-only"},
            "capabilities": ["completion", "embedding"],
        },
        "/api/ps": {"models": []},
        "/api/generate": {
            "model": chat,
            "response": "VPNに接続できない状況です。",
            "done": True,
            "done_reason": "stop",
            "total_duration": 200,
            "load_duration": 100,
            "prompt_eval_count": 20,
            "eval_count": 10,
        },
        "/api/embed": {
            "model": embed,
            "embeddings": [[0.6, 0.8]],
            "total_duration": 200,
            "load_duration": 100,
            "prompt_eval_count": 20,
        },
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def respond(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            calls.append((self.path, json.loads(raw) if raw else None))
            value = routes[self.path]
            if value == "wait":
                release.wait(5)
                return
            status, value = value if isinstance(value, tuple) else (200, value)
            payload = value if isinstance(value, bytes) else json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Location", "/must-not-follow")
            self.end_headers()
            with suppress(BrokenPipeError, ConnectionResetError):
                self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    settings = AISettings(ollama_base_url=f"http://127.0.0.1:{server.server_port}")
    try:
        yield OllamaClient(settings), routes, calls
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com:11434",
        "http://192.168.1.2:11434",
        "http://127.0.0.1:11434/api",
        "http://secret:password@localhost:11434",
        "http://localhost:11434?x=1",
        "http://localhost:11434#part",
        "http://localhost",
        "http://localhost:99999",
    ],
)
def test_external_or_ambiguous_url_is_rejected(url):
    with pytest.raises(ValidationError) as error:
        AISettings(ollama_base_url=url)
    assert url not in str(error.value)


@pytest.mark.parametrize("name", ["qwen3", "qwen3:cloud", "model@ollama.com", "", "a:\n"])
def test_model_name_requires_local_tag(name):
    with pytest.raises(ValidationError):
        AISettings(ollama_chat_model=name)


def test_real_http_contract_and_proxy_bypass(ollama_server, monkeypatch):
    client, _, calls = ollama_server
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("NO_PROXY", "")
    client = OllamaClient(client.settings)
    assert client.version() == "test-only"
    assert client.generate("日本語の架空入力")["response"] == "VPNに接続できない状況です。"
    result = client.embed("架空の問い合わせ")
    assert result["embeddings"] == [[0.6, 0.8]]
    assert result["dimensions"] == 2
    assert result["local_model"]["digest"] == "a" * 64
    assert client.running() == []
    generation = next(body for path, body in calls if path == "/api/generate")
    assert generation["prompt"] == "日本語の架空入力"
    assert generation["stream"] is False and generation["think"] is False
    assert generation["options"] == {"num_ctx": 2048, "num_predict": 128, "temperature": 0}
    embedding = next(body for path, body in calls if path == "/api/embed")
    assert embedding["truncate"] is False
    assert embedding["options"] == {"num_ctx": 2048}
    assert embedding["input"] == ["架空の問い合わせ"]


@pytest.mark.parametrize("method,path", [("generate", "/api/generate"), ("embed", "/api/embed")])
@pytest.mark.parametrize(
    "status,code",
    [
        (400, "AI_INPUT_REJECTED"),
        (404, "AI_MODEL_NOT_FOUND"),
        (503, "AI_BUSY"),
        (500, "AI_HTTP_ERROR"),
        (302, "AI_HTTP_ERROR"),
    ],
)
def test_http_failures_are_sanitized_and_never_retried(ollama_server, method, path, status, code):
    client, routes, calls = ollama_server
    routes[path] = (status, {"error": "secret prompt and internal path"})
    with pytest.raises(OllamaError) as error:
        getattr(client, method)("機密の試験入力")
    assert error.value.code == code
    assert "secret" not in str(error.value)
    assert [p for p, _ in calls].count(path) == 1
    assert not any(p == "/must-not-follow" for p, _ in calls)


@pytest.mark.parametrize(
    "changes,code",
    [
        (
            {"remote_host": "https://ollama.com", "remote_model": "remote"},
            "AI_LOCAL_MODEL_REQUIRED",
        ),
        ({"details": {"format": "mlx"}}, "AI_LOCAL_MODEL_REQUIRED"),
        ({"capabilities": []}, "AI_MODEL_UNSUPPORTED"),
        ({"model_info": {}}, "AI_MODEL_UNSUPPORTED"),
    ],
)
def test_remote_and_unsupported_models_are_blocked_before_inference(ollama_server, changes, code):
    client, routes, calls = ollama_server
    routes["/api/show"].update(changes)
    with pytest.raises(OllamaError) as error:
        client.generate("試験入力")
    assert error.value.code == code
    assert not any(path == "/api/generate" for path, _ in calls)


def test_missing_model_never_downloads_or_falls_back(ollama_server):
    client, routes, calls = ollama_server
    routes["/api/tags"] = {"models": []}
    with pytest.raises(OllamaError) as error:
        client.embed("入力")
    assert error.value.code == "AI_MODEL_NOT_FOUND"
    assert calls == [("/api/tags", None)]


@pytest.mark.parametrize(
    "method,path,changes",
    [
        ("generate", "/api/generate", {"done": False}),
        ("generate", "/api/generate", {"done": 1}),
        ("generate", "/api/generate", {"done_reason": "length"}),
        ("generate", "/api/generate", {"response": "   "}),
        ("generate", "/api/generate", {"model": "another:tag"}),
        ("generate", "/api/generate", {"eval_count": -1}),
        ("embed", "/api/embed", {"embeddings": []}),
        ("embed", "/api/embed", {"embeddings": [[]]}),
        ("embed", "/api/embed", {"embeddings": [[0, 0]]}),
        ("embed", "/api/embed", {"embeddings": [[True]]}),
        ("embed", "/api/embed", {"embeddings": [["0.1"]]}),
        ("embed", "/api/embed", {"embeddings": [[float("nan")]]}),
        ("embed", "/api/embed", {"embeddings": [[float("inf")]]}),
        ("embed", "/api/embed", {"embeddings": [[1], [1]]}),
        ("embed", "/api/embed", {"model": "another:tag"}),
    ],
)
def test_invalid_inference_responses(ollama_server, method, path, changes):
    client, routes, _ = ollama_server
    routes[path].update(changes)
    with pytest.raises(OllamaError) as error:
        getattr(client, method)("入力")
    assert error.value.code == "AI_INVALID_RESPONSE"


@pytest.mark.parametrize(
    "value", [b"not json", b"\xff", [], {"error": "private"}, b"x" * (MAX_RESPONSE_BYTES + 1)]
)
def test_malformed_and_oversized_json(ollama_server, value):
    client, routes, _ = ollama_server
    routes["/api/version"] = value
    with pytest.raises(OllamaError) as error:
        client.version()
    assert error.value.code == "AI_INVALID_RESPONSE"


@pytest.mark.parametrize(
    "method,path,setting",
    [
        ("generate", "/api/generate", "ollama_generate_timeout_seconds"),
        ("embed", "/api/embed", "ollama_embed_timeout_seconds"),
    ],
)
def test_actual_socket_timeout_releases_inference_lock(ollama_server, method, path, setting):
    client, routes, calls = ollama_server
    setattr(client.settings, setting, 0.05)
    routes[path] = "wait"
    with pytest.raises(OllamaError) as error:
        getattr(client, method)("入力")
    assert error.value.code == "AI_TIMEOUT"
    assert [p for p, _ in calls].count(path) == 1
    assert not INFERENCE_LOCK.locked()


def test_connection_refusal_is_typed():
    server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    port = server.server_port
    server.server_close()
    client = OllamaClient(AISettings(ollama_base_url=f"http://127.0.0.1:{port}"))
    with pytest.raises(OllamaError) as error:
        client.version()
    assert error.value.code == "AI_UNAVAILABLE"


def test_input_and_concurrency_limits(ollama_server):
    client, _, calls = ollama_server
    for text in ("", "  ", "あ" * 2001, None):
        with pytest.raises(OllamaError) as error:
            client.generate(text)
        assert error.value.code == "AI_INVALID_INPUT"
    with INFERENCE_LOCK, pytest.raises(OllamaError) as error:
        client.embed("入力")
    assert error.value.code == "AI_BUSY"
    assert calls == []


def test_cli_success_and_failure_codes(ollama_server, monkeypatch, capsys):
    client, routes, _ = ollama_server
    with patch("app.ai.__main__.AISettings", return_value=client.settings):
        monkeypatch.setattr("sys.argv", ["ai", "smoke"])
        assert main() == 0
        report = json.loads(capsys.readouterr().out)
        assert report["scope"] == "local_connection_smoke"
        assert report["embedding"]["dimensions"] == 2
        assert "embeddings" not in report["embedding"]
        routes["/api/tags"] = {"models": []}
        assert main() == 1
        assert json.loads(capsys.readouterr().err)["code"] == "AI_MODEL_NOT_FOUND"


def test_manual_api_startup_does_not_load_ai_settings_or_contact_ollama(monkeypatch):
    from fastapi.testclient import TestClient
    from test_foundation import local_settings

    from app.main import create_app

    monkeypatch.setenv("OLLAMA_BASE_URL", "https://invalid-external.example:11434")
    with patch.object(OllamaClient, "_request", side_effect=AssertionError("AI呼出し禁止")):
        with TestClient(create_app(local_settings())) as api:
            assert api.get("/health/live").json() == {"status": "alive"}
            assert api.get("/api/v1/auth/me").status_code == 401


def test_search_embed_uses_larger_context_without_truncation_and_pins_digest(ollama_server):
    client, _, calls = ollama_server
    result = client.embed("あ" * 2500, context_tokens=8192, expected_digest="a" * 64)
    assert result["prompt_eval_count"] == 20
    request = next(body for path, body in calls if path == "/api/embed")
    assert request["options"] == {"num_ctx": 8192} and request["truncate"] is False
    assert request["input"] == ["あ" * 2500]
    calls.clear()
    with pytest.raises(OllamaError) as error:
        client.embed("入力", expected_digest="b" * 64)
    assert error.value.code == "AI_PROFILE_MISMATCH"
    assert not any(path == "/api/embed" for path, _ in calls)
    with pytest.raises(OllamaError):
        client.embed("あ" * 11000, context_tokens=8192)


def test_search_embed_detects_retagging_during_inference(ollama_server, monkeypatch):
    client, routes, _ = ollama_server
    request = client._request

    def retag(path, *args, **kwargs):
        result = request(path, *args, **kwargs)
        if path == "/api/embed":
            routes["/api/tags"]["models"][1]["digest"] = "b" * 64
        return result

    monkeypatch.setattr(client, "_request", retag)
    with pytest.raises(OllamaError) as error:
        client.embed("入力", expected_digest="a" * 64)
    assert error.value.code == "AI_PROFILE_MISMATCH"
