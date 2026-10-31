from copy import deepcopy
from datetime import UTC, datetime, timedelta
from threading import Lock
from time import monotonic
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import AwareDatetime, Field, model_validator
from sqlalchemy import select

from app.accounts import no_body, no_query
from app.ai.knowledge import PROFILE_ID, SPECIFICATION, embed, fingerprint
from app.ai.ollama import OllamaError
from app.ai.radar import (
    BATCH_SECONDS,
    DETECTION_SECONDS,
    GROUP_RULE,
    MAX_BATCH,
    MAX_TICKETS,
    MIN_GROUP,
    PROMPT_VERSION,
    TICKET_PROFILE,
    TICKET_SPEC,
    TOP_K,
    check_time,
    groups,
    judge,
)
from app.ai.tickets import CHAT_DIGEST, CHAT_MODEL
from app.auth import DbSession, FullAuthenticated, require_csrf, require_json, require_operator
from app.business import Input, finish, not_found
from app.errors import ApiError
from app.knowledge import lock_tickets
from app.knowledge_generation import current_actor
from app.knowledge_search import (
    Client,
    complete,
    preparation,
    retrieve_public_chunks,
    search_state,
    supported_profile,
)
from app.models import (
    EmbeddingProfile,
    KnowledgeDocument,
    KnowledgeVersion,
    RadarCoverage,
    RadarRun,
    Ticket,
    TicketEmbedding,
)
from app.ticket_analysis import knowledge_source

router = APIRouter(prefix="/api/v1/radar", tags=["繰り返し問い合わせと知識不足"])
RADAR_LOCK = Lock()
POLICY = {
    "model": CHAT_MODEL,
    "digest": CHAT_DIGEST,
    "prompt_version": PROMPT_VERSION,
    "top_k": TOP_K,
    "batch_limit": MAX_BATCH,
    "budget_seconds": BATCH_SECONDS,
    "coverage_target": 0.8,
}


class RunInput(Input):
    request_key: UUID
    as_of: AwareDatetime
    days: Annotated[int, Field(strict=True, ge=1, le=90)] = 30
    threshold: Annotated[float, Field(strict=True, ge=0.5, le=1, allow_inf_nan=False)] = 0.92


class CoverageInput(Input):
    request_key: UUID


class BatchInput(CoverageInput):
    ticket_ids: list[UUID] = Field(min_length=1, max_length=MAX_BATCH)

    @model_validator(mode="after")
    def distinct(self):
        if len(set(self.ticket_ids)) != len(self.ticket_ids):
            raise ValueError("問い合わせの重複は指定できません。")
        return self


def changed():
    raise ApiError(
        409,
        "RADAR_CONTEXT_CHANGED",
        "問い合わせ・公開文書・分析条件が変わりました。新しい分析を開始してください。",
    )


def snapshot(ticket):
    return {
        "ticket_id": str(ticket.id),
        "version": ticket.version,
        "input_hash": fingerprint({"body": ticket.body}),
        "state_hash": fingerprint(
            {
                "title": ticket.title,
                "body": ticket.body,
                "status": ticket.status,
                "resolution": ticket.resolution,
                "resolved_at": ticket.resolved_at.isoformat() if ticket.resolved_at else None,
                "version": ticket.version,
            }
        ),
    }


def scope(session, as_of, days):
    rows = list(
        session.scalars(
            select(Ticket)
            .where(Ticket.created_at >= as_of - timedelta(days=days), Ticket.created_at <= as_of)
            .order_by(Ticket.id)
            .limit(MAX_TICKETS + 1)
            .execution_options(populate_existing=True)
        )
    )
    if len(rows) > MAX_TICKETS:
        raise ApiError(
            422, "RADAR_SCOPE_TOO_LARGE", "分析対象は100件までです。期間を絞ってください。"
        )
    if any(not row.body.strip() for row in rows):
        raise ApiError(
            422, "RADAR_INPUT_MISSING", "本文のない問い合わせがあります。原本を確認してください。"
        )
    return rows


