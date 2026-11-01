[日本語](setup.md) · [한국어](setup.ko.md) · [English](setup.en.md)

# Run the project

[Project overview](../README.en.md)

These Windows / PowerShell steps start a **dedicated demo** with 15 synthetic employees, 100 tickets and 15 approved documents. It uses a separate DB and ports without changing normal-environment settings.

## Prerequisites

- Docker Desktop with the Linux engine
- Node.js 22.19.0 or later within 22.x · npm 10.x
- Ollama running on the Windows host

Generation uses Qwen3 8B; embeddings use EmbeddingGemma2. If missing, download the models on the host. Downloads need network access; inference runs locally.

```powershell
ollama pull qwen3:8b
ollama pull embeddinggemma-2:270m-q8_0-text
```

The search profile also checks model digests. If they differ, consult the pinned model specification in the detailed reference below.

## Start the demo

Run these **one line at a time from the repository root**, checking success before continuing. If resources already exist, confirm they belong to this demo. Do not merge with the normal `compose.yaml`.

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml build demo-api
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml up -d --wait demo-db
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api alembic upgrade head
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo validate
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo inspect --confirm solveloop-demo/solveloop_demo
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.demo load --confirm solveloop-demo/solveloop_demo
```

Check `identity_matches: true` in `inspect`. The guard checks the actual dedicated DB identity, not just its name. Loading identical inputs preserves existing edits. Initial approvals are synthetic historical records, not new human approvals.

Prepare embeddings with live Ollama, then start the API.

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.ai backfill
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml run --rm --no-deps demo-api python -m app.ai activate
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml up -d --wait demo-api
```

If `backfill` fails, completed work remains. Fix the cause and rerun the same command. Semantic search is available once all public documents are prepared and `activate` succeeds.

## Open the UI

Open another PowerShell at the repository root.

```powershell
cd frontend
npm.cmd ci
$env:SOLVELOOP_API_TARGET='http://127.0.0.1:8020'
npm.cmd run dev -- --host 127.0.0.2 --port 5180 --strictPort
```

Open the [demo UI](http://127.0.0.2:5180). Host `127.0.0.2` separates cookies from the normal environment.

| Account | Purpose | Password |
| --- | --- | --- |
| `employee` | Employee questions, tickets and document search | `SolveLoop-Demo-2026!` |
| `operator` | Support, knowledge review and account management | `SolveLoop-Demo-2026!` |

This public password is for the local demo only. As an employee, try a question, resolution feedback and handoff. As an operator, try support, resolution, a knowledge draft, approval and retrieval. AI generation does not publish a document; human review comes first.

## Stop and troubleshoot

Stop the frontend with `Ctrl+C`. Stop the DB/API as follows; saved data remains.

```powershell
docker compose -p solveloop-demo -f infrastructure/compose.demo.yaml stop
```

- If search preparation fails, check host Ollama and both models. The API container connects through `host.docker.internal:11434`.
- If `8020` or `5180` is occupied, check whether the same demo is already running. Do not terminate unrelated services.
- To resume, start the API and frontend again. Reset is optional, not part of ordinary startup.

## Configuration and licenses

Pinned model digests and retrieval specifications are in the [retrieval settings](../backend/app/ai/knowledge.py) and [generation settings](../backend/app/ai/tickets.py). The demo uses [fixed synthetic inputs](../demo/manifest.json). The [50 IT-company documents](../demo/it-company/knowledge.json) used in the video are a separate dataset and are not included in this initial demo.

OSS notices are retained for the [frontend](../frontend/public/THIRD_PARTY_NOTICES.txt) and [backend](../backend/THIRD_PARTY_NOTICES.txt). Model use follows the distribution terms for [Qwen3](https://ollama.com/library/qwen3:8b) and [EmbeddingGemma2](https://ollama.com/library/embeddinggemma-2:270m-q8_0-text). Model weights are not bundled. The project's own license has not been selected.
