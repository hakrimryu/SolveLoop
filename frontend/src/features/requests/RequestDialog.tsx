import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, Link } from 'react-router'
import { api, ApiError, errorMessage, isStale } from '../../lib/api'
import type { Page, Ticket, TicketItem } from '../../lib/business'
import { validateText } from '../../lib/business'
import { useBusinessCall } from '../../lib/useBusiness'
import type { RequestProps } from './Requests'
import styles from './Requests.module.css'
import DiscardDialog, { trapDialogFocus } from '../../components/DiscardDialog'
import { clearSearchInquiry, readSearchInquiry } from '../../lib/searchInquiry'

export default function RequestDialog({ departments, onDirtyChange, onClose, personal = false }: RequestProps & { onClose: () => void }) {
  const location = useLocation()
  const dialog = useRef<HTMLDialogElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const title = useRef<HTMLInputElement>(null)
  const key = useRef(crypto.randomUUID())
  const [input, setInput] = useState(() => readSearchInquiry(location.state?.searchInquiryId) ?? { title: '', body: '', department_id: '' })
  const [errors, setErrors] = useState({ title: '', body: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [matches, setMatches] = useState<TicketItem[] | null>(null)
  const [checked, setChecked] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const call = useBusinessCall()
  const navigate = useNavigate()
  const basePath = personal ? '/my/requests' : '/requests'
  const dirty = !!(input.title || input.body || input.department_id)
  useLayoutEffect(() => { dialog.current!.showModal(); title.current?.focus(); return () => { dialog.current?.close(); clearSearchInquiry() } }, [])
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  function close() { if (!busy) { if (dirty) setConfirm(true); else onClose() } }
  // 結果不明時も入力と登録キーを固定し、人の確認後だけ同じ登録を再試行する。
  // [ko] 결과 미확인 중에는 입력과 등록 키를 고정하고 사용자 확인 후에만 같은 등록을 재시도한다.
  // [en] Keep payload and key fixed while the outcome is unknown; retry only after explicit review.
  async function submit() {
    if (busy) return
    const validation = { title: validateText(input.title, 120), body: validateText(input.body, 5000) }
    setErrors(validation)
    if (Object.values(validation).some(Boolean)) { form.current?.querySelector<HTMLElement>(`[name="${validation.title ? 'title' : 'body'}"]`)?.focus(); return }
    setBusy(true); setError(''); setMatches(null); setChecked(false)
    const generation = api.snapshot().generation
    try {
      const result = await call<Ticket>('/tickets', { ...input, department_id: input.department_id || null, ...(input.guidance_id ? { handoff_reason: input.handoff_reason?.trim() || null } : {}) }, { idempotencyKey: key.current })
      api.assertCurrent(generation)
      onDirtyChange(false)
      const params = new URLSearchParams(location.search); params.delete('new')
      navigate(`${basePath}/${result.id}${params.size ? `?${params}` : ''}`, { replace: true })
    } catch (cause) { if (!isStale(cause)) { setError(errorMessage(cause, true)); setUncertain(!(cause instanceof ApiError) || cause.status >= 500) } }
    finally { setBusy(false) }
  }
  async function check() {
    if (busy) return
    setBusy(true); setMatches(null); setChecked(false)
    try { const data = await call<Page<TicketItem>>(`/tickets?q=${encodeURIComponent(input.title.trim())}&page_size=100${personal ? '&scope=mine' : ''}`); setMatches(data.items) }
    catch (cause) { if (!isStale(cause)) setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  return <><dialog ref={dialog} className={styles.dialog} aria-modal="true" aria-labelledby="register-heading" onKeyDown={trapDialogFocus} onCancel={e => { e.preventDefault(); close() }}>
    <div className={styles.dialogHeading}><h2 id="register-heading">問い合わせを登録</h2><button className="button" disabled={busy} onClick={close}>閉じる</button></div><p className="muted">登録内容はサーバーに保存されます。担当部署が分からない場合は未定で登録できます。</p>
    <form ref={form} onSubmit={e => { e.preventDefault(); if (!uncertain) void submit() }} noValidate onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }}><fieldset disabled={busy || uncertain}>
      <label className={styles.field}>件名 <span className={styles.required}>必須</span><input ref={title} name="title" value={input.title} maxLength={120} required aria-invalid={!!errors.title} aria-describedby="title-error" onChange={e => setInput({ ...input, title: e.target.value })} /></label><p id="title-error" className={styles.error}>{errors.title}</p>
      <label className={styles.field}>内容 <span className={styles.required}>必須</span><textarea name="body" value={input.body} maxLength={5000} required aria-invalid={!!errors.body} aria-describedby="body-error" onChange={e => setInput({ ...input, body: e.target.value })} /></label><p id="body-error" className={styles.error}>{errors.body}</p>
      {input.guidance_id && <><p className={styles.help}>直前に確認したAI案内・根拠の記録を添付します。この記録は問い合わせの履歴として残り、担当者が確認できます。</p><label className={styles.field}>担当者に引き継ぐ理由・試したこと（任意）<textarea value={input.handoff_reason ?? ''} maxLength={1000} onChange={e => setInput({ ...input, handoff_reason: e.target.value })} /></label></>}
      <label className={styles.field}>担当部署<select value={input.department_id} onChange={e => setInput({ ...input, department_id: e.target.value })}><option value="">未定</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label><p className={styles.help}>申請者の所属ではなく、対応を依頼する部署です。割り当て・対応開始前に担当者が確定します。</p>
    </fieldset>{error && <p role="alert" className={styles.error}>{error}</p>}
    {uncertain && <div className="notice"><button type="button" className="button" disabled={busy} onClick={() => { void check() }}>一覧で登録結果を確認</button>{matches && <><p>{matches.length}件を取得しました。番号・内容を確認してください。</p>{matches.map(item => <p key={item.id}><Link to={`${basePath}/${item.id}`}>{item.number} {item.title}</Link></p>)}<label><input type="checkbox" checked={checked} disabled={busy} onChange={e => setChecked(e.target.checked)} />一覧で今回の登録結果を確認しました</label><p>同じ内容・登録キーで再試行します。作成済みの場合は同じ登録結果を取得します。</p><button type="button" className="button" disabled={!checked || busy} onClick={() => { void submit() }}>確認済み・同じ登録キーで再試行する</button></>}</div>}
    <div className={styles.actions}><button type="button" className="button" disabled={busy} onClick={close}>キャンセル</button><button className="button buttonPrimary" disabled={busy || uncertain}>{busy ? '登録中…' : '登録'}</button></div></form>
  </dialog>{confirm && <DiscardDialog onCancel={() => setConfirm(false)} onDiscard={() => { onDirtyChange(false); onClose() }} />}</>
}
