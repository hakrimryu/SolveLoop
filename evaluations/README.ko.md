[日本語](README.md) · [한국어](README.ko.md) · [English](README.en.md)

# 평가 요약

[프로젝트 소개](../README.ko.md)

실제 API·PostgreSQL·로컬 Ollama를 연결해 업무 흐름과 AI 동작을 확인했습니다. 아래 수치는 각 보고서의 고정 합성 입력과 측정 시점을 기준으로 합니다. 실제 기업의 문의 감소나 업무 시간 절감 효과를 측정한 결과는 아닙니다.

## 확인한 내용

직원 질문→미해결 인계→담당자 응대·해결→지식 초안·사람 승인→재검색을 확인했습니다. 권한, 오래된 버전의 수정 거부, 중복 등록 방지, 공개 문서만 검색하는 경계도 검증했습니다. 고정 응답 테스트와 실제 모델 평가는 구분했습니다.

## 대표 결과

| 평가 | 입력과 관측 결과 | 해석 |
| --- | --- | --- |
| 검색 기준선 | 정답 문서가 있는 20질문×3회, Recall@5 **60/60** | 문서 검색 결과이며 답변 내용의 정확도와는 별도 |
| Radar | 반복 그룹 **4/4**를 매회 탐지(3회), 문서 부족 판정 precision **5/8** | 반복 탐지와 문서 대응 가능성 판단은 다른 문제 |
| 직원 AI 안내 | 합성 공개 문서 3건·질문 8건, 단일 요청 **1.152~2.838초** | API 처리 시간이며 직원의 해결 시간은 아님 |

검색·Radar 기준선은 2026-10-31, 직원 안내는 2026-11-01 측정입니다. 같은 입력의 반복 실행을 독립 표본으로 합산하지 않습니다.

## 남은 과제

- 동시 직원 질문 2건의 후속 측정에서 1건이 `AI_UNAVAILABLE`로 실패했습니다. 동시 처리 안정성은 추가 검증이 필요합니다.
- AI의 적용 조건 해석과 초안의 주의사항 추출에 오류가 남습니다. 구조·인용 검사를 통과해도 내용이 충분하다는 뜻은 아니며, 실제 이용자의 초안 품질 리뷰는 완료되지 않았습니다.

## 평가 데이터·재실행

- [고정 입력](datasets/)·[기준선 집계](reports/baseline-v1/summary.json)·[직원 안내 실측](reports/employee-guidance-v1/records.jsonl)·[동시 요청](reports/employee-guidance-v1/concurrency.json)
- [불채택 후보 비교](reports/quality-v2/comparison.json)·[후보 patch](quality-v2-candidate.patch)·[고정 hash](quality-v2-manifest.json)
- 평가 당시 고정 규약 원문: [v1](frozen/protocol-v1.txt)·[v2](frozen/protocol-v2.txt). 내부 식별자를 포함한 원자료입니다.

실제 모델 재실행은 [infrastructure/compose.evaluation.yaml](../infrastructure/compose.evaluation.yaml)의 전용 DB로 제한합니다. [실행기](run.py)·[비교 실행기](quality.py)·[집계기](score.py)에 인자가 정의돼 있습니다. 새 평가는 합성 자료 준비와 DB 쓰기를 수행하므로 기존 결과를 백업하고 일반 이용 중인 DB에서는 실행하지 않습니다. 인자만 확인하는 예시:

```powershell
docker compose -p solveloop-evaluation -f infrastructure/compose.evaluation.yaml run --build --rm --no-deps eval python /evaluation/run.py --help
```

고정 입력·분모 검사는 [test_evaluation.py](test_evaluation.py)·[test_quality.py](test_quality.py)에 있습니다. 과거 비교 대상은 `ad49f2437977f4726a6bea40f4639cbbd820afc9`와 보존 patch로 복원합니다. 현재 코드의 재실행을 과거와 같은 측정으로 취급하지 않습니다.
