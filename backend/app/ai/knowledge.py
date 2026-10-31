import hashlib
import json
import math
import re
from dataclasses import dataclass

from app.ai.ollama import OllamaClient, OllamaError

SPECIFICATION = {
    "model": "embeddinggemma-2:270m-q8_0-text",
    "digest": "c21dd30c1e38444d3b4faa091407b6fa97221447b4965d74931d43d7f09bbbfd",
    "dimensions": 768,
    "normalization": "l2-v1",
    "query_template": "task: search result | query: {query}",
    "document_template": "title: {title} | text: 適用対象: {audience}\n{context}\n{body}",
    "context_tokens": 8192,
    "chunk_rule": "paragraph-sentence-neighbor-v1",
    "chunk_bytes": 2400,
    "neighbor_bytes": 600,
}


def fingerprint(value) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


PROFILE_ID = fingerprint(SPECIFICATION)
HEADING = re.compile(
    r"^(?:#{1,6}\s+.+|【.+】|(?:概要|対象|適用条件|症状|手順|解決方法|例外|注意事項?|補足)"
    r"(?:[：:].*)?)$"
)


@dataclass(frozen=True)
class Chunk:
    start: int
    end: int
    text: str
    context: str
    input: str
    content_hash: str
    line_start: int
    line_end: int


# byte上限は要求サイズの目安であり、トークン数の換算には使わない。
# [ko] byte 상한은 요청 크기의 기준이며 토큰 수 환산에 사용하지 않는다.
# [en] The byte budget bounds payload size; it is not a token count conversion.
def chunks(title: str, audience: str, body: str) -> list[Chunk]:
    boundaries = {0, len(body)}
    headings = []
    offset = 0
    for line in body.splitlines(keepends=True):
        if HEADING.fullmatch(line.strip()):
            boundaries.add(offset)
            headings.append((offset, line.strip()))
        if not line.strip():
            boundaries.add(offset + len(line))
        offset += len(line)
    units = []
    points = sorted(boundaries)
    for start, end in zip(points, points[1:], strict=False):
        while start < end:
            stop, size = start, 0
            while stop < end and size + len(body[stop].encode()) <= SPECIFICATION["chunk_bytes"]:
                size += len(body[stop].encode())
                stop += 1
            if stop < end:
                split = max(body.rfind(c, start, stop) for c in ("\n", "。", "！", "？", ". "))
                if split >= start:
                    stop = split + 1
            units.append((start, stop))
            start = stop
    spans = []
    for start, end in units:
        if spans and len(body[spans[-1][0] : end].encode()) <= SPECIFICATION["chunk_bytes"]:
            spans[-1] = (spans[-1][0], end)
        else:
            spans.append((start, end))
    result = []
    for index, (start, end) in enumerate(spans):
        # 隣接段落が短ければ一緒に読み、手順直後の例外・注意を境界で切り離さない。
        # [ko] 짧은 인접 문단을 함께 넣어 절차 직후의 예외·주의가 경계에서 떨어지지 않게 한다.
        # [en] Include short neighbors to keep procedures and caveats together.
        before = [unit for unit in units if unit[1] == start]
        after = [unit for unit in units if unit[0] == end]
        if before and len(body[before[0][0] : start].encode()) <= SPECIFICATION["neighbor_bytes"]:
            start = before[0][0]
        if after and len(body[end : after[0][1]].encode()) <= SPECIFICATION["neighbor_bytes"]:
            end = after[0][1]
        heading = next((label for pos, label in reversed(headings) if pos <= start), "")
        context = f"節: {heading}" if heading else ""
        if index and spans[index - 1][1] == spans[index][0] and not heading:
            context = "文書内の続き。適用条件・例外は全文も確認してください。"
        text = body[start:end]
        value = SPECIFICATION["document_template"].format(
            title=title, audience=audience, context=context, body=text
        )
        result.append(
            Chunk(
                start,
                end,
                text,
                context,
                value,
                fingerprint(value),
                body.count("\n", 0, start) + 1,
                body.count("\n", 0, max(start, end - 1)) + 1,
            )
        )
    return result


def embed(client: OllamaClient, value: str) -> tuple[list[float], int]:
    if client.settings.ollama_embed_model != SPECIFICATION["model"]:
        raise OllamaError("AI_PROFILE_MISMATCH", "モデル名が検索用の規格と異なります。")
    result = client.embed(
        value,
        context_tokens=SPECIFICATION["context_tokens"],
        expected_digest=SPECIFICATION["digest"],
    )
    model = result["local_model"]
    if model["name"] != SPECIFICATION["model"] or model["digest"] != SPECIFICATION["digest"]:
        raise OllamaError("AI_PROFILE_MISMATCH", "モデルと検索用の規格が一致しません。")
    vector = result["embeddings"][0]
    tokens = result["prompt_eval_count"]
    if len(vector) != SPECIFICATION["dimensions"]:
        raise OllamaError("AI_DIMENSION_MISMATCH", "埋め込みの次元が検索用の規格と異なります。")
    norm = math.hypot(*vector)
    if not math.isfinite(norm) or norm == 0 or any(not math.isfinite(v) for v in vector):
        raise OllamaError("AI_INVALID_RESPONSE", "埋め込みベクトルが不正です。")
    if not 0 < tokens <= SPECIFICATION["context_tokens"]:
        raise OllamaError("AI_INPUT_REJECTED", "入力のトークン上限を確認できませんでした。")
    return [value / norm for value in vector], tokens
