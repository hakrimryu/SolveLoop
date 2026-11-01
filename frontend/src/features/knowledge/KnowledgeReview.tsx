import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { api, ApiError, errorMessage, isStale } from '../../lib/api'
import { eventText, formatDate, knowledgeLabels, reviewApi, reviewUrl, validateKnowledge } from '../../lib/business'
import type { KnowledgeInput, Page, Review, ReviewItem, Source, SourceRef, Ticket, TicketItem } from '../../lib/business'
import { useBusinessCall, useLoad } from '../../lib/useBusiness'
import { LoadState } from '../../components/BusinessState'
import { KnowledgeBody, KnowledgeUnavailable } from './Knowledge'
import type { KnowledgeProps } from './Knowledge'
import KnowledgeManagement from './KnowledgeManagement'
import KnowledgeAI from './KnowledgeAI'
import RelatedKnowledge from './RelatedKnowledge'
import type { GeneratedDraft } from './KnowledgeAI'
import DiscardDialog, { trapDialogFocus } from '../../components/DiscardDialog'
import common from '../requests/Requests.module.css'
import styles from './Knowledge.module.css'

const inputOf = (saved?: Review): KnowledgeInput => saved ? { title: saved.title, audience: saved.audience, body: saved.body, department_id: saved.department?.id ?? null } : { title: '', audience: '', body: '', department_id: null }
const refsOf = (sources: Source[]): SourceRef[] => sources.map(s => ({ ticket_id: s.ticket_id, expected_ticket_version: s.ticket_version }))
const sourceOf = (ticket: Ticket): Source => ({ ticket_id: ticket.id, ticket_number: ticket.number, ticket_version: ticket.version, title: ticket.title, body: ticket.body, resolution: ticket.resolution!, department: ticket.department, resolved_at: ticket.resolved_at!, updated_at: ticket.updated_at, content_hash: '' })