def current_inputs(session, run):
    try:
        return (
            [snapshot(row) for row in scope(session, run.as_of, run.parameters["days"])]
            == run.inputs
            and run.parameters["ticket_profile_id"] == TICKET_PROFILE
            and run.parameters["group_rule"] == GROUP_RULE
        )
    except ApiError:
        return False


def require_current(session, run):
    if run.status != "complete" or not current_inputs(session, run):
        changed()


def corpus(session, lock=False):
    state = search_state(session, lock=lock, exclusive=lock)
    supported_profile(session, state.active_profile_id)
    rows = session.execute(
        select(KnowledgeDocument, KnowledgeVersion)
        .join(KnowledgeVersion, KnowledgeDocument.published_version_id == KnowledgeVersion.id)
        .order_by(KnowledgeDocument.id)
    ).all()
    manifest = []
    for doc, version in rows:
        ready = preparation(session, version.id, state.active_profile_id)
        if (
            not doc.publication_suspended
            and version.status == "approved"
            and (
                ready is None
                or ready.indexed_row_version != version.row_version
                or not complete(session, ready)
            )
        ):
            raise ApiError(503, "SEARCH_NOT_READY", "現在の公開文書の検索準備が完了していません。")
        manifest.append(
            [
                str(doc.id),
                str(version.id),
                version.row_version,
                doc.publication_suspended,
                ready.content_hash if ready else None,
                str(ready.id) if ready else None,
            ]
        )
    return fingerprint(
        {"revision": state.revision, "profile": state.active_profile_id, "documents": manifest}
    ), state


def find_run(session, run_id):
    row = session.get(RadarRun, run_id)
    if row is None:
        not_found()
    return row


def candidate(run, candidate_id):
    item = next((item for item in run.candidates if item["id"] == candidate_id), None)
    if item is None:
        not_found()
    return item


def public_sources(session, items):
    sources = []
    for item in items:
        version = session.get(KnowledgeVersion, UUID(item["version_id"]))
        if version is None or version.body[item["body_start"] : item["body_end"]] != item["text"]:
            raise OllamaError("AI_INVALID_EVIDENCE", "検索箇所と公開原文の位置を検証できません。")
        sources.append(knowledge_source(item))
    return sources


def run_dto(session, run, detail=True):
    valid = current_inputs(session, run)
    result = {
        "id": str(run.id),
        "as_of": run.as_of,
        "parameters": run.parameters,
        "status": "interrupted"
        if run.status == "running" and run.lease_until < datetime.now(UTC)
        else run.status,
        "error_code": run.error_code,
        "created_at": run.created_at,
        "completed_at": run.completed_at,
        "input_count": len(run.inputs),
        "input_snapshot_hash": fingerprint(run.inputs),
        "current": valid,
        "candidate_count": len(run.candidates),
        "request_key": str(run.request_key),
    }
    if detail:
        rows = {
            str(row.id): row
            for row in session.scalars(
                select(Ticket).where(
                    Ticket.id.in_([UUID(item["ticket_id"]) for item in run.inputs])
                )
            )
        }
        result["candidates"] = [
            {
                **group,
                "members": [
                    {
                        "id": ident,
                        "number": rows[ident].number,
                        "title": rows[ident].title,
                        "version": rows[ident].version,
                        "status": rows[ident].status,
                        "can_generate": valid
                        and rows[ident].status == "resolved"
                        and bool(
                            rows[ident].resolution
                            and rows[ident].resolution.strip()
                            and rows[ident].resolved_at
                        ),
                    }
                    if ident in rows
                    else {
                        "id": ident,
                        "number": "削除済み",
                        "title": "原本を参照できません",
                        "can_generate": False,
                    }
                    for ident in group["ticket_ids"]
                ],
            }
            for group in run.candidates
        ]
    return result


