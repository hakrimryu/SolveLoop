import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { api, ApiError, errorMessage, isStale } from '../../lib/api'
import { eventText, formatDate, statusLabels, validateText } from '../../lib/business'
import type { Ticket } from '../../lib/business'
import { useBusinessCall, useLoad } from '../../lib/useBusiness'
import { LoadState } from '../../components/BusinessState'
import type { RequestProps } from './Requests'
import DiscardDialog from '../../components/DiscardDialog'
import RequestAI from './RequestAI'
import styles from './Requests.module.css'

export default function RequestDetail(props: RequestProps) {
  const { requestId } = useParams()
  const resource = useLoad<Ticket>(`/tickets/${requestId}`)
  const location = useLocation()
  return resource.data ? <Detail key={requestId} {...props} initial={resource.data} /> : <><Link to={`/requests${location.search}`}>← 問い合わせ一覧へ戻る</Link><h1 tabIndex={-1}>問い合わせ詳細</h1><LoadState error={resource.error} reload={resource.reload} /></>
}

function Detail({ role, departments, operators, onDirtyChange, initial }: RequestProps & { initial: Ticket }) {
  const [saved, setSaved] = useState(initial)
  const [body, setBody] = useState(initial.body)
  const [editing, setEditing] = useState(false)
  const [assignee, setAssignee] = useState(initial.assignee?.id ?? '')
  const [dept, setDept] = useState(initial.department?.id ?? '')
  const [resolution, setResolution] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [latest, setLatest] = useState<Ticket | null>(null)
  const [discard, setDiscard] = useState(false)
  const call = useBusinessCall()
  const location = useLocation()
  const heading = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const formBody = useRef<HTMLTextAreaElement>(null)
  const isOperator = role === 'operator'
  const assignmentDirty = assignee !== (saved.assignee?.id ?? '') || dept !== (saved.department?.id ?? '')
  const bodyDirty = editing && body !== saved.body
  const dirty = bodyDirty || assignmentDirty || !!resolution
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useEffect(() => { if (editing) formBody.current?.focus() }, [editing])
  function showError(value: string) { setError(value); requestAnimationFrame(() => errorRef.current?.focus()) }
  async function refresh() {
    if (busy) return
    setBusy(true)
    try {
      const result = await call<Ticket>(`/tickets/${saved.id}`)
      // 最新の保存内容は別に表示し、比較・確認前に編集中の値を置き換えない。
      // [ko] 최신 저장 내용은 별도로 표시하고 비교·확인 전에 편집 중인 값을 교체하지 않는다.
      // [en] Show the latest saved record separately; do not replace edits before explicit review.
      if (dirty || blocked) { setLatest(result); setBlocked(true); setMessage('最新の保存内容を取得しました。入力は自動で置き換えていません。') }
      else { setSaved(result); setBody(result.body); setAssignee(result.assignee?.id ?? ''); setDept(result.department?.id ?? ''); setError('') }
    } catch (cause) { if (!isStale(cause)) showError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function apply(operation: 'edit' | 'assignment' | 'start' | 'resolve' | 'reopen') {
    if (busy || blocked) return
    if (operation === 'edit' && validateText(body, 5000)) { showError('内容を1〜5000文字で入力してください。'); return }
    if (operation === 'resolve' && validateText(resolution, 5000)) { showError('解決内容を1〜5000文字で入力してください。'); return }
    if (['start', 'resolve'].includes(operation) && (editing || assignmentDirty)) { showError('先に本文・担当の変更を保存するか取り消してください。'); return }
    setBusy(true); setError(''); setMessage('')
    const generation = api.snapshot().generation
    // 保存した領域だけを確定し、応答後の再取得でも他の未保存入力を保つ。
    // [ko] 저장한 영역만 확정하고 응답 후 재조회에서도 다른 영역의 미저장 입력을 유지한다.
    // [en] Accept only the saved section and preserve other unsaved inputs through the follow-up GET.
    function accept(value: Ticket) {
      setSaved(value)
      if (operation === 'edit' || !bodyDirty) setBody(value.body)
      if (operation === 'edit') setEditing(false)
      if (operation === 'resolve' || operation === 'reopen') setResolution('')
      if (operation === 'assignment' || operation === 'reopen' || !assignmentDirty) {
        setAssignee(value.assignee?.id ?? ''); setDept(value.department?.id ?? '')
      }
    }
    try {
      const payload = operation === 'edit' ? { body } : operation === 'assignment' ? { department_id: dept || null, assignee_id: assignee || null } : { action: operation, ...(operation === 'resolve' ? { resolution } : {}), ...(operation === 'reopen' && assignee && assignee !== saved.assignee?.id ? { assignee_id: assignee } : {}) }
      const path = `/tickets/${saved.id}${operation === 'edit' ? '' : operation === 'assignment' ? '/assignment' : '/transition'}`
      const result = await call<Ticket>(path, { ...payload, expected_version: saved.version }, { method: operation === 'edit' ? 'PATCH' : 'POST' })
      api.assertCurrent(generation)
      accept(result)
      setMessage('変更を保存しました。')
      const current = await call<Ticket>(`/tickets/${saved.id}`)
      api.assertCurrent(generation)
      accept(current)
      heading.current?.focus()
    } catch (cause) { if (!isStale(cause)) { showError(errorMessage(cause, true)); setBlocked(cause instanceof ApiError ? cause.status === 409 || cause.status >= 500 : true); setLatest(null) } }
    finally { setBusy(false) }
  }
  const back = new URLSearchParams(location.search); back.delete('new')
  return <>
    <Link className={styles.back} to={`/requests${back.size ? `?${back}` : ''}`}>← 問い合わせ一覧へ戻る（条件を保持）</Link>
    <div className={styles.heading}><div><p className="eyebrow">{saved.number} · 保存版 {saved.version}</p><h1 ref={heading} tabIndex={-1}>{saved.title}</h1><span className={`status ${saved.status}`}>{statusLabels[saved.status]}</span></div><button className="button" disabled={busy} onClick={() => { void refresh() }}>最新の保存内容を取得</button></div>
    {message && <p role="status" className={styles.success}>{message}</p>}{error && <p ref={errorRef} tabIndex={-1} role="alert" className={styles.errorBanner}>{error}</p>}
    {blocked && <section className="notice" aria-label="保存内容の再確認"><h2>入力を保持しています</h2><p>自動再送はしません。最新の保存内容・状態・履歴を確認してください。</p><button className="button" disabled={busy} onClick={() => { void refresh() }}>最新の保存内容を取得</button>{latest && <><p>保存版 {latest.version} · {statusLabels[latest.status]} · {formatDate(latest.updated_at)} JST</p><p className={styles.body}>{latest.body}</p><p className={styles.body}>{latest.resolution}</p><button className="button" onClick={() => { setSaved(latest); setBlocked(false); setLatest(null); setError(''); setMessage('最新の版を確認しました。保持した入力を見直し、必要な操作を明示的に行ってください。') }}>最新の版を確認済み・保持した入力で編集を続ける</button></>}</section>}
    <div className={styles.detailGrid}><div className={styles.reading}>
      <section className={styles.section} aria-labelledby="body-heading"><div className={styles.sectionHeading}><h2 id="body-heading">問い合わせ内容</h2>{saved.status !== 'resolved' && !editing && <button className="button" disabled={busy || blocked} onClick={() => setEditing(true)}>内容を編集</button>}</div><p className={styles.meta}>申請者 {saved.requester.display_name} · 登録 {formatDate(saved.created_at)} JST</p>
        {editing ? <form onSubmit={e => { e.preventDefault(); void apply('edit') }} onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }}><label className={styles.field}>内容 <span className={styles.required}>必須</span><textarea ref={formBody} value={body} maxLength={5000} disabled={busy} onChange={e => setBody(e.target.value)} /></label><div className={styles.actions}><button type="button" className="button" disabled={busy} onClick={() => { if (body !== saved.body) setDiscard(true); else setEditing(false) }}>編集をキャンセル</button><button className="button buttonPrimary" disabled={busy || blocked}>内容を保存</button></div></form> : <p className={styles.body}>{saved.body}</p>}
      </section>
      {saved.status === 'resolved' && <section className={styles.section}><h2>解決内容</h2><p className={styles.meta}>解決 {formatDate(saved.resolved_at!)} JST</p><p className={styles.body}>{saved.resolution}</p>{isOperator && <div className={styles.nextStep}><h3>解決記録をナレッジへ</h3><p>保存済みの解決記録を根拠として、手動で下書きを作成します。</p><Link className="button" to={`/knowledge/reviews/new?source=${saved.id}`}>ナレッジの下書きを作成</Link></div>}</section>}
      {isOperator && <RequestAI ticket={saved} disabled={busy || blocked || editing} />}
      <section className={styles.section}><h2>変更履歴</h2><p className={styles.help}>古い順 · サーバーに保存された業務記録です。</p><ol className={styles.history}>{saved.events.map(event => <li key={event.id}><div><strong>{event.actor.display_name}</strong><time dateTime={event.occurred_at}>{formatDate(event.occurred_at)} JST</time></div><p className={styles.body}>{eventText(event)}</p></li>)}</ol></section>
    </div><aside className={styles.side} aria-label="問い合わせの属性と操作"><section className={styles.section}><h2>問い合わせ情報</h2><dl className={styles.metadata}><dt>申請者</dt><dd>{saved.requester.display_name}</dd><dt>担当部署</dt><dd>{saved.department?.name ?? '未定'}</dd><dt>担当者</dt><dd>{saved.assignee?.display_name ?? '未割り当て'}</dd><dt>状態</dt><dd>{statusLabels[saved.status]}</dd><dt>更新日時</dt><dd>{formatDate(saved.updated_at)} JST</dd></dl></section>
      {isOperator && <section className={styles.section}><h2>担当者の操作</h2><fieldset disabled={busy || blocked}>
        {saved.status !== 'resolved' && <label className={styles.field}>担当部署<select value={dept} onChange={e => setDept(e.target.value)}><option value="">未定</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}{saved.department && !departments.some(d => d.id === saved.department!.id) && <option value={saved.department.id}>{saved.department.name}（現在の記録）</option>}</select></label>}
        <label className={styles.field}>{saved.status === 'resolved' ? '再開時の担当者' : '担当者を割り当てる'}<select value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">未割り当て</option>{operators.map(o => <option key={o.id} value={o.id}>{o.display_name}</option>)}{saved.assignee && !operators.some(o => o.id === saved.assignee!.id) && <option value={saved.assignee.id}>{saved.assignee.display_name}（現在の記録・変更が必要）</option>}</select></label>
        {saved.status !== 'resolved' ? <><button className="button" disabled={!assignmentDirty} onClick={() => { void apply('assignment') }}>割り当てを反映</button>{assignmentDirty && <button className="button" onClick={() => { setAssignee(saved.assignee?.id ?? ''); setDept(saved.department?.id ?? '') }}>担当の変更を取り消す</button>}{saved.status === 'open' ? <div className={styles.start}><p className={styles.help}>担当部署と担当者を確定してから対応を開始します。</p><button className="button buttonPrimary" disabled={!saved.department || !saved.assignee || assignmentDirty || editing} onClick={() => { void apply('start') }}>対応を開始</button></div> : <form className={styles.resolve} onSubmit={e => { e.preventDefault(); void apply('resolve') }} onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }}><label className={styles.field}>解決内容 <span className={styles.required}>必須</span><textarea value={resolution} maxLength={5000} onChange={e => setResolution(e.target.value)} /></label><p className={styles.help}>確認した原因・手順・結果を5000文字以内で記録します。</p><button className="button buttonPrimary" disabled={editing || assignmentDirty}>解決内容を記録して解決</button></form>}</> : <><p className={styles.help}>再開すると前回の解決内容を履歴に残し、対応中に戻します。</p><button className="button" onClick={() => { void apply('reopen') }}>対応を再開</button></>}
      </fieldset></section>}
    </aside></div>
    {discard && <DiscardDialog onCancel={() => setDiscard(false)} onDiscard={() => { setBody(saved.body); setEditing(false); setDiscard(false) }} />}
  </>
}
