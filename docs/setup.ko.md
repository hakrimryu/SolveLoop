[日本語](setup.md) · [한국어](setup.ko.md) · [English](setup.en.md)

# 실행 방법

[프로젝트 소개](../README.ko.md)

Windows / PowerShell에서 합성 자료가 준비된 **전용 데모**를 실행하는 순서입니다. 초기 자료는 직원 15명·문의 100건·승인 문서 15건입니다. 별도 DB와 포트를 사용하며 일반 환경의 설정은 바꾸지 않습니다.

## 준비

- Docker Desktop의 Linux 엔진
- Node.js 22.19.0 이상 22계열 · npm 10계열
- Windows 호스트에서 실행 중인 Ollama

생성은 Qwen3 8B, 임베딩은 EmbeddingGemma2를 사용합니다. 모델이 없다면 호스트에서 아래를 실행하세요. 다운로드에는 네트워크가 필요하지만 추론은 로컬에서 처리합니다.

```powershell
ollama pull qwen3:8b
ollama pull embeddinggemma-2:270m-q8_0-text
```

검색 profile은 모델 digest도 검사합니다. 불일치가 나면 아래 상세 자료의 고정 모델 규격을 확인하세요.

## 데모 시작

아래 명령은 **저장소 루트**에서 한 줄씩 실행하고, 성공한 뒤 다음으로 넘어갑니다. 기존 환경이 있다면 같은 데모인지 먼저 확인하세요. 일반 `compose.yaml`과 병합하지 않습니다.

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml build demo-api
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml up -d --wait demo-db
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api alembic upgrade head
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo validate
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo inspect --confirm solveloop-demo/solveloop_demo
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo load --confirm solveloop-demo/solveloop_demo
```

`inspect`의 `identity_matches: true`를 확인합니다. DB 이름뿐 아니라 실제 전용 DB 표식까지 검사합니다. 같은 자료를 다시 적재해도 기존 변경을 덮어쓰지 않습니다. 초기 문서의 승인은 합성 과거 이력이며 이번에 사람이 승인한 기록은 아닙니다.

다음으로 실제 Ollama 임베딩을 준비하고 API를 시작합니다.

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.ai backfill
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.ai activate
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml up -d --wait demo-api
```

`backfill`에 실패하면 완료된 자료는 보존되므로 원인을 확인하고 같은 명령으로 재개할 수 있습니다. 모든 공개 문서 준비가 끝난 뒤 `activate`가 성공해야 의미 검색을 사용할 수 있습니다.

## 화면 열기

다른 PowerShell을 저장소 루트에서 열어 실행합니다.

```powershell
cd frontend
npm.cmd ci
$env:SOLVELOOP_API_TARGET='http://127.0.0.1:8020'
npm.cmd run dev -- --host 127.0.0.2 --port 5180 --strictPort
```

[데모 화면](http://127.0.0.2:5180)을 엽니다. 일반 환경과 cookie를 분리하려고 `127.0.0.2`를 사용합니다.

| 계정 | 용도 | 비밀번호 |
| --- | --- | --- |
| `employee` | 직원의 질문·문의·문서 검색 | `SolveLoop-Demo-2026!` |
| `operator` | 문의 응대·지식 리뷰·계정 관리 | `SolveLoop-Demo-2026!` |

공개된 로컬 데모 전용 비밀번호입니다. 직원으로 질문·해결 확인·미해결 인계를 해 보고, 담당자로 응대·해결·지식 초안·승인·재검색의 흐름을 확인하면 됩니다. AI 생성과 지식 공개는 별개이며 공개 전 사람이 검토합니다.

## 중지와 문제 확인

프론트는 `Ctrl+C`로 종료합니다. DB와 API는 아래처럼 중지하며 저장 자료는 유지됩니다.

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml stop
```

- 검색 준비가 실패하면 호스트 Ollama와 두 모델을 확인하세요. API 컨테이너는 `host.docker.internal:11434`로 접속합니다.
- `8020`·`5180` 포트가 이미 사용 중이면 실행 중인 같은 데모를 재사용할지 확인하세요. 임의로 다른 서비스를 종료하지 않습니다.
- 재개 시에는 API 기동과 프론트 실행을 반복하면 됩니다. 데이터 리셋은 선택 작업이며 일반 실행에 필요하지 않습니다.

## 설정·라이선스

고정 모델 digest·검색 규격은 [검색 설정](../backend/app/ai/knowledge.py)과 [생성 설정](../backend/app/ai/tickets.py)에 있습니다. 데모는 [고정 합성 입력](../demo/manifest.json)을 사용합니다. 영상에 사용한 [IT 회사 문서 50건](../demo/it-company/knowledge.json)은 별도 자료로, 이 초기 데모에는 포함되지 않습니다.

OSS 고지는 [프론트엔드](../frontend/public/THIRD_PARTY_NOTICES.txt)·[백엔드](../backend/THIRD_PARTY_NOTICES.txt)에 보존합니다. 모델은 [Qwen3](https://ollama.com/library/qwen3:8b)·[EmbeddingGemma2](https://ollama.com/library/embeddinggemma-2:270m-q8_0-text)의 배포 조건을 따릅니다. 모델 가중치는 포함하지 않습니다. 프로젝트 자체 라이선스는 아직 정하지 않았습니다.
