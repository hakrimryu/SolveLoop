import json
import os
from http.cookiejar import CookieJar
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener

import pytest

BASE_URL = os.getenv("AUTH_TEST_BASE_URL", "")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not BASE_URL, reason="専用の起動済みAPIを指定してください。"),
]


@pytest.mark.parametrize("role", ["employee", "operator"])
def test_running_auth_api(role):
    cookies = CookieJar()
    client = build_opener(HTTPCookieProcessor(cookies))

    def call(path, data=None, csrf=None):
        headers = {"Origin": "http://127.0.0.1:8000"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if csrf:
            headers["X-CSRF-Token"] = csrf
        request = Request(
            BASE_URL + "/api/v1" + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers=headers,
        )
        try:
            result = client.open(request, timeout=10)
        except HTTPError as error:
            result = error
        with result:
            body = result.read()
            assert result.headers["Cache-Control"] == "no-store"
            return result.status, json.loads(body) if body else None

    assert call("/auth/me")[0] == 401
    status, login = call("/auth/login", {"login_id": role, "password": "SolveLoop-Demo-2026!"})
    assert status == 200
    assert login["user"]["role"] == role
    assert call("/auth/me")[1] == login["user"]
    assert call("/auth/csrf")[1]["csrf_token"] == login["csrf_token"]
    refs = call("/reference-data")[1]
    assert len(refs["departments"]) == 4
    assert ("operators" in refs) == (role == "operator")
    assert call("/auth/logout", {})[0] == 403
    assert call("/auth/logout", {}, login["csrf_token"])[0] == 204
    assert call("/auth/me")[0] == 401