def coverage_dto(session, coverage, run, current_hash=None):
    members = candidate(run, coverage.candidate_id)["ticket_ids"]
    if current_hash is None:
        try:
            current_hash = corpus(session)[0]
        except ApiError:
            current_hash = "unavailable"
    valid = (
        current_inputs(session, run)
        and coverage.corpus_hash == current_hash
        and coverage.policy == POLICY
        and coverage.search_profile_id == PROFILE_ID
    )
    counts = {
        status: sum(value["status"] == status for value in coverage.judgments.values())
        for status in ("covered", "uncovered", "unknown")
    }
    analyzed = sum(counts.values())
    # 分母は固定した全構成問い合わせ。未分析や不明を対応可能へ振り替えない。
    summary = {
        "total": len(members),
        "analyzed": analyzed,
        **counts,
        "unanalyzed": len(members) - analyzed,
        "rates": {key: value / len(members) for key, value in counts.items()},
        "coverage_on_analyzed": counts["covered"] / analyzed if analyzed else None,
        "gap_status": "pending"
        if analyzed < len(members)
        else "unknown"
        if counts["unknown"]
        else "gap"
        if counts["covered"] / len(members) < 0.8
        else "covered",
    }
    return {
        "id": str(coverage.id),
        "run_id": str(run.id),
        "candidate_id": coverage.candidate_id,
        "created_at": coverage.created_at,
        "corpus_hash": coverage.corpus_hash,
        "search_profile_id": coverage.search_profile_id,
        "policy": coverage.policy,
        "current": valid,
        "summary": summary,
        "judgments": coverage.judgments
        if valid
        else {
            ident: {"status": value["status"], "historical": True}
            for ident, value in coverage.judgments.items()
        },
        "batches": [
            {
                **batch,
                "status": "interrupted"
                if batch["status"] == "running"
                and datetime.fromisoformat(batch["lease_until"]) < datetime.now(UTC)
                else batch["status"],
            }
            for batch in coverage.batches
        ],
        "unanalyzed_ids": [ident for ident in members if ident not in coverage.judgments],
    }


@router.get("/runs", dependencies=[Depends(require_operator), Depends(no_body), Depends(no_query)])
def list_runs(auth: FullAuthenticated, session: DbSession):
    return {
        "items": [
            run_dto(session, row, False)
            for row in session.scalars(
                select(RadarRun).order_by(RadarRun.created_at.desc(), RadarRun.id).limit(20)
            )
        ]
    }


@router.get(
    "/runs/{run_id}", dependencies=[Depends(require_operator), Depends(no_body), Depends(no_query)]
)
def get_run(run_id: UUID, auth: FullAuthenticated, session: DbSession):
    run = find_run(session, run_id)
    result = run_dto(session, run)
    result["coverages"] = [
        coverage_dto(session, row, run)
        for row in session.scalars(
            select(RadarCoverage)
            .where(RadarCoverage.run_id == run.id)
            .order_by(RadarCoverage.created_at, RadarCoverage.id)
        )
    ]
    return result


