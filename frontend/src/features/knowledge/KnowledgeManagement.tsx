import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { ApiError, errorMessage, isStale } from '../../lib/api'
import { reviewApi } from '../../lib/business'
import type { Review } from '../../lib/business'
import { useBusinessCall } from '../../lib/useBusiness'
import { trapDialogFocus } from '../../components/DiscardDialog'
import common from '../requests/Requests.module.css'
import styles from './Knowledge.module.css'

type Operation = 'stop-publication' | 'resume-publication' | 'delete-document'
const labels: Record<Operation, string> = { 'stop-publication': '公開を停止', 'resume-publication': '再公開する', 'delete-document': '文書全体を完全に削除' }

export default function KnowledgeManagement({ initial, onDirtyChange, onChanged }: { initial: Review; onDirtyChange: (dirty: boolean) => void; onChanged?: (review: Review) => void }) {
  const [saved, setSaved] = useState(initial)
  const [operation, setOperation] = useState<Operation | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null)
  const confirmationId = useId()
  const call = useBusinessCall(), navigate = useNavigate()
  useEffect(() => { setSaved(initial) }, [initial])
  useLayoutEffect(() => {
    if (!operation) return
    const previous = document.activeElement as HTMLElement | null
    const node = dialog.current!
    node.showModal(); cancel.current?.focus()
    return () => { node.close(); if (previous?.isConnected) previous.focus() }
  }, [operation])
  const deleting = operation === 'delete-document'
  const published = saved.published_version_no === saved.version_no
  function open(next: Operation) { setOperation(next); setConfirmation(''); setError('') }
  async function refresh() {
    setBusy(true)
    try { const current = await call<Review>(reviewApi(saved)); setSaved(current); onChanged?.(current); setBlocked(false); setError(''); setOperation(null); setMessage('最新の保存内容を取得しました。対象を確認してから操作してください。') }
    catch (cause) { if (!isStale(cause)) setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!operation || busy || blocked || deleting && confirmation !== saved.number) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await call<Review>(`${reviewApi(saved)}/${operation}`, { expected_version: saved.row_version, expected_document_version: saved.document_row_version, ...(deleting ? { confirmation_number: confirmation } : {}) })
      setOperation(null)
      if (deleting) { onDirtyChange(false); navigate('/knowledge/reviews', { replace: true, state: { message: `${saved.number} を削除しました。` } }); return }
      setSaved(result); onChanged?.(result)
      setMessage(result.publication_suspended ? '公開を停止しました。社員の検索・閲覧から除外し、文書と履歴は保管しています。' : '再公開しました。社員の検索・閲覧を再開しました。')
    } catch (cause) {
      if (!isStale(cause)) { setError(errorMessage(cause, true)); setBlocked(!(cause instanceof ApiError) || cause.status === 409 || cause.status >= 500) }
    } finally { setBusy(false) }
  }
  return <section className={styles.management} aria-label="文書の管理">
    <h2>文書の管理</h2><p className={styles.managementWarning}>重要な操作です。対象と影響を確認してください。</p>
    <p>公開状態：<strong>{saved.published_version_no ? saved.publication_suspended ? '公開停止中' : '公開中' : '未公開'}</strong></p>
    {message && <p role="status">{message}</p>}
    {error && !operation && <p role="alert">{error}</p>}
    {blocked && <p>処理結果または保存版を再確認してください。自動再送はしません。<button className="button" disabled={busy} onClick={() => { void refresh() }}>最新の保存内容を確認</button></p>}
    <div className={styles.managementAction}><h3>{saved.publication_suspended ? '公開を再開する' : '公開を停止する'}</h3><p>公開停止中も、文書・すべての版・レビュー履歴は保管されます。</p>
      {published ? <button className={`button ${styles.stopButton}`} disabled={busy || blocked} onClick={() => open(saved.publication_suspended ? 'resume-publication' : 'stop-publication')}>{saved.publication_suspended ? '再公開…' : '公開を停止…'}</button> : saved.published_version_no ? <Link className="button" to={`/knowledge/${saved.document_id}`}>公開版の管理画面へ</Link> : <p>この文書はまだ公開されていません。</p>}
    </div>
    <div className={styles.managementAction}><h3>文書を削除する</h3><p>すべての版・レビュー履歴・検索資料を完全に削除します。元に戻せません。</p><button className={`button ${styles.dangerButton}`} disabled={busy || blocked} onClick={() => open('delete-document')}>文書を削除…</button></div>
    {operation && <dialog ref={dialog} className={`${common.dialog} ${styles.managementDialog}`} aria-modal="true" aria-labelledby={`${confirmationId}-heading`} onKeyDown={trapDialogFocus} onCancel={event => { event.preventDefault(); if (!busy) setOperation(null) }}>
      <h2 id={`${confirmationId}-heading`}>{deleting ? 'この文書を完全に削除しますか？' : saved.publication_suspended ? 'この文書を再公開しますか？' : 'この文書の公開を停止しますか？'}</h2>
      <p><strong>{saved.number}</strong> · {saved.title}</p><p>現在：{saved.published_version_no ? saved.publication_suspended ? '公開停止中' : '公開中' : '未公開'} / 公開版 {saved.published_version_no ? `v${saved.published_version_no}` : 'なし'}</p>
      <p>{deleting ? `下書き・公開版を含む全${saved.latest_version_no}版、レビュー履歴、根拠の写し、検索資料を削除します。元の問い合わせは削除しません。元に戻せません。` : saved.publication_suspended ? '現在の承認版を社員全員の検索・閲覧に戻します。作成中の下書きは公開しません。' : '社員の検索・閲覧から除外します。文書・すべての版・履歴は保管し、あとから再公開できます。'} </p>
      <form onSubmit={submit}>
        {deleting && <div className={styles.confirmationField}><label htmlFor={confirmationId}>確認のため文書番号「{saved.number}」を入力してください</label><input id={confirmationId} value={confirmation} maxLength={32} disabled={busy} autoComplete="off" spellCheck={false} onChange={event => setConfirmation(event.target.value)} /></div>}
        {error && <p role="alert" className={common.error}>{error}</p>}
        <div className={common.actions}><button ref={cancel} type="button" className="button" disabled={busy} onClick={() => setOperation(null)}>キャンセル</button><button className={`button ${deleting ? styles.dangerButton : styles.stopButton}`} disabled={busy || blocked || deleting && confirmation !== saved.number}>{busy ? '処理中…' : labels[operation]}</button></div>
      </form>
    </dialog>}
  </section>
}