export default function KnowledgeReview(props: KnowledgeProps) {
  const { documentId, version } = useParams()
  const [params] = useSearchParams()
  return props.role !== 'operator' ? <KnowledgeUnavailable /> : documentId ? <Existing {...props} key={`${documentId}:${version}`} documentId={documentId} version={version!} /> : <New {...props} key={JSON.stringify([params.getAll('source'), params.getAll('source_version')])} sourceIds={params.getAll('source')} expectedVersions={params.getAll('source_version')} />
}
function Existing(props: KnowledgeProps & { documentId: string; version: string }) {
  const resource = useLoad<Review>(`/knowledge/${props.documentId}/versions/${props.version}`)
  return resource.data ? <Editor {...props} initial={resource.data} /> : <><h1 tabIndex={-1}>ナレッジレビュー</h1><LoadState error={resource.error} reload={resource.reload} /></>
}
function New(props: KnowledgeProps & { sourceIds: string[]; expectedVersions: string[] }) {
  const call = useBusinessCall()
  const [tickets, setTickets] = useState<Ticket[] | null>(props.sourceIds.length ? null : [])
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const sourceKey = JSON.stringify(props.sourceIds)
  const versionKey = JSON.stringify(props.expectedVersions)
  useEffect(() => {
    let active = true
    const ids: string[] = JSON.parse(sourceKey)
    const versions: string[] = JSON.parse(versionKey)
    if (!ids.length) return
    if (ids.length > 5 || new Set(ids).size !== ids.length || (versions.length && versions.length !== ids.length)) { setError('生成の解決根拠は重複のない1〜5件を指定してください。'); return }
    void Promise.all(ids.map(id => call<Ticket>(`/tickets/${id}`))).then(values => {
      if (!active) return
      if (values.some((value, index) => value.status !== 'resolved' || !value.resolution?.trim() || !value.resolved_at || (versions.length && value.version !== Number(versions[index])))) { setError('選択後に根拠が変更されたか、有効な解決内容・日時がありません。Radarまたは原本で選び直してください。'); return }
      setTickets(values); setError('')
    }).catch(cause => { if (active && !isStale(cause)) setError(errorMessage(cause)) })
    return () => { active = false }
  }, [sourceKey, versionKey, revision, call])
  if (!tickets) return <><h1 tabIndex={-1}>根拠の問い合わせを確認</h1><LoadState error={error} reload={() => setRevision(value => value + 1)} /><Link to="/dashboard">Radarに戻る</Link></>
  return <Editor {...props} initialSources={tickets} />
}
function Editor({ initial, initialSources = [], departments, onDirtyChange }: KnowledgeProps & { initial?: Review; initialSources?: Ticket[] }) {
  const initialSource = initialSources[0]
  const [saved, setSaved] = useState(initial)
  const [input, setInput] = useState<KnowledgeInput>(() => initial ? inputOf(initial) : initialSource ? { title: initialSource.title, audience: '', body: initialSource.resolution!, department_id: initialSource.department?.id ?? null } : inputOf())
  const [sources, setSources] = useState<Source[]>(initial?.sources ?? initialSources.map(sourceOf))
  const [refs, setRefs] = useState<SourceRef[]>(() => refsOf(initial?.sources ?? initialSources.map(sourceOf)))
  const [current, setCurrent] = useState<Record<string, Ticket>>({})
  const [sourceQuery, setSourceQuery] = useState('')
  const [sourceMatches, setSourceMatches] = useState<TicketItem[] | null>(null)
  const [candidate, setCandidate] = useState<Ticket | null>(null)
  const [preview, setPreview] = useState(false)
  const [errors, setErrors] = useState<ReturnType<typeof validateKnowledge> | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [latest, setLatest] = useState<Review | null>(null)
  const [uncertainCreate, setUncertainCreate] = useState(false)
  const [createChecked, setCreateChecked] = useState(false)
  const [createMatches, setCreateMatches] = useState<ReviewItem[] | null>(null)
  const [confirm, setConfirm] = useState<'approve' | 'reject' | null>(null)
  const [reason, setReason] = useState('')
  const [discard, setDiscard] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generated, setGenerated] = useState<GeneratedDraft | null>(null)
  const createKey = useRef(crypto.randomUUID())
  const copyKey = useRef(crypto.randomUUID())
  const call = useBusinessCall()
  const navigate = useNavigate()
  const location = useLocation()
  const errorRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const editable = !saved || saved.status === 'draft'
  // 送信中・結果不明中は根拠も固定し、送った内容と画面の選択のずれを防ぐ。
  // [ko] 전송 중·결과 미확인 중에는 근거도 고정해 전송 내용과 화면 선택이 어긋나지 않게 한다.
  // [en] Freeze evidence during submission and unknown outcomes so selections match the sent payload.
  const sourcesLocked = busy || uncertainCreate || generating
  const refsDirty = JSON.stringify(refs) !== JSON.stringify(refsOf(saved?.sources ?? []))
  const inputDirty = editable && (JSON.stringify(input) !== JSON.stringify(inputOf(saved)) || refsDirty || !!generated)
  const dirty = inputDirty || !!reason || !!generated || generating
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useLayoutEffect(() => {
    if (!confirm) return
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current!.showModal(); cancelRef.current?.focus()
    return () => { dialogRef.current?.close(); if (previous?.isConnected) previous.focus() }
  }, [confirm])
  function showError(text: string) { setError(text); requestAnimationFrame(() => errorRef.current?.focus()) }
  function accepted(value: Review) { setSaved(value); setInput(inputOf(value)); setSources(value.sources); setRefs(refsOf(value.sources)); setCurrent({}); setBlocked(false); setLatest(null); setError(''); setGenerated(null) }
  async function refresh() {
    if (!saved || busy) return
    setBusy(true)
    try { const value = await call<Review>(reviewApi(saved)); setLatest(value); setBlocked(true); setMessage('最新の保存内容を取得しました。編集中の入力は保持しています。') }
    catch (cause) { if (!isStale(cause)) showError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function prepareSearch() {
    if (!saved || busy || generating || blocked || inputDirty) return
    setBusy(true); setPreparing(true); setError(''); setMessage('検索用ベクトルを準備しています。まだ承認・公開しません。')
    try {
      const result = await call<Review>(`${reviewApi(saved)}/prepare-search`, { expected_version: saved.row_version, expected_document_version: saved.document_row_version })
      setSaved(result); setMessage('検索準備が完了しました。保存内容を確認して、別途承認してください。')
    } catch (cause) { if (!isStale(cause)) { setMessage(''); showError(errorMessage(cause)); if (cause instanceof ApiError && cause.status === 409) setBlocked(true) } }
    finally { setBusy(false); setPreparing(false) }
  }
  // 下書き保存と公開を分け、根拠を明示変更した場合だけ置換集合を送る。
  // [ko] 초안 저장과 공개를 구분하고 근거를 명시적으로 바꾼 경우에만 교체 집합을 전송한다.
  // [en] Keep draft saving separate from publication; send source replacements only when edited.
  async function save(event?: FormEvent, retry = false) {
    event?.preventDefault()
    if (busy || generating || blocked || uncertainCreate && !retry) return
    const validation = validateKnowledge(input); setErrors(validation)
    if (Object.values(validation).some(Boolean)) { showError('入力内容を確認してください。入力は保持されています。'); return }
    setBusy(true); setError(''); setMessage('')
    if (uncertainCreate) { setCreateMatches(null); setCreateChecked(false) }
    const generation = api.snapshot().generation
    try {
      const provenance = generated ? { generation_id: generated.generation_id } : {}
      const result = await call<Review>(saved ? reviewApi(saved) : '/knowledge/drafts', saved ? { ...input, ...provenance, expected_version: saved.row_version, ...(refsDirty || generated ? { source_refs: refs } : {}) } : { ...input, source_refs: refs, ...provenance }, { method: saved ? 'PATCH' : 'POST', ...(!saved ? { idempotencyKey: createKey.current } : {}) })
      api.assertCurrent(generation)
      if (!saved) { onDirtyChange(false); navigate(reviewUrl(result), { replace: true }); return }
      accepted(result); onDirtyChange(false); setMessage('下書きを保存しました。まだ公開されていません。')
      const current = await call<Review>(reviewApi(result)); api.assertCurrent(generation); accepted(current)
    } catch (cause) { if (!isStale(cause)) { showError(errorMessage(cause, true)); const unknown = !(cause instanceof ApiError) || cause.status >= 500; setBlocked(!!saved && (unknown || cause instanceof ApiError && cause.status === 409)); if (!saved) setUncertainCreate(unknown) } }
    finally { setBusy(false) }
  }
  // 未保存の編集は承認せず、保存版と文書版の両方を指定して判断を送る。
  // [ko] 미저장 편집은 승인하지 않고 저장 버전과 문서 버전을 모두 지정해 검토 결과를 전송한다.
  // [en] Review saved content only, supplying both draft and document versions to detect conflicts.
  async function submitReview(event: FormEvent) {
    event.preventDefault()
    if (!saved || !confirm || busy || generating || blocked) return
    if (inputDirty || confirm === 'approve' && saved.search_preparation?.status !== 'ready') return
    if (confirm === 'reject' && (!reason.trim() || [...reason.trim()].length > 1000)) { showError('差し戻しの理由を1〜1000文字で入力してください。'); return }
    const operation = confirm
    setBusy(true); setError('')
    const generation = api.snapshot().generation
    try {
      const result = await call<Review>(`${reviewApi(saved)}/${operation}`, { expected_version: saved.row_version, expected_document_version: saved.document_row_version, ...(operation === 'reject' ? { reason } : {}) })
      api.assertCurrent(generation)
      accepted(result); setReason(''); setConfirm(null); onDirtyChange(false); setMessage(operation === 'approve' ? result.publication_suspended ? '承認しました。公開停止中のため、再公開するまで社員には表示されません。' : '承認しました。社員全員の検索に公開されています。' : '理由を記録して差し戻しました。この版は変更せず保存します。')
      const current = await call<Review>(reviewApi(result)); api.assertCurrent(generation); accepted(current)
    } catch (cause) { if (!isStale(cause)) { showError(errorMessage(cause, true)); setBlocked(cause instanceof ApiError ? cause.status === 409 || cause.status >= 500 : true) } }
    finally { setBusy(false) }
  }
  async function copy() {
    if (!saved || busy || blocked) return
    setBusy(true)
    try {
      const result = await call<Review>(`/knowledge/${saved.document_id}/drafts`, { base_version_no: saved.latest_version_no, expected_document_version: saved.document_row_version }, { idempotencyKey: copyKey.current })
      onDirtyChange(false); navigate(reviewUrl(result))
    } catch (cause) { if (!isStale(cause)) { showError(errorMessage(cause, true)); setBlocked(true) } }
    finally { setBusy(false) }
  }
  async function fetchSource(id: string, add = false) {
    if (sourcesLocked) return
    setBusy(true)
    try { const ticket = await call<Ticket>(`/tickets/${id}`); if (add) setCandidate(ticket); else setCurrent(values => ({ ...values, [id]: ticket })) }
    catch (cause) { if (!isStale(cause)) showError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  // 原本を確認した版を選ぶだけにし、下書き保存まで根拠の置換を確定しない。
  // [ko] 확인한 원본 버전을 선택만 하고 초안을 저장할 때까지 근거 교체를 확정하지 않는다.
  // [en] Select the reviewed source version locally; commit evidence replacement only on draft save.
  function confirmSource(ticket: Ticket) {
    if (sourcesLocked || ticket.status !== 'resolved') return
    if (!sources.some(s => s.ticket_id === ticket.id)) setSources([...sources, sourceOf(ticket)])
    setRefs([...refs.filter(r => r.ticket_id !== ticket.id), { ticket_id: ticket.id, expected_ticket_version: ticket.version }]); setCandidate(null); setSourceMatches(null); setSourceQuery('')
  }
  function reset() { setInput(inputOf(saved)); setRefs(refsOf(saved?.sources ?? [])); setSources(saved?.sources ?? []); setDiscard(false); setErrors(null); setGenerated(null) }
  function applyGeneration(value: GeneratedDraft) {
    setInput(previous => ({ ...previous, ...value.draft })); setSources(value.sources); setRefs(refsOf(value.sources)); setGenerated(value); setErrors(null); setError(''); setMessage('AI案を編集欄に反映しました。内容を確認・修正して保存してください。根拠を変更した場合は再生成・再確認が必要です。')
  }
  return <>
    <Link className={common.back} to={`/knowledge/reviews${saved ? location.search : ''}`}>← ナレッジレビューへ戻る</Link>
    <div className={common.heading}><div><p className="eyebrow">{saved ? `${saved.number} / ${knowledgeLabels[saved.status]} v${saved.version_no} / 保存版 ${saved.row_version}` : generated ? 'AI案を編集中 / 未保存' : '新規作成 / 未保存'}</p><h1 tabIndex={-1}>{saved?.title ?? 'ナレッジの下書きを作成'}</h1><p className="muted">{saved ? `更新 ${formatDate(saved.updated_at)} JST` : '解決根拠を確認し、手動入力またはローカルAI案から社員向けの文書を作成します。'}</p></div>{saved && <button className="button" disabled={busy || generating} onClick={() => { void refresh() }}>最新の保存内容を取得</button>}</div>
    {message && <p role="status" className={common.success}>{message}</p>}{error && <div ref={errorRef} tabIndex={-1} className={common.errorBanner} role="alert"><p>{error}</p>{errors && <ul>{Object.entries(errors).filter(([, value]) => value).map(([key, value]) => <li key={key}><a href={`#knowledge-${key}`} onClick={() => setPreview(false)}>{value}</a></li>)}</ul>}</div>}
    {blocked && <section className="notice"><h2>保存内容を確認してください</h2><p>入力と理由を保持しています。自動再送や版番号の自動更新はしません。</p><button className="button" disabled={busy} onClick={() => { void refresh() }}>最新の保存内容を取得</button>{latest && <><p>{knowledgeLabels[latest.status]} v{latest.version_no} / 保存版 {latest.row_version} / 文書版 {latest.document_row_version}</p><p className={common.body}>{latest.body}</p><p>根拠の警告 {latest.source_issues.length}件 · 下書き {latest.draft_version_no ?? 'なし'} · 最新版 v{latest.latest_version_no}</p><button className="button" onClick={() => { setSaved(latest); if (!refsDirty) { setSources(latest.sources); setRefs(refsOf(latest.sources)) } setBlocked(false); setLatest(null); setError(''); setMessage('最新の保存内容を確認しました。保持した入力を見直してください。') }}>最新の版を確認済み・入力を保持して続ける</button></>}</section>}
    {uncertainCreate && <div className="notice"><p>登録結果は未確認です。下書き一覧で作成済みか確認してください。入力はこの画面に保持しています。</p><button className="button" disabled={busy} onClick={() => { setBusy(true); void call<Page<ReviewItem>>('/knowledge/reviews?page_size=100').then(data => setCreateMatches(data.items)).catch(cause => { if (!isStale(cause)) showError(errorMessage(cause)) }).finally(() => setBusy(false)) }}>下書き一覧で結果を確認</button>{createMatches && <><p>最新の未承認文書 {createMatches.length}件を取得しました。番号・件名・内容を確認してください。</p>{createMatches.map(item => <p key={item.version_id}><Link to={reviewUrl(item)}>{item.number} v{item.version_no} {item.title}</Link></p>)}<label><input type="checkbox" checked={createChecked} onChange={e => setCreateChecked(e.target.checked)} />一覧で結果を確認しました</label><button className="button" disabled={!createChecked || busy} onClick={() => { void save(undefined, true) }}>同じ登録キーで明示的に再試行する</button></>}</div>}
    {saved?.published_version_no && editable && <p className={styles.warning}>改訂中も、社員には承認済み v{saved.published_version_no} を表示します。 <Link to={`/knowledge/${saved.document_id}`}>現在の公開版を読む</Link></p>}
    {saved?.status === 'rejected' && <p className={styles.warning}>この版と差し戻し理由は保存され、変更できません。同じ文書の次の版で再作成できます。</p>}
    {editable && <><ol className={styles.steps} aria-label="文書公開までの手順"><li>根拠を確認・編集</li><li>{saved ? '下書き保存済み' : '下書きを保存'}</li><li>{saved?.search_preparation?.status === 'ready' && !inputDirty ? '検索準備済み' : '検索準備'}</li><li>人が確認して承認</li></ol><div className={styles.editorTools}><details><summary>既存の公開文書を確認</summary><RelatedKnowledge query={input.title} disabled={busy || blocked || uncertainCreate || generating} /></details><details><summary>解決記録からAI下書き案を生成</summary><KnowledgeAI refs={refs} disabled={busy || blocked || uncertainCreate} applied={generated?.generation_id ?? null} onBusy={setGenerating} onApply={applyGeneration} /></details></div></>}
    {saved && inputDirty && <details className={common.section}><summary>保存内容と編集中の内容を比較</summary><div className={styles.comparison}><div><h3>保存した内容</h3><p>{saved.title}</p><p className={common.body}>{saved.body}</p></div><div><h3>編集中・未保存</h3><p>{input.title}</p><p className={common.body}>{input.body}</p></div></div></details>}
    {generated && <p className="notice">生成案ID：{generated.generation_id} · 保存期限 {formatDate(generated.expires_at)} JST。期限切れ・原本や根拠選択の変更時は入力を保持して再生成し、案を再確認して反映してください。</p>}
    <div className={styles.editorGrid}><section className={common.section} aria-label="文書の編集と確認">
      {editable && <div className={styles.modeBar}><button className="button" aria-pressed={!preview} onClick={() => setPreview(false)}>編集</button><button className="button" aria-pressed={preview} onClick={() => setPreview(true)}>プレビュー</button><span>{inputDirty ? '未保存の変更あり' : saved ? '保存済み' : '未保存'}</span></div>}
      {preview || !editable ? <><h2 className={styles.previewTitle}>{input.title || '（件名は未入力）'}</h2><p className={common.help}>{editable ? '編集中のプレビューです。保存・承認するまで公開されません。' : knowledgeLabels[saved!.status]}</p><KnowledgeBody input={editable ? input : saved!} /></> : <form onSubmit={save} noValidate onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }}><fieldset disabled={busy || uncertainCreate}>
        <label className={common.field} htmlFor="knowledge-title">件名 <span className={common.required}>必須</span></label><input className={styles.fullWidth} id="knowledge-title" value={input.title} maxLength={120} required aria-invalid={!!errors?.title} aria-describedby="knowledge-title-error" onChange={e => setInput({ ...input, title: e.target.value })} /><p id="knowledge-title-error" className={common.error}>{errors?.title}</p>
        <label className={common.field} htmlFor="knowledge-audience">適用対象 <span className={common.required}>必須</span></label><input className={styles.fullWidth} id="knowledge-audience" value={input.audience} maxLength={300} required aria-invalid={!!errors?.audience} aria-describedby="knowledge-audience-error" onChange={e => setInput({ ...input, audience: e.target.value })} /><p id="knowledge-audience-error" className={common.error}>{errors?.audience}</p>
        <label className={common.field} htmlFor="knowledge-department">担当部署</label><select className={styles.fullWidth} id="knowledge-department" value={input.department_id ?? ''} onChange={e => setInput({ ...input, department_id: e.target.value || null })}><option value="">未定</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}{saved?.department && !departments.some(d => d.id === saved.department!.id) && <option value={saved.department.id}>{saved.department.name}（現在の記録）</option>}</select><p className={common.help}>下書きでは未定にできます。承認前に有効な担当部署を確定してください。</p>
        <label className={common.field} htmlFor="knowledge-body">本文 <span className={common.required}>必須</span></label><textarea className={`${styles.fullWidth} ${styles.editorBody}`} id="knowledge-body" value={input.body} maxLength={20000} required aria-invalid={!!errors?.body} aria-describedby="knowledge-body-help knowledge-body-error" onChange={e => setInput({ ...input, body: e.target.value })} /><p id="knowledge-body-help" className={common.help}>20000文字以内。症状・手順・例外や注意事項を記載します。改行を保持し、HTML・Markdownは実行しません。</p><p id="knowledge-body-error" className={common.error}>{errors?.body}</p>
        <div className={common.actions}><button type="button" className="button" disabled={generating || !inputDirty && !generated} onClick={() => setDiscard(true)}>編集を取り消す</button><button className="button buttonPrimary" disabled={blocked || generating}>{preparing ? '検索準備中…' : busy ? '保存中…' : '下書きを保存'}</button></div><p className={common.help}>保存は公開ではありません。保存した内容を確認してから承認してください。</p>
      </fieldset></form>}
    </section><aside className={`${common.section} ${styles.evidence}`} aria-label="担当者用の解決根拠"><h2>元になった解決記録</h2><p className={common.help}>担当者専用。保存時の写しは公開文書に含みません。原本の変更を確認し、採用する版を明示して保存します。</p>
      {!sources.length && <p>問い合わせの根拠は関連付けられていません。手動の規程文書なども作成できます。</p>}
      {sources.map(source => { const issue = saved?.source_issues.find(issue => issue.ticket_id === source.ticket_id); const selected = refs.find(ref => ref.ticket_id === source.ticket_id); const ticket = current[source.ticket_id]; return <div key={source.ticket_id}>
        <Link target="_blank" rel="noopener noreferrer" to={`/requests/${source.ticket_id}`}>{source.ticket_number} を開く</Link><p className={styles.evidenceText}>{source.title}</p><p className={common.meta}>保存した写し：問い合わせ版 {source.ticket_version} · {formatDate(source.updated_at)} JST</p><h3>問い合わせ内容の写し</h3><p className={styles.evidenceText}>{source.body}</p><h3>解決内容の写し</h3><p className={styles.evidenceText}>{source.resolution}</p>
        {issue && <p role="alert" className={styles.warning}>{issue.code === 'SOURCE_NOT_RESOLVED' ? '原本は未解決です。承認できません。' : '原本が変わりました。写しとの比較・再確認が必要です。'}</p>}
        {editable && <><p className={common.help}>{selected ? `保存する根拠の版：${selected.expected_ticket_version}` : '根拠から外す予定です。保存まで反映されません。'}</p><button className="button" disabled={sourcesLocked} onClick={() => { void fetchSource(source.ticket_id) }}>現在の原本と比較</button>{selected && <button className="button" disabled={sourcesLocked} onClick={() => setRefs(refs.filter(ref => ref.ticket_id !== source.ticket_id))}>根拠から外す</button>}
          {ticket && <div className={styles.warning}><h3>現在の原本 · 版 {ticket.version}</h3><p>{ticket.title} / {ticket.status === 'resolved' ? '解決済み' : '未解決'}</p><p className={styles.evidenceText}>{ticket.body}</p><p className={styles.evidenceText}>{ticket.resolution}</p><button className="button" disabled={ticket.status !== 'resolved' || sourcesLocked} onClick={() => confirmSource(ticket)}>原本を確認済み・この版を根拠に選ぶ</button><p>選択後に下書きを保存し、内容を再確認してから承認してください。</p></div>}</>}
      </div> })}
      {editable && <form onSubmit={e => { e.preventDefault(); if (!sourcesLocked) { setBusy(true); void call<Page<TicketItem>>(`/tickets?status=resolved&q=${encodeURIComponent(sourceQuery.trim())}`).then(data => { setSourceMatches(data.items); setCandidate(null) }).catch(cause => { if (!isStale(cause)) showError(errorMessage(cause)) }).finally(() => setBusy(false)) } }}><label className={common.field}>解決済み問い合わせを検索<input className={styles.fullWidth} disabled={sourcesLocked} value={sourceQuery} maxLength={200} placeholder="件名・問い合わせ番号" onChange={e => setSourceQuery(e.target.value)} /></label><button className="button" disabled={sourcesLocked || refs.length >= 20}>根拠の候補を検索</button>{sourceMatches && <><p className={common.help}>検索結果 {sourceMatches.length}件（最大20件）。条件を絞って解決記録を選んでください。</p>{sourceMatches.map(item => <p key={item.id}>{item.number} {item.title} <button type="button" className="button" disabled={sourcesLocked} onClick={() => { void fetchSource(item.id, true) }}>解決記録を確認</button></p>)}</>}{candidate && <div className={styles.warning}><p>{candidate.number} / 版 {candidate.version} / {candidate.title}</p><p className={styles.evidenceText}>{candidate.body}</p><p className={styles.evidenceText}>{candidate.resolution ?? '未解決のため根拠には使用できません。'}</p><button type="button" className="button" disabled={sourcesLocked || candidate.status !== 'resolved' || refs.length >= 20} onClick={() => confirmSource(candidate)}>内容を確認して根拠に追加</button></div>}</form>}
    </aside></div>
    {editable && <section className={styles.reviewActions}><h2>検索準備 → 保存した版を確認して承認</h2><p>{!saved ? '先に下書きを保存してください。' : inputDirty ? '未保存の変更があります。保存後に検索準備を実行してください。' : `${saved.number} / v${saved.version_no} の保存済み内容が対象です。`}</p><p>{!inputDirty && saved?.search_preparation?.status === 'ready' ? `検索準備済み（${saved.search_preparation.chunk_count}箇所）。承認はまだ行っていません。` : '新しい版の公開には検索準備が必要です。準備失敗時も既存の公開版は維持します。'}</p><p>ローカルAIが停止していても手動の保存・差し戻しは利用できます。準備済みの版はAIを再実行せず承認できます。</p><div><button className="button" disabled={!saved || inputDirty || busy || generating || blocked || !!saved.source_issues.length} onClick={() => { void prepareSearch() }}>{preparing ? '検索準備中…' : '保存した版の検索準備'}</button><button className="button" disabled={!saved || inputDirty || busy || generating || blocked} onClick={() => { setError(''); setConfirm('reject') }}>理由を入力して差し戻す</button><button className="button buttonPrimary" disabled={!saved || inputDirty || busy || generating || blocked || !saved.department || !!saved.source_issues.length || saved.search_preparation?.status !== 'ready'} onClick={() => { setError(''); setConfirm('approve') }}>承認して公開</button></div>{saved?.source_issues.length ? <p className={styles.warning}>根拠に警告があります。原本を比較して再確認した根拠と本文を保存してください。</p> : null}</section>}
    {saved && !editable && <section className="notice">{saved.published_version_no && <Link className="button" to={`/knowledge/${saved.document_id}`}>現在の公開版を読む</Link>}{saved.draft_version_no ? <Link className="button" to={reviewUrl({ document_id: saved.document_id, version_no: saved.draft_version_no })}>作成中の下書きを開く</Link> : saved.version_no === saved.latest_version_no ? <button className="button buttonPrimary" disabled={busy || blocked} onClick={() => { void copy() }}>次の版の下書きを作成</button> : <Link className="button" to={reviewUrl({ document_id: saved.document_id, version_no: saved.latest_version_no })}>最新の版を確認</Link>}</section>}
    {saved && <section className={`${common.section} ${styles.historySection}`}><h2>保存・レビューの履歴</h2><p className={common.help}>作成 {saved.created_by.display_name}{saved.reviewed_by ? ` · レビュー ${saved.reviewed_by.display_name}` : ''} · サーバーの業務記録</p><ol className={common.history}>{saved.events.map(event => <li key={event.id}><strong>{event.actor.display_name}</strong><time>{formatDate(event.occurred_at)} JST</time><p className={common.body}>{eventText(event)}</p></li>)}</ol></section>}
    {confirm && saved && <dialog ref={dialogRef} className={common.dialog} aria-modal="true" aria-labelledby="review-confirm-heading" onKeyDown={trapDialogFocus} onCancel={e => { e.preventDefault(); if (!busy) setConfirm(null) }}>
      <h2 id="review-confirm-heading">{confirm === 'approve' ? '保存した版を承認しますか？' : '理由を記録して差し戻しますか？'}</h2><p>{saved.number} / v{saved.version_no} · {saved.title}</p><p>{confirm === 'approve' ? saved.publication_suspended ? '公開停止中です。承認後も再公開するまで社員には表示されません。' : '保存済みの内容を社員全員の検索に公開します。担当者用の根拠は公開しません。' : 'この版と理由を保存します。再作成は次の版で行います。'}</p>
      <form onSubmit={submitReview}>{confirm === 'reject' && <label className={common.field}>差し戻しの理由<textarea value={reason} required maxLength={1000} disabled={busy} onChange={e => setReason(e.target.value)} /></label>}{error && <p role="alert" className={common.error}>{error}</p>}<div className={common.actions}><button ref={cancelRef} type="button" className="button" disabled={busy} onClick={() => setConfirm(null)}>確認を閉じる（理由は保持）</button><button className="button buttonPrimary" disabled={busy || blocked}>{busy ? '保存中…' : confirm === 'approve' ? saved.publication_suspended ? 'この版を承認（公開停止を維持）' : 'この版を承認して公開' : '理由を記録して差し戻す'}</button></div></form>
    </dialog>}
    {saved && <KnowledgeManagement initial={saved} onDirtyChange={onDirtyChange} onChanged={value => setSaved(value)} />}
    {discard && <DiscardDialog onCancel={() => setDiscard(false)} onDiscard={reset} />}
  </>
}