@router.post(
    "/runs", dependencies=[Depends(require_operator), Depends(require_json), Depends(no_query)]
)
def detect(
    data: RunInput, request: Request, auth: FullAuthenticated, session: DbSession, client: Client
):
    require_csrf(request, auth, request.headers.get("X-CSRF-Token"))
    digest = fingerprint(data.model_dump(mode="json"))
    existing = session.scalar(
        select(RadarRun).where(
            RadarRun.actor_id == auth[1].id, RadarRun.request_key == data.request_key
        )
    )
    if existing:
        if existing.request_hash != digest:
            raise ApiError(
                409, "IDEMPOTENCY_KEY_REUSED", "同じ要求キーを異なる分析条件に使えません。"
            )
        return run_dto(session, existing)
    if data.as_of > datetime.now(UTC) + timedelta(seconds=5):
        raise ApiError(422, "VALIDATION_ERROR", "基準日時は現在以前を指定してください。")
    if not RADAR_LOCK.acquire(blocking=False):
        raise ApiError(503, "AI_BUSY", "別のRadar分析を処理中です。")
    ident = None
    deadline = monotonic() + DETECTION_SECONDS
    try:
        actor = current_actor(request, session)
        existing = session.scalar(
            select(RadarRun).where(
                RadarRun.actor_id == actor.id, RadarRun.request_key == data.request_key
            )
        )
        if existing:
            if existing.request_hash != digest:
                raise ApiError(
                    409, "IDEMPOTENCY_KEY_REUSED", "同じ要求キーを異なる分析条件に使えません。"
                )
            return run_dto(session, existing)
        active = session.scalar(
            select(RadarRun.id).where(
                RadarRun.actor_id == actor.id,
                RadarRun.status == "running",
                RadarRun.lease_until > datetime.now(UTC),
            )
        )
        if active:
            raise ApiError(
                409,
                "RADAR_RUN_RUNNING",
                "検出は実行中です。履歴から保存済み結果を確認してください。",
            )
        rows = scope(session, data.as_of, data.days)
        inputs = [snapshot(row) for row in rows]
        bodies = {str(row.id): row.body for row in rows}
        vectors, computed = {}, {}
        for row, item in zip(rows, inputs, strict=True):
            cached = session.get(TicketEmbedding, (row.id, TICKET_PROFILE))
            if (
                cached
                and cached.ticket_version == row.version
                and cached.input_hash == item["input_hash"]
            ):
                vectors[str(row.id)] = cached.embedding
        now = datetime.now(UTC)
        run = RadarRun(
            actor_id=actor.id,
            request_key=data.request_key,
            request_hash=digest,
            as_of=data.as_of,
            parameters={
                "days": data.days,
                "threshold": data.threshold,
                "minimum_group": MIN_GROUP,
                "ticket_profile_id": TICKET_PROFILE,
                "ticket_profile_specification": TICKET_SPEC,
                "group_rule": GROUP_RULE,
                "time_field": "created_at",
                "statuses": ["open", "in_progress", "resolved"],
                "maximum_tickets": MAX_TICKETS,
            },
            inputs=inputs,
            candidates=[],
            status="running",
            created_at=now,
            lease_until=now + timedelta(seconds=DETECTION_SECONDS + 120),
        )
        session.add(run)
        session.flush()
        ident = run.id
        session.commit()
        session.rollback()
        for item in inputs:
            check_time(deadline)
            ticket_id = item["ticket_id"]
            if ticket_id not in vectors:
                vector, tokens = embed(
                    client,
                    TICKET_SPEC["input_template"].format(body=bodies[ticket_id]),
                    deadline=deadline,
                )
                vectors[ticket_id] = vector
                computed[ticket_id] = (vector, tokens)
        found = groups(vectors, data.threshold)
        check_time(deadline)
        current_actor(request, session)
        lock_tickets(session, {UUID(item["ticket_id"]) for item in inputs})
        run = session.get(RadarRun, ident)
        if not current_inputs(session, run):
            changed()
        profile = session.get(EmbeddingProfile, TICKET_PROFILE)
        if profile is None:
            session.add(
                EmbeddingProfile(id=TICKET_PROFILE, specification=TICKET_SPEC, created_at=now)
            )
            session.flush()
        elif profile.specification != TICKET_SPEC:
            changed()
        for item in inputs:
            ticket_id = item["ticket_id"]
            if ticket_id in computed:
                vector, tokens = computed[ticket_id]
                cached = session.get(TicketEmbedding, (UUID(ticket_id), TICKET_PROFILE))
                if cached is None:
                    cached = TicketEmbedding(ticket_id=UUID(ticket_id), profile_id=TICKET_PROFILE)
                    session.add(cached)
                cached.ticket_version, cached.input_hash = item["version"], item["input_hash"]
                cached.embedding, cached.input_tokens, cached.created_at = (
                    vector,
                    tokens,
                    datetime.now(UTC),
                )
        run.candidates, run.status, run.completed_at = found, "complete", datetime.now(UTC)
        session.flush()
        return finish(session, run_dto(session, run))
    except Exception as error:
        session.rollback()
        if ident:
            run = session.get(RadarRun, ident)
            run.status = "failed"
            run.error_code = getattr(error, "code", "ANALYSIS_FAILED")
            run.completed_at = datetime.now(UTC)
            session.commit()
        if isinstance(error, OllamaError):
            from app.knowledge_search import ai_error

            ai_error(error)
        raise
    finally:
        RADAR_LOCK.release()


