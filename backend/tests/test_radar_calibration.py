import json
import os
from pathlib import Path

import pytest

from app.ai.config import AISettings
from app.ai.knowledge import embed
from app.ai.ollama import OllamaClient
from app.ai.radar import TICKET_PROFILE, TICKET_SPEC, groups


@pytest.mark.skipif(os.getenv("RUN_OLLAMA_TESTS") != "1", reason="実ローカルモデルの明示実行専用。")
def test_live_small_calibration_report():
    """少量の校正資料。保留評価や精度の測定とは区別する。"""
    data = json.loads(
        (Path(__file__).parent / "fixtures/radar_calibration.json").read_text(encoding="utf-8")
    )
    client = OllamaClient(AISettings())
    vectors = [
        embed(client, TICKET_SPEC["input_template"].format(body=body))[0] for body in data["bodies"]
    ]

    def score(pair):
        return sum(a * b for a, b in zip(vectors[pair[0]], vectors[pair[1]], strict=True))

    print(
        json.dumps(
            {
                "purpose": data["purpose"],
                "profile": TICKET_PROFILE,
                "specification": TICKET_SPEC,
                "same_problem_min": min(map(score, data["same_problem_pairs"])),
                "different_problem_max": max(map(score, data["different_problem_pairs"])),
                "threshold": 0.92,
                "group_sizes": [
                    len(group["ticket_ids"])
                    for group in groups(
                        {str(index): vector for index, vector in enumerate(vectors)}, 0.92
                    )
                ],
            },
            ensure_ascii=False,
        )
    )
    assert all(len(vector) == 768 for vector in vectors)
