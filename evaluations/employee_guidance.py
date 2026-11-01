"""原本の合成公開文書で社員向けAI案内を測定する。業務資料は変更しない。"""

import argparse
import hashlib
import http.cookiejar
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPCookieProcessor, Request, build_opener


class Client:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.csrf = ""

    def call(self, path, body=None):
        headers = {
            "Origin": "http://127.0.0.1:5174",
            "Content-Type": "application/json",
        }
        if self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        request = Request(
            self.base + "/api/v1" + path,
            data=json.dumps(body, ensure_ascii=False).encode()
            if body is not None
            else None,
            headers=headers,
        )
        started = perf_counter()
        try:
            with self.opener.open(request, timeout=180) as response:
                raw = response.read()
                return (
                    response.status,
                    json.loads(raw) if raw else None,
                    round((perf_counter() - started) * 1000),
                )
        except HTTPError as error:
            return (
                error.code,
                json.load(error),
                round((perf_counter() - started) * 1000),
            )

    def login(self):
        status, response, _ = self.call(
            "/auth/login",
            {
                "login_id": "employee",
                "password": os.getenv(
                    "SOLVELOOP_DEMO_PASSWORD", "SolveLoop-Demo-2026!"
                ),
            },
        )
        if status != 200:
            raise RuntimeError("合成社員アカウントにログインできません。")
        self.csrf = response["csrf_token"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if urlsplit(args.base_url).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("ローカルの合成デモだけを対象にしてください。")
    args.output.mkdir(parents=True, exist_ok=False)
    dataset = Path(__file__).parent / "datasets/employee-guidance-v1.json"
    cases = json.loads(dataset.read_text(encoding="utf-8"))["cases"]
    source_root = Path(__file__).resolve().parents[1] / "backend/app"
    local_sources = {
        str(path.relative_to(source_root)).replace("\\", "/"): hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
        for path in sorted(source_root.rglob("*.py"))
    }
    (args.output / "local-source-hashes.json").write_text(
        json.dumps(local_sources, indent=2), encoding="utf-8"
    )
    client = Client(args.base_url)
    client.login()
    records = []
    status, visible, _ = client.call("/knowledge?page_size=100")
    if status != 200 or not {"KB-0003", "KB-0004", "KB-0005"}.issubset(
        {item["number"] for item in visible["items"]}
    ):
        raise RuntimeError("対象の合成公開文書が揃っていません。原本は変更しません。")
    documents = []
    for item in visible["items"]:
        if item["number"] in {"KB-0003", "KB-0004", "KB-0005"}:
            code, detail, _ = client.call(f"/knowledge/{item['document_id']}")
            if code != 200:
                raise RuntimeError("公開文書を確認できません。")
            if (
                not detail["title"].startswith("合成")
                or "架空企業" not in detail["body"]
            ):
                raise RuntimeError("合成デモ用の文書だけを対象にしてください。")
            documents.append(detail)
    (args.output / "documents.json").write_text(
        json.dumps(documents, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    try:
        for case in cases:
            code, response, elapsed = client.call(
                "/knowledge/guidance", {"query": case["query"]}
            )
            record = {
                "case": case,
                "http_status": code,
                "elapsed_ms": elapsed,
                "response": response,
            }
            records.append(record)
            with (args.output / "records.jsonl").open("a", encoding="utf-8") as output:
                output.write(json.dumps(record, ensure_ascii=False) + "\n")
            print(
                f"{case['id']}: HTTP {code}, "
                f"{response.get('result', {}).get('status', response.get('code'))}, {elapsed}ms",
                flush=True,
            )
        with ThreadPoolExecutor(max_workers=2) as pool:
            parallel = list(
                pool.map(
                    lambda _: client.call(
                        "/knowledge/guidance", {"query": cases[1]["query"]}
                    ),
                    range(2),
                )
            )
        (args.output / "concurrency.json").write_text(
            json.dumps(
                [
                    {"http_status": code, "elapsed_ms": elapsed, "response": value}
                    for code, value, elapsed in parallel
                ],
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        lines = [
            "# 社員向けAI案内・小規模実測",
            "",
            f"実行: {datetime.now(UTC).isoformat()}",
            f"入力SHA-256: {hashlib.sha256(dataset.read_bytes()).hexdigest()}",
            "",
            "既存の合成文書3件を対象とした実推論です。一般的な精度、本人の解決、時間削減効果を示しません。正しい引用IDと内容の正しさは別に確認します。",
            "",
            "| ケース | HTTP | 応答 | 処理時間 | 期待状態との一致 |",
            "| --- | --- | --- | --- | --- |",
        ]
        for row in records:
            expected = row["case"]["expected_status"]
            actual = row["response"].get("result", {}).get("status")
            matched = (
                "人による条件確認"
                if expected is None
                else "一致"
                if expected == actual
                else "不一致・要確認"
            )
            lines.append(
                f"| {row['case']['id']} | {row['http_status']} | "
                f"{actual or row['response'].get('code')} | {row['elapsed_ms']}ms | {matched} |"
            )
        lines += [
            "",
            "## 同時2要求",
            "",
            *[
                f"- HTTP {code} / {elapsed}ms / "
                f"{value.get('result', {}).get('status', value.get('code'))}"
                for code, value, elapsed in parallel
            ],
            "",
            "## 内容レビュー",
            "",
            "案内・適用条件・注意・実際の引用をdocuments.json/records.jsonlと照合する必要があります。自動の状態一致だけを正答率としません。",
        ]
        (args.output / "report.md").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )
    finally:
        client.call("/auth/logout", {})


if __name__ == "__main__":
    main()
