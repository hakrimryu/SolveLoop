import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { errorMessage, isStale } from '../../lib/api'
import { formatDate } from '../../lib/business'
import { useBusinessCall, useLoad } from '../../lib/useBusiness'
import styles from './Radar.module.css'
import RadarReview from './RadarReview'
import type { HumanReview, ReviewContext } from './RadarReview'

type Member = { id: string; number: string; title: string; version: number; status: string; can_generate: boolean }
type Candidate = { id: string; ticket_ids: string[]; minimum_similarity: number; overlap: boolean; members: Member[]; pairs: { left: string; right: string; similarity: number }[] }
type Citation = { id: string; document_id: string; version_id: string; version_no: number; title: string; number: string; chunk_id: string; quote: string; quote_start: number; quote_end: number; href: string }
type Judgment = { status: 'covered' | 'uncovered' | 'unknown'; rationale?: string; missing_information?: string[]; citations?: Citation[]; error_code?: string; historical?: boolean; trace?: { mode: string; model?: string; prompt_version: string } }
type Summary = { total: number; analyzed: number; covered: number; uncovered: number; unknown: number; unanalyzed: number; rates: Record<'covered' | 'uncovered' | 'unknown', number>; coverage_on_analyzed: number | null; gap_status: string }
type Coverage = { id: string; candidate_id: string; run_id: string; created_at: string; current: boolean; corpus_hash: string; search_profile_id: string; policy: { prompt_version: string; top_k: number }; summary: Summary; judgments: Record<string, Judgment>; unanalyzed_ids: string[]; batches: { request_key: string; ticket_ids: string[]; status: string; error_code?: string; processed_ids?: string[] }[] }
type Run = { id: string; as_of: string; created_at: string; input_count: number; input_snapshot_hash: string; candidate_count: number; current: boolean; status: string; error_code?: string; request_key: string; parameters: { days: number; threshold: number; ticket_profile_id: string; group_rule: string }; candidates: Candidate[]; coverages: Coverage[]; reviews: HumanReview[]; review_context: ReviewContext }
const labels = { covered: '対応可能', uncovered: '文書不足', unknown: '判断不能', unanalyzed: '未分析' }
const statuses: Record<string, string> = { running: '処理中', complete: '完了', failed: '失敗', interrupted: '中断・新しい要求で再実行', pending: '一部未分析', gap: '不足候補', covered: '対応可能', unknown: '判断保留' }
const rate = (value: number) => `${(value * 100).toFixed(1)}%`