@router.post(
    "/runs/{run_id}/candidates/{candidate_id}/coverage",
    dependencies=[Depends(require_operator), Depends(require_json), Depends(no_query)],
)
def start_coverage(
    run_id: UUID,
    candidate_id: str,
    data: CoverageInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
):
    actor = current_actor(request, session)
    run = find_run(session, run_id)
    group = candidate(run, candidate_id)
    previous = session.scalar(
        select(RadarCoverage).where(
            RadarCoverage.actor_id == actor.id, RadarCoverage.request_key == data.request_key
        )
    )
    if previous:
        if previous.run_id != run_id or previous.candidate_id != group["id"]:
            raise ApiError(409, "IDEMPOTENCY_KEY_REUSED", "同じ要求キーを別の候補には使えません。")
        return coverage_dto(session, previous, run)
    corpus_hash, _ = corpus(session, lock=True)
    lock_tickets(session, {UUID(item["ticket_id"]) for item in run.inputs})
    require_current(session, run)
    row = RadarCoverage(
        run_id=run.id,
        candidate_id=group["id"],
        actor_id=actor.id,
        request_key=data.request_key,
        corpus_hash=corpus_hash,
        search_profile_id=PROFILE_ID,
        policy=POLICY,
        judgments={},
        batches=[],
        created_at=datetime.now(UTC),
    )
    session.add(row)
    session.flush()
    return finish(session, coverage_dto(session, row, run, corpus_hash))


@router.post(
    "/coverage/{coverage_id}/batches",
    dependencies=[Depends(require_operator), Depends(require_json), Depends(no_query)],
)
def analyze_batch(
    coverage_id: UUID,
    data: BatchInput,
    request: Request,
    auth: FullAuthenticated,
    session: DbSession,
    client: Client,
):
    require_csrf(request, auth, request.headers.get("X-CSRF-Token"))
    if not RADAR_LOCK.acquire(blocking=False):
        raise ApiError(503, "AI_BUSY", "別のRadar分析を処理中です。")
    claimed = False
    key = str(data.request_key)
    ids = sorted(str(ident) for ident in data.ticket_ids)
    deadline = monotonic() + BATCH_SECONDS
    try:
        current_actor(request, session)
        corpus_hash, state = corpus(session, lock=True)
        row = session.scalar(
            select(RadarCoverage).where(RadarCoverage.id == coverage_id).with_for_update()
        )
        if row is None:
            not_found()
        run = find_run(session, row.run_id)
        previous = next((batch for batch in row.batches if batch["request_key"] == key), None)
        if previous:
            if previous["ticket_ids"] != ids:
                raise ApiError(
                    409, "IDEMPOTENCY_KEY_REUSED", "同じ要求キーを別の問い合わせには使えません。"
                )
            return coverage_dto(session, row, run, corpus_hash)
        lock_tickets(session, {UUID(item["ticket_id"]) for item in run.inputs})
        require_current(session, run)
        if (
            row.corpus_hash != corpus_hash
            or row.policy != POLICY
            or row.search_profile_id != PROFILE_ID
        ):
            changed()
        members = candidate(run, row.candidate_id)["ticket_ids"]
        if any(ident not in members or ident in row.judgments for ident in ids):
            raise ApiError(
                409,
                "RADAR_BATCH_INVALID",
                "未分析の構成問い合わせだけを選択してください。再判定は新しい記録で実行します。",
            )
        batches = deepcopy(row.batches)
        for batch in batches:
            if batch["status"] == "running":
                if datetime.fromisoformat(batch["lease_until"]) > datetime.now(UTC):
                    raise ApiError(
                        409,
                        "RADAR_BATCH_RUNNING",
                        "この判定は実行中です。結果を再取得してください。",
                    )
                batch["status"] = "interrupted"
        targets = {ident: session.get(Ticket, UUID(ident)) for ident in ids}
        tickets = {
            ident: {"id": ident, "title": value.title, "body": value.body}
            for ident, value in targets.items()
        }
        batches.append(
            {
                "request_key": key,
                "ticket_ids": ids,
                "status": "running",
                "lease_until": (
                    datetime.now(UTC) + timedelta(seconds=BATCH_SECONDS + 120)
                ).isoformat(),
                "started_at": datetime.now(UTC).isoformat(),
            }
        )
        row.batches = batches
        session.commit()
        claimed = True
        session.rollback()
        judgments = {}
        for ident in ids:
            if monotonic() >= deadline:
                break
            try:
                target = tickets[ident]
                vector, _ = embed(
                    client,
                    SPECIFICATION["query_template"].format(
                        query=target["title"] + "\n" + target["body"]
                    ),
                    deadline=deadline,
                )
                current_actor(request, session)
                run = find_run(session, run.id)
                require_current(session, run)
                current_hash, state = corpus(session)
                if current_hash != corpus_hash:
                    changed()
                sources = public_sources(
                    session, retrieve_public_chunks(session, vector, state, TOP_K)
                )
                session.rollback()
                judgments[ident] = judge(client, target, sources, deadline)
            except OllamaError as error:
                session.rollback()
                judgments[ident] = {
                    "status": "unknown",
                    "rationale": "AI・通信・形式または出典の検証に失敗しました。",
                    "missing_information": ["新しい判定記録で再実行してください。"],
                    "citations": [],
                    "error_code": error.code,
                }
        current_actor(request, session)
        current_hash, _ = corpus(session, lock=True)
        row = session.scalar(
            select(RadarCoverage).where(RadarCoverage.id == coverage_id).with_for_update()
        )
        run = find_run(session, row.run_id)
        lock_tickets(session, {UUID(item["ticket_id"]) for item in run.inputs})
        require_current(session, run)
        if current_hash != corpus_hash:
            changed()
        # 公開状態は検索状態の排他ロック下で再確認する。過去の引用を現在の根拠として保存しない。
        for value in judgments.values():
            for source in value["citations"]:
                actual = retrieve_public_chunks(
                    session,
                    [1.0] + [0.0] * 767,
                    search_state(session),
                    TOP_K,
                    chunk_ids=[UUID(source["id"])],
                )
                if not actual or public_sources(session, actual)[0] != {
                    key: val
                    for key, val in source.items()
                    if key not in {"quote", "quote_start", "quote_end"}
                }:
                    changed()
        batches = deepcopy(row.batches)
        batch = next(batch for batch in batches if batch["request_key"] == key)
        if batch["status"] != "running" or datetime.fromisoformat(
            batch["lease_until"]
        ) <= datetime.now(UTC):
            raise ApiError(
                409,
                "RADAR_BATCH_EXPIRED",
                "処理の所有期限が切れました。保存済み範囲を確認して新しい要求で続けてください。",
            )
        batch.update(
            status="complete",
            processed_ids=list(judgments),
            budget_exhausted=len(judgments) < len(ids),
            completed_at=datetime.now(UTC).isoformat(),
        )
        row.batches, row.judgments = batches, {**row.judgments, **judgments}
        session.flush()
        return finish(session, coverage_dto(session, row, run, current_hash))
    except Exception as error:
        session.rollback()
        if claimed:
            row = session.scalar(
                select(RadarCoverage).where(RadarCoverage.id == coverage_id).with_for_update()
            )
            batches = deepcopy(row.batches)
            batch = next(batch for batch in batches if batch["request_key"] == key)
            if batch["status"] == "running":
                batch.update(status="failed", error_code=getattr(error, "code", "ANALYSIS_FAILED"))
            row.batches = batches
            session.commit()
        raise
    finally:
        RADAR_LOCK.release()