export default function Radar({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const [reviewDirty, setReviewDirty] = useState(false)
  const setDirty = useCallback((dirty: boolean) => { setReviewDirty(dirty); onDirtyChange(dirty) }, [onDirtyChange])
  const [params, setParams] = useSearchParams()
  const list = useLoad<{ items: Run[] }>('/radar/runs')
  const call = useBusinessCall()
  const [run, setRun] = useState<Run | null>(null)
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 19) + 'Z')
  const [days, setDays] = useState(30)
  const [threshold, setThreshold] = useState(0.92)
  const [candidateId, setCandidateId] = useState('')
  const [coverageId, setCoverageId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ path: string; body: unknown } | null>(null)
  const controller = useRef<AbortController | null>(null)
  const serial = useRef(0)
  const runId = params.get('radar')
  async function load(id: string) {
    const current = serial.current
    const value = await call<Run>(`/radar/runs/${id}`)
    if (current === serial.current) setRun(value)
    return value
  }
  useEffect(() => {
    const current = ++serial.current
    setRun(null); setSelected([]); setCandidateId(''); setCoverageId(''); setError('')
    if (runId) void call<Run>(`/radar/runs/${runId}`).then(value => { if (serial.current === current) setRun(value) }).catch(cause => { if (serial.current === current && !isStale(cause)) setError(errorMessage(cause)) })
    return () => { serial.current++; controller.current?.abort() }
  }, [runId, call])
  async function execute(path: string, body: unknown) {
    const abort = new AbortController()
    controller.current = abort
    setBusy(true); setError(''); setPending({ path, body })
    try {
      const value = await call<Run | Coverage>(path, body, { signal: abort.signal })
      if (abort.signal.aborted) return
      setPending(null)
      const id = 'run_id' in value ? value.run_id : value.id
      if ('run_id' in value) setCoverageId(value.id)
      if (id !== runId) setParams(previous => { previous.set('radar', id); return previous })
      else await load(id)
      list.reload()
    } catch (cause) {
      if (!isStale(cause)) setError(errorMessage(cause))
    } finally { if (controller.current === abort) { setBusy(false); controller.current = null } }
  }
  const group = run?.candidates?.find(item => item.id === candidateId)
  const rounds = run?.coverages?.filter(item => item.candidate_id === candidateId) ?? []
  const coverage = rounds.find(item => item.id === coverageId) ?? rounds.at(-1)
  const before = coverage ? rounds.filter(item => item.id !== coverage.id && item.created_at < coverage.created_at).at(-1) : undefined
  const canCompare = !!(before && coverage && run?.current && before.summary.unanalyzed === 0 && coverage.summary.unanalyzed === 0 && before.summary.unknown === 0 && coverage.summary.unknown === 0 && JSON.stringify(before.policy) === JSON.stringify(coverage.policy) && before.search_profile_id === coverage.search_profile_id)
  function choose(id: string) { setCandidateId(id); setCoverageId(''); setSelected([]) }
  const draftParams = new URLSearchParams()
  for (const id of selected) {
    const member = group?.members.find(item => item.id === id)
    if (member) { draftParams.append('source', id); draftParams.append('source_version', String(member.version)) }
  }
  return <section className={styles.radar} aria-labelledby="radar-heading">
    <div className={styles.heading}><h2 id="radar-heading">ナレッジ不足の候補（Radar）</h2><span className="sampleLabel">ローカルAI・人による確認が必要</span></div>
    <p>繰り返しの検出 → 公開文書の対応範囲を別途判定 → 解決記録を選んで下書きへ。判定だけで問い合わせの解決・承認・公開は行いません。</p>
    <form className={styles.conditions} onSubmit={event => { event.preventDefault(); if (!busy && !reviewDirty && !pending) void execute('/radar/runs', { request_key: crypto.randomUUID(), as_of: asOf, days, threshold }) }}>
      <label>基準日時（タイムゾーン必須）<input required value={asOf} disabled={busy || reviewDirty || !!pending} onChange={event => setAsOf(event.target.value)} /></label>
      <label>生成日時による直近の日数<input type="number" min={1} max={90} required value={days} disabled={busy || reviewDirty || !!pending} onChange={event => setDays(Number(event.target.value))} /></label>
      <label>類似度の閾値（仮）<input type="number" min={0.5} max={1} step="0.001" required value={threshold} disabled={busy || reviewDirty || !!pending} onChange={event => setThreshold(Number(event.target.value))} /></label>
      <button className="button buttonPrimary" disabled={busy || reviewDirty || !!pending}>繰り返しを検出</button>
    </form>
    <p className="muted">全状態・最大100件・異なる問い合わせ5件以上。本文の実埋め込みと全組み合わせのcosine類似度を使用します。閾値0.92と文書対応率80%は暫定値で、精度ではありません。</p>
    {error && <p role="alert" className="notice">{error}</p>}
    {busy && <div role="status"><p>分析中です。手動業務は引き続き利用できます。</p><button className="button" onClick={() => { controller.current?.abort(); setBusy(false); setError('受信を中止しました。サーバーの即時停止は保証されません。保存済み結果を確認するか、同じ要求を再取得してください。') }}>結果の受信を中止</button></div>}
    {pending && !busy && <div className="notice"><p>結果未確認の要求があります。要求キーを保持しています。</p><button className="button" onClick={() => { void execute(pending.path, pending.body) }}>同じ要求で結果を確認</button><button className="button" onClick={() => { setPending(null); list.reload() }}>要求を保留して履歴を取得</button></div>}
    <div className={styles.history}><label>分析履歴（最新20件）<select disabled={busy || reviewDirty} value={runId ?? ''} onChange={event => { setPending(null); setParams(previous => { if (event.target.value) previous.set('radar', event.target.value); else previous.delete('radar'); return previous }) }}><option value="">履歴を選択</option>{list.data?.items.map(item => <option key={item.id} value={item.id}>{formatDate(item.created_at)} · {statuses[item.status] ?? item.status} · {item.input_count}件{!item.current ? '・入力変更あり' : ''}</option>)}</select></label><button className="button" disabled={busy || reviewDirty} onClick={() => { list.reload(); if (runId) void load(runId).catch(cause => { if (!isStale(cause)) setError(errorMessage(cause)) }) }}>保存済み結果を再取得</button>{list.error && <p role="alert">{list.error}</p>}</div>
    {run && <>
      <p><strong>{statuses[run.status] ?? run.status}</strong> · 対象 {run.input_count}件 · 候補 {run.candidate_count}組 · 基準 {formatDate(run.as_of)} JST · 直近{run.parameters.days}日 · 閾値 {run.parameters.threshold}</p>
      {run.error_code && <p role="alert">検出失敗：{run.error_code}。正常な0件ではありません。条件を確認して新しい検出を実行してください。</p>}
      {!run.current && <p className="notice">原本・問い合わせ集合または規格が変更されています。過去の分析記録です。現在の資料として再利用せず、同じ条件で新しい検出を実行してください。</p>}
      <details><summary>入力と規格の追跡</summary><p>生成時刻で期間を選び、実行時の最新本文を固定します。過去時点の本文を復元する機能ではありません。</p><dl><dt>問い合わせ集合・版・入力hash</dt><dd>{run.input_snapshot_hash}</dd><dt>問い合わせprofile</dt><dd>{run.parameters.ticket_profile_id}</dd><dt>グループ規則</dt><dd>{run.parameters.group_rule}</dd><dt>要求キー</dt><dd>{run.request_key}</dd></dl></details>
      {run.status === 'complete' && !run.candidates.length && <p>この条件で5件以上の繰り返し候補は検出されませんでした。文書の対応可否は分析していません。</p>}
      {!!run.candidates?.length && <div className={styles.tableScroll}><table><caption>繰り返し候補。重なる候補の件数を合算しないでください。</caption><thead><tr><th>代表問い合わせ</th><th>件数</th><th>最小類似度</th><th>重複</th><th>根拠</th></tr></thead><tbody>{run.candidates.map(item => <tr key={item.id}><th>{item.members[0]?.title}</th><td>{item.ticket_ids.length}</td><td>{item.minimum_similarity.toFixed(3)}</td><td>{item.overlap ? '他候補と重複あり' : 'なし'}</td><td><button className="button" disabled={busy || reviewDirty} onClick={() => choose(item.id)}>構成・判定を確認</button></td></tr>)}</tbody></table></div>}
      {group && <section className={styles.detail} aria-label="候補の根拠と文書対応判定"><h3>構成問い合わせ {group.ticket_ids.length}件</h3><p>各構成員は他の全構成員と閾値以上です。連鎖的な類似だけでは結合しません。解決記録は人が1〜5件を明示選択します。</p>
        <ul className={styles.members}>{group.members.map(member => <li key={member.id}><label><input type="checkbox" checked={selected.includes(member.id)} disabled={busy || !member.can_generate || (!selected.includes(member.id) && selected.length >= 5)} onChange={event => setSelected(previous => event.target.checked ? [...previous, member.id] : previous.filter(id => id !== member.id))} /> 解決根拠に選ぶ</label><Link to={`/requests/${member.id}`}>{member.number} {member.title}</Link><span>{member.can_generate ? `有効な解決記録・版${member.version}` : '解決内容・日時または現在の入力条件を満たさないため選択不可'}</span></li>)}</ul>
        {selected.length ? <Link className="button" to={`/knowledge/reviews/new?${draftParams}`}>選択した解決記録{selected.length}件で下書きを作成</Link> : <p>有効な解決記録を選択してください。解決済みの根拠がなければAI下書きは生成できません。</p>}
        <details><summary>全組み合わせの類似度</summary><ul>{group.pairs.map(pair => <li key={`${pair.left}:${pair.right}`}>{group.members.find(item => item.id === pair.left)?.number} ↔ {group.members.find(item => item.id === pair.right)?.number}：{pair.similarity.toFixed(4)}</li>)}</ul></details>
        <RadarReview key={group.id} runId={run.id} candidateId={group.id} members={group.members} context={run.review_context} reviews={run.reviews.filter(item => item.candidate_id === group.id)} coverageId={coverage?.id} current={run.current} disabled={busy || !!pending} onDirtyChange={setDirty} onSaved={() => load(run.id)} />
        <h3>AIによる公開文書の対応判定</h3><p>検索は問い合わせごとに最大3箇所。主題の近さだけでは解決可能と判断しません。対象・症状・手順・条件・例外の確認を支援します。</p>
        <button className="button buttonPrimary" disabled={busy || reviewDirty || !!pending || !run.current || run.status !== 'complete'} onClick={() => { void execute(`/radar/runs/${run.id}/candidates/${group.id}/coverage`, { request_key: crypto.randomUUID() }) }}>新しい判定記録を開始（承認後の再分析もこちら）</button>
        {!!rounds.length && <label className={styles.round}>判定記録<select disabled={busy || reviewDirty} value={coverage?.id ?? ''} onChange={event => setCoverageId(event.target.value)}>{rounds.map((item, index) => <option key={item.id} value={item.id}>#{index + 1} {formatDate(item.created_at)} · {item.summary.analyzed}/{item.summary.total}件分析</option>)}</select></label>}
        {coverage && <>
          {!coverage.current && <p className="notice">過去の判定です。公開文書・検索規格・原本の変更により、理由と引用の再表示を停止しています。過去の件数は履歴として保持します。新しい判定を開始してください。</p>}
          <p>判定範囲 {coverage.summary.analyzed}/{coverage.summary.total}件 · {statuses[coverage.summary.gap_status]}（80%は仮の運用基準）</p>
          <ul>{(['covered', 'uncovered', 'unknown', 'unanalyzed'] as const).map(key => <li key={key}>{labels[key]} {coverage.summary[key]}件 / 全{coverage.summary.total}件（{rate(coverage.summary[key] / coverage.summary.total)}）</li>)}</ul>
          <p>分析済みだけの対応率 {coverage.summary.coverage_on_analyzed === null ? '未算出' : rate(coverage.summary.coverage_on_analyzed)}。全構成員の対応率とは分けて表示しています。</p>
          {!!coverage.unanalyzed_ids.length && <button className="button" disabled={busy || reviewDirty || !!pending || !coverage.current} onClick={() => { void execute(`/radar/coverage/${coverage.id}/batches`, { request_key: crypto.randomUUID(), ticket_ids: coverage.unanalyzed_ids.slice(0, 3) }) }}>次の未分析{Math.min(3, coverage.unanalyzed_ids.length)}件を明示分析</button>}
          <p className="muted">1バッチ3件・経過時間予算240秒。各通信のsocket待機上限とは別です。厳密な強制停止や即時キャンセルは保証しません。unknownの再試行は新しい判定記録で行います。</p>
          {coverage.batches.map(batch => <p key={batch.request_key}>バッチ {statuses[batch.status] ?? batch.status} · 要求{batch.ticket_ids.length}件 / 完了{batch.processed_ids?.length ?? 0}件 {batch.error_code} · キー {batch.request_key}</p>)}
          {group.members.map(member => { const value = coverage.judgments[member.id]; return <details key={member.id} className={styles.judgment}><summary>{member.number} · {value ? labels[value.status] : '未分析'}</summary>{value?.historical ? <p>過去記録の件数のみ表示しています。原文・公開状態を再確認してください。</p> : value ? <><p>{value.rationale}</p>{value.error_code && <p>エラー：{value.error_code}</p>}<ul>{value.missing_information?.map(text => <li key={text}>{text}</li>)}</ul>{value.citations?.map(source => <div key={`${source.chunk_id}:${source.quote_start}`}><Link to={source.href}>{source.number} {source.title} v{source.version_no} 原文へ</Link><blockquote>{source.quote}</blockquote><p>文書 {source.document_id} / 版 {source.version_id} / chunk {source.chunk_id} / 位置 [{source.quote_start}, {source.quote_end})</p></div>)}<p className="muted">{value.trace?.mode === 'live' ? `実推論 ${value.trace.model} / ${value.trace.prompt_version}` : '検索結果またはエラー。生成判定と区別しています。'}。引用の一致は意味判断の正しさを保証しません。</p></> : <p>この問い合わせはまだ処理していません。</p>}</details> })}
          <h3>承認前後の比較</h3>{before ? <><p>同じrun・候補・問い合わせ集合・本文hash・閾値・グループ規則で比較します。分母は全{coverage.summary.total}件のままです。公開資料の集合は変わり得ます。</p>{canCompare ? <p>対応可能 {before.summary.covered}/{before.summary.total}件 → {coverage.summary.covered}/{coverage.summary.total}件 · {rate(before.summary.rates.covered)} → {rate(coverage.summary.rates.covered)}。AIによる参考判定です。実測の業務改善・精度ではありません。</p> : <p>未分析・判断不能・原本または判定規格の変更があるため、単純な改善比較を表示しません。</p>}</> : <p>別の判定記録はまだありません。下書き保存 → 検索準備 → 別操作の人による承認後に、新しい判定を開始してください。</p>}
        </>}
      </section>}
    </>}
  </section>
}
